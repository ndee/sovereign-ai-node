import type { Logger } from "../logging/logger.js";
import type { ExecRunner } from "../system/exec.js";
import { isRecord, parseJsonSafely, truncateText } from "./real-service-shared.js";

export const detectInstalledLobsterCli = async (input: {
  execRunner: ExecRunner | null;
  packageName: string;
  probeTimeoutMs: number;
}): Promise<{
  binaryPath: string;
  version: string | null;
  commands: string[];
} | null> => {
  if (input.execRunner === null) {
    return null;
  }
  const probe = await input.execRunner.run({
    command: "lobster",
    args: ["commands.list | json"],
    options: {
      timeout: input.probeTimeoutMs,
      env: {
        CI: "1",
      },
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
      env: {
        CI: "1",
      },
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
    binaryPath: "lobster",
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
      env: {
        CI: "1",
      },
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
