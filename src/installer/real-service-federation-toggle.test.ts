import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SovereignPaths } from "../config/paths.js";
import type { InstallRequest } from "../contracts/index.js";
import { createLogger } from "../logging/logger.js";
import type { OpenClawBootstrapper } from "../openclaw/bootstrap.js";
import type { ExecInput, ExecResult } from "../system/exec.js";
import type { ImapTester } from "../system/imap.js";
import { DockerComposeBundledMatrixProvisioner } from "../system/matrix.js";
import type { HostPreflightChecker } from "../system/preflight.js";
import type { GatewayReadinessOutcome } from "./gateway-readiness.js";
import { RealInstallerService } from "./real-service.js";
import type { RuntimeConfig } from "./real-service-shared.js";

// One-shot write failure, armed per test: the first write whose path matches
// fails, later writes (the rollback restoring that same file) go through.
const injected = vi.hoisted(() => ({ failWriteOnce: null as ((path: string) => boolean) | null }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const writeFile: typeof actual.writeFile = async (file, data, options) => {
    const predicate = injected.failWriteOnce;
    if (predicate?.(String(file))) {
      injected.failWriteOnce = null;
      throw Object.assign(new Error(`EIO: injected write failure, write '${String(file)}'`), {
        code: "EIO",
      });
    }
    return actual.writeFile(file, data, options);
  };
  return { ...actual, writeFile };
});

type Internals = {
  writeOpenClawRuntimeArtifacts(config: RuntimeConfig): Promise<void>;
  setManagedOpenClawEnv(config: RuntimeConfig): void;
  refreshGatewayAfterRuntimeConfig(config: RuntimeConfig): Promise<GatewayReadinessOutcome>;
};

const DOMAIN = "matrix.example.org";
const RESTART = "restart synapse";
const RECREATE = "up -d --no-deps --force-recreate reverse-proxy";

const buildRequest = (): InstallRequest => ({
  mode: "bundled_matrix",
  openclaw: {
    manageInstallation: true,
    installMethod: "install_sh",
    version: "pinned-by-sovereign",
    skipIfCompatibleInstalled: true,
    forceReinstall: false,
    runOnboard: false,
  },
  openrouter: { model: "qwen/qwen-2.5-7b-instruct", secretRef: "file:/tmp/openrouter" },
  imap: {
    host: "imap.example.org",
    port: 993,
    tls: true,
    username: "operator@example.org",
    secretRef: "file:/tmp/imap-secret",
    mailbox: "INBOX",
  },
  matrix: {
    homeserverDomain: DOMAIN,
    publicBaseUrl: `https://${DOMAIN}`,
    federationEnabled: false,
    tlsMode: "auto",
    alertRoomName: "Sovereign Alerts",
  },
  operator: { username: "operator" },
  advanced: { nonInteractive: true },
});

const snapshotTree = async (dir: string): Promise<Record<string, string>> => {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      files[relative(dir, path)] = await readFile(path, "utf8");
    }
  }
  return files;
};

