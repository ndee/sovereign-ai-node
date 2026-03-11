import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";

import type { Logger } from "../logging/logger.js";
import type { ExecResult, ExecRunner } from "../system/exec.js";

const OPENCLAW_GATEWAY_COMMAND_TIMEOUT_MS = 120_000;
const MANAGED_OPENCLAW_ENV_KEYS = [
  "OPENCLAW_HOME",
  "OPENCLAW_CONFIG",
  "OPENCLAW_CONFIG_PATH",
  "SOVEREIGN_NODE_CONFIG",
] as const;

export type GatewayInstallOptions = {
  force?: boolean;
};

export interface OpenClawGatewayServiceManager {
  install(options?: GatewayInstallOptions): Promise<void>;
  start(): Promise<void>;
  restart(): Promise<void>;
}

export class ShellOpenClawGatewayServiceManager implements OpenClawGatewayServiceManager {
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

    const sudoGatewayCommand = (await resolveExecutablePath("openclaw")) ?? "openclaw";
    const sudoGatewayEnv = [
      "CI=1",
      `XDG_RUNTIME_DIR=/run/user/${fallback.uid}`,
      `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${fallback.uid}/bus`,
      ...resolveManagedOpenClawEnvArgs(),
    ];
    const retry = await this.execRunner.run({
      command: "sudo",
      args: [
        "-u",
        fallback.user,
        "--",
        "/usr/bin/env",
        ...sudoGatewayEnv,
        process.execPath,
        sudoGatewayCommand,
        ...args,
      ],
      options: {
        timeout: OPENCLAW_GATEWAY_COMMAND_TIMEOUT_MS,
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

const resolveExecutablePath = async (command: string): Promise<string | null> => {
  if (command.includes("/")) {
    return command;
  }

  const pathValue = process.env.PATH ?? "";
  for (const entry of pathValue.split(delimiter)) {
    if (entry.length === 0) {
      continue;
    }
    const candidate = join(entry, command);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {}
  }

  return null;
};

const resolveManagedOpenClawEnvArgs = (): string[] =>
  MANAGED_OPENCLAW_ENV_KEYS.flatMap((key) => {
    const value = process.env[key];
    return typeof value === "string" && value.length > 0 ? [`${key}=${value}`] : [];
  });

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
