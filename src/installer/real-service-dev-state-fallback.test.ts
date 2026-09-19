import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { SovereignPaths } from "../config/paths.js";
import { createLogger } from "../logging/logger.js";
import {
  devStateFallbackDir,
  RealInstallerService,
  SOVEREIGN_DEV_STATE_DIR_NAME,
} from "./real-service.js";

/**
 * Neither the secrets-dir nor the install-jobs-dir fallback had any test
 * coverage. Both used to relocate a privileged state directory under
 * `process.cwd()` on ANY error and log it at `debug`, so a permissions fault
 * on a real node silently moved the secrets directory somewhere nobody looks.
 *
 * These tests pin both halves: the dev affordance still works when the
 * `.sovereign-node-dev` marker is present, and the same failure without the
 * marker is a loud error rather than a silent relocation.
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
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) {
      await cleanup();
    }
  }
});

/**
 * Make `dir` unwritable so the preferred-path branch throws EACCES, and
 * guarantee it is made writable again afterwards (an unwritable temp dir
 * cannot be removed).
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

describe("devStateFallbackDir", () => {
  it("returns a marker-relative dir when the scaffold marker exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-dev-marker-"));
    cleanups.push(async () => {
      await rm(root, { recursive: true, force: true });
    });
    await mkdir(join(root, SOVEREIGN_DEV_STATE_DIR_NAME), { recursive: true });

    await expect(devStateFallbackDir("secrets", root)).resolves.toBe(
      resolve(root, SOVEREIGN_DEV_STATE_DIR_NAME, "secrets"),
    );
  });

  it("returns null when there is no scaffold marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-dev-nomarker-"));
    cleanups.push(async () => {
      await rm(root, { recursive: true, force: true });
    });

    await expect(devStateFallbackDir("secrets", root)).resolves.toBeNull();
  });

  it("refuses a marker that is a file rather than a directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-dev-filemarker-"));
    cleanups.push(async () => {
      await rm(root, { recursive: true, force: true });
    });
    await writeFile(join(root, SOVEREIGN_DEV_STATE_DIR_NAME), "not a dir\n", "utf8");

    await expect(devStateFallbackDir("secrets", root)).resolves.toBeNull();
  });
});

describe("privileged state dirs do not silently relocate", () => {
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

  it("fails loudly when the install jobs dir is unwritable outside a scaffold checkout", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-jobs-prod-"));
    cleanups.push(async () => {
      await rm(tempRoot, { recursive: true, force: true });
    });
    const cwd = join(tempRoot, "cwd");
    await mkdir(cwd, { recursive: true });
    // Nest the jobs dir under an unwritable parent: chmod on a dir the test
    // user owns would simply restore write access, so the parent is what makes
    // creation genuinely impossible.
    const paths = { ...buildPaths(tempRoot), installJobsDir: join(tempRoot, "locked", "jobs") };
    await makeUnwritable(join(tempRoot, "locked"));

    await withCwd(cwd, async () => {
      const service = buildService(paths);
      // getInstallJob reaches ensureInstallJobsDir. The unwritable dir must
      // surface as the underlying permissions error, NOT be papered over by a
      // relocation that then reports a plain "job not found".
      await expect(service.getInstallJob("job_missing")).rejects.toMatchObject({
        code: "EACCES",
      });
      // Nothing may have been created under the working directory.
      await expect(devStateFallbackDir("install-jobs", cwd)).resolves.toBeNull();
    });
  });

  it("uses the scaffold fallback for install jobs when the marker is present", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-jobs-dev-"));
    cleanups.push(async () => {
      await rm(tempRoot, { recursive: true, force: true });
    });
    const cwd = join(tempRoot, "cwd");
    await mkdir(join(cwd, SOVEREIGN_DEV_STATE_DIR_NAME), { recursive: true });
    const paths = { ...buildPaths(tempRoot), installJobsDir: join(tempRoot, "locked", "jobs") };
    await makeUnwritable(join(tempRoot, "locked"));

    await withCwd(cwd, async () => {
      const service = buildService(paths);
      // The scaffold fallback is taken, so the lookup gets far enough to
      // report an ordinary miss instead of a permissions failure.
      await expect(service.getInstallJob("job_missing")).rejects.toMatchObject({
        code: "INSTALL_JOB_NOT_FOUND",
      });
    });
  });

  it("refuses to relocate the secrets dir outside a scaffold checkout", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-secrets-prod-"));
    cleanups.push(async () => {
      await rm(tempRoot, { recursive: true, force: true });
    });
    const cwd = join(tempRoot, "cwd");
    await mkdir(cwd, { recursive: true });
    const paths = buildPaths(tempRoot);
    // The parent is unwritable, so the secrets dir itself cannot be created.
    await makeUnwritable(join(tempRoot, "etc"));

    await withCwd(cwd, async () => {
      const service = buildService(paths);
      await expect(
        (
          service as unknown as {
            ensureSecretsDir: () => Promise<string>;
          }
        ).ensureSecretsDir(),
      ).rejects.toMatchObject({ code: "EACCES" });
      // Credentials must not have been redirected under the working directory.
      await expect(devStateFallbackDir("secrets", cwd)).resolves.toBeNull();
    });
  });

  it("uses the scaffold fallback for secrets when the marker is present", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-secrets-dev-"));
    cleanups.push(async () => {
      await rm(tempRoot, { recursive: true, force: true });
    });
    const cwd = join(tempRoot, "cwd");
    await mkdir(join(cwd, SOVEREIGN_DEV_STATE_DIR_NAME), { recursive: true });
    const paths = buildPaths(tempRoot);
    await makeUnwritable(join(tempRoot, "etc"));

    await withCwd(cwd, async () => {
      const service = buildService(paths);
      const resolved = await (
        service as unknown as {
          ensureSecretsDir: () => Promise<string>;
        }
      ).ensureSecretsDir();
      expect(resolved).toBe(resolve(cwd, SOVEREIGN_DEV_STATE_DIR_NAME, "secrets"));
    });
  });
});
