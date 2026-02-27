import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
          federationEnabled: false,
          tlsMode: "local-dev",
        };
      },
    };
    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: fakeBootstrapper,
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

  it("runs matrix_provision after IMAP validation and then stops at account bootstrap TODO", async () => {
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
    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => null,
        ensureInstalled: async (opts) => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: opts.version,
          installMethod: "install_sh",
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
            federationEnabled: req.matrix.federationEnabled ?? false,
            tlsMode: "local-dev",
          };
        },
      },
    });

    try {
      const started = await service.startInstall(buildInstallRequest());

      expect(started.job.state).toBe("failed");
      expect(matrixProvisionCalls).toBe(1);

      const stepStates = Object.fromEntries(
        started.job.steps.map((step) => [step.id, step.state]),
      );
      expect(stepStates.preflight).toBe("succeeded");
      expect(stepStates.openclaw_bootstrap_cli).toBe("succeeded");
      expect(stepStates.imap_validate).toBe("succeeded");
      expect(stepStates.matrix_provision).toBe("succeeded");
      expect(stepStates.matrix_bootstrap_accounts).toBe("failed");
      expect(stepStates.matrix_bootstrap_room).toBe("pending");

      const stored = await service.getInstallJob(started.job.jobId);
      expect(stored.error?.code).toBe("NOT_IMPLEMENTED");
      expect(stored.job.currentStepId).toBe("matrix_bootstrap_accounts");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
