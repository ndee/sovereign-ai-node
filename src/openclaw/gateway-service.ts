import type { Logger } from "../logging/logger.js";
import type { ExecResult, ExecRunner } from "../system/exec.js";

const OPENCLAW_GATEWAY_COMMAND_TIMEOUT_MS = 120_000;

export type GatewayInstallOptions = {
  force?: boolean;
};

export interface OpenClawGatewayServiceManager {
  install(options?: GatewayInstallOptions): Promise<void>;
  start(): Promise<void>;
  restart(): Promise<void>;
}

export class ShellOpenClawGatewayServiceManager
  implements OpenClawGatewayServiceManager
{
  constructor(
    private readonly execRunner: ExecRunner,
    private readonly logger: Logger,
  ) {}

  async install(options?: GatewayInstallOptions): Promise<void> {
    const args = ["gateway", "install"];
    if (options?.force) {
      args.push("--force");
    }
    const result = await this.execRunner.run({
      command: "openclaw",
      args,
      options: {
        timeout: OPENCLAW_GATEWAY_COMMAND_TIMEOUT_MS,
        env: {
          CI: "1",
        },
      },
    });
    ensureSuccess(result, "OPENCLAW_GATEWAY_INSTALL_FAILED");
    this.logger.info({ args }, "OpenClaw gateway service install completed");
  }

  async start(): Promise<void> {
    const args = ["gateway", "start"];
    const result = await this.execRunner.run({
      command: "openclaw",
      args,
      options: {
        timeout: OPENCLAW_GATEWAY_COMMAND_TIMEOUT_MS,
        env: {
          CI: "1",
        },
      },
    });
    ensureSuccess(result, "OPENCLAW_GATEWAY_START_FAILED");
    this.logger.info("OpenClaw gateway service start completed");
  }

  async restart(): Promise<void> {
    const args = ["gateway", "restart"];
    const result = await this.execRunner.run({
      command: "openclaw",
      args,
      options: {
        timeout: OPENCLAW_GATEWAY_COMMAND_TIMEOUT_MS,
        env: {
          CI: "1",
        },
      },
    });
    ensureSuccess(result, "OPENCLAW_GATEWAY_RESTART_FAILED");
    this.logger.info("OpenClaw gateway service restart completed");
  }
}

const ensureSuccess = (result: ExecResult, code: string): void => {
  if (result.exitCode === 0) {
    return;
  }

  throw {
    code,
    message: "OpenClaw gateway command exited with non-zero status",
    retryable: true,
    details: {
      command: result.command,
      exitCode: result.exitCode,
      stderr: truncateText(result.stderr, 4000),
      stdout: truncateText(result.stdout, 2000),
    },
  };
};

const truncateText = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}...(truncated)`;
};
