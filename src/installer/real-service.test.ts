import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import type { InstallRequest } from "../contracts/index.js";
import { createLogger } from "../logging/logger.js";
import type { SovereignPaths } from "../config/paths.js";
import type {
  OpenClawBootstrapper,
  OpenClawInstallInfo,
  OpenClawInstallOptions,
} from "../openclaw/bootstrap.js";
import type { ImapTester } from "../system/imap.js";
import type {
  BundledMatrixProvisioner,
  BundledMatrixProvisionResult,
} from "../system/matrix.js";
import type { HostPreflightChecker } from "../system/preflight.js";
import type { ExecResult } from "../system/exec.js";
import { RealInstallerService } from "./real-service.js";

const buildInstallRequest = (): InstallRequest => ({
  mode: "bundled_matrix",
  openclaw: {
    manageInstallation: true,
    installMethod: "install_sh",
    version: "pinned-by-sovereign",
    skipIfCompatibleInstalled: true,
    forceReinstall: false,
    runOnboard: false,
  },
  openrouter: {
    model: "openrouter/anthropic/claude-sonnet-4-5",
    apiKey: "sk-or-test",
  },
  imap: {
    host: "imap.example.org",
    port: 993,
    tls: true,
    username: "operator@example.org",
    secretRef: "file:/tmp/imap-secret",
    mailbox: "INBOX",
  },
  matrix: {
    homeserverDomain: "matrix.example.org",
    publicBaseUrl: "https://matrix.example.org",
    federationEnabled: false,
    tlsMode: "local-dev",
    alertRoomName: "Sovereign Alerts",
  },
  operator: {
    username: "operator",
  },
  mailSentinel: {
    pollInterval: "5m",
    lookbackWindow: "15m",
    e2eeAlertRoom: false,
  },
  advanced: {
    nonInteractive: true,
  },
});

