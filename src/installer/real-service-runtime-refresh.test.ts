import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FilesystemBotCatalog } from "../bots/catalog.js";
import type { SovereignPaths } from "../config/paths.js";
import { createLogger } from "../logging/logger.js";
import type { OpenClawBootstrapper } from "../openclaw/bootstrap.js";
import type { ExecInput, ExecResult } from "../system/exec.js";
import type { ImapTester } from "../system/imap.js";
import type { BundledMatrixProvisioner } from "../system/matrix.js";
import type { HostPreflightChecker } from "../system/preflight.js";
import type { GatewayReadinessOutcome } from "./gateway-readiness.js";
import { RealInstallerService } from "./real-service.js";
import type { RuntimeConfig } from "./real-service-shared.js";

type Internals = {
  writeOpenClawRuntimeArtifacts(config: RuntimeConfig): Promise<void>;
  setManagedOpenClawEnv(config: RuntimeConfig): void;
  refreshGatewayAfterRuntimeConfig(
    config: RuntimeConfig,
    options?: { preferInstalledSystemUnit?: boolean },
  ): Promise<GatewayReadinessOutcome>;
};

const readyOutcome = (
  overrides: Partial<GatewayReadinessOutcome> = {},
): GatewayReadinessOutcome => ({
  unitStarted: true,
  ready: true,
  waitedMs: 4_321,
  deadlineMs: 300_000,
  unit: "sovereign-openclaw-gateway.service",
  ...overrides,
});

