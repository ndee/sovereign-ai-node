import type { Logger } from "../logging/logger.js";
import type { ExecResult, ExecRunner } from "./exec.js";

const DEFAULT_INSTALL_SCRIPT_PATH = "/usr/local/lib/sovereign-node/install-docker.sh";
const DOCKER_PROBE_TIMEOUT_MS = 10_000;
const DOCKER_INSTALL_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_CHARS = 4000;

export type DockerRuntimeProbe = {
  cli: boolean;
  compose: boolean;
};

export type DockerRuntimePrepareResult = {
  alreadyPresent: boolean;
  ranInstaller: boolean;
  probe: DockerRuntimeProbe;
};

export interface DockerRuntimePreparer {
  prepare(onProgress?: (note: string) => void | Promise<void>): Promise<DockerRuntimePrepareResult>;
}

export class ShellDockerRuntimePreparer implements DockerRuntimePreparer {
  private readonly installScriptPath: string;

  constructor(
    private readonly execRunner: ExecRunner,
    private readonly logger: Logger,
    options?: { installScriptPath?: string },
  ) {
    this.installScriptPath = options?.installScriptPath ?? DEFAULT_INSTALL_SCRIPT_PATH;
  }

  async prepare(
    onProgress?: (note: string) => void | Promise<void>,
  ): Promise<DockerRuntimePrepareResult> {
    const initial = await this.probe();
    if (initial.cli && initial.compose) {
      await emit(onProgress, "Docker and Compose are already installed");
      return { alreadyPresent: true, ranInstaller: false, probe: initial };
    }

    await emit(
      onProgress,
      `Installing Docker runtime via ${this.installScriptPath} (this can take a few minutes)`,
    );
    this.logger.info(
      {
        installScriptPath: this.installScriptPath,
        probe: initial,
      },
      "Preparing Docker runtime for bundled Matrix install",
    );

    const installer = await this.safeExec("sudo", ["-n", this.installScriptPath], {
      timeout: DOCKER_INSTALL_TIMEOUT_MS,
    });
    if (!installer.ok) {
      throw {
        code: "DOCKER_RUNTIME_INSTALL_FAILED",
        message: `Failed to invoke Docker installer at ${this.installScriptPath}`,
        retryable: false,
        details: {
          installScriptPath: this.installScriptPath,
          spawnError: installer.error,
        },
      };
    }
    if (installer.result.exitCode !== 0) {
      throw {
        code: "DOCKER_RUNTIME_INSTALL_FAILED",
        message: `Docker installer exited ${installer.result.exitCode}`,
        retryable: false,
        details: {
          installScriptPath: this.installScriptPath,
          exitCode: installer.result.exitCode,
          stdout: truncate(installer.result.stdout),
          stderr: truncate(installer.result.stderr),
        },
      };
    }

    const after = await this.probe();
    if (!after.cli || !after.compose) {
      throw {
        code: "DOCKER_RUNTIME_INSTALL_FAILED",
        message: "Docker installer reported success but docker CLI/Compose is still unavailable",
        retryable: false,
        details: {
          installScriptPath: this.installScriptPath,
          probe: after,
          stdout: truncate(installer.result.stdout),
          stderr: truncate(installer.result.stderr),
        },
      };
    }

    await emit(onProgress, "Docker runtime installed");
    return { alreadyPresent: false, ranInstaller: true, probe: after };
  }

  private async probe(): Promise<DockerRuntimeProbe> {
    const cli = await this.safeExec("docker", ["--version"], { timeout: DOCKER_PROBE_TIMEOUT_MS });
    const compose = await this.safeExec("docker", ["compose", "version"], {
      timeout: DOCKER_PROBE_TIMEOUT_MS,
    });
    return {
      cli: cli.ok && cli.result.exitCode === 0,
      compose: compose.ok && compose.result.exitCode === 0,
    };
  }

  private async safeExec(
    command: string,
    args: string[],
    options: { timeout: number },
  ): Promise<{ ok: true; result: ExecResult } | { ok: false; error: string }> {
    try {
      const result = await this.execRunner.run({
        command,
        args,
        options: { timeout: options.timeout },
      });
      return { ok: true, result };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

const emit = async (
  onProgress: ((note: string) => void | Promise<void>) | undefined,
  note: string,
): Promise<void> => {
  if (onProgress === undefined) {
    return;
  }
  await onProgress(note);
};

const truncate = (value: string): string =>
  value.length <= MAX_OUTPUT_CHARS ? value : `${value.slice(0, MAX_OUTPUT_CHARS)}...(truncated)`;
