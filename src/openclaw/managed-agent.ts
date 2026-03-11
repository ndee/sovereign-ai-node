import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";

import type { Logger } from "../logging/logger.js";
import type { ExecResult, ExecRunner } from "../system/exec.js";

const OPENCLAW_MANAGED_AGENT_COMMAND_TIMEOUT_MS = 90_000;
const OPENCLAW_GATEWAY_RETRY_ATTEMPTS = 15;
const OPENCLAW_GATEWAY_RETRY_DELAY_MS = 2_000;
const MANAGED_OPENCLAW_ENV_KEYS = [
  "OPENCLAW_HOME",
  "OPENCLAW_CONFIG",
  "OPENCLAW_CONFIG_PATH",
  "SOVEREIGN_NODE_CONFIG",
] as const;

export type ManagedAgentRegistrationInput = {
  agentId: string;
  workspaceDir: string;
  cron?: {
    id: string;
    every: string;
    message: string;
    announceRoomId?: string;
    session?: "isolated";
  };
};

export type ManagedAgentRegistrationResult = {
  agentId: string;
  workspaceDir: string;
  agentCommand: string;
  cronJobId?: string;
  cronCommand?: string;
};

type CronListJob = {
  id: string;
  name?: string;
  agentId?: string;
};

type PreferredManagedOpenClawUser =
  | {
      mode: "service-user";
      user: string;
    }
  | {
      mode: "sudo-user-bus";
      user: string;
      uid: string;
    };

export interface OpenClawManagedAgentRegistrar {
  register(input: ManagedAgentRegistrationInput): Promise<ManagedAgentRegistrationResult>;
}

export class ShellOpenClawManagedAgentRegistrar implements OpenClawManagedAgentRegistrar {
  constructor(
    private readonly execRunner: ExecRunner,
    private readonly logger: Logger,
  ) {}

  async register(input: ManagedAgentRegistrationInput): Promise<ManagedAgentRegistrationResult> {
    const agentCommandResult = await this.runCommandAlternatives({
      label: `${input.agentId}-agent`,
      commands: [
        ["agents", "add", input.agentId, "--workspace", input.workspaceDir],
        ["agents", "create", input.agentId, "--workspace", input.workspaceDir],
        ["agents", "upsert", input.agentId, "--workspace", input.workspaceDir],
        ["agents", "upsert", "--id", input.agentId, "--workspace", input.workspaceDir],
        ["agents", "add", "--id", input.agentId, "--workspace", input.workspaceDir],
        ["agents", "create", "--id", input.agentId, "--workspace", input.workspaceDir],
      ],
      allowAlreadyExists: true,
    });

    let cronCommandResult: ExecResult | undefined;
    if (input.cron !== undefined) {
      await this.removeExistingCronJobs(input.agentId, input.cron.id);
      cronCommandResult = await this.runCommandAlternatives({
        label: `${input.agentId}-cron`,
        commands: buildCronCommands(input),
        allowAlreadyExists: true,
      });
    }

    this.logger.info(
      {
        agentId: input.agentId,
        workspaceDir: input.workspaceDir,
        cronJobId: input.cron?.id,
      },
      "OpenClaw managed agent registration completed",
    );

    return {
      agentId: input.agentId,
      workspaceDir: input.workspaceDir,
      agentCommand: agentCommandResult.command,
      ...(input.cron === undefined
        ? {}
        : {
            cronJobId: input.cron.id,
            ...(cronCommandResult === undefined ? {} : { cronCommand: cronCommandResult.command }),
          }),
    };
  }

  private async removeExistingCronJobs(agentId: string, cronJobId: string): Promise<void> {
    const jobs = await this.listCronJobs();
    const staleJobs = jobs.filter(
      (job) => job.name === cronJobId && (job.agentId === undefined || job.agentId === agentId),
    );
    for (const job of staleJobs) {
      const result = await this.execRunner.run({
        command: "openclaw",
        args: ["cron", "rm", job.id],
        options: {
          timeout: OPENCLAW_MANAGED_AGENT_COMMAND_TIMEOUT_MS,
          env: {
            CI: "1",
          },
        },
      });
      if (result.exitCode !== 0 && !isNotFoundResult(result)) {
        throw {
          code: "MANAGED_AGENT_REGISTER_FAILED",
          message: `Failed to remove existing OpenClaw cron job ${job.id}`,
          retryable: true,
          details: {
            command: result.command,
            exitCode: result.exitCode,
            stderr: truncateText(result.stderr, 1200),
            stdout: truncateText(result.stdout, 1200),
          },
        };
      }
    }
  }

