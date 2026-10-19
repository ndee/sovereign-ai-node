import { readFile } from "node:fs/promises";

import type {
  FetchMessageObject,
  MailboxLockObject,
  MessageAddressObject,
  SearchObject,
} from "imapflow";
import PostalMime from "postal-mime";

import { DEFAULT_PATHS } from "../config/paths.js";
import type { MailProtocol } from "../contracts/install.js";
import type {
  ImapReadMailResult,
  ImapSearchMailResult,
  MailInventoryResult,
} from "../contracts/tool.js";
import type { RuntimeConfig } from "../installer/real-service-shared.js";
import { parseRuntimeConfigDocument } from "../installer/real-service-shared.js";
import {
  type ImapAccountCredentials,
  type ImapClientLike,
  runWithImapClient,
} from "../system/imap-client.js";
import { parseTemplateRef } from "../templates/catalog.js";
import {
  clampInventoryTimeout,
  compressUidRanges,
  countUidGaps,
  withInventoryDeadline,
} from "./mail-inventory.js";
import {
  normalizeParsedHeaders,
  parseBooleanString,
  parsePort,
  resolveSecretRefValue,
  SovereignToolError,
  stripHtmlTags,
  truncateText,
} from "./mail-shared.js";

import { Pop3ReadonlyToolService } from "./pop3-readonly.js";

export { SovereignToolError } from "./mail-shared.js";

const DEFAULT_MAX_SEARCH_RESULTS = 10;
const MAX_SEARCH_RESULTS = 50;
const DEFAULT_MAX_MESSAGE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_TEXT_CHARS = 12_000;
/** UIDs are 32-bit unsigned (RFC 3501 §2.3.1.1). */
const MAX_IMAP_UID = 4_294_967_295;

type ToolRunner = <T>(
  account: ImapAccountCredentials,
  handler: (client: ImapClientLike) => Promise<T>,
) => Promise<T>;

type RuntimeConfigLoader = (configPath: string) => Promise<RuntimeConfig>;

type ResolvedImapToolInstance = {
  instanceId: string;
  protocol: MailProtocol;
  account: ImapAccountCredentials & {
    mailbox: string;
  };
};

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

