import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Logger } from "../logging/logger.js";
import type { ExecInput, ExecResult, ExecRunner } from "../system/exec.js";
import {
  type OpenClawBootstrapper,
  type OpenClawInstallInfo,
  SOVEREIGN_PINNED_OPENCLAW_VERSION,
} from "./bootstrap.js";
import {
  installForStagedMigration,
  STAGED_MIGRATION_GATEWAY_UNIT,
  STAGED_MIGRATION_LOCK_PATH,
} from "./staged-migration.js";

const TARGET = SOVEREIGN_PINNED_OPENCLAW_VERSION;
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const lockFile = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "staged-migration-"));
  dirs.push(dir);
  const path = join(dir, "migrate.lock");
  writeFileSync(path, "");
  return path;
};

const logger = { info: vi.fn(), warn: vi.fn() } as unknown as Logger;

const setup = (
  opts: {
    flockExit?: number;
    unitState?: string;
    installed?: Partial<OpenClawInstallInfo>;
    withoutReinstalled?: boolean;
  } = {},
) => {
  const order: string[] = [];
  const execRunner: ExecRunner = {
    run: vi.fn(async (input: ExecInput): Promise<ExecResult> => {
      order.push(input.command);
      if (input.command === "flock") {
        return { command: "flock", exitCode: opts.flockExit ?? 1, stdout: "", stderr: "" };
      }
      return {
        command: "systemctl",
        exitCode: 3,
        stdout: `${opts.unitState ?? "inactive"}\n`,
        stderr: "",
      };
    }),
  };
  const ensureInstalled = vi.fn(async () => {
    order.push("ensureInstalled");
    const info: OpenClawInstallInfo = {
      binaryPath: "/srv/home/.npm-global/bin/openclaw",
      version: TARGET,
      installMethod: "locked_project",
      reinstalled: true,
      ...opts.installed,
    };
    if (opts.withoutReinstalled === true) delete info.reinstalled;
    return info;
  });
  const bootstrapper: OpenClawBootstrapper = { detectInstalled: vi.fn(), ensureInstalled };
  return { execRunner, bootstrapper, ensureInstalled, order };
};

