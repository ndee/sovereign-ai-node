import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import PostalMime from "postal-mime";

import { DEFAULT_PATHS } from "../config/paths.js";
import type { ImapReadMailResult, ImapSearchMailResult } from "../contracts/tool.js";
import {
  type Pop3AccountCredentials,
  type Pop3ClientLike,
  runWithPop3Client,
} from "../system/pop3-client.js";
import {
  normalizeParsedHeaders,
  SovereignToolError,
  stripHtmlTags,
  truncateText,
} from "./mail-shared.js";

/**
 * POP3 backend for the read-only mail tool.
 *
 * POP3 has no folders, no server-side search and no stable numeric UIDs —
 * only an opaque per-message UIDL string. Mail Sentinel's scan loop, however,
 * is built around IMAP semantics: a monotonic numeric `uid` watermark plus a
 * `uidValidity` token that resets the watermark when it changes. To keep that
 * pipeline untouched, this service maintains a small per-instance index that
 * maps every UIDL it has ever seen to a synthetic, strictly increasing uid:
 *
 *   - a UIDL that is new to the index gets `nextUid++` — so anything that
 *     arrives after the last scan always sorts above the watermark;
 *   - `uidValidity` is the index *generation*, minted when the index is first
 *     created. If the index file is ever lost, a fresh generation makes the
 *     scan loop drop its watermark and rely on Message-ID dedup instead of
 *     silently skipping mail whose fresh uids happen to sort below it;
 *   - the mailbox account is folded into `uidValidity` as well, so switching
 *     the node to a different POP3 account never inherits a watermark.
 *
 * The first scan of a large mailbox is bounded: headers are fetched newest
 * first, and once enough consecutive messages fall outside the lookback
 * window the remaining unknown UIDLs are recorded as a *baseline* (uid
 * assigned, no headers) so they are never fetched again and never reported
 * as new. Nothing here deletes mail — the client has no DELE.
 */

const DEFAULT_MAX_SEARCH_RESULTS = 10;
const MAX_SEARCH_RESULTS = 50;
const DEFAULT_MAX_MESSAGE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_TEXT_CHARS = 12_000;
/** Upper bound on TOP round-trips per search; the rest becomes baseline. */
const MAX_HEADER_FETCHES_PER_SEARCH = 200;
/** Newest-first header walk stops after this many consecutive out-of-window messages. */
const STOP_AFTER_CONSECUTIVE_OLD = 10;
const INDEX_VERSION = 1;
/**
 * A search that matches nothing while the newest dated message the server
 * shows is this much older than the `since:` bound is reported as a stuck
 * POP3 window (see `buildStuckWindowNote`): the server is presenting an old
 * slice of the mailbox, not a mailbox that happens to be quiet. The margin
 * keeps a merely-quiet mailbox (days without mail) from tripping the note.
 */
export const STUCK_WINDOW_MARGIN_MS = 30 * 24 * 60 * 60 * 1000;

export type Pop3ToolRunner = <T>(
  account: Pop3AccountCredentials,
  handler: (client: Pop3ClientLike) => Promise<T>,
) => Promise<T>;

type Pop3IndexEntry = {
  uid: number;
  messageId?: string;
  subject?: string;
  from: string[];
  to: string[];
  cc: string[];
  date?: string;
  size?: number;
  /** Recorded without headers during the bounded first scan; never reported. */
  baseline?: true;
};

export type Pop3UidlIndex = {
  version: typeof INDEX_VERSION;
  generation: string;
  nextUid: number;
  entries: Record<string, Pop3IndexEntry>;
};

type ParsedAddress = { name?: string; address?: string };

const defaultRunner: Pop3ToolRunner = async (account, handler) =>
  await runWithPop3Client({ account }, handler);

export const defaultPop3IndexDir = (): string =>
  process.env.SOVEREIGN_POP3_INDEX_DIR ?? join(DEFAULT_PATHS.stateDir, "pop3-index");

const createIndex = (): Pop3UidlIndex => ({
  version: INDEX_VERSION,
  generation: randomUUID().replace(/-/g, "").slice(0, 12),
  nextUid: 1,
  entries: {},
});

const isIndex = (value: unknown): value is Pop3UidlIndex =>
  typeof value === "object" &&
  value !== null &&
  (value as Pop3UidlIndex).version === INDEX_VERSION &&
  typeof (value as Pop3UidlIndex).generation === "string" &&
  Number.isInteger((value as Pop3UidlIndex).nextUid) &&
  typeof (value as Pop3UidlIndex).entries === "object" &&
  (value as Pop3UidlIndex).entries !== null;

