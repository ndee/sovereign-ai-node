import { readFile } from "node:fs/promises";

import type {
  FetchMessageObject,
  MailboxLockObject,
  MessageAddressObject,
  SearchObject,
} from "imapflow";
import PostalMime from "postal-mime";

import { DEFAULT_PATHS } from "../config/paths.js";
import type { ImapReadMailResult, ImapSearchMailResult } from "../contracts/tool.js";
import type { RuntimeConfig } from "../installer/real-service-shared.js";
import { parseRuntimeConfigDocument } from "../installer/real-service-shared.js";
import {
  type ImapAccountCredentials,
  type ImapClientLike,
  runWithImapClient,
} from "../system/imap-client.js";
import { parseTemplateRef } from "../templates/catalog.js";

const DEFAULT_MAX_SEARCH_RESULTS = 10;
const MAX_SEARCH_RESULTS = 50;
const DEFAULT_MAX_MESSAGE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_TEXT_CHARS = 12_000;

type ToolRunner = <T>(
  account: ImapAccountCredentials,
  handler: (client: ImapClientLike) => Promise<T>,
) => Promise<T>;

type RuntimeConfigLoader = (configPath: string) => Promise<RuntimeConfig>;

type ResolvedImapToolInstance = {
  instanceId: string;
  account: ImapAccountCredentials & {
    mailbox: string;
  };
};

export class SovereignToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly details?: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SovereignToolError";
  }
}

const defaultRuntimeConfigLoader: RuntimeConfigLoader = async (configPath) => {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    throw new SovereignToolError(
      "RUNTIME_CONFIG_READ_FAILED",
      `Failed to read Sovereign runtime config at ${configPath}`,
      false,
      {
        configPath,
        error: error instanceof Error ? error.message : String(error),
      },
      { cause: error instanceof Error ? error : undefined },
    );
  }

  const parsed = parseRuntimeConfigDocument(raw);
  if (parsed === null) {
    throw new SovereignToolError(
      "RUNTIME_CONFIG_INVALID",
      `Sovereign runtime config at ${configPath} is missing required fields`,
      false,
      {
        configPath,
      },
    );
  }

  return parsed;
};

const defaultRunner: ToolRunner = async (account, handler) =>
  await runWithImapClient({ account }, async (client) => await handler(client));

const defaultConfigPath = (): string =>
  process.env.SOVEREIGN_NODE_CONFIG ?? DEFAULT_PATHS.configPath;

const resolveSecretRefValue = async (secretRef: string): Promise<string> => {
  if (secretRef.startsWith("file:")) {
    const filePath = secretRef.slice("file:".length);
    try {
      const raw = await readFile(filePath, "utf8");
      const value = stripSingleTrailingNewline(raw);
      if (value.length > 0) {
        return value;
      }
      throw new SovereignToolError("SECRET_READ_FAILED", "Secret file is empty", false, {
        secretRef,
      });
    } catch (error) {
      if (error instanceof SovereignToolError) {
        throw error;
      }
      throw new SovereignToolError(
        "SECRET_READ_FAILED",
        `Failed to read secret file for ${secretRef}`,
        false,
        {
          secretRef,
          error: error instanceof Error ? error.message : String(error),
        },
        { cause: error instanceof Error ? error : undefined },
      );
    }
  }

  if (secretRef.startsWith("env:")) {
    const key = secretRef.slice("env:".length);
    const value = process.env[key];
    if (value !== undefined && value.length > 0) {
      return value;
    }
    throw new SovereignToolError(
      "SECRET_READ_FAILED",
      `Environment variable ${key} referenced by ${secretRef} is not set`,
      false,
      {
        secretRef,
      },
    );
  }

  throw new SovereignToolError(
    "SECRET_REF_UNSUPPORTED",
    `Unsupported secretRef format for ${secretRef}`,
    false,
    {
      secretRef,
    },
  );
};