// Older tool instances have no `protocol` binding at all: they are IMAP.
const parseMailProtocol = (value: string | undefined, instanceId: string): MailProtocol => {
  const normalized = (value ?? "imap").trim().toLowerCase();
  if (normalized === "imap" || normalized === "pop3") {
    return normalized;
  }
  throw new SovereignToolError(
    "TOOL_INSTANCE_INVALID",
    `Tool instance '${instanceId}' has an unsupported mail protocol '${value ?? ""}'`,
    false,
    { instanceId, value },
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

  private readonly pop3: Pop3ReadonlyToolService;

  constructor(
    private readonly options: {
      configLoader?: RuntimeConfigLoader;
      runner?: ToolRunner;
      /** POP3 backend; defaults to a real-socket service sharing the size limits. */
      pop3?: Pop3ReadonlyToolService;
      maxMessageBytes?: number;
      maxTextChars?: number;
    } = {},
  ) {
    this.loadRuntimeConfig = options.configLoader ?? defaultRuntimeConfigLoader;
    this.runner = options.runner ?? defaultRunner;
    this.pop3 =
      options.pop3 ??
      new Pop3ReadonlyToolService({
        ...(options.maxMessageBytes === undefined
          ? {}
          : { maxMessageBytes: options.maxMessageBytes }),
        ...(options.maxTextChars === undefined ? {} : { maxTextChars: options.maxTextChars }),
      });
  }

  async searchMail(input: {
    instanceId: string;
    query: string;
    limit?: number;
    configPath?: string;
  }): Promise<ImapSearchMailResult> {
    const instance = await this.resolveToolInstance(input.instanceId, input.configPath);
    if (instance.protocol === "pop3") {
      return await this.pop3.searchMail({
        instanceId: instance.instanceId,
        account: instance.account,
        query: input.query,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
    }
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
            const openMailbox = client.mailbox;
            const uidValidity =
              openMailbox !== false && typeof openMailbox.uidValidity === "bigint"
                ? openMailbox.uidValidity.toString()
                : undefined;

            return {
              instanceId: instance.instanceId,
              mailbox: instance.account.mailbox,
              query: input.query,
              totalMatches: sortedUids.length,
              messages,
              ...(uidValidity === undefined ? {} : { uidValidity }),
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
    if (instance.protocol === "pop3") {
      return await this.pop3.readMail({
        instanceId: instance.instanceId,
        account: instance.account,
        messageId: input.messageId,
      });
    }
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

  /**
   * Read-only identifier census: the UIDs above `afterUid` (all of them when
   * the key space changed or no `afterUid` was given), the mailbox's
   * UIDVALIDITY and the server's own message count. Unlike `searchMail` there
   * is no result limit and no date window, so an outage of any length still
   * lists every arrival that is still in the mailbox.
   */
  async inventoryMail(input: {
    instanceId: string;
    afterUid?: number;
    uidValidity?: string;
    timeoutMs?: number;
    configPath?: string;
  }): Promise<MailInventoryResult> {
    const instance = await this.resolveToolInstance(input.instanceId, input.configPath);
    const timeoutMs = clampInventoryTimeout(input.timeoutMs);
    if (instance.protocol === "pop3") {
      return await this.pop3.inventoryMail({
        instanceId: instance.instanceId,
        account: instance.account,
        timeoutMs,
      });
    }
    const requestedAfterUid = input.afterUid ?? 0;
    if (
      !Number.isSafeInteger(requestedAfterUid) ||
      requestedAfterUid < 0 ||
      requestedAfterUid > MAX_IMAP_UID ||
      (requestedAfterUid > 0 && input.uidValidity === undefined)
    ) {
      throw new SovereignToolError(
        "MAIL_INVENTORY_INVALID_ARGUMENT",
        "--after-uid must be an IMAP UID and needs the --uid-validity it was recorded under",
        false,
        { afterUid: input.afterUid },
      );
    }
    const mailbox = instance.account.mailbox;
    let openClient: ImapClientLike | undefined;
    const work = this.runner(instance.account, async (client) => {
      openClient = client;
      // STATUS before EXAMINE: RFC 3501 advises against STATUS on the selected mailbox.
      // imapflow resolves `false` (not a throw) when the server refuses STATUS.
      const status = (await client.status(mailbox, { messages: true })) as
        | { messages?: number }
        | false;
      return await withMailboxLock(
        client,
        mailbox,
        `sovereign-tool:${instance.instanceId}:inventory`,
        async () => {
          const open = client.mailbox;
          const uidValidity =
            open !== false && typeof open.uidValidity === "bigint"
              ? open.uidValidity.toString()
              : undefined;
          const uidNext =
            open !== false && typeof open.uidNext === "number" && open.uidNext > 0
              ? open.uidNext
              : undefined;
          const uidValidityChanged =
            input.uidValidity !== undefined && input.uidValidity !== uidValidity;
          const afterUid = uidValidityChanged ? 0 : requestedAfterUid;
          const nothingNew = uidNext !== undefined && afterUid + 1 >= uidNext;
          const matches = nothingNew
            ? []
            : await client.search({ uid: `${String(afterUid + 1)}:*` }, { uid: true });
          // imapflow resolves `false` when the search failed (NO/BAD or a lost
          // connection); in a census that must not read as "no messages".
          if (matches === false) {
            throw new SovereignToolError(
              "MAIL_INVENTORY_SEARCH_FAILED",
              `The IMAP server did not answer the UID search of ${mailbox}`,
              true,
              { mailbox, afterUid },
            );
          }
          // `n:*` also matches the highest UID when n is above it (RFC 3501 §6.4.8).
          const uidRanges = compressUidRanges(matches.filter((uid) => uid > afterUid));
          const lowestUid = uidRanges[0]?.[0];
          const highestUid = uidRanges[uidRanges.length - 1]?.[1];
          const count = uidRanges.reduce((sum, [first, last]) => sum + last - first + 1, 0);
          // A continuation counts every UID assigned since the last census; a
          // full census only the holes between the UIDs it lists, because the
          // mailbox's earlier history is not an arrival in this period.
          const uidGaps =
            afterUid > 0
              ? countUidGaps(
                  uidRanges,
                  afterUid,
                  Math.max(uidNext === undefined ? 0 : uidNext - 1, highestUid ?? afterUid),
                )
              : lowestUid === undefined || highestUid === undefined
                ? 0
                : countUidGaps(uidRanges, lowestUid - 1, highestUid);
          const reportedCount =
            status !== false && typeof status.messages === "number"
              ? status.messages
              : open === false
                ? count
                : open.exists;

          return {
            protocol: "imap" as const,
            instanceId: instance.instanceId,
            mailbox,
            inventoriedAt: new Date().toISOString(),
            messageCount: reportedCount,
            count,
            ...(uidValidity === undefined ? {} : { uidValidity }),
            uidValidityChanged,
            afterUid,
            ...(uidNext === undefined ? {} : { uidNext }),
            ...(highestUid === undefined ? {} : { highestUid }),
            uidRanges,
            uidGaps,
          };
        },
      );
    });
    return await withInventoryDeadline(timeoutMs, work, () => {
      openClient?.close();
    });
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

    const protocol = parseMailProtocol(tool.config.protocol, instanceId);
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
      protocol,
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
