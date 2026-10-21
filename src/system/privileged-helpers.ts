import { existsSync } from "node:fs";

// Root-owned helpers installed by scripts/install/lib-build.sh. The runtime
// API (non-root) reaches them through exact sudo rules instead of running raw
// commands as root or using the docker group.
export const PRIVILEGED_HELPER_DIR = "/usr/local/lib/sovereign-node";
export const SYSTEMD_UNIT_HELPER_PATH = `${PRIVILEGED_HELPER_DIR}/install-systemd-unit`;
export const BUNDLED_MATRIX_DOCKER_HELPER_PATH = `${PRIVILEGED_HELPER_DIR}/bundled-matrix-docker`;
export const RECLAIM_OWNERSHIP_HELPER_PATH = `${PRIVILEGED_HELPER_DIR}/reclaim-ownership`;

export type DockerAccess = "direct" | "helper";

export type DockerAccessProbe = {
  getuid?: () => number;
  helperInstalled?: () => boolean;
};

/**
 * Root runs docker itself. A non-root process goes through the helper when it
 * is installed; without it (a developer checkout, unit tests) docker is run
 * directly, which is how such setups have always worked.
 */
export const resolveDockerAccess = (probe: DockerAccessProbe = {}): DockerAccess => {
  const uid = probe.getuid === undefined ? process.getuid?.() : probe.getuid();
  if (uid === undefined || uid === 0) {
    return "direct";
  }
  const helperInstalled =
    probe.helperInstalled ?? (() => existsSync(BUNDLED_MATRIX_DOCKER_HELPER_PATH));
  return helperInstalled() ? "helper" : "direct";
};

export type CommandInvocation = { command: string; args: string[] };

export const bundledMatrixComposeInvocation = (input: {
  access: DockerAccess;
  projectDir: string;
  composeFilePath: string;
  args: string[];
}): CommandInvocation =>
  input.access === "helper"
    ? {
        command: "sudo",
        args: ["-n", BUNDLED_MATRIX_DOCKER_HELPER_PATH, input.projectDir, "compose", ...input.args],
      }
    : {
        command: "docker",
        args: [
          "compose",
          "-f",
          input.composeFilePath,
          "--project-directory",
          input.projectDir,
          ...input.args,
        ],
      };

export const bundledMatrixDockerInvocation = (input: {
  access: DockerAccess;
  projectDir: string;
  args: string[];
}): CommandInvocation =>
  input.access === "helper"
    ? {
        command: "sudo",
        args: ["-n", BUNDLED_MATRIX_DOCKER_HELPER_PATH, input.projectDir, ...input.args],
      }
    : { command: "docker", args: input.args };

export const reclaimOwnershipInvocation = (path: string): CommandInvocation => ({
  command: "sudo",
  args: ["-n", RECLAIM_OWNERSHIP_HELPER_PATH, path],
});

export const systemdUnitInstallInvocation = (unitName: string): CommandInvocation => ({
  command: "sudo",
  args: ["-n", SYSTEMD_UNIT_HELPER_PATH, unitName],
});
