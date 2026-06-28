import { homedir } from "node:os";
import { join } from "node:path";

import type { Logger } from "../logging/logger.js";
import type { ExecRunner } from "../system/exec.js";
import { isRecord, parseJsonSafely, truncateText } from "./real-service-shared.js";

// Capture the API service's original HOME at module load, before any other
// installer code (notably setManagedOpenClawEnv in real-service.ts) mutates
// process.env.HOME for the OpenClaw subsystem. This is only the *fallback*
// HOME used when the caller does not supply an explicit service home (e.g.
// dev installs where the service user IS the invoking user / root). We need a
// concrete HOME here because npm reads .npmrc from $HOME and falls back to the
// system global prefix (/usr/lib/node_modules) — which is root-owned — when
// HOME points at a directory without an .npmrc.
const ORIGINAL_HOME = process.env.HOME ?? homedir();

// The npm prefix the scan service expects on its PATH (10-lobster-path.conf
// drop-in adds `<serviceHome>/.npm-global/bin`). Keep in sync with that unit.
const npmGlobalSubdir = ".npm-global";

const resolveServiceHome = (serviceHome?: string): string => {
  const trimmed = serviceHome?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : ORIGINAL_HOME;
};

const npmGlobalPrefix = (serviceHome?: string): string =>
  join(resolveServiceHome(serviceHome), npmGlobalSubdir);

// Absolute path to the lobster binary inside the targeted npm prefix. We probe
// this directly rather than relying on `lobster` being on PATH: the installer
// runs as root with whatever PATH it inherited (which does not include the
// service user's `<serviceHome>/.npm-global/bin`), so a bare-command probe
// would not resolve. npm writes the bin as world-readable/executable (mode
// 0755) under the prefix, so a root install into the service user's home is
// reachable by the service user at runtime via the PATH drop-in.
const lobsterBinaryPath = (serviceHome?: string): string =>
  join(npmGlobalPrefix(serviceHome), "bin", "lobster");

const buildNpmEnv = (serviceHome?: string): Record<string, string> => {
  const home = resolveServiceHome(serviceHome);
  return {
    CI: "1",
    HOME: home,
    npm_config_prefix: npmGlobalPrefix(serviceHome),
  };
};

export const detectInstalledLobsterCli = async (input: {
  execRunner: ExecRunner | null;
  packageName: string;
  probeTimeoutMs: number;
  serviceHome?: string | undefined;
}): Promise<{
  binaryPath: string;
  version: string | null;
  commands: string[];
} | null> => {
  if (input.execRunner === null) {
    return null;
  }
  const env = buildNpmEnv(input.serviceHome);
  const binaryPath = lobsterBinaryPath(input.serviceHome);
  const probe = await input.execRunner.run({
    command: binaryPath,
    args: ["commands.list | json"],
    options: {
      timeout: input.probeTimeoutMs,
      env,
    },
  });
  if (probe.exitCode !== 0) {
    return null;
  }
  const parsed = parseJsonSafely(probe.stdout);
  const commands = Array.isArray(parsed)
    ? parsed.filter((entry): entry is string => typeof entry === "string")
    : [];
  const versionResult = await input.execRunner.run({
    command: "npm",
    args: ["list", "-g", input.packageName, "--json", "--depth=0"],
    options: {
      timeout: input.probeTimeoutMs,
      env,
    },
  });
  const versionPayload = parseJsonSafely(versionResult.stdout);
  const dependencyRecord =
    isRecord(versionPayload) && isRecord(versionPayload.dependencies)
      ? versionPayload.dependencies[input.packageName]
      : undefined;
  const version =
    isRecord(dependencyRecord) && typeof dependencyRecord.version === "string"
      ? dependencyRecord.version
      : null;
  return {
    binaryPath,
    version,
    commands,
  };
};

export const ensureLobsterCliInstalled = async (input: {
  execRunner: ExecRunner | null;
  logger: Logger;
  packageName: string;
  version: string;
  installTimeoutMs: number;
  probeTimeoutMs: number;
  requiredCommands: string[];
  serviceHome?: string | undefined;
}): Promise<void> => {
  if (input.execRunner === null) {
    throw {
      code: "LOBSTER_INSTALL_FAILED",
      message: "Exec runner unavailable; cannot install or probe Lobster CLI",
      retryable: false,
    };
  }
  const detected = await detectInstalledLobsterCli({
    execRunner: input.execRunner,
    packageName: input.packageName,
    probeTimeoutMs: input.probeTimeoutMs,
    serviceHome: input.serviceHome,
  });
  if (detected !== null) {
    const versionVerified = detected.version === input.version;
    const commandsVerified =
      detected.commands.length > 0 &&
      input.requiredCommands.every((commandName) => detected.commands.includes(commandName));
    if (versionVerified || commandsVerified) {
      return;
    }
    input.logger.info(
      "Lobster CLI binary found but could not verify version or required commands; reinstalling",
    );
  }

  const installResult = await input.execRunner.run({
    command: "npm",
    args: ["install", "-g", `${input.packageName}@${input.version}`],
    options: {
      timeout: input.installTimeoutMs,
      env: buildNpmEnv(input.serviceHome),
    },
  });
  if (installResult.exitCode !== 0) {
    throw {
      code: "LOBSTER_INSTALL_FAILED",
      message: "npm install for Lobster CLI exited with non-zero status",
      retryable: true,
      details: {
        command: installResult.command,
        exitCode: installResult.exitCode,
        stdout: truncateText(installResult.stdout, 2000),
        stderr: truncateText(installResult.stderr, 4000),
      },
    };
  }

  const verified = await detectInstalledLobsterCli({
    execRunner: input.execRunner,
    packageName: input.packageName,
    probeTimeoutMs: input.probeTimeoutMs,
    serviceHome: input.serviceHome,
  });
  const verifiedByVersion = verified?.version === input.version;
  const verifiedByCommands =
    verified !== null &&
    input.requiredCommands.every((commandName) => verified.commands.includes(commandName));
  if (!verifiedByVersion && !verifiedByCommands) {
    throw {
      code: "LOBSTER_INSTALL_FAILED",
      message: "Lobster CLI installed but required workflow commands are unavailable",
      retryable: true,
      details: {
        requiredCommands: input.requiredCommands,
        detectedCommands: verified?.commands ?? [],
        version: verified?.version ?? null,
      },
    };
  }
};