const stripSingleTrailingNewline = (value: string): string => value.replace(/\r?\n$/, "");

const parseBooleanString = (value: string, key: string, instanceId: string): boolean => {
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  throw new SovereignToolError(
    "TOOL_INSTANCE_INVALID",
    `Tool instance '${instanceId}' has an invalid boolean value for '${key}'`,
    false,
    {
      instanceId,
      key,
      value,
    },
  );
};

const parsePort = (value: string, instanceId: string): number => {
  const parsed = Number.parseInt(value, 10);
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535) {
    return parsed;
  }
  throw new SovereignToolError(
    "TOOL_INSTANCE_INVALID",
    `Tool instance '${instanceId}' has an invalid IMAP port`,
    false,
    {
      instanceId,
      value,
    },
  );
};

const formatAddress = (address: MessageAddressObject): string => {
  if (address.name !== undefined && address.name.length > 0 && address.address !== undefined) {
    return `${address.name} <${address.address}>`;
  }
  return address.address ?? address.name ?? "(unknown)";
};

const formatAddressList = (addresses: MessageAddressObject[] | undefined): string[] =>
  (addresses ?? []).map((address) => formatAddress(address));

const sortFlags = (flags: Set<string> | undefined): string[] =>
  Array.from(flags ?? []).sort((left, right) => left.localeCompare(right));

const formatTimestamp = (value: Date | string | undefined): string | undefined => {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return undefined;
};

const truncateText = (value: string, maxChars: number): { text: string; truncated: boolean } => {
  const normalized = value.trim();
  if (normalized.length <= maxChars) {
    return {
      text: normalized,
      truncated: false,
    };
  }
  return {
    text: `${normalized.slice(0, maxChars).trimEnd()}\n\n[truncated]`,
    truncated: true,
  };
};

const stripHtmlTags = (value: string): string =>
  value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const normalizeParsedHeaders = (value: unknown): Record<string, string> => {
  if (value instanceof Map) {
    return Object.fromEntries(
      Array.from(value.entries()).flatMap(([key, entryValue]) => {
        if (typeof key !== "string") {
          return [];
        }
        if (Array.isArray(entryValue)) {
          return [[key.toLowerCase(), entryValue.map((part) => String(part)).join(", ")]];
        }
        if (entryValue === undefined || entryValue === null) {
          return [];
        }
        return [[key.toLowerCase(), String(entryValue)]];
      }),
    );
  }
  if (Array.isArray(value)) {
    return Object.fromEntries(
      value.flatMap((entry) => {
        if (entry && typeof entry === "object") {
          const record = entry as Record<string, unknown>;
          const key = typeof record.key === "string" ? record.key : record.name;
          if (typeof key === "string" && typeof record.value === "string") {
            return [[key.toLowerCase(), record.value]];
          }
        }
        return [];
      }),
    );
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, entryValue]) => {
        if (Array.isArray(entryValue)) {
          return [[key.toLowerCase(), entryValue.map((part) => String(part)).join(", ")]];
        }
        if (typeof entryValue === "string") {
          return [[key.toLowerCase(), entryValue]];
        }
        return [];
      }),
    );
  }
  return {};
};

const splitSearchTerms = (value: string): string[] => {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (const char of value) {
    if (quote !== null) {
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
};

const normalizeMessageIdSearchValue = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    return trimmed;
  }
  if (trimmed.includes("@")) {
    return `<${trimmed}>`;
  }
  return trimmed;
};

