#!/usr/bin/env node

import { Command, InvalidArgumentError } from "commander";

import { writeCliError, writeCliSuccess } from "../cli/output.js";
import {
  type GuardedJsonStateListResult,
  type GuardedJsonStateMutationResult,
  type GuardedJsonStateShowResult,
  guardedJsonStateListResultSchema,
  guardedJsonStateMutationResultSchema,
  guardedJsonStateShowResultSchema,
  type ImapReadMailResult,
  type ImapSearchMailResult,
  imapReadMailResultSchema,
  imapSearchMailResultSchema,
} from "../contracts/tool.js";
import {
  GuardedJsonStateToolService,
  normalizeMatrixActorUserId,
  resolveMatrixActorFromSessionStatus,
} from "../tooling/guarded-json-state.js";
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

const formatGuardedStateShowResult = (result: GuardedJsonStateShowResult): string =>
  `State ${result.statePath} loaded via ${result.instanceId}.`;

const formatGuardedStateListResult = (result: GuardedJsonStateListResult): string =>
  `${result.entity}: ${String(result.count)} item(s)`;

const formatGuardedStateMutationResult = (result: GuardedJsonStateMutationResult): string => {
  if (result.action === "delete-self") {
    return `${result.entity} ${result.id}: ${result.deleted === true ? "deleted" : "not found"}`;
  }
  return `${result.entity} ${result.id}: ${result.created === true ? "created" : "updated"}`;
};

const collectOption = (value: string, previous: string[] = []): string[] => [...previous, value];

const parseFieldAssignments = (values: string[] | undefined): Record<string, string> => {
  const entries = (values ?? []).map((entry) => {
    const separatorIndex = entry.indexOf("=");
    if (separatorIndex <= 0 || separatorIndex === entry.length - 1) {
      throw new InvalidArgumentError("Expected key=value");
    }
    return [entry.slice(0, separatorIndex), entry.slice(separatorIndex + 1)] as const;
  });
  return Object.fromEntries(entries);
};

const parseArrayFieldAssignments = (values: string[] | undefined): Record<string, string[]> => {
  const grouped = new Map<string, string[]>();
  for (const entry of values ?? []) {
    const separatorIndex = entry.indexOf("=");
    if (separatorIndex <= 0 || separatorIndex === entry.length - 1) {
      throw new InvalidArgumentError("Expected key=value");
    }
    const key = entry.slice(0, separatorIndex);
    const value = entry.slice(separatorIndex + 1);
    const existing = grouped.get(key) ?? [];
    existing.push(value);
    grouped.set(key, existing);
  }
  return Object.fromEntries(grouped.entries());
};