describe("reconfigureMatrix federation toggle", () => {
  let tempRoot: string;
  let paths: SovereignPaths;
  let requestPath: string;
  let projectDir: string;
  let compose: string[];
  let exitCodeFor: (args: string) => number;
  let order: string[];
  let priorRequestFile: string | undefined;

  beforeEach(async () => {
    priorRequestFile = process.env.SOVEREIGN_NODE_REQUEST_FILE;
    delete process.env.SOVEREIGN_NODE_REQUEST_FILE;
    tempRoot = await mkdtemp(join(tmpdir(), "reconfigure-federation-test-"));
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
    requestPath = join(tempRoot, "etc", "install-request.json");
    compose = [];
    exitCodeFor = () => 0;
    order = [];

    projectDir = (
      await new DockerComposeBundledMatrixProvisioner(
        { run: async () => ({ command: "", exitCode: 0, stdout: "", stderr: "" }) },
        createLogger(),
        paths,
        undefined,
        () => ["10.20.30.40"],
        () => "direct",
      ).provision(buildRequest())
    ).projectDir;

    await mkdir(join(tempRoot, "etc"), { recursive: true });
    // Deliberately not in the installer's own JSON layout, so a restore that
    // re-serialises instead of putting the original bytes back is caught.
    await writeFile(
      paths.configPath,
      `${JSON.stringify({
        matrix: {
          publicBaseUrl: `https://${DOMAIN}`,
          adminBaseUrl: "http://127.0.0.1:8008",
          homeserverDomain: DOMAIN,
          accessMode: "direct",
          federationEnabled: false,
          projectDir,
          operator: { userId: `@operator:${DOMAIN}` },
          bot: {
            localpart: "sovereign-bot",
            userId: `@sovereign-bot:${DOMAIN}`,
            accessTokenSecretRef: "file:/tmp/token",
          },
          alertRoom: { roomId: `!alerts:${DOMAIN}` },
        },
        openclawProfile: { agents: [] },
      })}\n`,
      "utf8",
    );
    await writeFile(requestPath, `${JSON.stringify(buildRequest())}\n`, "utf8");
  });

  afterEach(async () => {
    injected.failWriteOnce = null;
    vi.restoreAllMocks();
    if (priorRequestFile === undefined) {
      delete process.env.SOVEREIGN_NODE_REQUEST_FILE;
    } else {
      process.env.SOVEREIGN_NODE_REQUEST_FILE = priorRequestFile;
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  const makeService = () => {
    const execRunner = {
      run: async (input: ExecInput): Promise<ExecResult> => {
        const command = [input.command, ...(input.args ?? [])].join(" ");
        if (input.command !== "docker") {
          return { command, exitCode: 127, stdout: "", stderr: "command not found" };
        }
        const args = (input.args ?? []).slice(5).join(" ");
        compose.push(args);
        order.push(args);
        return { command, exitCode: exitCodeFor(args), stdout: "", stderr: "compose said no" };
      },
    };
    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {} as unknown as OpenClawBootstrapper,
      openclawGatewayServiceManager: {
        install: async () => {},
        start: async () => {},
        restart: async () => {},
      },
      preflightChecker: {} as unknown as HostPreflightChecker,
      imapTester: {} as unknown as ImapTester,
      matrixProvisioner: new DockerComposeBundledMatrixProvisioner(
        execRunner,
        createLogger(),
        paths,
        undefined,
        () => ["10.20.30.40"],
        () => "direct",
      ),
    });
    const internals = service as unknown as Internals;
    const render = vi
      .spyOn(internals, "writeOpenClawRuntimeArtifacts")
      .mockImplementation(async (config) => {
        order.push(`render federation=${String(config.matrix.federationEnabled)}`);
      });
    const env = vi.spyOn(internals, "setManagedOpenClawEnv").mockImplementation((config) => {
      order.push(`env federation=${String(config.matrix.federationEnabled)}`);
    });
    const refresh = vi
      .spyOn(internals, "refreshGatewayAfterRuntimeConfig")
      .mockImplementation(async () => {
        order.push("gateway");
        return { unitStarted: true, ready: true, waitedMs: 0, deadlineMs: 1 };
      });
    return { service, render, env, refresh };
  };

  const snapshotState = async () => ({
    config: await readFile(paths.configPath, "utf8"),
    request: await readFile(requestPath, "utf8"),
    project: await snapshotTree(projectDir),
  });

  const federationOf = async (path: string): Promise<unknown> =>
    (JSON.parse(await readFile(path, "utf8")) as { matrix: { federationEnabled: unknown } }).matrix
      .federationEnabled;

  it("switches Synapse, the edge, the runtime config and the install request together", async () => {
    const before = await snapshotState();
    const { service } = makeService();

    const result = await service.reconfigureMatrix({ matrix: { federationEnabled: true } });

    expect(result.changed).toEqual([
      "matrix.federationEnabled",
      "request.matrix.federationEnabled",
    ]);
    expect(await federationOf(paths.configPath)).toBe(true);
    expect(await federationOf(requestPath)).toBe(true);
    const project = await snapshotTree(projectDir);
    expect(project["synapse/homeserver.yaml"]).not.toContain("federation_domain_whitelist");
    expect(project["reverse-proxy/Caddyfile"]).not.toBe(before.project["reverse-proxy/Caddyfile"]);
    expect(order).toEqual([
      RESTART,
      RECREATE,
      "render federation=true",
      "env federation=true",
      "gateway",
    ]);
    expect(result.restartRequiredServices).toEqual(["openclaw-gateway", "synapse"]);
  });

  type FailureCase = {
    step: string;
    arm: (ctx: { render: ReturnType<typeof makeService>["render"] }) => void;
    code: string;
    composeAfter: string[];
    retryable: boolean;
    gatewayRestarted: boolean;
  };

  const failOnce = (match: string) => {
    let seen = 0;
    return (args: string) => (args === match && ++seen === 1 ? 1 : 0);
  };

  const cases: FailureCase[] = [
    {
      step: "the homeserver.yaml rewrite",
      arm: () => {
        injected.failWriteOnce = (path) => path === join(projectDir, "synapse", "homeserver.yaml");
      },
      code: "MATRIX_FEDERATION_UPDATE_FAILED",
      composeAfter: [],
      retryable: false,
      gatewayRestarted: false,
    },
    {
      step: "the Caddyfile rewrite",
      arm: () => {
        injected.failWriteOnce = (path) => path === join(projectDir, "reverse-proxy", "Caddyfile");
      },
      code: "MATRIX_FEDERATION_UPDATE_FAILED",
      composeAfter: [],
      retryable: false,
      gatewayRestarted: false,
    },
    {
      step: "the Synapse restart",
      arm: () => {
        exitCodeFor = failOnce(RESTART);
      },
      code: "MATRIX_SYNAPSE_RESTART_FAILED",
      composeAfter: [RESTART, RESTART],
      retryable: true,
      gatewayRestarted: true,
    },
    {
      step: "the reverse-proxy recreate",
      arm: () => {
        exitCodeFor = failOnce(RECREATE);
      },
      code: "MATRIX_EDGE_RELOAD_FAILED",
      composeAfter: [RESTART, RECREATE, RESTART, RECREATE],
      retryable: true,
      gatewayRestarted: true,
    },
    {
      step: "the runtime config write",
      arm: () => {
        injected.failWriteOnce = (path) => path.startsWith(`${paths.configPath}.`);
      },
      code: "MATRIX_RECONFIGURE_FAILED",
      composeAfter: [RESTART, RECREATE, RESTART, RECREATE],
      retryable: false,
      gatewayRestarted: true,
    },
    {
      step: "the install request write",
      arm: () => {
        injected.failWriteOnce = (path) => path.startsWith(`${requestPath}.`);
      },
      code: "REQUEST_UPDATE_FAILED",
      composeAfter: [RESTART, RECREATE, RESTART, RECREATE],
      retryable: false,
      gatewayRestarted: true,
    },
    {
      step: "the OpenClaw runtime render",
      arm: ({ render }) => {
        render.mockImplementationOnce(async () => {
          throw { code: "OPENCLAW_RENDER_FAILED", message: "render broke", retryable: true };
        });
      },
      code: "OPENCLAW_RENDER_FAILED",
      composeAfter: [RESTART, RECREATE, RESTART, RECREATE],
      retryable: true,
      gatewayRestarted: true,
    },
  ];

  it.each(cases)("restores the original state when $step fails", async (failure) => {
    const before = await snapshotState();
    const { service, render, refresh } = makeService();
    failure.arm({ render });

    await expect(
      service.reconfigureMatrix({ matrix: { federationEnabled: true } }),
    ).rejects.toMatchObject({
      code: failure.code,
      retryable: failure.retryable,
      details: { rollback: { complete: true, failures: [] } },
    });

    expect(await snapshotState()).toEqual(before);
    expect(compose).toEqual(failure.composeAfter);
    // Only a restarted Synapse needs the gateway restarted, on the old runtime.
    expect(refresh.mock.calls.map(([config]) => config.matrix.federationEnabled)).toEqual(
      failure.gatewayRestarted ? [false] : [],
    );
  });

  it("is not retryable when the gateway cannot be restarted during the rollback", async () => {
    const before = await snapshotState();
    const { service, refresh } = makeService();
    exitCodeFor = failOnce(RECREATE);
    refresh.mockRejectedValueOnce(new Error("gateway unit failed"));

    await expect(
      service.reconfigureMatrix({ matrix: { federationEnabled: true } }),
    ).rejects.toMatchObject({
      code: "MATRIX_EDGE_RELOAD_FAILED",
      retryable: false,
      details: {
        rollback: {
          complete: false,
          failures: [{ step: "OpenClaw gateway restart", error: "gateway unit failed" }],
        },
      },
    });
    expect(await snapshotState()).toEqual(before);
  });

  it("re-renders the OpenClaw runtime from the previous config when its render fails", async () => {
    const { service, render } = makeService();
    render.mockImplementationOnce(async () => {
      order.push("render federation=true");
      throw new Error("disk full");
    });

    await expect(
      service.reconfigureMatrix({ matrix: { federationEnabled: true } }),
    ).rejects.toMatchObject({ code: "MATRIX_RECONFIGURE_FAILED", retryable: false });

    expect(order.filter((entry) => !entry.includes("synapse") && !entry.includes("proxy"))).toEqual(
      ["render federation=true", "render federation=false", "env federation=false", "gateway"],
    );
  });

  it("is not retryable when the Matrix side cannot be rolled back", async () => {
    const before = await snapshotState();
    const { service, render } = makeService();
    render.mockImplementationOnce(async () => {
      throw { code: "OPENCLAW_RENDER_FAILED", message: "render broke", retryable: true };
    });
    let restarts = 0;
    exitCodeFor = (args) => (args === RESTART && ++restarts === 2 ? 1 : 0);

    await expect(
      service.reconfigureMatrix({ matrix: { federationEnabled: true } }),
    ).rejects.toMatchObject({
      code: "OPENCLAW_RENDER_FAILED",
      retryable: false,
      details: {
        rollback: {
          complete: false,
          failures: [
            {
              step: "bundled Matrix federation settings",
              error: expect.stringContaining("restart synapse"),
            },
          ],
        },
      },
    });
    // Files are restored even though Synapse did not come back on them.
    expect(await snapshotState()).toEqual(before);
  });

  it("refuses a runtime config that changed shape after it was read, before touching anything", async () => {
    const { service, render } = makeService();
    const internals = service as unknown as { readRuntimeConfig(): Promise<RuntimeConfig> };
    const current = await internals.readRuntimeConfig();
    vi.spyOn(internals, "readRuntimeConfig").mockResolvedValue(current);
    await writeFile(paths.configPath, "not a config\n", "utf8");
    const before = await snapshotState();

    await expect(
      service.reconfigureMatrix({ matrix: { federationEnabled: true } }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID", retryable: false });

    expect(await snapshotState()).toEqual(before);
    expect(compose).toEqual([]);
    expect(render).not.toHaveBeenCalled();
  });

  it("adds a matrix section to a runtime config that lost it after it was read", async () => {
    const { service } = makeService();
    const internals = service as unknown as { readRuntimeConfig(): Promise<RuntimeConfig> };
    const current = await internals.readRuntimeConfig();
    vi.spyOn(internals, "readRuntimeConfig").mockResolvedValue(current);
    await writeFile(paths.configPath, "{}\n", "utf8");

    await service.reconfigureMatrix({ matrix: { federationEnabled: true } });

    expect(await federationOf(paths.configPath)).toBe(true);
  });

  it("leaves everything unchanged and reports no rollback when the switch is a no-op", async () => {
    const before = await snapshotState();
    const { service, render } = makeService();

    const result = await service.reconfigureMatrix({ matrix: { federationEnabled: false } });

    expect(result.changed).toEqual([]);
    expect(render).not.toHaveBeenCalled();
    expect(compose).toEqual([]);
    expect(await snapshotState()).toEqual(before);
  });
});