const applySearchTerm = (
  term: string,
  state: {
    query: SearchObject;
    textTerms: string[];
  },
): void => {
  const separator = term.indexOf(":");
  if (separator <= 0) {
    state.textTerms.push(term);
    return;
  }

  const rawKey = term.slice(0, separator).trim().toLowerCase();
  const rawValue = term.slice(separator + 1).trim();
  if (rawValue.length === 0) {
    state.textTerms.push(term);
    return;
  }

  switch (rawKey) {
    case "from":
      state.query.from = rawValue;
      return;
    case "to":
      state.query.to = rawValue;
      return;
    case "cc":
      state.query.cc = rawValue;
      return;
    case "bcc":
      state.query.bcc = rawValue;
      return;
    case "subject":
      state.query.subject = rawValue;
      return;
    case "body":
      state.query.body = rawValue;
      return;
    case "text":
      state.query.text = rawValue;
      return;
    case "message-id":
    case "msgid":
      state.query.header = {
        ...(state.query.header ?? {}),
        "message-id": normalizeMessageIdSearchValue(rawValue),
      };
      return;
    case "since":
      state.query.since = rawValue;
      return;
    case "before":
      state.query.before = rawValue;
      return;
    case "on":
      state.query.on = rawValue;
      return;
    case "is":
      if (rawValue === "seen" || rawValue === "read") {
        state.query.seen = true;
        return;
      }
      if (rawValue === "unseen" || rawValue === "unread") {
        state.query.seen = false;
        return;
      }
      state.textTerms.push(term);
      return;
    default:
      state.textTerms.push(term);
  }
};

export const buildImapSearchQuery = (query: string): SearchObject => {
  const trimmed = query.trim();
  if (trimmed.length === 0 || trimmed === "*" || trimmed.toLowerCase() === "all") {
    return {
      all: true,
    };
  }

  const state: {
    query: SearchObject;
    textTerms: string[];
  } = {
    query: {},
    textTerms: [],
  };

  for (const term of splitSearchTerms(trimmed)) {
    applySearchTerm(term, state);
  }

  if (state.textTerms.length > 0) {
    state.query.text = state.textTerms.join(" ");
  }

  if (Object.keys(state.query).length === 0) {
    state.query.all = true;
  }

  return state.query;
};

export const normalizeImapSearchQuery = (query: string, mailbox: string): string => {
  const trimmed = query.trim();
  const normalizedMailbox = mailbox.trim();
  if (trimmed.length === 0 || normalizedMailbox.length === 0) {
    return trimmed;
  }

  const lowerQuery = trimmed.toLowerCase();
  const lowerMailbox = normalizedMailbox.toLowerCase();
  if (lowerQuery === lowerMailbox) {
    return "ALL";
  }
  if (lowerQuery.startsWith(`${lowerMailbox} `)) {
    const stripped = trimmed.slice(normalizedMailbox.length).trim();
    return stripped.length === 0 ? "ALL" : stripped;
  }
  return trimmed;
};

const clampSearchLimit = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_MAX_SEARCH_RESULTS;
  }
  return Math.max(1, Math.min(MAX_SEARCH_RESULTS, Math.trunc(value)));
};

const resolveFetchSummary = (
  message: Pick<FetchMessageObject, "uid" | "envelope" | "flags" | "internalDate" | "size">,
): ImapSearchMailResult["messages"][number] => ({
  uid: message.uid,
  ...(message.envelope?.messageId === undefined ? {} : { messageId: message.envelope.messageId }),
  ...(message.envelope?.subject === undefined ? {} : { subject: message.envelope.subject }),
  from: formatAddressList(message.envelope?.from),
  to: formatAddressList(message.envelope?.to),
  cc: formatAddressList(message.envelope?.cc),
  ...(formatTimestamp(message.internalDate) === undefined
    ? {}
    : { date: formatTimestamp(message.internalDate) }),
  flags: sortFlags(message.flags),
  ...(typeof message.size === "number" ? { size: message.size } : {}),
});

const computeAttachmentSize = (content: ArrayBuffer | string): number =>
  typeof content === "string" ? Buffer.byteLength(content, "utf8") : content.byteLength;

const withMailboxLock = async <T>(
  client: ImapClientLike,
  mailbox: string,
  description: string,
  action: () => Promise<T>,
): Promise<T> => {
  const lock = await client.getMailboxLock(mailbox, {
    readOnly: true,
    description,
  });

  try {
    return await action();
  } finally {
    (lock as MailboxLockObject).release();
  }
};

