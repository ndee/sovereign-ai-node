import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { SovereignPaths } from "../config/paths.js";
import { createLogger } from "../logging/logger.js";
import { DEV_STATE_FALLBACK_ENV, SOVEREIGN_DEV_STATE_DIR_NAME } from "../system/state-dir.js";
import { RealInstallerService } from "./real-service.js";

/**
 * The secrets dir and the install-jobs dir are privileged state. Relocating
 * either under `process.cwd()` hides a permissions fault on a real node, so
 * the relocation is only allowed when a developer opts in explicitly with
 * `SOVEREIGN_NODE_DEV_STATE_FALLBACK=1`. A `.sovereign-node-dev` directory
 * lying around in the working directory is NOT an opt-in: on a real node it
 * can be left behind by an older release, and it must not switch the
 * relocation back on.
 */

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

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  delete process.env[DEV_STATE_FALLBACK_ENV];
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) {
      await cleanup();
    }
  }
});

const makeTempRoot = async (prefix: string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
};

/**
 * Make `dir` unwritable so the preferred-path branch throws EACCES, and
 * guarantee it is made writable again afterwards (an unwritable temp dir
 * cannot be removed). The state dir is nested under it: chmod on a dir the
 * test user owns would simply restore write access, so the parent is what
 * makes creation genuinely impossible.
 */
const makeUnwritable = async (dir: string): Promise<void> => {
  await mkdir(dir, { recursive: true });
  await chmod(dir, 0o500);
  cleanups.push(async () => {
    await chmod(dir, 0o700).catch(() => {});
  });
};

const withCwd = async (dir: string, action: () => Promise<void>): Promise<void> => {
  const original = process.cwd();
  process.chdir(dir);
  try {
    await action();
  } finally {
    process.chdir(original);
  }
};

// These tests never get far enough to use any collaborator: resolving the
// state directory is the first thing that happens and the first thing that
// fails. The stubs exist only to satisfy the required deps shape.
const buildService = (paths: SovereignPaths): RealInstallerService =>
  new RealInstallerService(createLogger(), paths, {
    openclawBootstrapper: {
      detectInstalled: async () => null,
      ensureInstalled: async () => {
        throw new Error("not used");
      },
    },
    openclawGatewayServiceManager: {
      install: async () => {},
      start: async () => {},
      restart: async () => {},
    },
    preflightChecker: {
      run: async () => {
        throw new Error("not used");
      },
    },
    imapTester: {
      test: async () => {
        throw new Error("not used");
      },
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
      test: async () => {
        throw new Error("not used");
      },
    },
  });

const ensureSecretsDir = (service: RealInstallerService): Promise<string> =>
  (service as unknown as { ensureSecretsDir: () => Promise<string> }).ensureSecretsDir();

const listDir = async (dir: string): Promise<string[]> => (await readdir(dir)).sort();

