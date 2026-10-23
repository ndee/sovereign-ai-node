import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SovereignPaths } from "../config/paths.js";
import { createLogger } from "../logging/logger.js";
import type { OpenClawBootstrapper, OpenClawInstallInfo } from "../openclaw/bootstrap.js";
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

const runningAsRoot = process.getuid?.() === 0;

type GatewayFallbackHandle = {
  gatewayReadinessClock: { now: () => number; sleep: (ms: number) => Promise<void> };
  ensureSystemGatewayServiceFallback(config: RuntimeConfig): Promise<GatewayReadinessOutcome>;
};
type InstallStepsHandle = {
  buildInstallSteps(req: unknown): Array<{ id: string; run: () => Promise<void> }>;
};

describe("OpenClaw temp dir across gateway restarts", () => {
  let tempRoot: string;
  let paths: SovereignPaths;
  let tempDir: string;
  let priorUnitPath: string | undefined;
  let priorDeadline: string | undefined;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-openclaw-tmp-"));
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
    tempDir = join(paths.openclawServiceHome, "tmp");
    priorUnitPath = process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH;
    process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH = join(tempRoot, "gateway.service");
    priorDeadline = process.env[GATEWAY_READY_TIMEOUT_ENV];
    delete process.env[GATEWAY_READY_TIMEOUT_ENV];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (priorUnitPath === undefined) {
      delete process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH;
    } else {
      process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH = priorUnitPath;
    }
    if (priorDeadline === undefined) {
      delete process.env[GATEWAY_READY_TIMEOUT_ENV];
    } else {
      process.env[GATEWAY_READY_TIMEOUT_ENV] = priorDeadline;
    }
    await chmod(tempDir, 0o700).catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  });

  const makeService = (installInfo?: OpenClawInstallInfo) =>
    new RealInstallerService(createLogger(), paths, {
      execRunner: {
        run: async ({ command, args }: ExecInput): Promise<ExecResult> => ({
          command: [command, ...(args ?? [])].join(" "),
          exitCode: 0,
          stdout: "",
          stderr: "",
        }),
      },
      // Any HTTP answer means the gateway listens, so the readiness wait after
      // the restart returns on its first probe instead of polling a real port.
      fetchImpl: async () => new Response("not found", { status: 404 }),
      ...(installInfo === undefined
        ? {}
        : {
            openclawBootstrapper: {
              detectInstalled: async () => null,
              ensureInstalled: async () => installInfo,
            } as OpenClawBootstrapper,
          }),
    } as unknown as ConstructorParameters<typeof RealInstallerService>[2]);

  const runtimeConfig = (): RuntimeConfig =>
    ({
      matrix: { adminBaseUrl: "https://matrix.example.org" },
      openclaw: {
        serviceUser: "sovereign-node",
        serviceGroup: "sovereign-node",
        gatewayEnvPath: join(paths.openclawServiceHome, "gateway.env"),
      },
    }) as unknown as RuntimeConfig;

  const restartGateway = async (): Promise<void> => {
    const service = makeService() as unknown as GatewayFallbackHandle;
    let clock = 0;
    service.gatewayReadinessClock = {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    };
    const outcome = await service.ensureSystemGatewayServiceFallback(runtimeConfig());
    expect(outcome).toMatchObject({ unitStarted: true, ready: true });
  };

  const seedCaches = async (): Promise<void> => {
    await mkdir(join(tempDir, "jiti"), { recursive: true });
    await writeFile(join(tempDir, "jiti", "plugin-matrix.cjs"), "transpiled");
    await mkdir(join(tempDir, "node-compile-cache"), { recursive: true });
    await writeFile(join(tempDir, "node-compile-cache", "chunk"), "v8");
  };

  it("keeps the service user's caches and keeps TMPDIR pointing at them", async () => {
    await seedCaches();

    await restartGateway();

    expect((await readdir(tempDir)).sort()).toEqual(["jiti", "node-compile-cache"]);
    expect(await readdir(join(tempDir, "jiti"))).toEqual(["plugin-matrix.cjs"]);
    const unit = await readFile(join(tempRoot, "gateway.service"), "utf8");
    expect(unit).toContain(`Environment=TMPDIR=${tempDir}\n`);
  });

  it("removes entries owned by a uid other than the service user's", async () => {
    await seedCaches();
    // The process uid stands in for the service account; the seeded files
    // belong to the real test uid, so they read as left behind by another user.
    vi.spyOn(process as { getuid: () => number }, "getuid").mockReturnValue(4242);

    await restartGateway();

    expect(await readdir(tempDir)).toEqual([]);
  });

  it.skipIf(runningAsRoot)("still restarts when the temp dir cannot be read", async () => {
    await seedCaches();
    await chmod(tempDir, 0o000);

    await restartGateway();

    expect((await readdir(tempDir)).sort()).toEqual(["jiti", "node-compile-cache"]);
  });

  const runBootstrapStep = async (installInfo: OpenClawInstallInfo): Promise<void> => {
    const steps = (makeService(installInfo) as unknown as InstallStepsHandle).buildInstallSteps({
      openclaw: { manageInstallation: true },
    });
    const step = steps.find((candidate) => candidate.id === "openclaw_bootstrap_cli");
    await step?.run();
  };

  const installInfo = (reinstalled?: boolean): OpenClawInstallInfo => ({
    binaryPath: "/usr/bin/openclaw",
    version: "2026.3.13",
    installMethod: "install_sh",
    ...(reinstalled === undefined ? {} : { reinstalled }),
  });

  it("clears the caches once when OpenClaw was (re)installed", async () => {
    await seedCaches();
    await writeFile(join(tempDir, "unrelated"), "x");

    await runBootstrapStep(installInfo(true));

    expect(await readdir(tempDir)).toEqual(["unrelated"]);
  });

  it("keeps the caches when the installed OpenClaw was kept", async () => {
    await seedCaches();

    await runBootstrapStep(installInfo(false));
    await runBootstrapStep(installInfo());

    expect((await readdir(tempDir)).sort()).toEqual(["jiti", "node-compile-cache"]);
  });

  it.skipIf(runningAsRoot)(
    "does not fail the install when the caches cannot be cleared",
    async () => {
      await seedCaches();
      await chmod(tempDir, 0o500);

      await expect(runBootstrapStep(installInfo(true))).resolves.toBeUndefined();

      await chmod(tempDir, 0o700);
      expect((await readdir(tempDir)).sort()).toEqual(["jiti", "node-compile-cache"]);
    },
  );
});
