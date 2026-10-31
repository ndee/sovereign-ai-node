import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { SovereignPaths } from "../config/paths.js";
import type { InstallRequest } from "../contracts/index.js";
import { createLogger } from "../logging/logger.js";
import type { ExecRunner } from "./exec.js";
import { DockerComposeBundledMatrixProvisioner } from "./matrix.js";
import { DEV_STATE_FALLBACK_ENV, SOVEREIGN_DEV_STATE_DIR_NAME } from "./state-dir.js";

/**
 * An unwritable `<stateDir>/bundled-matrix` used to be relocated under
 * `<cwd>/.sovereign-node-dev/bundled-matrix` and logged at debug. On a real
 * node that left Synapse with an empty data dir and surfaced much later as a
 * Matrix login failure. Only an explicit dev opt-in may relocate it now.
 */

const request: InstallRequest = {
  mode: "bundled_matrix",
  openclaw: {
    manageInstallation: true,
    installMethod: "install_sh",
    version: "pinned-by-sovereign",
    skipIfCompatibleInstalled: true,
    forceReinstall: false,
    runOnboard: false,
  },
  openrouter: { model: "qwen/qwen-2.5-7b-instruct", apiKey: "sk-or-test" },
  imap: {
    host: "imap.example.org",
    port: 993,
    tls: true,
    username: "operator@example.org",
    secretRef: "file:/tmp/imap-secret",
    mailbox: "INBOX",
  },
  matrix: {
    homeserverDomain: "matrix.local.test",
    publicBaseUrl: "http://matrix.local.test:8008",
    federationEnabled: false,
    tlsMode: "local-dev",
    alertRoomName: "Sovereign Alerts",
  },
  operator: { username: "operator" },
  advanced: { nonInteractive: true },
};

const unusedExecRunner: ExecRunner = {
  run: async () => {
    throw new Error("exec must not be reached when the state dir is unusable");
  },
};

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  delete process.env[DEV_STATE_FALLBACK_ENV];
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

/**
 * A temp root whose `locked/` state dir parent is read-only, so
 * `<stateDir>/bundled-matrix` cannot be created, plus an empty cwd.
 */
const setup = async (): Promise<{ cwd: string; paths: SovereignPaths }> => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-matrix-state-dir-"));
  cleanups.push(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });
  const locked = join(tempRoot, "locked");
  await mkdir(locked, { recursive: true });
  await chmod(locked, 0o500);
  cleanups.push(async () => {
    await chmod(locked, 0o700).catch(() => {});
  });
  const cwd = join(tempRoot, "cwd");
  await mkdir(cwd, { recursive: true });
  return {
    cwd,
    paths: {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(locked, "state"),
      logsDir: join(tempRoot, "logs"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    },
  };
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

describe("bundled Matrix state dir", () => {
  it("fails fast with an actionable error and creates no dev dir", async () => {
    const { cwd, paths } = await setup();
    const preferred = join(paths.stateDir, "bundled-matrix");

    await withCwd(cwd, async () => {
      const provisioner = new DockerComposeBundledMatrixProvisioner(
        unusedExecRunner,
        createLogger(),
        paths,
      );
      const failure = provisioner.provision(request);
      await expect(failure).rejects.toMatchObject({
        code: "MATRIX_STATE_DIR_UNWRITABLE",
        retryable: false,
        details: { dir: preferred, requiredMode: "0750", causeCode: "EACCES" },
      });
      const error = (await failure.catch((caught: unknown) => caught)) as Error;
      expect(error.message).toContain(
        `Bundled Matrix state directory ${preferred} is not writable`,
      );
      expect(error.message).toContain(`sudo mkdir -p ${preferred}`);
      expect(error.message).toContain(`sudo chmod 0750 ${preferred}`);
      expect(error.message).toContain("EACCES");
    });
    expect(await readdir(cwd)).toEqual([]);
  });

  it("ignores a leftover .sovereign-node-dev dir without the explicit flag", async () => {
    const { cwd, paths } = await setup();
    await mkdir(join(cwd, SOVEREIGN_DEV_STATE_DIR_NAME));

    await withCwd(cwd, async () => {
      await expect(
        new DockerComposeBundledMatrixProvisioner(
          unusedExecRunner,
          createLogger(),
          paths,
        ).provision(request),
      ).rejects.toMatchObject({ code: "MATRIX_STATE_DIR_UNWRITABLE" });
    });
    expect(await readdir(join(cwd, SOVEREIGN_DEV_STATE_DIR_NAME))).toEqual([]);
  });

  it("uses the dev fallback when the explicit flag is set", async () => {
    const { cwd, paths } = await setup();
    process.env[DEV_STATE_FALLBACK_ENV] = "1";

    await withCwd(cwd, async () => {
      const provisioner = new DockerComposeBundledMatrixProvisioner(
        unusedExecRunner,
        createLogger(),
        paths,
      );
      const resolved = await (
        provisioner as unknown as { ensureBaseDir: () => Promise<string> }
      ).ensureBaseDir();
      expect(resolved).toBe(resolve(cwd, SOVEREIGN_DEV_STATE_DIR_NAME, "bundled-matrix"));
    });
  });
});