export const accountFingerprint = (account: { host: string; username: string }): string =>
  createHash("sha256")
    .update(`pop3|${account.host.toLowerCase()}|${account.username}`)
    .digest("hex")
    .slice(0, 8);

const formatAddress = (address: ParsedAddress): string => {
  if (address.name !== undefined && address.name.length > 0 && address.address !== undefined) {
    return `${address.name} <${address.address}>`;
  }
  return address.address ?? address.name ?? "(unknown)";
};

const formatAddressList = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is ParsedAddress => typeof entry === "object" && entry !== null)
    .map((entry) => formatAddress(entry));
};

const parseDateHeader = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
};

/** Extracts the `since:<date>` bound from the shared search-query syntax. */
export const parseSinceBound = (query: string): Date | undefined => {
  const match = /(?:^|\s)since:(\S+)/i.exec(query);
  if (match?.[1] === undefined) {
    return undefined;
  }
  const parsed = new Date(match[1]);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

const isGmailHost = (host: string): boolean => /(^|\.)(gmail|googlemail)\.com$/i.test(host.trim());

/**
 * Detects a POP3 view that is stuck in the past and names it, instead of
 * letting the scan report a clean "no new messages" while recent mail is
 * structurally invisible.
 *
 * Gmail's "all mail" POP mode is the known trigger: it serves the account's
 * entire history oldest-first in batches of a few hundred and only advances
 * the window when a client downloads the batch — which this read-only tool
 * never does. On an old account every visible message can then be years old
 * and new mail never enters the window. The note carries the Gmail-specific
 * remediation (`recent:` username prefix, or the "mail that arrives from now
 * on" POP setting) when the host is Gmail, and a generic hint otherwise.
 */
export const buildStuckWindowNote = (input: {
  account: { host: string; username: string };
  since: Date | undefined;
  matchingCount: number;
  visibleCount: number;
  newestKnownDate: Date | undefined;
}): string | undefined => {
  if (
    input.since === undefined ||
    input.matchingCount > 0 ||
    input.visibleCount === 0 ||
    input.newestKnownDate === undefined ||
    input.newestKnownDate.getTime() >= input.since.getTime() - STUCK_WINDOW_MARGIN_MS
  ) {
    return undefined;
  }
  const newest = input.newestKnownDate.toISOString().slice(0, 10);
  const base = `POP3 shows ${String(input.visibleCount)} message(s) but the newest dated one is from ${newest}, far older than the search window — the server's POP3 view appears to exclude recent mail.`;
  if (isGmailHost(input.account.host) && !/^recent:/i.test(input.account.username)) {
    return `${base} Gmail's "all mail" POP mode serves the oldest messages first and never advances for a read-only client: set the POP3 username to "recent:${input.account.username}" or switch Gmail to "Enable POP for mail that arrives from now on".`;
  }
  return `${base} Check the mail server's POP3 download-window settings.`;
};

const clampSearchLimit = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_MAX_SEARCH_RESULTS;
  }
  return Math.max(1, Math.min(MAX_SEARCH_RESULTS, Math.trunc(value)));
};

const toSummary = (entry: Pop3IndexEntry): ImapSearchMailResult["messages"][number] => ({
  uid: entry.uid,
  ...(entry.messageId === undefined ? {} : { messageId: entry.messageId }),
  ...(entry.subject === undefined ? {} : { subject: entry.subject }),
  from: entry.from,
  to: entry.to,
  cc: entry.cc,
  ...(entry.date === undefined ? {} : { date: entry.date }),
  flags: [],
  ...(entry.size === undefined ? {} : { size: entry.size }),
});

const summarizeHeaders = async (
  raw: Buffer,
): Promise<Pick<Pop3IndexEntry, "messageId" | "subject" | "from" | "to" | "cc" | "date">> => {
  try {
    const parsed = await PostalMime.parse(raw);
    const messageId = typeof parsed.messageId === "string" ? parsed.messageId.trim() : "";
    const subject = typeof parsed.subject === "string" ? parsed.subject.trim() : "";
    const date = parseDateHeader(parsed.date);
    return {
      ...(messageId.length === 0 ? {} : { messageId }),
      ...(subject.length === 0 ? {} : { subject }),
      from: parsed.from === undefined ? [] : formatAddressList([parsed.from]),
      to: formatAddressList(parsed.to),
      cc: formatAddressList(parsed.cc),
      ...(date === undefined ? {} : { date }),
    };
  } catch {
    return { from: [], to: [], cc: [] };
  }
};

