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
    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: fakeBootstrapper,
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
      expect(ensureInstalledCalls).toHaveLength(1);
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
});
