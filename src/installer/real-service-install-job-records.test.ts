import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { SovereignPaths } from "../config/paths.js";
import type { InstallJobStatusResponse, InstallRequest } from "../contracts/index.js";
import { createLogger } from "../logging/logger.js";
import { RealInstallerService } from "./real-service.js";

const buildPaths = (tempRoot: string): SovereignPaths => ({
  configPath: join(tempRoot, "etc", "sovereign-node.json5"),
  secretsDir: join(tempRoot, "etc", "secrets"),
  stateDir: join(tempRoot, "var", "lib"),
  logsDir: join(tempRoot, "var", "log"),
  installJobsDir: join(tempRoot, "install-jobs"),
  openclawServiceHome: join(tempRoot, "openclaw-home"),
  provenancePath: join(tempRoot, "install-provenance.json"),
  backupsDir: join(tempRoot, "backups"),
});

const buildRequestWithInlineSecrets = (): InstallRequest => ({
  mode: "bundled_matrix",
  openrouter: { model: "qwen/qwen-2.5-7b-instruct", apiKey: "sk-or-inline-test-key" },
  imap: {
    host: "imap.example.org",
    port: 993,
    tls: true,
    username: "operator@example.org",
    password: "imap-inline-password",
  },
  matrix: {
    homeserverDomain: "matrix.example.org",
    publicBaseUrl: "https://matrix.example.org",
    tlsMode: "local-dev",
  },
  operator: { username: "operator", password: "operator-inline-password" },
});

const createService = (paths: SovereignPaths): RealInstallerService =>
  new RealInstallerService(createLogger(), paths, {
    openclawBootstrapper: {
      detectInstalled: async () => null,
      ensureInstalled: async () => {
        throw new Error("unexpected ensureInstalled call");
      },
    },
    openclawGatewayServiceManager: {
      install: async () => {},
      start: async () => {},
      restart: async () => {},
    },
    preflightChecker: {
      run: async () => ({
        mode: "bundled_matrix",
        overall: "fail",
        checks: [],
        recommendedActions: [],
      }),
    },
    imapTester: {
      test: async () => {
        throw new Error("unexpected imap test call");
      },
    },
    matrixProvisioner: {
      provision: async () => {
        throw new Error("unexpected provision call");
      },
      bootstrapAccounts: async () => {
        throw new Error("unexpected bootstrapAccounts call");
      },
      bootstrapRoom: async () => {
        throw new Error("unexpected bootstrapRoom call");
      },
      test: async () => {
        throw new Error("unexpected matrix test call");
      },
    },
  });

const waitForJob = async (
  service: RealInstallerService,
  jobId: string,
): Promise<InstallJobStatusResponse> => {
  for (let i = 0; i < 200; i++) {
    const result = await service.getInstallJob(jobId);
    if (result.job.state !== "pending" && result.job.state !== "running") {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Job ${jobId} did not reach a terminal state within 2s`);
};

describe("install job records", () => {
  it("persists redacted records with owner-only file and directory modes", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-install-jobs-"));
    const paths = buildPaths(tempRoot);
    try {
      // Pre-existing world-readable directory must be tightened, not trusted.
      await mkdir(paths.installJobsDir, { recursive: true, mode: 0o755 });
      await chmod(paths.installJobsDir, 0o755);

      const service = createService(paths);
      const started = await service.startInstall(buildRequestWithInlineSecrets());
      const finished = await waitForJob(service, started.job.jobId);
      expect(finished.job.state).toBe("failed");

      const recordPath = join(paths.installJobsDir, `${started.job.jobId}.json`);
      const raw = await readFile(recordPath, "utf8");
      expect(raw).not.toMatch(/sk-or-|"password"|inline/);
      const record = JSON.parse(raw) as { request: InstallRequest };
      expect(record.request.imap?.secretRef).toBe(
        `file:${join(paths.secretsDir, "imap-password")}`,
      );
      expect(record.request.openrouter.secretRef).toBe(
        `file:${join(paths.secretsDir, "openrouter-api-key")}`,
      );
      expect(record.request.operator).toEqual({ username: "operator" });

      expect((await stat(recordPath)).mode & 0o777).toBe(0o600);
      expect((await stat(paths.installJobsDir)).mode & 0o777).toBe(0o700);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("prunes stale finished job records on start and on completion", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-install-jobs-"));
    const paths = buildPaths(tempRoot);
    try {
      await mkdir(paths.installJobsDir, { recursive: true });
      const stalePath = join(paths.installJobsDir, "job_stale.json");
      await writeFile(
        stalePath,
        JSON.stringify({ response: { job: { jobId: "job_stale", state: "succeeded" } } }),
        "utf8",
      );
      const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
      await utimes(stalePath, twoDaysAgo, twoDaysAgo);

      const service = createService(paths);
      const started = await service.startInstall(buildRequestWithInlineSecrets());
      await waitForJob(service, started.job.jobId);

      const files = await readdir(paths.installJobsDir);
      expect(files).toEqual([`${started.job.jobId}.json`]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("survives an unwritable install jobs directory when pruning", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-install-jobs-"));
    const paths = buildPaths(tempRoot);
    const priorOverride = process.env.SOVEREIGN_NODE_INSTALL_JOBS_DIR;
    try {
      // A file in place of the override directory makes mkdir fail so the
      // prune step's error path is exercised; the job still fails cleanly.
      const blocker = join(tempRoot, "blocked-jobs");
      await writeFile(blocker, "not a directory", "utf8");
      process.env.SOVEREIGN_NODE_INSTALL_JOBS_DIR = blocker;
      const service = createService(paths);
      await expect(service.startInstall(buildRequestWithInlineSecrets())).rejects.toThrow();
    } finally {
      if (priorOverride === undefined) {
        delete process.env.SOVEREIGN_NODE_INSTALL_JOBS_DIR;
      } else {
        process.env.SOVEREIGN_NODE_INSTALL_JOBS_DIR = priorOverride;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