const parseInputJsonAssignments = (
  value: string | undefined,
): {
  fields: Record<string, string>;
  arrayFields: Record<string, string[]>;
} => {
  if (value === undefined) {
    return {
      fields: {},
      arrayFields: {},
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new InvalidArgumentError("Expected --input-json to be a valid JSON object");
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidArgumentError("Expected --input-json to be a JSON object");
  }

  const fields: Record<string, string> = {};
  const arrayFields: Record<string, string[]> = {};
  const isScalar = (entry: unknown): entry is string | number | boolean =>
    typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean";
  for (const [key, entry] of Object.entries(parsed)) {
    if (isScalar(entry)) {
      fields[key] = String(entry);
      continue;
    }
    if (Array.isArray(entry) && entry.every((item) => isScalar(item))) {
      arrayFields[key] = entry.map((item) => String(item));
      continue;
    }
    throw new InvalidArgumentError(
      `Expected --input-json.${key} to be a scalar or an array of scalars`,
    );
  }

  return {
    fields,
    arrayFields,
  };
};

const resolveActorFromMutationOptions = (opts: {
  actor?: string;
  sessionKey?: string;
  originFrom?: string;
}): string => {
  const fromActor = opts.actor === undefined ? null : normalizeMatrixActorUserId(opts.actor);
  const fromSessionStatus =
    opts.sessionKey === undefined && opts.originFrom === undefined
      ? null
      : resolveMatrixActorFromSessionStatus({
          ...(opts.sessionKey === undefined ? {} : { sessionKey: opts.sessionKey }),
          ...(opts.originFrom === undefined ? {} : { originFrom: opts.originFrom }),
        });

  if (fromActor !== null && fromSessionStatus !== null && fromActor !== fromSessionStatus) {
    throw new InvalidArgumentError("Expected --actor to match the current session_status actor");
  }
  if (fromActor !== null) {
    return fromActor;
  }
  if (fromSessionStatus !== null) {
    return fromSessionStatus;
  }
  throw new InvalidArgumentError("Expected --actor or current session_status metadata");
};

const resolveMutationInput = (opts: {
  inputJson?: string;
  field?: string[];
  arrayItem?: string[];
}): {
  fields: Record<string, string>;
  arrayFields: Record<string, string[]>;
} => {
  if (
    opts.inputJson !== undefined &&
    ((opts.field?.length ?? 0) > 0 || (opts.arrayItem?.length ?? 0) > 0)
  ) {
    throw new InvalidArgumentError("Use either --input-json or --field/--array-item, not both");
  }
  if (opts.inputJson !== undefined) {
    return parseInputJsonAssignments(opts.inputJson);
  }
  return {
    fields: parseFieldAssignments(opts.field),
    arrayFields: parseArrayFieldAssignments(opts.arrayItem),
  };
};

const main = async (): Promise<void> => {
  const toolService = new ImapReadonlyToolService();
  const guardedStateService = new GuardedJsonStateToolService();
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
    .action(
      async (opts: {
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
      },
    );

  program
    .command("imap-read-mail")
    .requiredOption("--instance <id>", "Tool instance ID")
    .requiredOption("--message-id <selector>", "UID or RFC 5322 Message-ID")
    .option("--config-path <path>", "Override Sovereign runtime config path")
    .option("--json", "Emit JSON output")
    .action(
      async (opts: {
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
      },
    );

  const guardedState = program
    .command("json-state")
    .description("Operate on guarded JSON state through a trusted tool instance");

  guardedState
    .command("show")
    .requiredOption("--instance <id>", "Tool instance ID")
    .option("--config-path <path>", "Override Sovereign runtime config path")
    .option("--json", "Emit JSON output")
    .action(async (opts: { instance: string; configPath?: string; json?: boolean }) => {
      const command = "json-state show";
      try {
        const result = await guardedStateService.showState({
          instanceId: opts.instance,
          ...(opts.configPath === undefined ? {} : { configPath: opts.configPath }),
        });
        if (opts.json) {
          writeCliSuccess(command, result, guardedJsonStateShowResultSchema, true);
          return;
        }
        process.stdout.write(`${formatGuardedStateShowResult(result)}\n`);
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });

  guardedState
    .command("list")
    .requiredOption("--instance <id>", "Tool instance ID")
    .requiredOption("--entity <id>", "Policy entity ID")
    .option("--config-path <path>", "Override Sovereign runtime config path")
    .option("--json", "Emit JSON output")
    .action(
      async (opts: { instance: string; entity: string; configPath?: string; json?: boolean }) => {
        const command = "json-state list";
        try {
          const result = await guardedStateService.listEntity({
            instanceId: opts.instance,
            entityId: opts.entity,
            ...(opts.configPath === undefined ? {} : { configPath: opts.configPath }),
          });
          if (opts.json) {
            writeCliSuccess(command, result, guardedJsonStateListResultSchema, true);
            return;
          }
          process.stdout.write(`${formatGuardedStateListResult(result)}\n`);
        } catch (error) {
          writeCliError(command, error, Boolean(opts.json));
          process.exitCode = 1;
        }
      },
    );

  guardedState
    .command("upsert-self")
    .requiredOption("--instance <id>", "Tool instance ID")
    .requiredOption("--entity <id>", "Policy entity ID")
    .option("--actor <value>", "Current Matrix actor user id")
    .option("--session-key <value>", "Current session_status.sessionKey value")
    .option("--origin-from <value>", "Current session_status.origin.from value")
    .option("--input-json <json>", "JSON object with scalar and string-array fields")
    .option("--field <key=value>", "Set a scalar field", collectOption)
    .option("--array-item <key=value>", "Append an array item", collectOption)
    .option("--config-path <path>", "Override Sovereign runtime config path")
    .option("--json", "Emit JSON output")
    .action(
      async (opts: {
        instance: string;
        entity: string;
        actor?: string;
        sessionKey?: string;
        originFrom?: string;
        inputJson?: string;
        field?: string[];
        arrayItem?: string[];
        configPath?: string;
        json?: boolean;
      }) => {
        const command = "json-state upsert-self";
        try {
          const actor = resolveActorFromMutationOptions(opts);
          const mutationInput = resolveMutationInput(opts);
          const result = await guardedStateService.upsertSelf({
            instanceId: opts.instance,
            entityId: opts.entity,
            actor,
            fields: mutationInput.fields,
            arrayFields: mutationInput.arrayFields,
            ...(opts.configPath === undefined ? {} : { configPath: opts.configPath }),
          });
          if (opts.json) {
            writeCliSuccess<GuardedJsonStateMutationResult>(
              command,
              result,
              guardedJsonStateMutationResultSchema,
              true,
            );
            return;
          }
          process.stdout.write(`${formatGuardedStateMutationResult(result)}\n`);
        } catch (error) {
          writeCliError(command, error, Boolean(opts.json));
          process.exitCode = 1;
        }
      },
    );

  guardedState
    .command("delete-self")
    .requiredOption("--instance <id>", "Tool instance ID")
    .requiredOption("--entity <id>", "Policy entity ID")
    .option("--actor <value>", "Current Matrix actor user id")
    .option("--session-key <value>", "Current session_status.sessionKey value")
    .option("--origin-from <value>", "Current session_status.origin.from value")
    .requiredOption("--id <value>", "Entity key value")
    .option("--config-path <path>", "Override Sovereign runtime config path")
    .option("--json", "Emit JSON output")
    .action(
      async (opts: {
        instance: string;
        entity: string;
        actor?: string;
        sessionKey?: string;
        originFrom?: string;
        id: string;
        configPath?: string;
        json?: boolean;
      }) => {
        const command = "json-state delete-self";
        try {
          const actor = resolveActorFromMutationOptions(opts);
          const result = await guardedStateService.deleteSelf({
            instanceId: opts.instance,
            entityId: opts.entity,
            actor,
            id: opts.id,
            ...(opts.configPath === undefined ? {} : { configPath: opts.configPath }),
          });
          if (opts.json) {
            writeCliSuccess<GuardedJsonStateMutationResult>(
              command,
              result,
              guardedJsonStateMutationResultSchema,
              true,
            );
            return;
          }
          process.stdout.write(`${formatGuardedStateMutationResult(result)}\n`);
        } catch (error) {
          writeCliError(command, error, Boolean(opts.json));
          process.exitCode = 1;
        }
      },
    );

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
