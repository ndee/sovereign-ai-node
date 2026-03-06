#!/usr/bin/env node

import { Command, InvalidArgumentError } from "commander";

import { writeCliError, writeCliSuccess } from "../cli/output.js";
import {
  type ImapReadMailResult,
  type ImapSearchMailResult,
  imapReadMailResultSchema,
  imapSearchMailResultSchema,
} from "../contracts/tool.js";
import { ImapReadonlyToolService } from "../tooling/imap-readonly.js";

const parsePositiveInteger = (value: string): number => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("Expected a positive integer");
  }
  return parsed;
};

const renderHeaderLine = (label: string, value: string | undefined): string | null =>
  value === undefined || value.length === 0 ? null : `${label}: ${value}`;

const formatSearchResult = (result: ImapSearchMailResult): string => {
  if (result.messages.length === 0) {
    return `No messages matched '${result.query}' in ${result.mailbox}.`;
  }

  const lines = [
    `Search results for '${result.query}' in ${result.mailbox}: ${result.totalMatches} match(es), showing ${result.messages.length}.`,
  ];
  for (const message of result.messages) {
    const date = message.date ?? "unknown date";
    const from = message.from[0] ?? "(unknown sender)";
    const subject = message.subject ?? "(no subject)";
    lines.push(`- UID ${message.uid} | ${date} | ${from} | ${subject}`);
  }
  return lines.join("\n");
};

const formatReadResult = (result: ImapReadMailResult): string => {
  const lines = [
    `Message UID ${result.message.uid} in ${result.mailbox} (selected by ${result.selectedBy}).`,
  ];
  const headerLines = [
    renderHeaderLine("Subject", result.message.subject),
    renderHeaderLine("Message-ID", result.message.messageId),
    renderHeaderLine("Date", result.message.date),
    renderHeaderLine("From", result.message.from.join(", ")),
    renderHeaderLine("To", result.message.to.join(", ")),
    renderHeaderLine("Cc", result.message.cc.join(", ")),
    renderHeaderLine("Flags", result.message.flags.join(", ")),
  ].filter((line): line is string => line !== null);
  lines.push(...headerLines);

  if (result.message.attachments.length > 0) {
    lines.push("Attachments:");
    for (const attachment of result.message.attachments) {
      lines.push(
        `- ${attachment.filename ?? "(unnamed)"} | ${attachment.mimeType} | ${attachment.disposition ?? "n/a"} | ${attachment.sizeBytes} bytes`,
      );
    }
  }

  if (result.message.bodyParseWarning !== undefined) {
    lines.push(`Body parse warning: ${result.message.bodyParseWarning}`);
  }

  lines.push("Text:");
  lines.push(result.message.text.length > 0 ? result.message.text : "(empty)");
  return lines.join("\n");
};

const main = async (): Promise<void> => {
  const toolService = new ImapReadonlyToolService();
  const program = new Command()
    .name("sovereign-tool")
    .description("Execute trusted Sovereign tool instances");

  program
    .command("imap-search-mail")
    .requiredOption("--instance <id>", "Tool instance ID")
    .requiredOption("--query <query>", "IMAP search query")
    .option("--limit <count>", "Maximum messages to return", parsePositiveInteger)
    .option("--config-path <path>", "Override Sovereign runtime config path")
    .option("--json", "Emit JSON output")
    .action(async (opts: {
      instance: string;
      query: string;
      limit?: number;
      configPath?: string;
      json?: boolean;
    }) => {
      const command = "imap-search-mail";
      try {
        const result = await toolService.searchMail({
          instanceId: opts.instance,
          query: opts.query,
          ...(opts.limit === undefined ? {} : { limit: opts.limit }),
          ...(opts.configPath === undefined ? {} : { configPath: opts.configPath }),
        });
        if (opts.json) {
          writeCliSuccess(command, result, imapSearchMailResultSchema, true);
          return;
        }
        process.stdout.write(`${formatSearchResult(result)}\n`);
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });

  program
    .command("imap-read-mail")
    .requiredOption("--instance <id>", "Tool instance ID")
    .requiredOption("--message-id <selector>", "UID or RFC 5322 Message-ID")
    .option("--config-path <path>", "Override Sovereign runtime config path")
    .option("--json", "Emit JSON output")
    .action(async (opts: {
      instance: string;
      messageId: string;
      configPath?: string;
      json?: boolean;
    }) => {
      const command = "imap-read-mail";
      try {
        const result = await toolService.readMail({
          instanceId: opts.instance,
          messageId: opts.messageId,
          ...(opts.configPath === undefined ? {} : { configPath: opts.configPath }),
        });
        if (opts.json) {
          writeCliSuccess(command, result, imapReadMailResultSchema, true);
          return;
        }
        process.stdout.write(`${formatReadResult(result)}\n`);
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });

  await program.parseAsync(process.argv);
};

main().catch((error) => {
  const normalized = error as Error;
  process.stderr.write(
    `sovereign-tool bootstrap failure: ${
      normalized instanceof Error ? normalized.message : String(normalized)
    }\n`,
  );
  process.exitCode = 1;
});
