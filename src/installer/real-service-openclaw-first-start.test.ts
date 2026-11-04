import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SovereignPaths } from "../config/paths.js";
import { createLogger } from "../logging/logger.js";
import type { ExecInput, ExecResult } from "../system/exec.js";
import {
  GATEWAY_FIRST_START_READY_DEADLINE_MS,
  GATEWAY_READY_DEADLINE_MS,
  type GatewayReadinessOutcome,
} from "./gateway-readiness.js";
import { OPENCLAW_DOCTOR_TIMEOUT_MS } from "./openclaw-first-start.js";
import { RealInstallerService } from "./real-service.js";
import type { RuntimeConfig } from "./real-service-shared.js";

vi.mock("../system/service-node.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../system/service-node.js")>()),
  resolveServiceNode: async () => ({ ok: true, path: "/usr/bin/node" }),
}));

const GATEWAY_URL = "http://127.0.0.1:18789/";
const CONSENT_HELP =
  "Options:\n  --force\n  --accept-capabilities  Accept the plugin's capabilities\n";

type StartOptions = { readyDeadlineMs?: number };

type Internals = {
  gatewayReadinessClock: { now: () => number; sleep: (ms: number) => Promise<void> };
  prepareOpenClawGatewayStart(
    config: RuntimeConfig,
  ): Promise<{ shape: "list" | "keyed"; startOptions: StartOptions }>;
  ensureSystemGatewayServiceFallback(
    config: RuntimeConfig,
    options?: StartOptions,
  ): Promise<GatewayReadinessOutcome>;
  refreshGatewayAfterRuntimeConfig(
    config: RuntimeConfig,
    options?: StartOptions,
  ): Promise<GatewayReadinessOutcome>;
  startInstalledUserGatewayService(
    requestedVersion: string | undefined,
    config: RuntimeConfig | undefined,
  ): Promise<void>;
  ensureManagedAgentOpenClawBindings(config: RuntimeConfig, shape: "list" | "keyed"): Promise<void>;
  resolveHostPlanOpenClawCli(config: RuntimeConfig): Promise<{ openclawCli?: unknown }>;
  safeExec(
    command: string,
    args: string[],
  ): Promise<{ ok: true; result: ExecResult } | { ok: false; error: string }>;
  ensureMatrixCryptoRuntimeWritable(config?: RuntimeConfig): Promise<void>;
  reconcileManagedExecApprovals(config: RuntimeConfig): Promise<void>;
  waitForOpenClawListContains(
    args: string[],
    id: string,
  ): Promise<{ present: boolean; verified: boolean }>;
};

type Reply = Partial<ExecResult>;

