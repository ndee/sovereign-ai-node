import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SovereignPaths } from "../config/paths.js";
import { createLogger } from "../logging/logger.js";
import type { ExecInput, ExecResult } from "../system/exec.js";
import { GATEWAY_READY_TIMEOUT_ENV, type GatewayReadinessOutcome } from "./gateway-readiness.js";
import { RealInstallerService } from "./real-service.js";
import type { RuntimeConfig } from "./real-service-shared.js";

// The gateway unit takes the host's system node; these tests are about other
// behaviour and must not depend on whether the test host has one.
vi.mock("../system/service-node.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../system/service-node.js")>()),
  resolveServiceNode: async () => ({ ok: true, path: "/usr/bin/node" }),
}));

const GATEWAY_URL = "http://127.0.0.1:18789/";

type Responder = (serialized: string, input: ExecInput) => Partial<ExecResult> | "throw";

type Internals = {
  gatewayReadinessClock: { now: () => number; sleep: (ms: number) => Promise<void> };
  ensureSystemGatewayServiceFallback(config: RuntimeConfig): Promise<GatewayReadinessOutcome>;
  refreshGatewayAfterRuntimeConfig(config: RuntimeConfig): Promise<GatewayReadinessOutcome>;
  buildInstallSteps(req: unknown): Array<{ id: string; run: () => Promise<unknown> }>;
};