describe("install jobs dir", () => {
  it("fails fast with an actionable error and creates no dev dir", async () => {
    const tempRoot = await makeTempRoot("sovereign-jobs-prod-");
    const cwd = join(tempRoot, "cwd");
    await mkdir(cwd, { recursive: true });
    const jobsDir = join(tempRoot, "locked", "jobs");
    await makeUnwritable(join(tempRoot, "locked"));

    await withCwd(cwd, async () => {
      // getInstallJob reaches ensureInstallJobsDir. The unwritable dir must
      // surface as a named failure, NOT be papered over by a relocation that
      // then reports a plain "job not found".
      const failure = buildService({
        ...buildPaths(tempRoot),
        installJobsDir: jobsDir,
      }).getInstallJob("job_missing");
      await expect(failure).rejects.toMatchObject({
        code: "INSTALL_JOBS_DIR_UNWRITABLE",
        retryable: false,
        details: { dir: jobsDir, requiredMode: "0700", causeCode: "EACCES" },
      });
      const error = (await failure.catch((caught: unknown) => caught)) as Error;
      expect(error.message).toContain(`Install jobs directory ${jobsDir} is not writable`);
      expect(error.message).toContain(`sudo chown`);
      expect(error.message).toContain(`sudo chmod 0700 ${jobsDir}`);
      expect(error.message).toContain("EACCES");
    });
    expect(await listDir(cwd)).toEqual([]);
  });

  it("ignores a leftover .sovereign-node-dev dir without the explicit flag", async () => {
    const tempRoot = await makeTempRoot("sovereign-jobs-leftover-");
    const cwd = join(tempRoot, "cwd");
    await mkdir(join(cwd, SOVEREIGN_DEV_STATE_DIR_NAME), { recursive: true });
    const jobsDir = join(tempRoot, "locked", "jobs");
    await makeUnwritable(join(tempRoot, "locked"));

    await withCwd(cwd, async () => {
      await expect(
        buildService({ ...buildPaths(tempRoot), installJobsDir: jobsDir }).getInstallJob(
          "job_missing",
        ),
      ).rejects.toMatchObject({ code: "INSTALL_JOBS_DIR_UNWRITABLE" });
    });
    expect(await listDir(join(cwd, SOVEREIGN_DEV_STATE_DIR_NAME))).toEqual([]);
  });

  it("uses the dev fallback when the explicit flag is set", async () => {
    const tempRoot = await makeTempRoot("sovereign-jobs-dev-");
    const cwd = join(tempRoot, "cwd");
    await mkdir(cwd, { recursive: true });
    const jobsDir = join(tempRoot, "locked", "jobs");
    await makeUnwritable(join(tempRoot, "locked"));
    process.env[DEV_STATE_FALLBACK_ENV] = "1";

    await withCwd(cwd, async () => {
      // The dev fallback is taken, so the lookup gets far enough to report an
      // ordinary miss instead of a permissions failure.
      await expect(
        buildService({ ...buildPaths(tempRoot), installJobsDir: jobsDir }).getInstallJob(
          "job_missing",
        ),
      ).rejects.toMatchObject({ code: "INSTALL_JOB_NOT_FOUND" });
    });
    expect(await listDir(join(cwd, SOVEREIGN_DEV_STATE_DIR_NAME))).toEqual(["install-jobs"]);
  });
});

describe("secrets dir", () => {
  it("fails fast with an actionable error and creates no dev dir", async () => {
    const tempRoot = await makeTempRoot("sovereign-secrets-prod-");
    const cwd = join(tempRoot, "cwd");
    await mkdir(cwd, { recursive: true });
    const paths = buildPaths(tempRoot);
    await makeUnwritable(join(tempRoot, "etc"));

    await withCwd(cwd, async () => {
      const failure = ensureSecretsDir(buildService(paths));
      await expect(failure).rejects.toMatchObject({
        code: "SECRETS_DIR_UNWRITABLE",
        retryable: false,
        details: { dir: paths.secretsDir, requiredMode: "0700", causeCode: "EACCES" },
      });
      const error = (await failure.catch((caught: unknown) => caught)) as Error;
      expect(error.message).toContain(`Secrets directory ${paths.secretsDir} is not writable`);
      expect(error.message).toContain(`sudo chmod 0700 ${paths.secretsDir}`);
    });
    // Credentials must not have been redirected under the working directory.
    expect(await listDir(cwd)).toEqual([]);
  });

  it("ignores a leftover .sovereign-node-dev dir without the explicit flag", async () => {
    const tempRoot = await makeTempRoot("sovereign-secrets-leftover-");
    const cwd = join(tempRoot, "cwd");
    await mkdir(join(cwd, SOVEREIGN_DEV_STATE_DIR_NAME), { recursive: true });
    await makeUnwritable(join(tempRoot, "etc"));

    await withCwd(cwd, async () => {
      await expect(ensureSecretsDir(buildService(buildPaths(tempRoot)))).rejects.toMatchObject({
        code: "SECRETS_DIR_UNWRITABLE",
      });
    });
    expect(await listDir(join(cwd, SOVEREIGN_DEV_STATE_DIR_NAME))).toEqual([]);
  });

  it("uses the dev fallback when the explicit flag is set", async () => {
    const tempRoot = await makeTempRoot("sovereign-secrets-dev-");
    const cwd = join(tempRoot, "cwd");
    await mkdir(cwd, { recursive: true });
    await makeUnwritable(join(tempRoot, "etc"));
    process.env[DEV_STATE_FALLBACK_ENV] = "1";

    await withCwd(cwd, async () => {
      const resolved = await ensureSecretsDir(buildService(buildPaths(tempRoot)));
      expect(resolved).toBe(resolve(cwd, SOVEREIGN_DEV_STATE_DIR_NAME, "secrets"));
    });
  });
});
