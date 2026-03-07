import type { Logger } from "../logging/logger.js";
import type { ExecResult, ExecRunner } from "../system/exec.js";

const OPENCLAW_MANAGED_AGENT_COMMAND_TIMEOUT_MS = 90_000;

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
    const staleJobs = jobs.filter((job) =>
      job.name === cronJobId && (job.agentId === undefined || job.agentId === agentId)
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
      const result = await this.execRunner.run({
        command: "openclaw",
        args,
        options: {
          timeout: OPENCLAW_MANAGED_AGENT_COMMAND_TIMEOUT_MS,
          env: {
            CI: "1",
          },
        },
      });
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
    const jsonResult = await this.execRunner.run({
      command: "openclaw",
      args: ["cron", "list", "--json"],
      options: {
        timeout: OPENCLAW_MANAGED_AGENT_COMMAND_TIMEOUT_MS,
        env: {
          CI: "1",
        },
      },
    });
    if (jsonResult.exitCode === 0) {
      const parsed = parseCronListJson(jsonResult.stdout);
      if (parsed !== null) {
        return parsed;
      }
    }

    const textResult = await this.execRunner.run({
      command: "openclaw",
      args: ["cron", "list"],
      options: {
        timeout: OPENCLAW_MANAGED_AGENT_COMMAND_TIMEOUT_MS,
        env: {
          CI: "1",
        },
      },
    });
    if (textResult.exitCode !== 0) {
      throw {
        code: "MANAGED_AGENT_REGISTER_FAILED",
        message: "Failed to list existing OpenClaw cron jobs",
        retryable: true,
        details: {
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
    return parseCronListTable(textResult.stdout);
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
  const announceArgs = input.cron.announceRoomId === undefined
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
      return [{
        id: job.id,
        ...(typeof job.name === "string" ? { name: job.name } : {}),
        ...(typeof job.agentId === "string" ? { agentId: job.agentId } : {}),
      }];
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
      const match = line.match(
        /^([0-9a-f-]{36})\s+(\S+)(?:\s+.+?\s+(?:isolated|main)\s+(\S+))?$/i,
      );
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
