import type { Logger } from "../logging/logger.js";
import type { ExecResult, ExecRunner } from "../system/exec.js";

const OPENCLAW_MAIL_SENTINEL_COMMAND_TIMEOUT_MS = 90_000;

export type MailSentinelRegistrationInput = {
  agentId: string;
  workspaceDir: string;
  cronJobName: string;
  pollInterval: string;
  lookbackWindow: string;
  roomId: string;
};

export type MailSentinelRegistrationResult = {
  agentId: string;
  cronJobId: string;
  workspaceDir: string;
  agentCommand: string;
  cronCommand: string;
};

export interface OpenClawMailSentinelRegistrar {
  register(input: MailSentinelRegistrationInput): Promise<MailSentinelRegistrationResult>;
}

export class ShellOpenClawMailSentinelRegistrar
  implements OpenClawMailSentinelRegistrar
{
  constructor(
    private readonly execRunner: ExecRunner,
    private readonly logger: Logger,
  ) {}

  async register(
    input: MailSentinelRegistrationInput,
  ): Promise<MailSentinelRegistrationResult> {
    const agentCommandResult = await this.runCommandAlternatives({
      label: "mail-sentinel-agent",
      commands: [
        [
          "agents",
          "add",
          input.agentId,
          "--workspace",
          input.workspaceDir,
        ],
        [
          "agents",
          "create",
          input.agentId,
          "--workspace",
          input.workspaceDir,
        ],
        [
          "agents",
          "upsert",
          input.agentId,
          "--workspace",
          input.workspaceDir,
        ],
        [
          "agents",
          "upsert",
          "--id",
          input.agentId,
          "--workspace",
          input.workspaceDir,
        ],
        [
          "agents",
          "add",
          "--id",
          input.agentId,
          "--workspace",
          input.workspaceDir,
        ],
        [
          "agents",
          "create",
          "--id",
          input.agentId,
          "--workspace",
          input.workspaceDir,
        ],
      ],
      allowAlreadyExists: true,
    });

    const cronMessage = [
      "Poll configured mailboxes using read-only IMAP tools, classify new messages",
      `with lookback window ${input.lookbackWindow}, send alerts to room ${input.roomId},`,
      "and update local checkpoint state.",
    ].join(" ");
    const cronCommandResult = await this.runCommandAlternatives({
      label: "mail-sentinel-cron",
      commands: [
        [
          "cron",
          "add",
          "--name",
          input.cronJobName,
          "--every",
          input.pollInterval,
          "--session",
          "isolated",
          "--message",
          cronMessage,
          "--replace",
        ],
        [
          "cron",
          "add",
          "--name",
          input.cronJobName,
          "--every",
          input.pollInterval,
          "--session",
          "isolated",
          "--message",
          cronMessage,
        ],
      ],
      allowAlreadyExists: true,
    });

    this.logger.info(
      {
        agentId: input.agentId,
        cronJobName: input.cronJobName,
        workspaceDir: input.workspaceDir,
      },
      "OpenClaw Mail Sentinel registration completed",
    );

    return {
      agentId: input.agentId,
      cronJobId: input.cronJobName,
      workspaceDir: input.workspaceDir,
      agentCommand: agentCommandResult.command,
      cronCommand: cronCommandResult.command,
    };
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
          timeout: OPENCLAW_MAIL_SENTINEL_COMMAND_TIMEOUT_MS,
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
      code: "MAIL_SENTINEL_REGISTER_FAILED",
      message: `OpenClaw ${input.label} registration commands failed`,
      retryable: true,
      details: {
        failures,
      },
    };
  }
}

const isAlreadyExistsResult = (result: ExecResult): boolean =>
  /already\s+exists|exists/i.test(`${result.stderr}\n${result.stdout}`);

const truncateText = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}...(truncated)`;
};