describe("OpenClaw gateway readiness", () => {
  let tempRoot: string;
  let paths: SovereignPaths;
  let clock: number;
  let execCalls: ExecInput[];
  let gatewayProbes: number;
  let priorUnitPath: string | undefined;
  let priorDeadline: string | undefined;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-gateway-ready-"));
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
    execCalls = [];
    gatewayProbes = 0;
    priorUnitPath = process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH;
    priorDeadline = process.env[GATEWAY_READY_TIMEOUT_ENV];
    process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH = join(tempRoot, "gateway.service");
    delete process.env[GATEWAY_READY_TIMEOUT_ENV];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const [key, value] of [
      ["SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH", priorUnitPath],
      [GATEWAY_READY_TIMEOUT_ENV, priorDeadline],
    ] as const) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  /** `listening(n)` answers the gateway URL from the n-th probe on. */
  const makeService = (input: {
    listening: (probe: number) => boolean;
    exec?: Responder;
    noExec?: boolean;
    gateway?: { restart?: () => Promise<void>; start?: () => Promise<void> };
  }) => {
    const respond: Responder = input.exec ?? (() => ({}));
    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => ({ binaryPath: "/usr/bin/openclaw", version: "2026.3.13" }),
        ensureInstalled: async () => {
          throw new Error("not used");
        },
      },
      openclawGatewayServiceManager: {
        install: async () => {},
        start: input.gateway?.start ?? (async () => {}),
        restart: input.gateway?.restart ?? (async () => {}),
      },
      ...(input.noExec
        ? {}
        : {
            execRunner: {
              run: async (call: ExecInput): Promise<ExecResult> => {
                execCalls.push(call);
                const serialized = [call.command, ...(call.args ?? [])].join(" ");
                const response = respond(serialized, call);
                if (response === "throw") {
                  throw new Error(`spawn ${call.command} ENOENT`);
                }
                return { command: serialized, exitCode: 0, stdout: "", stderr: "", ...response };
              },
            },
          }),
      fetchImpl: async (url: string) => {
        if (url === GATEWAY_URL) {
          gatewayProbes += 1;
          if (!input.listening(gatewayProbes)) {
            throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
          }
        }
        return new Response("not found", { status: 404 });
      },
    } as unknown as ConstructorParameters<typeof RealInstallerService>[2]);
    (service as unknown as Internals).gatewayReadinessClock = {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    };
    return service;
  };

  const internals = (service: RealInstallerService) => service as unknown as Internals;

  const runtimeConfig = (): RuntimeConfig =>
    ({
      matrix: { adminBaseUrl: "https://matrix.example.org" },
      openclaw: {
        serviceUser: "sovereign-node",
        serviceGroup: "sovereign-node",
        gatewayEnvPath: join(paths.openclawServiceHome, "gateway.env"),
      },
    }) as unknown as RuntimeConfig;

  const openclawCalls = () => execCalls.filter((call) => call.command === "openclaw");

  describe("system-level gateway restart", () => {
    it("returns as soon as the port answers and checks `openclaw health` once afterwards", async () => {
      const service = makeService({ listening: (probe) => probe > 40 });

      const outcome = await internals(service).ensureSystemGatewayServiceFallback(runtimeConfig());

      expect(outcome).toEqual({
        unitStarted: true,
        ready: true,
        waitedMs: 80_000,
        deadlineMs: 300_000,
        readyAt: new Date(80_000).toISOString(),
        unit: "sovereign-openclaw-gateway.service",
      });
      expect(openclawCalls()).toHaveLength(1);
      expect(openclawCalls()[0]).toMatchObject({
        args: ["health"],
        options: { timeout: 60_000 },
      });
    });

    it("stays ready when `openclaw health` cannot be spawned", async () => {
      const service = makeService({
        listening: () => true,
        exec: (serialized) => (serialized === "openclaw health" ? "throw" : {}),
      });

      const outcome = await internals(service).ensureSystemGatewayServiceFallback(runtimeConfig());

      expect(outcome.ready).toBe(true);
    });

    it("stays ready when the deep `openclaw health` check fails", async () => {
      const service = makeService({
        listening: () => true,
        exec: (serialized) =>
          serialized === "openclaw health" ? { exitCode: 1, stdout: "gateway closed (1006)" } : {},
      });

      const outcome = await internals(service).ensureSystemGatewayServiceFallback(runtimeConfig());

      expect(outcome.ready).toBe(true);
    });

    it("never spawns the OpenClaw CLI while waiting, and gives up at the deadline", async () => {
      const service = makeService({ listening: () => false });

      const outcome = await internals(service).ensureSystemGatewayServiceFallback(runtimeConfig());

      expect(outcome).toEqual({
        unitStarted: true,
        ready: false,
        waitedMs: 300_000,
        deadlineMs: 300_000,
        lastProbe: "ECONNREFUSED",
        unit: "sovereign-openclaw-gateway.service",
      });
      expect(openclawCalls()).toEqual([]);
    });

    it("honours the deadline override", async () => {
      process.env[GATEWAY_READY_TIMEOUT_ENV] = "45000";
      const service = makeService({ listening: () => false });

      const outcome = await internals(service).ensureSystemGatewayServiceFallback(runtimeConfig());

      expect(outcome).toMatchObject({ ready: false, waitedMs: 45_000, deadlineMs: 45_000 });
    });

    it("stops waiting as soon as systemd reports the unit failed", async () => {
      let shows = 0;
      const service = makeService({
        listening: () => false,
        exec: (serialized) => {
          if (!serialized.startsWith("systemctl show")) {
            return {};
          }
          shows += 1;
          return {
            stdout: `ActiveState=${shows < 3 ? "activating" : "failed"}\nNRestarts=0\nActiveEnterTimestamp=\n`,
          };
        },
      });

      const outcome = await internals(service).ensureSystemGatewayServiceFallback(runtimeConfig());

      expect(outcome).toMatchObject({ unitStarted: false, ready: false, waitedMs: 2_000 });
    });

    it("reports a unit that systemctl could not start", async () => {
      const service = makeService({
        listening: () => true,
        exec: (serialized) =>
          serialized.startsWith("systemctl enable") ? { exitCode: 1, stderr: "Unit masked" } : {},
      });

      const outcome = await internals(service).ensureSystemGatewayServiceFallback(runtimeConfig());

      expect(outcome).toMatchObject({ unitStarted: false, ready: false, waitedMs: 0 });
      expect(outcome.lastProbe).toContain(
        "systemctl enable --now sovereign-openclaw-gateway.service exited 1",
      );
    });

    it("reports a systemctl that could not be spawned", async () => {
      const service = makeService({
        listening: () => true,
        exec: (serialized) => (serialized === "systemctl daemon-reload" ? "throw" : {}),
      });

      const outcome = await internals(service).ensureSystemGatewayServiceFallback(runtimeConfig());

      expect(outcome.unitStarted).toBe(false);
      expect(outcome.lastProbe).toBe("systemctl daemon-reload: spawn systemctl ENOENT");
    });

    it("reports a unit file that could not be written", async () => {
      await writeFile(join(tempRoot, "not-a-dir"), "x");
      process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH = join(tempRoot, "not-a-dir", "unit");
      const service = makeService({ listening: () => true });

      const outcome = await internals(service).ensureSystemGatewayServiceFallback(runtimeConfig());

      expect(outcome.unitStarted).toBe(false);
      expect(outcome.lastProbe).toContain("failed to write");
    });

    it("cannot start anything without an exec runner", async () => {
      const service = makeService({ listening: () => true, noExec: true });

      expect(
        await internals(service).ensureSystemGatewayServiceFallback(runtimeConfig()),
      ).toMatchObject({ unitStarted: false, lastProbe: "exec runner unavailable" });
    });
  });

  describe("refreshGatewayAfterRuntimeConfig", () => {
    const asRoot = () => vi.spyOn(process as { getuid: () => number }, "getuid").mockReturnValue(0);

    it("returns a slow system gateway as not ready instead of failing", async () => {
      asRoot();
      const service = makeService({ listening: () => false });

      const outcome = await internals(service).refreshGatewayAfterRuntimeConfig(runtimeConfig());

      expect(outcome).toMatchObject({ unitStarted: true, ready: false });
    });

    it("still fails when the system gateway unit failed", async () => {
      asRoot();
      const service = makeService({
        listening: () => false,
        exec: (serialized) =>
          serialized.startsWith("systemctl show") ? { stdout: "ActiveState=failed\n" } : {},
      });

      await expect(
        internals(service).refreshGatewayAfterRuntimeConfig(runtimeConfig()),
      ).rejects.toMatchObject({
        code: "OPENCLAW_GATEWAY_RESTART_FAILED",
        message:
          "OpenClaw gateway unit failed to start; last probe: unit failed; last probe: ECONNREFUSED",
        details: { unitStarted: false, ready: false },
      });
    });

    it("waits for the user service and returns once it listens", async () => {
      const restart = vi.fn(async () => {});
      const service = makeService({ listening: (probe) => probe > 3, gateway: { restart } });

      const outcome = await internals(service).refreshGatewayAfterRuntimeConfig(runtimeConfig());

      expect(restart).toHaveBeenCalledTimes(1);
      expect(outcome).toMatchObject({
        ready: true,
        waitedMs: 6_000,
        unit: "openclaw-gateway.service",
      });
    });

    it("returns a user service that is still starting at the deadline as not ready", async () => {
      const service = makeService({
        listening: () => false,
        exec: (serialized) =>
          serialized.startsWith("systemctl --user show")
            ? { stdout: "ActiveState=activating\nNRestarts=0\n" }
            : {},
      });

      const outcome = await internals(service).refreshGatewayAfterRuntimeConfig(runtimeConfig());

      expect(outcome).toMatchObject({ unitStarted: true, ready: false, waitedMs: 300_000 });
      expect(execCalls.some((call) => call.args?.includes("daemon-reload"))).toBe(false);
    });

    it("falls back to the system unit when the user service failed", async () => {
      let userShows = 0;
      const service = makeService({
        listening: () => userShows >= 2,
        exec: (serialized) => {
          if (serialized.startsWith("systemctl --user show")) {
            userShows += 1;
            return { stdout: "ActiveState=failed\n" };
          }
          return {};
        },
      });

      const outcome = await internals(service).refreshGatewayAfterRuntimeConfig(runtimeConfig());

      expect(outcome).toMatchObject({
        ready: true,
        unit: "sovereign-openclaw-gateway.service",
      });
      expect(execCalls.some((call) => call.args?.includes("daemon-reload"))).toBe(true);
    });

    it("treats an unreadable user unit as unknown, not failed", async () => {
      const service = makeService({
        listening: (probe) => probe > 1,
        exec: (serialized) =>
          serialized.startsWith("systemctl --user show") ? { exitCode: 1 } : {},
      });

      expect(
        (await internals(service).refreshGatewayAfterRuntimeConfig(runtimeConfig())).ready,
      ).toBe(true);
    });

    it("retries with start when the user-service restart fails", async () => {
      const start = vi.fn(async () => {});
      const service = makeService({
        listening: () => true,
        gateway: {
          restart: async () => {
            throw new Error("restart failed");
          },
          start,
        },
      });

      await internals(service).refreshGatewayAfterRuntimeConfig(runtimeConfig());

      expect(start).toHaveBeenCalledTimes(1);
    });

    it("rethrows when systemd user services are unavailable", async () => {
      const service = makeService({
        listening: () => true,
        gateway: {
          restart: async () => {
            throw {
              code: "OPENCLAW_GATEWAY_RESTART_FAILED",
              message: "OpenClaw gateway command exited with non-zero status",
              retryable: true,
              details: {
                stderr: "systemctl --user unavailable: Failed to connect to bus: No medium found",
              },
            };
          },
        },
      });

      await expect(
        internals(service).refreshGatewayAfterRuntimeConfig(runtimeConfig()),
      ).rejects.toMatchObject({ code: "OPENCLAW_GATEWAY_RESTART_FAILED" });
    });

    it("cannot verify anything without an exec runner", async () => {
      const service = makeService({ listening: () => false, noExec: true });

      expect(
        await internals(service).refreshGatewayAfterRuntimeConfig(runtimeConfig()),
      ).toMatchObject({ ready: true, waitedMs: 0 });
    });
  });

  describe("gateway_ready step without a restart", () => {
    const runStep = async (service: RealInstallerService) => {
      const step = internals(service)
        .buildInstallSteps({})
        .find((candidate) => candidate.id === "gateway_ready");
      return await step?.run();
    };

    it("passes when a gateway is already listening", async () => {
      await expect(runStep(makeService({ listening: () => true }))).resolves.toBeUndefined();
    });

    it("warns that the restart was skipped when nothing listens", async () => {
      await expect(runStep(makeService({ listening: () => false }))).rejects.toMatchObject({
        code: "OPENCLAW_GATEWAY_NOT_READY",
        message:
          "OpenClaw gateway unit failed to start; last probe: gateway restart was skipped; ECONNREFUSED",
        details: {
          unit: "sovereign-openclaw-gateway.service",
          unitStarted: false,
          waitedMs: 0,
          deadlineMs: 0,
        },
      });
    });
  });

  describe("status readiness", () => {
    const openclawService = async (service: RealInstallerService) =>
      (await service.getStatus()).services.find((entry) => entry.kind === "openclaw");

    it("reports a listening gateway as ready with the unit's start time", async () => {
      const service = makeService({
        listening: () => true,
        exec: (serialized) => {
          if (serialized.startsWith("systemctl show")) {
            return {
              stdout: "ActiveState=active\nNRestarts=0\nActiveEnterTimestamp=@1790000000\n",
            };
          }
          if (serialized.startsWith("systemctl is-active")) {
            return { stdout: "active\n" };
          }
          return {};
        },
      });

      expect(await openclawService(service)).toMatchObject({
        readiness: "ready",
        since: new Date(1_790_000_000_000).toISOString(),
      });
      expect(openclawCalls().filter((call) => call.args?.[0] === "health")).toEqual([
        expect.objectContaining({ options: expect.objectContaining({ timeout: 60_000 }) }),
      ]);
    });

    it("omits the message when the unit inspection gave none", async () => {
      const service = makeService({ listening: () => true });
      (
        service as unknown as { inspectGatewayService: () => Promise<unknown> }
      ).inspectGatewayService = async () => ({ installed: true, state: "running" });

      const entry = await openclawService(service);
      expect(entry?.readiness).toBe("ready");
      expect(entry).not.toHaveProperty("message");
    });

    it("reports a running unit that does not listen yet as starting", async () => {
      const service = makeService({
        listening: () => false,
        exec: (serialized) =>
          serialized.startsWith("systemctl is-active") ? { stdout: "active\n" } : {},
      });

      expect(await openclawService(service)).toMatchObject({
        health: "degraded",
        readiness: "starting",
        message: "gateway starting (not listening yet)",
      });
      expect(openclawCalls().some((call) => call.args?.[0] === "health")).toBe(false);
    });

    it("reports an activating unit as starting", async () => {
      const service = makeService({
        listening: () => false,
        exec: (serialized) => {
          if (serialized.startsWith("systemctl show")) {
            return { stdout: "ActiveState=activating\n" };
          }
          return serialized.startsWith("systemctl is-active")
            ? { exitCode: 3, stdout: "activating\n" }
            : {};
        },
      });

      expect((await openclawService(service))?.readiness).toBe("starting");
    });

    it("reports a stopped gateway as down", async () => {
      const service = makeService({
        listening: () => false,
        exec: (serialized) =>
          serialized.startsWith("systemctl is-active") ? { exitCode: 3, stdout: "inactive\n" } : {},
      });

      const entry = await openclawService(service);
      expect(entry?.readiness).toBe("down");
      expect(entry?.since).toBeUndefined();
    });

    it("carries readiness into the doctor's gateway health check", async () => {
      const service = makeService({
        listening: () => false,
        exec: (serialized) =>
          serialized.startsWith("systemctl is-active") ? { stdout: "active\n" } : {},
      });

      const report = await service.getDoctorReport();
      expect(report.checks.find((entry) => entry.id === "gateway-service-health")).toMatchObject({
        status: "warn",
        details: {
          readiness: "starting",
          healthProbe: "gateway starting (not listening yet): ECONNREFUSED",
        },
      });
    });
  });
});
