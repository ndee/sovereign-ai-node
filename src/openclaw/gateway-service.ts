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
    const result = await this.runGatewayCommandWithFallback(args);
    ensureSuccess(result, "OPENCLAW_GATEWAY_INSTALL_FAILED");
    this.logger.info({ args }, "OpenClaw gateway service install completed");
  }

  async start(): Promise<void> {
    const args = ["gateway", "start"];
    const result = await this.runGatewayCommandWithFallback(args);
    ensureSuccess(result, "OPENCLAW_GATEWAY_START_FAILED");
    this.logger.info("OpenClaw gateway service start completed");
  }

  async restart(): Promise<void> {
    const args = ["gateway", "restart"];
    const result = await this.runGatewayCommandWithFallback(args);
    ensureSuccess(result, "OPENCLAW_GATEWAY_RESTART_FAILED");
    this.logger.info("OpenClaw gateway service restart completed");
  }

  private async runGatewayCommandWithFallback(args: string[]): Promise<ExecResult> {
    const primary = await this.execRunner.run({
      command: "openclaw",
      args,
      options: {
        timeout: OPENCLAW_GATEWAY_COMMAND_TIMEOUT_MS,
        env: {
          CI: "1",
        },
      },
    });
    if (primary.exitCode === 0) {
      return primary;
    }

    const fallback = resolveSudoUserFallback();
    if (fallback === null || !looksLikeSystemdUserBusError(primary)) {
      return primary;
    }

    const retry = await this.execRunner.run({
      command: "sudo",
      args: ["-u", fallback.user, "--", "openclaw", ...args],
      options: {
        timeout: OPENCLAW_GATEWAY_COMMAND_TIMEOUT_MS,
        env: {
          CI: "1",
          XDG_RUNTIME_DIR: `/run/user/${fallback.uid}`,
          DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${fallback.uid}/bus`,
        },
      },
    });
    if (retry.exitCode === 0) {
      this.logger.warn(
        {
          user: fallback.user,
          uid: fallback.uid,
          command: primary.command,
        },
        "OpenClaw gateway command failed as root; retry succeeded via invoking sudo user",
      );
      return retry;
    }

    return retry;
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

const looksLikeSystemdUserBusError = (result: ExecResult): boolean =>
  /systemctl --user unavailable|failed to connect to bus|no medium found/i.test(
    `${result.stderr}\n${result.stdout}`,
  );

const resolveSudoUserFallback = (): { user: string; uid: string } | null => {
  const user = process.env.SUDO_USER?.trim() ?? "";
  const uid = process.env.SUDO_UID?.trim() ?? "";
  if (user.length === 0 || user === "root") {
    return null;
  }
  if (!/^[0-9]+$/.test(uid)) {
    return null;
  }
  return { user, uid };
};