  private async runCommandAlternatives(input: {
    label: string;
    commands: string[][];
    allowAlreadyExists: boolean;
  }): Promise<ExecResult> {
    const failures: {
      command: string;
      exitCode: number;
      stderr: string;
      stdout: string;
    }[] = [];
    for (const args of input.commands) {
      const result = await this.runOpenClawCommandWithGatewayRetry(args);
      if (result.exitCode === 0) {
        return result;
      }
      if (input.allowAlreadyExists && isAlreadyExistsResult(result)) {
        return result;
      }
      failures.push({
        command: result.command,
        exitCode: result.exitCode,
        stderr: truncateText(result.stderr, 1200),
        stdout: truncateText(result.stdout, 1200),
      });
    }
    throw {
      code: "MANAGED_AGENT_REGISTER_FAILED",
      message: `OpenClaw ${input.label} registration commands failed`,
      retryable: true,
      details: {
        failures,
      },
    };
  }

  private async listCronJobs(): Promise<CronListJob[]> {
    const jsonResult = await this.runOpenClawCommandWithGatewayRetry(["cron", "list", "--json"]);
    if (jsonResult.exitCode === 0) {
      const parsed = parseCronListJson(jsonResult.stdout);
      if (parsed !== null) {
        return parsed;
      }
    }

    const textResult = await this.runOpenClawCommandWithGatewayRetry(["cron", "list"]);
    if (textResult.exitCode === 0) {
      return parseCronListTable(textResult.stdout);
    }

    throw {
      code: "MANAGED_AGENT_REGISTER_FAILED",
      message: "Failed to list existing OpenClaw cron jobs",
      retryable: true,
      details: {
        attempts: OPENCLAW_GATEWAY_RETRY_ATTEMPTS,
        jsonCommand: jsonResult.command,
        jsonExitCode: jsonResult.exitCode,
        jsonStdout: truncateText(jsonResult.stdout, 1200),
        jsonStderr: truncateText(jsonResult.stderr, 1200),
        textCommand: textResult.command,
        textExitCode: textResult.exitCode,
        textStdout: truncateText(textResult.stdout, 1200),
        textStderr: truncateText(textResult.stderr, 1200),
      },
    };
  }

  private async runOpenClawCommandWithGatewayRetry(args: string[]): Promise<ExecResult> {
    let result: ExecResult | null = null;
    const preferredUser = resolvePreferredManagedOpenClawUser();
    for (let attempt = 1; attempt <= OPENCLAW_GATEWAY_RETRY_ATTEMPTS; attempt += 1) {
      if (preferredUser !== null) {
        const delegatedResult = await this.runOpenClawCommandViaPreferredUser(args, preferredUser);
        result = delegatedResult;
        if (delegatedResult.exitCode === 0 || !isGatewayUnavailableResult(delegatedResult)) {
          return delegatedResult;
        }
      } else {
        const primaryResult = await this.execRunner.run({
          command: "openclaw",
          args,
          options: {
            timeout: OPENCLAW_MANAGED_AGENT_COMMAND_TIMEOUT_MS,
            env: {
              CI: "1",
            },
          },
        });
        result = primaryResult;
        if (primaryResult.exitCode === 0) {
          return primaryResult;
        }

        const sudoUserRetry = await this.retryGatewayCommandViaSudoUser(args, primaryResult);
        if (sudoUserRetry !== null) {
          result = sudoUserRetry;
          if (sudoUserRetry.exitCode === 0 || !isGatewayUnavailableResult(sudoUserRetry)) {
            return sudoUserRetry;
          }
        } else if (!isGatewayUnavailableResult(primaryResult)) {
          return primaryResult;
        }
      }
      if (attempt >= OPENCLAW_GATEWAY_RETRY_ATTEMPTS) {
        break;
      }
      this.logger.warn(
        {
          command: result.command,
          attempt,
          maxAttempts: OPENCLAW_GATEWAY_RETRY_ATTEMPTS,
          exitCode: result.exitCode,
        },
        "OpenClaw gateway temporarily unavailable; retrying command",
      );
      await delay(OPENCLAW_GATEWAY_RETRY_DELAY_MS);
    }

    return (
      result ?? {
        command: `openclaw ${args.join(" ")}`,
        exitCode: 1,
        stdout: "",
        stderr: "openclaw command did not execute",
      }
    );
  }

  private async retryGatewayCommandViaSudoUser(
    args: string[],
    result: ExecResult,
  ): Promise<ExecResult | null> {
    if (!isGatewayUnavailableResult(result)) {
      return null;
    }

    const fallback = resolveSudoUserFallback();
    if (fallback === null) {
      return null;
    }

    const retry = await this.runOpenClawCommandViaSudoUser(args, fallback);
    if (retry.exitCode === 0) {
      this.logger.warn(
        {
          user: fallback.user,
          uid: fallback.uid,
          command: result.command,
        },
        "OpenClaw managed-agent command failed as root; retry succeeded via invoking sudo user",
      );
    }

    return retry;
  }

  private async runOpenClawCommandViaSudoUser(
    args: string[],
    fallback: { user: string; uid: string },
  ): Promise<ExecResult> {
    return await this.runOpenClawCommandViaPreferredUser(args, {
      mode: "sudo-user-bus",
      user: fallback.user,
      uid: fallback.uid,
    });
  }