const writeRuntimeArtifacts = async (paths: SovereignPaths): Promise<void> => {
  const runtimeConfigPath = join(paths.openclawServiceHome, ".openclaw", "openclaw.json5");
  const runtimeProfilePath = join(
    paths.openclawServiceHome,
    "profiles",
    "sovereign-runtime-profile.json5",
  );
  const gatewayEnvPath = join(paths.openclawServiceHome, "gateway.env");
  const matrixBotTokenPath = join(paths.secretsDir, "matrix-bot-access-token");

  await mkdir(dirname(paths.configPath), { recursive: true });
  await mkdir(paths.secretsDir, { recursive: true });
  await mkdir(dirname(runtimeConfigPath), { recursive: true });
  await mkdir(dirname(runtimeProfilePath), { recursive: true });
  await mkdir(join(paths.stateDir, "mail-sentinel"), { recursive: true });

  await writeFile(matrixBotTokenPath, "bot-token\n", "utf8");
  await writeFile(
    paths.configPath,
    `${JSON.stringify(
      {
        contractVersion: "1.0.0",
        mode: "bundled_matrix",
        openclaw: {
          managedInstallation: true,
          installMethod: "install_sh",
          requestedVersion: "0.2.0",
          serviceHome: paths.openclawServiceHome,
          openclawHome: join(paths.openclawServiceHome, ".openclaw"),
          runtimeConfigPath,
          runtimeProfilePath,
          gatewayEnvPath,
        },
        openrouter: {
          model: "openrouter/anthropic/claude-sonnet-4-5",
          apiKeySecretRef: "env:OPENROUTER_API_KEY",
        },
        openclawProfile: {
          plugins: {
            allow: ["matrix", "imap-readonly"],
          },
          agents: [
            {
              id: "mail-sentinel",
              workspace: join(paths.stateDir, "mail-sentinel", "workspace"),
            },
          ],
          cron: {
            id: "mail-sentinel-poll",
            every: "5m",
          },
        },
        imap: {
          host: "imap.example.org",
          mailbox: "INBOX",
          secretRef: "file:/tmp/imap-secret",
        },
        matrix: {
          publicBaseUrl: "https://matrix.example.org",
          federationEnabled: false,
          operator: {
            userId: "@operator:matrix.example.org",
          },
          bot: {
            userId: "@mail-sentinel:matrix.example.org",
            accessTokenSecretRef: `file:${matrixBotTokenPath}`,
          },
          alertRoom: {
            roomId: "!alerts:matrix.example.org",
            roomName: "Sovereign Alerts",
          },
        },
        mailSentinel: {
          pollInterval: "5m",
          lookbackWindow: "15m",
          e2eeAlertRoom: false,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(runtimeConfigPath, "{\n  \"source\": \"test\"\n}\n", "utf8");
  await writeFile(runtimeProfilePath, "{\n  \"source\": \"test\"\n}\n", "utf8");
  await writeFile(
    gatewayEnvPath,
    [
      `OPENCLAW_HOME=${join(paths.openclawServiceHome, ".openclaw")}`,
      `OPENCLAW_CONFIG=${runtimeConfigPath}`,
      `OPENCLAW_CONFIG_PATH=${runtimeConfigPath}`,
      `SOVEREIGN_NODE_CONFIG=${paths.configPath}`,
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(paths.stateDir, "mail-sentinel", "registration.json"),
    `${JSON.stringify(
      {
        agentId: "mail-sentinel",
        cronJobId: "mail-sentinel-poll",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
};

describe("RealInstallerService", () => {
  it("persists install job snapshots and serves them via getInstallJob", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
    };
    const ensureInstalledCalls: OpenClawInstallOptions[] = [];
    let preflightCalls = 0;
    let imapTestCalls = 0;
    let matrixProvisionCalls = 0;
    const fakeBootstrapper: OpenClawBootstrapper = {
      detectInstalled: async () => null,
      ensureInstalled: async (opts): Promise<OpenClawInstallInfo> => {
        ensureInstalledCalls.push(opts);
        return {
          binaryPath: "/usr/local/bin/openclaw",
          version: opts.version,
          installMethod: "install_sh",
        };
      },
    };
    const fakePreflightChecker: HostPreflightChecker = {
      run: async () => {
        preflightCalls += 1;
        return {
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        };
      },
    };
    const fakeImapTester: ImapTester = {
      test: async (req) => {
        imapTestCalls += 1;
        return {
          ok: false,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "failed",
          mailbox: req.imap.mailbox ?? "INBOX",
          error: {
            code: "IMAP_AUTH_FAILED",
            message: "Fake IMAP auth failure for installer-service unit test",
            retryable: false,
          },
        };
      },
    };
    const fakeMatrixProvisioner: BundledMatrixProvisioner = {
      provision: async (): Promise<BundledMatrixProvisionResult> => {
        matrixProvisionCalls += 1;
        return {
          projectDir: "/tmp/fake-matrix",
          composeFilePath: "/tmp/fake-matrix/compose.yaml",
          homeserverDomain: "matrix.example.org",
          publicBaseUrl: "https://matrix.example.org",
          adminBaseUrl: "http://127.0.0.1:8008",
          federationEnabled: false,
          tlsMode: "local-dev",
        };
      },
      bootstrapAccounts: async () => {
        throw new Error("unexpected bootstrapAccounts call");
      },
      bootstrapRoom: async () => {
        throw new Error("unexpected bootstrapRoom call");
      },
      test: async (req) => ({
        ok: false,
        homeserverUrl: req.publicBaseUrl,
        checks: [],
      }),
    };
    let gatewayInstallCalls = 0;
    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: fakeBootstrapper,
      openclawGatewayServiceManager: {
        install: async () => {
          gatewayInstallCalls += 1;
        },
        start: async () => {},
        restart: async () => {},
      },
      mailSentinelRegistrar: {
        register: async () => {
          throw new Error("unexpected mail-sentinel register call");
        },
      },
      preflightChecker: fakePreflightChecker,
      imapTester: fakeImapTester,
      matrixProvisioner: fakeMatrixProvisioner,
    });

    try {
      const started = await service.startInstall(buildInstallRequest());

      expect(started.job.state).toBe("failed");
      expect(started.job.steps[0]?.id).toBe("preflight");
      expect(started.job.steps[0]?.state).toBe("succeeded");
      expect(started.job.steps[1]?.id).toBe("openclaw_bootstrap_cli");
      expect(started.job.steps[1]?.state).toBe("succeeded");
      expect(started.job.steps[2]?.id).toBe("imap_validate");
      expect(started.job.steps[2]?.state).toBe("failed");

      const stored = await service.getInstallJob(started.job.jobId);
      expect(stored.job.jobId).toBe(started.job.jobId);
      expect(stored.job.state).toBe("failed");
      expect(stored.error?.code).toBe("IMAP_TEST_FAILED");

      const files = await readdir(paths.installJobsDir);
      expect(files.some((name) => name.includes(started.job.jobId))).toBe(true);
      expect(preflightCalls).toBe(1);
      expect(ensureInstalledCalls).toHaveLength(1);
      expect(imapTestCalls).toBe(1);
      expect(matrixProvisionCalls).toBe(0);
      expect(gatewayInstallCalls).toBe(0);
      expect(ensureInstalledCalls[0]).toMatchObject({
        version: "pinned-by-sovereign",
        noOnboard: true,
        noPrompt: true,
        forceReinstall: false,
        skipIfCompatibleInstalled: true,
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("runs through mail_sentinel_register and fails at smoke_checks when matrix probe fails", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
    };

    let matrixProvisionCalls = 0;
    let matrixBootstrapAccountCalls = 0;
    let matrixBootstrapRoomCalls = 0;
    let gatewayInstallCalls = 0;
    let gatewayInstallForceArg: boolean | undefined;
    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
        }),
        ensureInstalled: async (opts) => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: opts.version,
          installMethod: "install_sh",
        }),
      },
      openclawGatewayServiceManager: {
        install: async (options) => {
          gatewayInstallCalls += 1;
          gatewayInstallForceArg = options?.force;
        },
        start: async () => {},
        restart: async () => {},
      },
      mailSentinelRegistrar: {
        register: async () => ({
          agentId: "mail-sentinel",
          cronJobId: "mail-sentinel-poll",
          workspaceDir: join(paths.stateDir, "mail-sentinel", "workspace"),
          agentCommand: "openclaw agents upsert --id mail-sentinel",
          cronCommand: "openclaw cron add --name mail-sentinel-poll --every 5m",
        }),
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async (req) => ({
          ok: true,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "ok",
          mailbox: req.imap.mailbox ?? "INBOX",
          capabilities: ["IMAP4rev1"],
        }),
      },
      matrixProvisioner: {
        provision: async (req) => {
          matrixProvisionCalls += 1;
          return {
            projectDir: join(tempRoot, "matrix"),
            composeFilePath: join(tempRoot, "matrix", "compose.yaml"),
            homeserverDomain: req.matrix.homeserverDomain,
            publicBaseUrl: req.matrix.publicBaseUrl,
            adminBaseUrl: "http://127.0.0.1:8008",
            federationEnabled: req.matrix.federationEnabled ?? false,
            tlsMode: "local-dev",
          };
        },
        bootstrapAccounts: async () => {
          matrixBootstrapAccountCalls += 1;
          return {
            operator: {
              localpart: "operator",
              userId: "@operator:matrix.example.org",
              passwordSecretRef: "file:/tmp/operator.password",
              accessToken: "operator-token",
            },
            bot: {
              localpart: "mail-sentinel",
              userId: "@mail-sentinel:matrix.example.org",
              passwordSecretRef: "file:/tmp/mail-sentinel.password",
              accessToken: "bot-token",
            },
          };
        },
        bootstrapRoom: async (req) => {
          matrixBootstrapRoomCalls += 1;
          return {
            roomId: "!alerts:matrix.example.org",
            roomName: req.matrix.alertRoomName ?? "Sovereign Alerts",
          };
        },
        test: async (req) => ({
          ok: false,
          homeserverUrl: req.publicBaseUrl,
          checks: [],
        }),
      },
    });

    try {
      const started = await service.startInstall(buildInstallRequest());

      expect(started.job.state).toBe("failed");
      expect(matrixProvisionCalls).toBe(1);
      expect(matrixBootstrapAccountCalls).toBe(1);
      expect(matrixBootstrapRoomCalls).toBe(1);
      expect(gatewayInstallCalls).toBe(1);
      expect(gatewayInstallForceArg).toBe(false);

      const stepStates = Object.fromEntries(
        started.job.steps.map((step) => [step.id, step.state]),
      );
      expect(stepStates.preflight).toBe("succeeded");
      expect(stepStates.openclaw_bootstrap_cli).toBe("succeeded");
      expect(stepStates.imap_validate).toBe("succeeded");
      expect(stepStates.matrix_provision).toBe("succeeded");
      expect(stepStates.matrix_bootstrap_accounts).toBe("succeeded");
      expect(stepStates.matrix_bootstrap_room).toBe("succeeded");
      expect(stepStates.openclaw_gateway_service_install).toBe("succeeded");
      expect(stepStates.openclaw_configure).toBe("succeeded");
      expect(stepStates.mail_sentinel_register).toBe("succeeded");
      expect(stepStates.smoke_checks).toBe("failed");
      expect(stepStates.test_alert).toBe("pending");

      const stored = await service.getInstallJob(started.job.jobId);
      expect(stored.error?.code).toBe("SMOKE_CHECKS_FAILED");
      expect(stored.job.currentStepId).toBe("smoke_checks");

      const writtenConfigRaw = await readFile(paths.configPath, "utf8");
      const writtenConfig = JSON.parse(writtenConfigRaw) as {
        matrix?: {
          alertRoom?: { roomId?: string };
          bot?: { accessTokenSecretRef?: string };
        };
      };
      expect(writtenConfig.matrix?.alertRoom?.roomId).toBe("!alerts:matrix.example.org");
      expect(writtenConfig.matrix?.bot?.accessTokenSecretRef?.startsWith("file:")).toBe(
        true,
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("completes install flow through test_alert when smoke checks and alert delivery pass", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
    };

    let matrixTestCalls = 0;
    let sentMessageBody = "";
    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
        }),
        ensureInstalled: async (opts) => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: opts.version,
          installMethod: "install_sh",
        }),
      },
      openclawGatewayServiceManager: {
        install: async () => {},
        start: async () => {},
        restart: async () => {},
      },
      mailSentinelRegistrar: {
        register: async () => ({
          agentId: "mail-sentinel",
          cronJobId: "mail-sentinel-poll",
          workspaceDir: join(paths.stateDir, "mail-sentinel", "workspace"),
          agentCommand: "openclaw agents upsert --id mail-sentinel",
          cronCommand: "openclaw cron add --name mail-sentinel-poll --every 5m",
        }),
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async (req) => ({
          ok: true,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "ok",
          mailbox: req.imap.mailbox ?? "INBOX",
          capabilities: ["IMAP4rev1"],
        }),
      },
      matrixProvisioner: {
        provision: async (req) => ({
          projectDir: join(tempRoot, "matrix"),
          composeFilePath: join(tempRoot, "matrix", "compose.yaml"),
          homeserverDomain: req.matrix.homeserverDomain,
          publicBaseUrl: "http://matrix.example.org",
          adminBaseUrl: "http://127.0.0.1:8008",
          federationEnabled: req.matrix.federationEnabled ?? false,
          tlsMode: "local-dev",
        }),
        bootstrapAccounts: async () => ({
          operator: {
            localpart: "operator",
            userId: "@operator:matrix.example.org",
            passwordSecretRef: "file:/tmp/operator.password",
            accessToken: "operator-token",
          },
          bot: {
            localpart: "mail-sentinel",
            userId: "@mail-sentinel:matrix.example.org",
            passwordSecretRef: "file:/tmp/mail-sentinel.password",
            accessToken: "bot-token",
          },
        }),
        bootstrapRoom: async () => ({
          roomId: "!alerts:matrix.example.org",
          roomName: "Sovereign Alerts",
        }),
        test: async (req) => {
          matrixTestCalls += 1;
          return {
            ok: true,
            homeserverUrl: req.publicBaseUrl,
            checks: [],
          };
        },
      },
      fetchImpl: async (url, init) => {
        if (!url.includes("/_matrix/client/v3/rooms/")) {
          return new Response("not found", { status: 404 });
        }
        sentMessageBody = typeof init?.body === "string" ? init.body : "";
        return new Response(JSON.stringify({ event_id: "$evt1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    try {
      const started = await service.startInstall(buildInstallRequest());

      expect(started.job.state).toBe("succeeded");
      expect(matrixTestCalls).toBe(1);

      const stepStates = Object.fromEntries(
        started.job.steps.map((step) => [step.id, step.state]),
      );
      expect(stepStates.preflight).toBe("succeeded");
      expect(stepStates.openclaw_bootstrap_cli).toBe("succeeded");
      expect(stepStates.imap_validate).toBe("succeeded");
      expect(stepStates.matrix_provision).toBe("succeeded");
      expect(stepStates.matrix_bootstrap_accounts).toBe("succeeded");
      expect(stepStates.matrix_bootstrap_room).toBe("succeeded");
      expect(stepStates.openclaw_gateway_service_install).toBe("succeeded");
      expect(stepStates.openclaw_configure).toBe("succeeded");
      expect(stepStates.mail_sentinel_register).toBe("succeeded");
      expect(stepStates.smoke_checks).toBe("succeeded");
      expect(stepStates.test_alert).toBe("succeeded");
      expect(sentMessageBody).toContain("Hello from Mail Sentinel");

      const stored = await service.getInstallJob(started.job.jobId);
      expect(stored.job.state).toBe("succeeded");
      expect(stored.error).toBeUndefined();

      const registrationRaw = await readFile(
        join(paths.stateDir, "mail-sentinel", "registration.json"),
        "utf8",
      );
      const registration = JSON.parse(registrationRaw) as { agentId?: string };
      expect(registration.agentId).toBe("mail-sentinel");

      const openclawConfigRaw = await readFile(
        join(paths.openclawServiceHome, ".openclaw", "openclaw.json5"),
        "utf8",
      );
      const openclawConfig = JSON.parse(openclawConfigRaw) as {
        generatedAt?: string;
        source?: string;
        profileRef?: string;
        matrix?: unknown;
        cron?: { enabled?: boolean; jobs?: unknown };
        agents?: { defaults?: { model?: string } };
        plugins?: { entries?: { matrix?: { enabled?: boolean; config?: unknown } } };
        channels?: { matrix?: { enabled?: boolean; homeserver?: string; userId?: string } };
      };
      expect(openclawConfig.generatedAt).toBeUndefined();
      expect(openclawConfig.source).toBeUndefined();
      expect(openclawConfig.profileRef).toBeUndefined();
      expect(openclawConfig.matrix).toBeUndefined();
      expect(openclawConfig.cron?.enabled).toBe(true);
      expect(openclawConfig.cron?.jobs).toBeUndefined();
      expect(openclawConfig.plugins?.entries?.matrix?.enabled).toBe(true);
      expect(openclawConfig.plugins?.entries?.matrix?.config).toBeUndefined();
      expect(openclawConfig.channels?.matrix?.enabled).toBe(true);
      expect(openclawConfig.channels?.matrix?.homeserver).toBe("http://matrix.example.org");
      expect(openclawConfig.channels?.matrix?.userId).toBe("@mail-sentinel:matrix.example.org");
      expect(openclawConfig.agents?.defaults?.model).toBe(
        "openrouter/anthropic/claude-sonnet-4-5",
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("continues install when gateway user systemd bus is unavailable", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
    };

    let gatewayInstallCalls = 0;
    let gatewayRestartCalls = 0;
    let registrarCalls = 0;
    let sentMessageBody = "";

    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
        }),
        ensureInstalled: async (opts) => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: opts.version,
          installMethod: "install_sh",
        }),
      },
      openclawGatewayServiceManager: {
        install: async () => {
          gatewayInstallCalls += 1;
          throw {
            code: "OPENCLAW_GATEWAY_INSTALL_FAILED",
            message: "OpenClaw gateway command exited with non-zero status",
            retryable: true,
            details: {
              command: "openclaw gateway install",
              stderr:
                "Gateway service check failed: Error: systemctl --user unavailable: Failed to connect to bus: No medium found",
            },
          };
        },
        start: async () => {},
        restart: async () => {
          gatewayRestartCalls += 1;
        },
      },
      mailSentinelRegistrar: {
        register: async () => {
          registrarCalls += 1;
          throw {
            code: "MAIL_SENTINEL_REGISTER_FAILED",
            message: "OpenClaw mail-sentinel-cron registration commands failed",
            retryable: true,
            details: {
              failures: [
                {
                  command:
                    "openclaw cron add --name mail-sentinel-poll --every 5m --session isolated --message hello",
                  exitCode: 1,
                  stderr:
                    "Error: gateway closed (1006 abnormal closure (no close frame)): no close reason\nGateway target: ws://127.0.0.1:18789",
                  stdout: "",
                },
              ],
            },
          };
        },
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async (req) => ({
          ok: true,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "ok",
          mailbox: req.imap.mailbox ?? "INBOX",
          capabilities: ["IMAP4rev1"],
        }),
      },
      matrixProvisioner: {
        provision: async (req) => ({
          projectDir: join(tempRoot, "matrix"),
          composeFilePath: join(tempRoot, "matrix", "compose.yaml"),
          homeserverDomain: req.matrix.homeserverDomain,
          publicBaseUrl: req.matrix.publicBaseUrl,
          adminBaseUrl: "http://127.0.0.1:8008",
          federationEnabled: req.matrix.federationEnabled ?? false,
          tlsMode: "local-dev",
        }),
        bootstrapAccounts: async () => ({
          operator: {
            localpart: "operator",
            userId: "@operator:matrix.example.org",
            passwordSecretRef: "file:/tmp/operator.password",
            accessToken: "operator-token",
          },
          bot: {
            localpart: "mail-sentinel",
            userId: "@mail-sentinel:matrix.example.org",
            passwordSecretRef: "file:/tmp/mail-sentinel.password",
            accessToken: "bot-token",
          },
        }),
        bootstrapRoom: async () => ({
          roomId: "!alerts:matrix.example.org",
          roomName: "Sovereign Alerts",
        }),
        test: async (req) => ({
          ok: true,
          homeserverUrl: req.publicBaseUrl,
          checks: [],
        }),
      },
      fetchImpl: async (url, init) => {
        if (url.includes("/joined_members")) {
          return new Response(JSON.stringify({ joined: {} }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.includes("/send/m.room.message/")) {
          sentMessageBody = typeof init?.body === "string" ? init.body : "";
          return new Response(JSON.stringify({ event_id: "$evt1" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        return new Response("not found", { status: 404 });
      },
    });

    try {
      const started = await service.startInstall(buildInstallRequest());
      expect(started.job.state).toBe("succeeded");
      expect(gatewayInstallCalls).toBe(1);
      expect(gatewayRestartCalls).toBe(0);
      expect(registrarCalls).toBe(1);

      const stepStates = Object.fromEntries(
        started.job.steps.map((step) => [step.id, step.state]),
      );
      expect(stepStates.openclaw_gateway_service_install).toBe("succeeded");
      expect(stepStates.openclaw_configure).toBe("succeeded");
      expect(stepStates.mail_sentinel_register).toBe("succeeded");
      expect(stepStates.smoke_checks).toBe("succeeded");
      expect(stepStates.test_alert).toBe("succeeded");
      expect(sentMessageBody).toContain("Hello from Mail Sentinel");

      const registrationRaw = await readFile(
        join(paths.stateDir, "mail-sentinel", "registration.json"),
        "utf8",
      );
      const registration = JSON.parse(registrationRaw) as {
        deferred?: boolean;
        cronJobId?: string;
      };
      expect(registration.deferred).toBe(true);
      expect(registration.cronJobId).toBe("mail-sentinel-poll");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("starts system-level gateway fallback when user services are unavailable", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const priorGatewayUnitPath = process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH;
    const priorServiceUser = process.env.SOVEREIGN_NODE_SERVICE_USER;
    const priorServiceGroup = process.env.SOVEREIGN_NODE_SERVICE_GROUP;
    process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH = join(
      tempRoot,
      "systemd",
      "sovereign-openclaw-gateway.service",
    );
    process.env.SOVEREIGN_NODE_SERVICE_USER = "sovereign-node";
    process.env.SOVEREIGN_NODE_SERVICE_GROUP = "sovereign-node";
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
    };

    let gatewayInstallCalls = 0;
    let gatewayRestartCalls = 0;
    let registrarCalls = 0;
    const commandCalls: string[] = [];
    let sentMessageBody = "";

    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
        }),
        ensureInstalled: async (opts) => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: opts.version,
          installMethod: "install_sh",
        }),
      },
      openclawGatewayServiceManager: {
        install: async () => {
          gatewayInstallCalls += 1;
          throw {
            code: "OPENCLAW_GATEWAY_INSTALL_FAILED",
            message: "OpenClaw gateway command exited with non-zero status",
            retryable: true,
            details: {
              command: "openclaw gateway install",
              stderr:
                "Gateway service check failed: Error: systemctl --user unavailable: Failed to connect to bus: No medium found",
            },
          };
        },
        start: async () => {},
        restart: async () => {
          gatewayRestartCalls += 1;
        },
      },
      mailSentinelRegistrar: {
        register: async () => {
          registrarCalls += 1;
          return {
            agentId: "mail-sentinel",
            cronJobId: "mail-sentinel-poll",
            workspaceDir: join(paths.stateDir, "mail-sentinel", "workspace"),
            agentCommand: "openclaw agents add mail-sentinel --workspace /tmp/ws",
            cronCommand: "openclaw cron add --name mail-sentinel-poll --every 5m",
          };
        },
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async (req) => ({
          ok: true,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "ok",
          mailbox: req.imap.mailbox ?? "INBOX",
          capabilities: ["IMAP4rev1"],
        }),
      },
      matrixProvisioner: {
        provision: async (req) => ({
          projectDir: join(tempRoot, "matrix"),
          composeFilePath: join(tempRoot, "matrix", "compose.yaml"),
          homeserverDomain: req.matrix.homeserverDomain,
          publicBaseUrl: req.matrix.publicBaseUrl,
          adminBaseUrl: "http://127.0.0.1:8008",
          federationEnabled: req.matrix.federationEnabled ?? false,
          tlsMode: "local-dev",
        }),
        bootstrapAccounts: async () => ({
          operator: {
            localpart: "operator",
            userId: "@operator:matrix.example.org",
            passwordSecretRef: "file:/tmp/operator.password",
            accessToken: "operator-token",
          },
          bot: {
            localpart: "mail-sentinel",
            userId: "@mail-sentinel:matrix.example.org",
            passwordSecretRef: "file:/tmp/mail-sentinel.password",
            accessToken: "bot-token",
          },
        }),
        bootstrapRoom: async () => ({
          roomId: "!alerts:matrix.example.org",
          roomName: "Sovereign Alerts",
        }),
        test: async (req) => ({
          ok: true,
          homeserverUrl: req.publicBaseUrl,
          checks: [],
        }),
      },
      execRunner: {
        run: async (input): Promise<ExecResult> => {
          const serialized = [input.command, ...(input.args ?? [])].join(" ");
          commandCalls.push(serialized);

          if (serialized.startsWith("systemctl ")) {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "active",
              stderr: "",
            };
          }
          if (serialized === "openclaw health") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "ok",
              stderr: "",
            };
          }
          if (serialized === "openclaw gateway status") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "running",
              stderr: "",
            };
          }
          if (serialized === "openclaw agents list") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "mail-sentinel",
              stderr: "",
            };
          }
          if (serialized === "openclaw cron list") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "mail-sentinel-poll",
              stderr: "",
            };
          }
          return {
            command: serialized,
            exitCode: 1,
            stdout: "",
            stderr: "unexpected command",
          };
        },
      },
      fetchImpl: async (url, init) => {
        if (url.includes("/joined_members")) {
          return new Response(JSON.stringify({ joined: {} }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.includes("/send/m.room.message/")) {
          sentMessageBody = typeof init?.body === "string" ? init.body : "";
          return new Response(JSON.stringify({ event_id: "$evt1" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        return new Response("not found", { status: 404 });
      },
    });

    try {
      const started = await service.startInstall(buildInstallRequest());
      expect(started.job.state).toBe("succeeded");
      expect(gatewayInstallCalls).toBe(1);
      expect(gatewayRestartCalls).toBe(0);
      expect(registrarCalls).toBe(1);
      expect(commandCalls.some((command) => command === "systemctl daemon-reload")).toBe(true);
      expect(commandCalls.some((command) => command.includes("enable --now"))).toBe(true);
      expect(commandCalls.some((command) => command.includes("is-active"))).toBe(true);

      const stepStates = Object.fromEntries(
        started.job.steps.map((step) => [step.id, step.state]),
      );
      expect(stepStates.openclaw_gateway_service_install).toBe("succeeded");
      expect(stepStates.openclaw_configure).toBe("succeeded");
      expect(stepStates.mail_sentinel_register).toBe("succeeded");
      expect(stepStates.smoke_checks).toBe("succeeded");
      expect(stepStates.test_alert).toBe("succeeded");
      expect(sentMessageBody).toContain("Hello from Mail Sentinel");

      const unitRaw = await readFile(
        process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH!,
        "utf8",
      );
      expect(unitRaw).toContain("User=sovereign-node");
      expect(unitRaw).toContain("Group=sovereign-node");

      const registrationRaw = await readFile(
        join(paths.stateDir, "mail-sentinel", "registration.json"),
        "utf8",
      );
      const registration = JSON.parse(registrationRaw) as {
        deferred?: boolean;
      };
      expect(registration.deferred).not.toBe(true);
    } finally {
      if (priorGatewayUnitPath === undefined) {
        delete process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH;
      } else {
        process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH = priorGatewayUnitPath;
      }
      if (priorServiceUser === undefined) {
        delete process.env.SOVEREIGN_NODE_SERVICE_USER;
      } else {
        process.env.SOVEREIGN_NODE_SERVICE_USER = priorServiceUser;
      }
      if (priorServiceGroup === undefined) {
        delete process.env.SOVEREIGN_NODE_SERVICE_GROUP;
      } else {
        process.env.SOVEREIGN_NODE_SERVICE_GROUP = priorServiceGroup;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("builds status from runtime config and OpenClaw probes", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
    };
    await writeRuntimeArtifacts(paths);

    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
        }),
        ensureInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
          installMethod: "install_sh",
        }),
      },
      openclawGatewayServiceManager: {
        install: async () => {},
        start: async () => {},
        restart: async () => {},
      },
      mailSentinelRegistrar: {
        register: async () => ({
          agentId: "mail-sentinel",
          cronJobId: "mail-sentinel-poll",
          workspaceDir: join(paths.stateDir, "mail-sentinel", "workspace"),
          agentCommand: "openclaw agents upsert",
          cronCommand: "openclaw cron add",
        }),
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async (req) => ({
          ok: true,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "ok",
          mailbox: req.imap.mailbox ?? "INBOX",
        }),
      },
      matrixProvisioner: {
        provision: async () => {
          throw new Error("not used");
        },
        bootstrapAccounts: async () => {
          throw new Error("not used");
        },
        bootstrapRoom: async () => {
          throw new Error("not used");
        },
        test: async () => ({
          ok: true,
          homeserverUrl: "https://matrix.example.org",
          checks: [],
        }),
      },
      execRunner: {
        run: async ({ command, args }) => {
          const serialized = [command, ...(args ?? [])].join(" ");
          if (serialized === "openclaw gateway status") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "running",
              stderr: "",
            };
          }
          if (serialized === "openclaw health") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "ok",
              stderr: "",
            };
          }
          if (serialized === "openclaw agents list") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "mail-sentinel",
              stderr: "",
            };
          }
          if (serialized === "openclaw cron list") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "mail-sentinel-poll",
              stderr: "",
            };
          }
          return {
            command: serialized,
            exitCode: 1,
            stdout: "",
            stderr: "unexpected command",
          };
        },
      },
      fetchImpl: async (url) => {
        if (!url.includes("/joined_members")) {
          return new Response("not found", { status: 404 });
        }
        return new Response(JSON.stringify({ joined: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    try {
      const status = await service.getStatus();
      expect(status.mode).toBe("bundled_matrix");
      expect(status.openclaw.cliInstalled).toBe(true);
      expect(status.openclaw.serviceInstalled).toBe(true);
      expect(status.openclaw.serviceState).toBe("running");
      expect(status.openclaw.agentPresent).toBe(true);
      expect(status.openclaw.cronPresent).toBe(true);
      expect(status.matrix.roomReachable).toBe(true);
      expect(status.services.some((entry) => entry.kind === "openclaw")).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("reports doctor failures when gateway health and registration checks fail", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
    };
    await writeRuntimeArtifacts(paths);

    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
        }),
        ensureInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
          installMethod: "install_sh",
        }),
      },
      openclawGatewayServiceManager: {
        install: async () => {},
        start: async () => {},
        restart: async () => {},
      },
      mailSentinelRegistrar: {
        register: async () => ({
          agentId: "mail-sentinel",
          cronJobId: "mail-sentinel-poll",
          workspaceDir: join(paths.stateDir, "mail-sentinel", "workspace"),
          agentCommand: "openclaw agents upsert",
          cronCommand: "openclaw cron add",
        }),
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async (req) => ({
          ok: true,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "ok",
          mailbox: req.imap.mailbox ?? "INBOX",
        }),
      },
      matrixProvisioner: {
        provision: async () => {
          throw new Error("not used");
        },
        bootstrapAccounts: async () => {
          throw new Error("not used");
        },
        bootstrapRoom: async () => {
          throw new Error("not used");
        },
        test: async () => ({
          ok: false,
          homeserverUrl: "https://matrix.example.org",
          checks: [],
        }),
      },
      execRunner: {
        run: async ({ command, args }) => {
          const serialized = [command, ...(args ?? [])].join(" ");
          if (serialized === "openclaw gateway status") {
            return {
              command: serialized,
              exitCode: 3,
              stdout: "inactive",
              stderr: "",
            };
          }
          if (serialized === "openclaw health") {
            return {
              command: serialized,
              exitCode: 1,
              stdout: "",
              stderr: "health check failed",
            };
          }
          if (serialized === "openclaw agents list") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "other-agent",
              stderr: "",
            };
          }
          if (serialized === "openclaw cron list") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "other-cron",
              stderr: "",
            };
          }
          return {
            command: serialized,
            exitCode: 1,
            stdout: "",
            stderr: "unexpected command",
          };
        },
      },
      fetchImpl: async () => new Response("not found", { status: 404 }),
    });

    try {
      const report = await service.getDoctorReport();
      expect(report.overall).toBe("fail");
      expect(
        report.checks.find((entry) => entry.id === "gateway-service-health")?.status,
      ).toBe("fail");
      expect(
        report.checks.find((entry) => entry.id === "mail-sentinel-registration")?.status,
      ).toBe("fail");
      expect(report.suggestedCommands.some((entry) => entry.includes("openclaw gateway restart"))).toBe(
        true,
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