describe("OpenClaw 2026.8 first start", () => {
  let tempRoot: string;
  let paths: SovereignPaths;
  let clock: number;
  let calls: ExecInput[];
  let replies: Record<string, Reply>;
  let gatewayStarts: string[];
  let priorUnitPath: string | undefined;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-openclaw-first-start-"));
    paths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };
    clock = 0;
    calls = [];
    replies = { "openclaw plugins install --help": { stdout: CONSENT_HELP } };
    gatewayStarts = [];
    priorUnitPath = process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH;
    process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH = join(tempRoot, "gateway.service");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (priorUnitPath === undefined) {
      delete process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH;
    } else {
      process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH = priorUnitPath;
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  const runtimeConfig = (): RuntimeConfig =>
    ({
      openclaw: {
        requestedVersion: "pinned-by-sovereign",
        openclawHome: join(paths.openclawServiceHome, ".openclaw"),
        runtimeConfigPath: join(paths.openclawServiceHome, ".openclaw", "openclaw.json5"),
        gatewayEnvPath: join(paths.openclawServiceHome, "gateway.env"),
        serviceUser: "sovereign-node",
        serviceGroup: "sovereign-node",
      },
      openclawProfile: {
        agents: [
          {
            id: "mail-sentinel",
            workspace: join(paths.stateDir, "mail-sentinel", "workspace"),
            matrix: {
              userId: "@mail-sentinel:matrix.example.org",
              accessTokenSecretRef: "file:/dev/null",
            },
          },
        ],
        crons: [],
      },
      matrix: {
        adminBaseUrl: "https://matrix.example.org",
        bot: { userId: "@service:matrix.example.org" },
      },
    }) as unknown as RuntimeConfig;

  const makeService = (installedVersion: string | null, options?: { noExec?: boolean }) => {
    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () =>
          installedVersion === null
            ? null
            : { binaryPath: "/usr/bin/openclaw", version: installedVersion },
        ensureInstalled: async () => {
          throw new Error("not used");
        },
      },
      openclawGatewayServiceManager: {
        install: async () => {},
        start: async () => {
          gatewayStarts.push("start");
        },
        restart: async () => {
          gatewayStarts.push("restart");
        },
      },
      ...(options?.noExec === true
        ? {}
        : {
            execRunner: {
              run: async (call: ExecInput): Promise<ExecResult> => {
                calls.push(call);
                const serialized = [call.command, ...(call.args ?? [])].join(" ");
                const key = Object.keys(replies).find((prefix) => serialized.startsWith(prefix));
                return {
                  command: serialized,
                  exitCode: 0,
                  stdout: "",
                  stderr: "",
                  ...(key === undefined ? {} : replies[key]),
                };
              },
            },
          }),
      fetchImpl: async (url: string) => {
        if (url === GATEWAY_URL) {
          return new Response("ok", { status: 200 });
        }
        return new Response("not found", { status: 404 });
      },
    } as unknown as ConstructorParameters<typeof RealInstallerService>[2]);
    const internals = service as unknown as Internals;
    internals.gatewayReadinessClock = {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    };
    return internals;
  };

  const commands = () => calls.map((call) => [call.command, ...(call.args ?? [])].join(" "));
  const openclawCommands = () => commands().filter((command) => command.startsWith("openclaw "));

  describe("before the gateway starts", () => {
    it("installs the Matrix plugin at the host version, repairs and validates the config, as the gateway's CLI", async () => {
      const prepared = await makeService("2026.8.35").prepareOpenClawGatewayStart(runtimeConfig());

      expect(prepared).toEqual({
        shape: "keyed",
        startOptions: { readyDeadlineMs: GATEWAY_FIRST_START_READY_DEADLINE_MS },
      });
      expect(openclawCommands()).toEqual([
        "openclaw plugins install --help",
        "openclaw plugins install npm:@openclaw/matrix@2026.8.35 --force --accept-capabilities",
        "openclaw doctor --fix --non-interactive",
        "openclaw config validate",
      ]);
      const doctor = calls.find((call) => call.args?.[0] === "doctor");
      expect(doctor?.options).toMatchObject({
        timeout: OPENCLAW_DOCTOR_TIMEOUT_MS,
        env: expect.objectContaining({ CI: "1" }),
      });
    });

    it("stops an installed system gateway before the repair", async () => {
      await writeFile(join(tempRoot, "gateway.service"), "[Unit]\n", "utf8");

      await makeService("2026.8.35").prepareOpenClawGatewayStart(runtimeConfig());

      const all = commands();
      const stop = all.indexOf("systemctl stop sovereign-openclaw-gateway.service");
      expect(stop).toBeGreaterThanOrEqual(0);
      expect(stop).toBeLessThan(all.indexOf("openclaw doctor --fix --non-interactive"));
    });

    it("still repairs when the gateway cannot be stopped, and lets doctor decide", async () => {
      await writeFile(join(tempRoot, "gateway.service"), "[Unit]\n", "utf8");
      replies["systemctl stop"] = { exitCode: 5, stderr: "Unit not loaded" };
      replies["sudo -n systemctl stop"] = { exitCode: 1, stderr: "denied" };

      await makeService("2026.8.35").prepareOpenClawGatewayStart(runtimeConfig());

      expect(openclawCommands()).toContain("openclaw doctor --fix --non-interactive");
    });

    it("does not start the gateway when the plugin cannot be installed", async () => {
      replies["openclaw plugins install npm:"] = { exitCode: 1, stderr: "E404 Not Found" };

      await expect(
        makeService("2026.8.35").prepareOpenClawGatewayStart(runtimeConfig()),
      ).rejects.toMatchObject({ code: "OPENCLAW_MATRIX_PLUGIN_INSTALL_FAILED" });
      expect(openclawCommands()).not.toContain("openclaw doctor --fix --non-interactive");
    });

    it("uses the pinned version when the CLI cannot report its own", async () => {
      const service = makeService(null);
      const config = runtimeConfig();
      config.openclaw.requestedVersion = "2026.8.35";

      await service.prepareOpenClawGatewayStart(config);

      expect(openclawCommands()).toContain(
        "openclaw plugins install npm:@openclaw/matrix@2026.8.35 --force --accept-capabilities",
      );
    });

    it("changes nothing for 2026.3", async () => {
      expect(await makeService("2026.3.13").prepareOpenClawGatewayStart(runtimeConfig())).toEqual({
        shape: "list",
        startOptions: {},
      });
      expect(openclawCommands()).toEqual([]);
    });

    it("skips the preparation without an exec runner", async () => {
      expect(
        await makeService("2026.8.35", { noExec: true }).prepareOpenClawGatewayStart(
          runtimeConfig(),
        ),
      ).toEqual({ shape: "keyed", startOptions: {} });
    });
  });

  describe("the first start", () => {
    it("waits up to the first-start deadline for the system gateway", async () => {
      const outcome = await makeService("2026.8.35").ensureSystemGatewayServiceFallback(
        runtimeConfig(),
        { readyDeadlineMs: GATEWAY_FIRST_START_READY_DEADLINE_MS },
      );

      expect(outcome).toMatchObject({
        ready: true,
        deadlineMs: GATEWAY_FIRST_START_READY_DEADLINE_MS,
      });
    });

    it("keeps the ordinary deadline otherwise", async () => {
      const outcome = await makeService("2026.3.13").ensureSystemGatewayServiceFallback(
        runtimeConfig(),
      );

      expect(outcome.deadlineMs).toBe(GATEWAY_READY_DEADLINE_MS);
    });

    it("hands the first-start deadline to the user gateway service", async () => {
      const outcome = await makeService("2026.8.35").refreshGatewayAfterRuntimeConfig(
        runtimeConfig(),
        { readyDeadlineMs: GATEWAY_FIRST_START_READY_DEADLINE_MS },
      );

      expect(gatewayStarts).toEqual(["restart"]);
      expect(outcome.deadlineMs).toBe(GATEWAY_FIRST_START_READY_DEADLINE_MS);
    });

    it("hands the first-start deadline to the system fallback of the user service", async () => {
      replies["systemctl --user show"] = { stdout: "ActiveState=failed\nNRestarts=0\n" };
      let probes = 0;
      const service = makeService("2026.8.35");
      Object.assign(service, {
        fetchImpl: async () => {
          probes += 1;
          if (probes <= 1) {
            throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
          }
          return new Response("ok", { status: 200 });
        },
      });

      const outcome = await service.refreshGatewayAfterRuntimeConfig(runtimeConfig(), {
        readyDeadlineMs: GATEWAY_FIRST_START_READY_DEADLINE_MS,
      });

      expect(outcome.deadlineMs).toBe(GATEWAY_FIRST_START_READY_DEADLINE_MS);
    });
  });

  describe("the user gateway service", () => {
    it("is not started on 2026.8 before its config exists", async () => {
      const service = makeService("2026.8.35");
      const fix = vi.spyOn(service, "ensureMatrixCryptoRuntimeWritable").mockResolvedValue();

      await service.startInstalledUserGatewayService(undefined, undefined);

      expect(gatewayStarts).toEqual([]);
      expect(fix).not.toHaveBeenCalled();
    });

    it("is started on 2026.3 as before", async () => {
      const service = makeService("2026.3.13");
      const fix = vi.spyOn(service, "ensureMatrixCryptoRuntimeWritable").mockResolvedValue();

      await service.startInstalledUserGatewayService(undefined, undefined);

      expect(gatewayStarts).toEqual(["start"]);
      expect(fix).toHaveBeenCalledOnce();
    });
  });

  describe("managed agent bindings", () => {
    it("on 2026.8 checks that the gateway lists the agent instead of registering it", async () => {
      replies["openclaw agents list"] = { stdout: "mail-sentinel\n" };
      const service = makeService("2026.8.35");
      vi.spyOn(service, "reconcileManagedExecApprovals").mockResolvedValue();

      await service.ensureManagedAgentOpenClawBindings(runtimeConfig(), "keyed");

      expect(openclawCommands()).toContain("openclaw agents list");
      expect(
        openclawCommands().filter((command) =>
          /^openclaw agents (add|create|upsert|bind)/.test(command),
        ),
      ).toEqual([]);
    });

    it("on 2026.8 fails when the gateway does not list the rendered agent", async () => {
      const service = makeService("2026.8.35");
      vi.spyOn(service, "waitForOpenClawListContains").mockResolvedValue({
        present: false,
        verified: true,
      });

      await expect(
        service.ensureManagedAgentOpenClawBindings(runtimeConfig(), "keyed"),
      ).rejects.toMatchObject({
        code: "MANAGED_AGENT_REGISTER_FAILED",
        details: { agentId: "mail-sentinel" },
      });
    });
  });

  describe("the host resources plan", () => {
    it("names the gateway's identity, environment and CLI for OpenClaw cron jobs", async () => {
      const config = runtimeConfig();
      config.hostResources = {
        planPath: join(tempRoot, "host-resources.json"),
        resources: [{ kind: "openclawCron", desiredState: "absent", match: { name: "x-poll" } }],
      } as unknown as NonNullable<RuntimeConfig["hostResources"]>;

      const plan = await makeService("2026.8.35").resolveHostPlanOpenClawCli(config);

      expect(plan.openclawCli).toMatchObject({
        user: "sovereign-node",
        home: paths.openclawServiceHome,
        configPath: config.openclaw.runtimeConfigPath,
      });
      const command = (plan.openclawCli as { command: string[] }).command;
      expect(command.at(-1)).toMatch(/openclaw$/);
    });

    it("runs a bare CLI with its own shebang when no absolute CLI path is known", async () => {
      const config = runtimeConfig();
      config.hostResources = {
        planPath: join(tempRoot, "host-resources.json"),
        resources: [{ kind: "openclawCron", desiredState: "absent", match: { name: "x-poll" } }],
      } as unknown as NonNullable<RuntimeConfig["hostResources"]>;
      const priorPath = process.env.PATH;
      process.env.PATH = join(tempRoot, "empty-bin");
      try {
        const service = makeService("2026.8.35");
        Object.assign(service, { serviceProgramSearchPath: join(tempRoot, "empty-bin") });
        const plan = await service.resolveHostPlanOpenClawCli(config);
        expect((plan.openclawCli as { command: string[] }).command).toEqual(["openclaw"]);
      } finally {
        process.env.PATH = priorPath;
      }
    });

    it("leaves a plan without OpenClaw cron jobs unchanged", async () => {
      const config = runtimeConfig();
      expect(await makeService("2026.8.35").resolveHostPlanOpenClawCli(config)).toEqual({});
      config.hostResources = {
        planPath: join(tempRoot, "host-resources.json"),
        resources: [{ kind: "systemdTimer", name: "x.timer" }],
      } as unknown as NonNullable<RuntimeConfig["hostResources"]>;
      expect(await makeService("2026.8.35").resolveHostPlanOpenClawCli(config)).toEqual({});
    });
  });

  describe("npm run as root", () => {
    it("keeps root's own HOME instead of the OpenClaw service home", async () => {
      vi.spyOn(process as { getuid: () => number }, "getuid").mockReturnValue(0);

      await makeService("2026.8.35").safeExec("npm", ["root", "-g"]);

      expect(calls[0]?.options?.env).toEqual({ HOME: userInfo().homedir });
    });

    it("leaves an unprivileged npm's environment alone", async () => {
      vi.spyOn(process as { getuid: () => number }, "getuid").mockReturnValue(1000);

      await makeService("2026.8.35").safeExec("npm", ["root", "-g"]);

      expect(calls[0]?.options?.env).toBeUndefined();
    });
  });
});