  private async runOpenClawCommandViaPreferredUser(
    args: string[],
    preferredUser: PreferredManagedOpenClawUser,
  ): Promise<ExecResult> {
    const sudoGatewayCommand = (await resolveExecutablePath("openclaw")) ?? "openclaw";
    const sudoGatewayEnv =
      preferredUser.mode === "sudo-user-bus"
        ? [
            "CI=1",
            `XDG_RUNTIME_DIR=/run/user/${preferredUser.uid}`,
            `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${preferredUser.uid}/bus`,
            ...resolveManagedOpenClawEnvArgs(),
          ]
        : ["CI=1", ...resolveManagedOpenClawEnvArgs()];
    return await this.execRunner.run({
      command: "sudo",
      args: [
        "-u",
        preferredUser.user,
        "--",
        "/usr/bin/env",
        ...sudoGatewayEnv,
        process.execPath,
        sudoGatewayCommand,
        ...args,
      ],
      options: {
        timeout: OPENCLAW_MANAGED_AGENT_COMMAND_TIMEOUT_MS,
      },
    });
  }
}

const buildCronCommands = (input: ManagedAgentRegistrationInput): string[][] => {
  if (input.cron === undefined) {
    return [];
  }
  const sharedArgs = [
    "cron",
    "add",
    "--name",
    input.cron.id,
    "--agent",
    input.agentId,
    "--every",
    input.cron.every,
    "--session",
    input.cron.session ?? "isolated",
    "--message",
    input.cron.message,
  ];
  const announceArgs =
    input.cron.announceRoomId === undefined
      ? []
      : ["--announce", "--channel", "matrix", "--to", input.cron.announceRoomId];
  return [
    [...sharedArgs, ...announceArgs, "--replace"],
    [...sharedArgs, ...announceArgs],
    [...sharedArgs, "--replace"],
    [...sharedArgs],
  ];
};

const isAlreadyExistsResult = (result: ExecResult): boolean =>
  /already\s+exists|exists/i.test(`${result.stderr}\n${result.stdout}`);

const isNotFoundResult = (result: ExecResult): boolean =>
  /not\s+found|unknown\s+job|no\s+such/i.test(`${result.stderr}\n${result.stdout}`);

const isGatewayUnavailableResult = (result: ExecResult): boolean =>
  isGatewayUnavailableOutput(`${result.stderr}\n${result.stdout}`);

const isGatewayUnavailableOutput = (value: string): boolean =>
  /gateway\s+closed|gateway\s+unavailable|abnormal\s+closure|econnrefused|connect\s+econnrefused|socket\s+hang\s+up/i.test(
    value.toLowerCase(),
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

const resolvePreferredManagedOpenClawUser = (): PreferredManagedOpenClawUser | null => {
  const serviceUser = process.env.SOVEREIGN_NODE_SERVICE_USER?.trim() ?? "";
  if (serviceUser.length === 0 || serviceUser === "root") {
    return null;
  }

  const fallback = resolveSudoUserFallback();
  if (fallback !== null && serviceUser === fallback.user) {
    return {
      mode: "sudo-user-bus",
      user: fallback.user,
      uid: fallback.uid,
    };
  }

  if (typeof process.getuid === "function" && process.getuid() === 0) {
    return {
      mode: "service-user",
      user: serviceUser,
    };
  }

  return null;
};

const delay = async (ms: number): Promise<void> =>
  new Promise((resolveTimeout) => {
    setTimeout(resolveTimeout, ms);
  });

const parseCronListJson = (value: string): CronListJob[] | null => {
  try {
    const parsed = JSON.parse(value) as {
      jobs?: Array<{
        id?: unknown;
        name?: unknown;
        agentId?: unknown;
      }>;
    };
    if (!Array.isArray(parsed.jobs)) {
      return null;
    }
    return parsed.jobs.flatMap((job) => {
      if (typeof job.id !== "string" || job.id.length === 0) {
        return [];
      }
      return [
        {
          id: job.id,
          ...(typeof job.name === "string" ? { name: job.name } : {}),
          ...(typeof job.agentId === "string" ? { agentId: job.agentId } : {}),
        },
      ];
    });
  } catch {
    return null;
  }
};

const parseCronListTable = (value: string): CronListJob[] =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[0-9a-f]{8}-[0-9a-f-]{27}\s+/i.test(line))
    .map((line) => {
      const match = line.match(/^([0-9a-f-]{36})\s+(\S+)(?:\s+.+?\s+(?:isolated|main)\s+(\S+))?$/i);
      if (match === null) {
        const id = line.split(/\s+/, 1)[0];
        if (id === undefined || id.length === 0) {
          return null;
        }
        return {
          id,
        };
      }
      const [, id, name, agentId] = match;
      if (id === undefined || id.length === 0) {
        return null;
      }
      return {
        id,
        ...(name === undefined ? {} : { name }),
        ...(agentId === undefined ? {} : { agentId }),
      };
    })
    .filter((job): job is CronListJob => job !== null);

const truncateText = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}...(truncated)`;
};