export class Pop3ReadonlyToolService {
  private readonly runner: Pop3ToolRunner;

  constructor(
    private readonly options: {
      runner?: Pop3ToolRunner;
      indexDir?: string;
      maxMessageBytes?: number;
      maxTextChars?: number;
    } = {},
  ) {
    this.runner = options.runner ?? defaultRunner;
  }

  private indexPath(instanceId: string): string {
    return join(this.options.indexDir ?? defaultPop3IndexDir(), `${instanceId}.json`);
  }

  private async loadIndex(instanceId: string): Promise<Pop3UidlIndex> {
    const path = this.indexPath(instanceId);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return createIndex();
      }
      throw new SovereignToolError(
        "POP3_INDEX_READ_FAILED",
        `Failed to read the POP3 message index at ${path}`,
        false,
        { instanceId, path, error: error instanceof Error ? error.message : String(error) },
      );
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isIndex(parsed)) {
        return parsed;
      }
    } catch {
      // fall through: a corrupt index is replaced by a fresh generation
    }
    return createIndex();
  }

  private async saveIndex(instanceId: string, index: Pop3UidlIndex): Promise<void> {
    const path = this.indexPath(instanceId);
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const tempPath = `${path}.${randomUUID()}.tmp`;
      await writeFile(tempPath, `${JSON.stringify(index)}\n`, { encoding: "utf8", mode: 0o600 });
      await chmod(tempPath, 0o600);
      await rename(tempPath, path);
    } catch (error) {
      throw new SovereignToolError(
        "POP3_INDEX_WRITE_FAILED",
        `Failed to write the POP3 message index at ${path}`,
        false,
        { instanceId, path, error: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  async searchMail(input: {
    instanceId: string;
    account: Pop3AccountCredentials;
    query: string;
    limit?: number;
  }): Promise<ImapSearchMailResult> {
    const limit = clampSearchLimit(input.limit);
    const since = parseSinceBound(input.query);
    const index = await this.loadIndex(input.instanceId);

    await this.runner(input.account, async (client) => {
      const listing = await client.uidl();
      const sizes = new Map((await client.list()).map((entry) => [entry.number, entry.size]));
      const present = new Set(listing.map((entry) => entry.uidl));

      // Forget messages the user has deleted server-side; uids stay monotonic
      // because nextUid is never rewound.
      for (const uidl of Object.keys(index.entries)) {
        if (!present.has(uidl)) {
          delete index.entries[uidl];
        }
      }

      // Walk unknown messages newest-first so the header fetch can stop early
      // on an old mailbox, but assign uids oldest-first so that within one
      // scan uid order matches arrival order.
      const unknown = listing
        .filter((entry) => index.entries[entry.uidl] === undefined)
        .sort((left, right) => right.number - left.number);

      const pending = new Map<string, Omit<Pop3IndexEntry, "uid">>();
      let fetched = 0;
      let consecutiveOld = 0;
      for (const entry of unknown) {
        const size = sizes.get(entry.number);
        if (
          fetched >= MAX_HEADER_FETCHES_PER_SEARCH ||
          consecutiveOld >= STOP_AFTER_CONSECUTIVE_OLD
        ) {
          pending.set(entry.uidl, {
            from: [],
            to: [],
            cc: [],
            ...(size === undefined ? {} : { size }),
            baseline: true,
          });
          continue;
        }
        const headers = await summarizeHeaders(await client.top(entry.number, 0));
        fetched += 1;
        pending.set(entry.uidl, { ...headers, ...(size === undefined ? {} : { size }) });
        const isOld =
          since !== undefined && headers.date !== undefined && new Date(headers.date) < since;
        consecutiveOld = isOld ? consecutiveOld + 1 : 0;
      }
      for (const entry of [...unknown].sort((left, right) => left.number - right.number)) {
        const prepared = pending.get(entry.uidl);
        if (prepared !== undefined) {
          index.entries[entry.uidl] = { uid: index.nextUid++, ...prepared };
        }
      }
    });

    await this.saveIndex(input.instanceId, index);

    const matching = Object.values(index.entries)
      .filter((entry) => entry.baseline !== true)
      .filter(
        (entry) => since === undefined || entry.date === undefined || new Date(entry.date) >= since,
      )
      .sort((left, right) => right.uid - left.uid);

    // Newest Date header across everything indexed (baseline entries carry no
    // date); in a stuck window this stays years behind `since` on every scan.
    let newestKnownDate: Date | undefined;
    for (const entry of Object.values(index.entries)) {
      if (entry.date === undefined) {
        continue;
      }
      const date = new Date(entry.date);
      if (
        !Number.isNaN(date.getTime()) &&
        (newestKnownDate === undefined || date > newestKnownDate)
      ) {
        newestKnownDate = date;
      }
    }
    const note = buildStuckWindowNote({
      account: input.account,
      since,
      matchingCount: matching.length,
      visibleCount: Object.keys(index.entries).length,
      newestKnownDate,
    });

    return {
      instanceId: input.instanceId,
      mailbox: "INBOX",
      query: input.query,
      totalMatches: matching.length,
      messages: matching.slice(0, limit).map((entry) => toSummary(entry)),
      uidValidity: `${accountFingerprint(input.account)}:${index.generation}`,
      ...(note === undefined ? {} : { note }),
    };
  }

  async readMail(input: {
    instanceId: string;
    account: Pop3AccountCredentials;
    messageId: string;
  }): Promise<ImapReadMailResult> {
    const maxMessageBytes = this.options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    const maxTextChars = this.options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;
    const index = await this.loadIndex(input.instanceId);
    const selector = input.messageId.trim();
    const selectedBy: ImapReadMailResult["selectedBy"] = /^[1-9][0-9]*$/.test(selector)
      ? "uid"
      : "message-id";
    const wanted = Number.parseInt(selector, 10);
    const match = Object.entries(index.entries).find(([, entry]) =>
      selectedBy === "uid"
        ? entry.uid === wanted
        : entry.messageId !== undefined &&
          entry.messageId.replace(/^<|>$/g, "") === selector.replace(/^<|>$/g, ""),
    );
    if (match === undefined) {
      throw new SovereignToolError(
        "IMAP_MESSAGE_NOT_FOUND",
        `No message found for selector '${input.messageId}'`,
        false,
        { selector: input.messageId },
      );
    }
    const [uidl, entry] = match;

    return await this.runner(input.account, async (client) => {
      const current = (await client.uidl()).find((candidate) => candidate.uidl === uidl);
      if (current === undefined) {
        throw new SovereignToolError(
          "IMAP_MESSAGE_NOT_FOUND",
          `Message ${String(entry.uid)} is no longer on the POP3 server`,
          false,
          { selector: input.messageId, uid: entry.uid },
        );
      }
      const size = (await client.list()).find(
        (candidate) => candidate.number === current.number,
      )?.size;
      if (size !== undefined && size > maxMessageBytes) {
        throw new SovereignToolError(
          "IMAP_MESSAGE_TOO_LARGE",
          `Message ${String(entry.uid)} exceeds the ${String(maxMessageBytes)}-byte read limit`,
          false,
          { uid: entry.uid, size, maxMessageBytes },
        );
      }

      const source = await client.retr(current.number);
      let parsedWarning: string | undefined;
      let textBody = "";
      let htmlAvailable = false;
      let attachments: ImapReadMailResult["message"]["attachments"] = [];
      let headers: ImapReadMailResult["message"]["headers"] = {};
      let summary = toSummary(entry);
      try {
        const parsed = await PostalMime.parse(source);
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
          sizeBytes:
            typeof attachment.content === "string"
              ? Buffer.byteLength(attachment.content, "utf8")
              : attachment.content.byteLength,
        }));
        // Baseline entries were indexed without headers; fill them in now.
        const fromSource = await summarizeHeaders(source);
        summary = toSummary({ ...entry, ...fromSource, ...(size === undefined ? {} : { size }) });
      } catch (error) {
        parsedWarning = error instanceof Error ? error.message : String(error);
      }
      const truncated = truncateText(textBody, maxTextChars);

      return {
        instanceId: input.instanceId,
        mailbox: "INBOX",
        selectedBy,
        message: {
          ...summary,
          headers,
          text: truncated.text,
          textTruncated: truncated.truncated,
          htmlAvailable,
          attachments,
          ...(parsedWarning === undefined ? {} : { bodyParseWarning: parsedWarning }),
        },
      };
    });
  }
}