describe("installForStagedMigration", () => {
  it("defaults to the migration script's lock and the system gateway unit", () => {
    expect(STAGED_MIGRATION_LOCK_PATH).toBe("/run/sovereign-openclaw-migrate.lock");
    expect(STAGED_MIGRATION_GATEWAY_UNIT).toBe("sovereign-openclaw-gateway.service");
  });

  it("passes allowVersionChange exactly once, after the lock and unit checks", async () => {
    const lockPath = lockFile();
    const { execRunner, bootstrapper, ensureInstalled, order } = setup();
    const result = await installForStagedMigration({
      bootstrapper,
      execRunner,
      logger,
      target: TARGET,
      lockPath,
    });
    expect(result).toEqual({
      version: TARGET,
      binaryPath: "/srv/home/.npm-global/bin/openclaw",
      installMethod: "locked_project",
      reinstalled: true,
    });
    expect(order).toEqual(["flock", "systemctl", "ensureInstalled"]);
    expect(ensureInstalled).toHaveBeenCalledTimes(1);
    expect(ensureInstalled).toHaveBeenCalledWith({
      version: TARGET,
      noPrompt: true,
      noOnboard: true,
      allowVersionChange: true,
    });
    expect(execRunner.run).toHaveBeenCalledWith({
      command: "flock",
      args: ["-n", "-s", lockPath, "true"],
    });
    expect(execRunner.run).toHaveBeenCalledWith({
      command: "systemctl",
      args: ["is-active", STAGED_MIGRATION_GATEWAY_UNIT],
    });
  });

  it("accepts a v-prefixed target and reports a kept runtime as not reinstalled", async () => {
    const { execRunner, bootstrapper } = setup({
      installed: { version: `v${TARGET}` },
      withoutReinstalled: true,
    });
    const result = await installForStagedMigration({
      bootstrapper,
      execRunner,
      logger,
      target: `v${TARGET}`,
      lockPath: lockFile(),
      gatewayUnit: "custom.service",
    });
    expect(result.reinstalled).toBe(false);
    expect(execRunner.run).toHaveBeenCalledWith({
      command: "systemctl",
      args: ["is-active", "custom.service"],
    });
  });

  it("refuses when the lock file does not exist", async () => {
    const { execRunner, bootstrapper, ensureInstalled } = setup();
    await expect(
      installForStagedMigration({
        bootstrapper,
        execRunner,
        logger,
        target: TARGET,
        lockPath: join(tmpdir(), "no-such-dir-staged-migration", "migrate.lock"),
      }),
    ).rejects.toMatchObject({ code: "OPENCLAW_MIGRATION_NOT_STAGED", retryable: false });
    expect(execRunner.run).not.toHaveBeenCalled();
    expect(ensureInstalled).not.toHaveBeenCalled();
  });

  it("checks the migration script's own lock when no lock path is given", async () => {
    // Whether or not that file exists on this host, nothing holds it here.
    const { execRunner, bootstrapper, ensureInstalled } = setup({ flockExit: 0 });
    await expect(
      installForStagedMigration({ bootstrapper, execRunner, logger, target: TARGET }),
    ).rejects.toMatchObject({
      code: "OPENCLAW_MIGRATION_NOT_STAGED",
      details: { lockPath: STAGED_MIGRATION_LOCK_PATH },
    });
    expect(ensureInstalled).not.toHaveBeenCalled();
  });

  it("refuses when nobody holds the lock", async () => {
    const lockPath = lockFile();
    const { execRunner, bootstrapper, ensureInstalled } = setup({ flockExit: 0 });
    await expect(
      installForStagedMigration({ bootstrapper, execRunner, logger, target: TARGET, lockPath }),
    ).rejects.toMatchObject({
      code: "OPENCLAW_MIGRATION_NOT_STAGED",
      details: { lockPath },
    });
    expect(ensureInstalled).not.toHaveBeenCalled();
  });

  it("refuses when the lock cannot be probed instead of reading that as held", async () => {
    const lockPath = lockFile();
    const { execRunner, bootstrapper, ensureInstalled } = setup({ flockExit: 66 });
    await expect(
      installForStagedMigration({ bootstrapper, execRunner, logger, target: TARGET, lockPath }),
    ).rejects.toMatchObject({
      code: "OPENCLAW_MIGRATION_NOT_STAGED",
      details: { lockPath, flockExitCode: 66 },
    });
    expect(ensureInstalled).not.toHaveBeenCalled();
  });

  for (const state of ["active", "activating", "reloading", "deactivating", "refreshing"]) {
    it(`refuses while the gateway is ${state}`, async () => {
      const { execRunner, bootstrapper, ensureInstalled } = setup({ unitState: state });
      await expect(
        installForStagedMigration({
          bootstrapper,
          execRunner,
          logger,
          target: TARGET,
          lockPath: lockFile(),
        }),
      ).rejects.toMatchObject({
        code: "OPENCLAW_MIGRATION_NOT_STAGED",
        message: expect.stringContaining("must be stopped"),
        details: { state },
      });
      expect(ensureInstalled).not.toHaveBeenCalled();
    });
  }

  for (const state of ["inactive", "failed", "unknown", ""]) {
    it(`proceeds when the gateway is ${state || "not reported"}`, async () => {
      const { execRunner, bootstrapper, ensureInstalled } = setup({ unitState: state });
      await installForStagedMigration({
        bootstrapper,
        execRunner,
        logger,
        target: TARGET,
        lockPath: lockFile(),
      });
      expect(ensureInstalled).toHaveBeenCalledTimes(1);
    });
  }

  it("refuses a target this build does not ship", async () => {
    const { execRunner, bootstrapper, ensureInstalled } = setup();
    await expect(
      installForStagedMigration({
        bootstrapper,
        execRunner,
        logger,
        target: "2026.3.13",
        lockPath: lockFile(),
      }),
    ).rejects.toMatchObject({
      code: "OPENCLAW_MIGRATION_TARGET_MISMATCH",
      details: { target: "2026.3.13", locked: TARGET },
    });
    expect(ensureInstalled).not.toHaveBeenCalled();
  });

  it("fails when the installed CLI reports another version", async () => {
    const { execRunner, bootstrapper } = setup({ installed: { version: "2026.3.13" } });
    await expect(
      installForStagedMigration({
        bootstrapper,
        execRunner,
        logger,
        target: TARGET,
        lockPath: lockFile(),
      }),
    ).rejects.toMatchObject({
      code: "OPENCLAW_MIGRATION_INSTALL_MISMATCH",
      details: { target: TARGET, installed: "2026.3.13" },
    });
  });
});

describe("allowVersionChange", () => {
  const srcDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
    });

  it("is set to true only by the staged migration", () => {
    const hits = sources(srcDir).flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => /allowVersionChange\s*:\s*true/.test(line))
        .map(() => relative(srcDir, path)),
    );
    expect(hits).toEqual(["openclaw/staged-migration.ts"]);
  });
});