describe("reconcileAgentWorkspaces runtime refresh", () => {
  let tempRoot: string;
  let paths: SovereignPaths;
  let catalogDir: string;
  let execCalls: ExecInput[];

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "runtime-refresh-test-"));
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
    catalogDir = join(tempRoot, "bots-catalog");
    execCalls = [];
    await mkdir(join(catalogDir, "bots"), { recursive: true });
    await mkdir(join(tempRoot, "etc"), { recursive: true });
    await writeFile(
      paths.configPath,
      `${JSON.stringify(
        {
          matrix: {
            publicBaseUrl: "http://matrix.example.org",
            adminBaseUrl: "http://127.0.0.1:8008",
            operator: { userId: "@operator:matrix.example.org" },
            bot: {
              localpart: "sovereign-bot",
              userId: "@sovereign-bot:matrix.example.org",
              accessTokenSecretRef: "file:/tmp/token",
            },
            alertRoom: { roomId: "!alerts:matrix.example.org" },
          },
          openclawProfile: { agents: [] },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempRoot, { recursive: true, force: true });
  });

  const makeService = (
    respond: (serialized: string) => Partial<ExecResult> | "throw" = () => ({}),
  ) => {
    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {} as unknown as OpenClawBootstrapper,
      openclawGatewayServiceManager: {
        install: async () => {},
        start: async () => {},
        restart: async () => {},
      },
      preflightChecker: {} as unknown as HostPreflightChecker,
      imapTester: {} as unknown as ImapTester,
      matrixProvisioner: {} as unknown as BundledMatrixProvisioner,
      botCatalog: new FilesystemBotCatalog(catalogDir),
      execRunner: {
        run: async (call: ExecInput): Promise<ExecResult> => {
          execCalls.push(call);
          const serialized = [call.command, ...(call.args ?? [])].join(" ");
          const response = respond(serialized);
          if (response === "throw") {
            throw new Error(`spawn ${call.command} ENOENT`);
          }
          return { command: serialized, exitCode: 0, stdout: "", stderr: "", ...response };
        },
      },
    });
    const internals = service as unknown as Internals;
    const order: string[] = [];
    const write = vi
      .spyOn(internals, "writeOpenClawRuntimeArtifacts")
      .mockImplementation(async () => {
        order.push("render");
      });
    const env = vi.spyOn(internals, "setManagedOpenClawEnv").mockImplementation(() => {
      order.push("env");
    });
    const refresh = vi
      .spyOn(internals, "refreshGatewayAfterRuntimeConfig")
      .mockImplementation(async () => {
        order.push("gateway");
        return readyOutcome();
      });
    return { service, order, write, env, refresh };
  };

  const invocationIdShow = (serialized: string): Partial<ExecResult> | undefined =>
    serialized === "systemctl show -p InvocationID --value sovereign-openclaw-gateway.service"
      ? { stdout: "4b6f1e0c2a9d4f1b8e3c7a5d6f0e1b2c\n" }
      : undefined;

  it("does not touch the OpenClaw runtime without the flag", async () => {
    const { service, write, env, refresh } = makeService();

    const result = await service.reconcileAgentWorkspaces();

    expect(write).not.toHaveBeenCalled();
    expect(env).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(result).toEqual({
      reconciled: [],
      systemdUnits: { applied: [] },
      templateTransitions: [],
      releaseAuthorization: null,
    });
  });

  it("does not touch the OpenClaw runtime when the flag is false", async () => {
    const { service, write, refresh } = makeService();

    const result = await service.reconcileAgentWorkspaces({ refreshRuntime: false });

    expect(write).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("runtimeRefresh");
  });

  it("renders, sets the env and restarts the gateway in that order with the flag", async () => {
    const { service, order, write, refresh } = makeService(
      (serialized) => invocationIdShow(serialized) ?? {},
    );

    const result = await service.reconcileAgentWorkspaces({ refreshRuntime: true });

    expect(order).toEqual(["render", "env", "gateway"]);
    expect(write.mock.calls[0]?.[0]).toMatchObject({ openclawProfile: { agents: [] } });
    expect(refresh).toHaveBeenCalledWith(expect.anything(), { preferInstalledSystemUnit: true });
    expect(result.runtimeRefresh).toEqual({
      rendered: true,
      restarted: true,
      ready: true,
      waitedMs: 4_321,
      invocationId: "4b6f1e0c2a9d4f1b8e3c7a5d6f0e1b2c",
    });
  });

  it("reads the invocation id of a user-level gateway unit from the user manager", async () => {
    const { service, refresh } = makeService((serialized) =>
      serialized === "systemctl --user show -p InvocationID --value openclaw-gateway.service"
        ? { stdout: "user-invocation\n" }
        : {},
    );
    refresh.mockResolvedValue(readyOutcome({ unit: "openclaw-gateway.service" }));

    const result = await service.reconcileAgentWorkspaces({ refreshRuntime: true });

    expect(result.runtimeRefresh?.invocationId).toBe("user-invocation");
  });

  it.each([
    ["the gateway reports no unit", undefined, () => ({})],
    ["systemctl cannot be run", "sovereign-openclaw-gateway.service", () => "throw" as const],
    ["systemctl show fails", "sovereign-openclaw-gateway.service", () => ({ exitCode: 1 })],
    [
      "the unit has no invocation id",
      "sovereign-openclaw-gateway.service",
      () => ({ stdout: "\n" }),
    ],
  ])("reports a null invocation id when %s", async (_label, unit, respond) => {
    const { service, refresh } = makeService(respond);
    const { unit: _systemUnit, ...withoutUnit } = readyOutcome();
    refresh.mockResolvedValue(unit === undefined ? withoutUnit : readyOutcome({ unit }));

    const result = await service.reconcileAgentWorkspaces({ refreshRuntime: true });

    expect(result.runtimeRefresh).toMatchObject({ ready: true, invocationId: null });
  });

  it("fails with GATEWAY_REFRESH_FAILED when the gateway does not become ready", async () => {
    const { service, refresh } = makeService();
    refresh.mockResolvedValue(
      readyOutcome({ ready: false, waitedMs: 300_000, lastProbe: "ECONNREFUSED" }),
    );

    await expect(service.reconcileAgentWorkspaces({ refreshRuntime: true })).rejects.toMatchObject({
      code: "GATEWAY_REFRESH_FAILED",
      retryable: true,
      message: expect.stringContaining("not listening after 300 s"),
      details: {
        step: "openclaw-runtime",
        gateway: { unitStarted: true, ready: false, waitedMs: 300_000 },
      },
    });
  });

  it("fails with GATEWAY_REFRESH_FAILED when the gateway restart throws", async () => {
    const { service, refresh } = makeService();
    refresh.mockRejectedValue({
      code: "OPENCLAW_GATEWAY_RESTART_FAILED",
      message: "OpenClaw gateway unit failed to start",
      retryable: true,
    });

    await expect(service.reconcileAgentWorkspaces({ refreshRuntime: true })).rejects.toMatchObject({
      code: "GATEWAY_REFRESH_FAILED",
      message: expect.stringContaining("OpenClaw gateway unit failed to start"),
      details: {
        step: "openclaw-runtime",
        cause: { code: "OPENCLAW_GATEWAY_RESTART_FAILED" },
      },
    });
  });

  it("fails with GATEWAY_REFRESH_FAILED and never restarts when the render throws", async () => {
    const { service, write, refresh } = makeService();
    write.mockRejectedValue(new Error("EACCES: openclaw.json5"));

    await expect(service.reconcileAgentWorkspaces({ refreshRuntime: true })).rejects.toMatchObject({
      code: "GATEWAY_REFRESH_FAILED",
      message: expect.stringContaining("EACCES: openclaw.json5"),
      details: { step: "openclaw-runtime", cause: { message: "EACCES: openclaw.json5" } },
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("reports nothing to refresh on a host without a core config", async () => {
    await rm(paths.configPath);
    const { service, write, refresh } = makeService();

    const result = await service.reconcileAgentWorkspaces({ refreshRuntime: true });

    expect(result.runtimeRefresh).toBeNull();
    expect(write).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("keeps the no-config result unchanged without the flag", async () => {
    await rm(paths.configPath);
    const { service } = makeService();

    expect(await service.reconcileAgentWorkspaces()).not.toHaveProperty("runtimeRefresh");
  });
});
