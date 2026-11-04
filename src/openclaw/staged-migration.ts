import { existsSync } from "node:fs";

import type { Logger } from "../logging/logger.js";
import type { ExecRunner } from "../system/exec.js";
import {
  type OpenClawBootstrapper,
  type OpenClawInstallInfo,
  SOVEREIGN_PINNED_OPENCLAW_VERSION,
} from "./bootstrap.js";

/** The lock scripts/openclaw-migrate.sh holds for its whole run. */
export const STAGED_MIGRATION_LOCK_PATH = "/run/sovereign-openclaw-migrate.lock";
export const STAGED_MIGRATION_GATEWAY_UNIT = "sovereign-openclaw-gateway.service";

// Every state in which the gateway process may still be reading or writing
// the OpenClaw tree and state it is about to lose.
const RUNNING_UNIT_STATES = new Set([
  "active",
  "activating",
  "reloading",
  "deactivating",
  "refreshing",
]);

export type StagedMigrationInstallInput = {
  bootstrapper: OpenClawBootstrapper;
  execRunner: ExecRunner;
  logger: Logger;
  target: string;
  lockPath?: string;
  gatewayUnit?: string;
};

export type StagedMigrationInstallResult = Pick<
  OpenClawInstallInfo,
  "version" | "binaryPath" | "installMethod"
> & { reinstalled: boolean };

const notStaged = (message: string, details: Record<string, unknown>) => ({
  code: "OPENCLAW_MIGRATION_NOT_STAGED",
  message,
  retryable: false,
  details,
});

const normalizeVersion = (version: string): string => version.trim().replace(/^v/, "");

/**
 * The upgrade step of the staged OpenClaw migration, and the only caller that
 * may let the bootstrapper replace an installed OpenClaw of another version.
 *
 * It runs as the owner of the OpenClaw npm prefix, which on a web-installed
 * node is the service user, so it cannot read the migration's root-owned
 * state. What it can check is what makes the swap safe: the migration's lock
 * is held (the script takes it before it stops anything and backs up) and the
 * gateway is not running on the tree that is about to change.
 */
export const installForStagedMigration = async (
  input: StagedMigrationInstallInput,
): Promise<StagedMigrationInstallResult> => {
  const lockPath = input.lockPath ?? STAGED_MIGRATION_LOCK_PATH;
  const gatewayUnit = input.gatewayUnit ?? STAGED_MIGRATION_GATEWAY_UNIT;

  if (!existsSync(lockPath)) {
    throw notStaged(
      `No staged OpenClaw migration is running (${lockPath} does not exist); run scripts/openclaw-migrate.sh`,
      { lockPath },
    );
  }
  // A shared, non-blocking attempt fails only while another process holds
  // the exclusive lock the migration script takes. flock reports that
  // conflict as exit 1; any other failure (an unreadable lock file, say)
  // proves nothing about a running migration.
  const probe = await input.execRunner.run({
    command: "flock",
    args: ["-n", "-s", lockPath, "true"],
  });
  if (probe.exitCode === 0) {
    throw notStaged(
      `No staged OpenClaw migration holds ${lockPath}; run scripts/openclaw-migrate.sh`,
      { lockPath },
    );
  }
  if (probe.exitCode !== 1) {
    throw notStaged(`Could not probe the staged OpenClaw migration lock ${lockPath}`, {
      lockPath,
      flockExitCode: probe.exitCode,
    });
  }

  const unitState = await input.execRunner.run({
    command: "systemctl",
    args: ["is-active", gatewayUnit],
  });
  const state = unitState.stdout.trim();
  if (RUNNING_UNIT_STATES.has(state)) {
    throw notStaged(
      `${gatewayUnit} is ${state}; the gateway must be stopped before OpenClaw changes version`,
      { gatewayUnit, state },
    );
  }

  if (normalizeVersion(input.target) !== SOVEREIGN_PINNED_OPENCLAW_VERSION) {
    throw {
      code: "OPENCLAW_MIGRATION_TARGET_MISMATCH",
      message: `This build installs OpenClaw ${SOVEREIGN_PINNED_OPENCLAW_VERSION}, not the requested ${input.target}`,
      retryable: false,
      details: { target: input.target, locked: SOVEREIGN_PINNED_OPENCLAW_VERSION },
    };
  }

  input.logger.info(
    { target: input.target, lockPath, gatewayUnit, gatewayState: state },
    "Installing the locked OpenClaw runtime for the staged migration",
  );
  const installed = await input.bootstrapper.ensureInstalled({
    version: input.target,
    noPrompt: true,
    noOnboard: true,
    allowVersionChange: true,
  });
  if (normalizeVersion(installed.version) !== normalizeVersion(input.target)) {
    throw {
      code: "OPENCLAW_MIGRATION_INSTALL_MISMATCH",
      message: `The OpenClaw install finished but the CLI reports ${installed.version}, not ${input.target}`,
      retryable: false,
      details: {
        target: input.target,
        installed: installed.version,
        binaryPath: installed.binaryPath,
      },
    };
  }
  return {
    version: installed.version,
    binaryPath: installed.binaryPath,
    installMethod: installed.installMethod,
    reinstalled: installed.reinstalled === true,
  };
};