const resolveMessageSelection = async (
  client: ImapClientLike,
  selector: string,
): Promise<{ selectedBy: "uid" | "message-id"; uid: number }> => {
  const trimmed = selector.trim();
  if (/^[1-9][0-9]*$/.test(trimmed)) {
    return {
      selectedBy: "uid",
      uid: Number.parseInt(trimmed, 10),
    };
  }

  const matches = await client.search(
    {
      header: {
        "message-id": normalizeMessageIdSearchValue(trimmed),
      },
    },
    { uid: true },
  );
  const sorted = (matches === false ? [] : matches).slice().sort((left, right) => right - left);
  if (sorted[0] === undefined) {
    throw new SovereignToolError(
      "IMAP_MESSAGE_NOT_FOUND",
      `No message found for selector '${selector}'`,
      false,
      {
        selector,
      },
    );
  }

  return {
    selectedBy: "message-id",
    uid: sorted[0],
  };
};

export class ImapReadonlyToolService {
  private readonly loadRuntimeConfig: RuntimeConfigLoader;

  private readonly runner: ToolRunner;

  constructor(
    private readonly options: {
      configLoader?: RuntimeConfigLoader;
      runner?: ToolRunner;
      maxMessageBytes?: number;
      maxTextChars?: number;
    } = {},
  ) {
    this.loadRuntimeConfig = options.configLoader ?? defaultRuntimeConfigLoader;
    this.runner = options.runner ?? defaultRunner;
  }

  async searchMail(input: {
    instanceId: string;
    query: string;
    limit?: number;
    configPath?: string;
  }): Promise<ImapSearchMailResult> {
    const instance = await this.resolveToolInstance(input.instanceId, input.configPath);
    const normalizedQuery = normalizeImapSearchQuery(input.query, instance.account.mailbox);
    const searchQuery = buildImapSearchQuery(normalizedQuery);
    const limit = clampSearchLimit(input.limit);

    return await this.runner(
      instance.account,
      async (client) =>
        await withMailboxLock(
          client,
          instance.account.mailbox,
          `sovereign-tool:${instance.instanceId}:search`,
          async () => {
            const matches = await client.search(searchQuery, { uid: true });
            const sortedUids = (matches === false ? [] : matches)
              .slice()
              .sort((left, right) => right - left);
            const selectedUids = sortedUids.slice(0, limit);
            const fetched =
              selectedUids.length === 0
                ? []
                : await client.fetchAll(
                    selectedUids,
                    {
                      uid: true,
                      envelope: true,
                      flags: true,
                      internalDate: true,
                      size: true,
                    },
                    { uid: true },
                  );
            const messages = fetched
              .map((message) => resolveFetchSummary(message))
              .sort((left, right) => right.uid - left.uid);

            return {
              instanceId: instance.instanceId,
              mailbox: instance.account.mailbox,
              query: input.query,
              totalMatches: sortedUids.length,
              messages,
            };
          },
        ),
    );
  }

  async readMail(input: {
    instanceId: string;
    messageId: string;
    configPath?: string;
  }): Promise<ImapReadMailResult> {
    const instance = await this.resolveToolInstance(input.instanceId, input.configPath);
    const maxMessageBytes = this.options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    const maxTextChars = this.options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;

    return await this.runner(
      instance.account,
      async (client) =>
        await withMailboxLock(
          client,
          instance.account.mailbox,
          `sovereign-tool:${instance.instanceId}:read`,
          async () => {
            const selection = await resolveMessageSelection(client, input.messageId);
            const message = await client.fetchOne(
              selection.uid,
              {
                uid: true,
                envelope: true,
                flags: true,
                internalDate: true,
                size: true,
                source: true,
              },
              { uid: true },
            );

            if (message === false || message.source === undefined) {
              throw new SovereignToolError(
                "IMAP_MESSAGE_NOT_FOUND",
                `No message found for selector '${input.messageId}'`,
                false,
                {
                  selector: input.messageId,
                },
              );
            }

            if (typeof message.size === "number" && message.size > maxMessageBytes) {
              throw new SovereignToolError(
                "IMAP_MESSAGE_TOO_LARGE",
                `Message ${selection.uid} exceeds the ${maxMessageBytes}-byte read limit`,
                false,
                {
                  uid: selection.uid,
                  size: message.size,
                  maxMessageBytes,
                },
              );
            }

            let parsedWarning: string | undefined;
            let textBody = "";
            let htmlAvailable = false;
            let attachments: ImapReadMailResult["message"]["attachments"] = [];
            let headers: ImapReadMailResult["message"]["headers"] = {};

            try {
              const parsed = await PostalMime.parse(message.source);
              textBody = parsed.text ?? "";
              if (textBody.trim().length === 0 && typeof parsed.html === "string") {
                textBody = stripHtmlTags(parsed.html);
              }
              htmlAvailable = typeof parsed.html === "string" && parsed.html.length > 0;
              headers = normalizeParsedHeaders(parsed.headers);
              attachments = parsed.attachments.map((attachment) => ({
                filename: attachment.filename,
                mimeType: attachment.mimeType,
                disposition: attachment.disposition,
                related: attachment.related === true,
                sizeBytes: computeAttachmentSize(attachment.content),
              }));
            } catch (error) {
              parsedWarning = error instanceof Error ? error.message : String(error);
            }

            const truncated = truncateText(textBody, maxTextChars);

            return {
              instanceId: instance.instanceId,
              mailbox: instance.account.mailbox,
              selectedBy: selection.selectedBy,
              message: {
                ...resolveFetchSummary(message),
                headers,
                text: truncated.text,
                textTruncated: truncated.truncated,
                htmlAvailable,
                attachments,
                ...(parsedWarning === undefined ? {} : { bodyParseWarning: parsedWarning }),
              },
            };
          },
        ),
    );
  }

  private async resolveToolInstance(
    instanceId: string,
    configPathOverride: string | undefined,
  ): Promise<ResolvedImapToolInstance> {
    const configPath = configPathOverride ?? defaultConfigPath();
    const runtimeConfig = await this.loadRuntimeConfig(configPath);
    const tool = runtimeConfig.sovereignTools.instances.find((entry) => entry.id === instanceId);
    if (tool === undefined) {
      throw new SovereignToolError(
        "TOOL_INSTANCE_NOT_FOUND",
        `Tool instance '${instanceId}' was not found in ${configPath}`,
        false,
        {
          instanceId,
          configPath,
        },
      );
    }

    const parsedRef = parseTemplateRef(tool.templateRef);
    if (parsedRef.id !== "imap-readonly") {
      throw new SovereignToolError(
        "TOOL_INSTANCE_TEMPLATE_MISMATCH",
        `Tool instance '${instanceId}' is not bound to an imap-readonly template`,
        false,
        {
          instanceId,
          templateRef: tool.templateRef,
        },
      );
    }

    const host = tool.config.host;
    const port = tool.config.port;
    const tls = tool.config.tls;
    const username = tool.config.username;
    const mailbox = tool.config.mailbox;
    const passwordRef = tool.secretRefs.password;
    if (
      host === undefined ||
      port === undefined ||
      tls === undefined ||
      username === undefined ||
      mailbox === undefined ||
      passwordRef === undefined
    ) {
      throw new SovereignToolError(
        "TOOL_INSTANCE_INVALID",
        `Tool instance '${instanceId}' is missing IMAP config or secret bindings`,
        false,
        {
          instanceId,
        },
      );
    }

    return {
      instanceId,
      account: {
        host,
        port: parsePort(port, instanceId),
        tls: parseBooleanString(tls, "tls", instanceId),
        username,
        password: await resolveSecretRefValue(passwordRef),
        mailbox,
      },
    };
  }
}
