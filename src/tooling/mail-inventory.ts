import { createHash } from "node:crypto";

import type { MailInventoryResult } from "../contracts/tool.js";
import { SovereignToolError } from "./mail-shared.js";

/**
 * Helpers for `sovereign-tool mail-inventory`: an identifier census of a
 * mailbox taken outside the search path, so a consumer can check every
 * arrival against what it actually processed. It shares no result limit,
 * watermark, header walk or date window with `imap-search-mail`.
 */

/**
 * The inventory runs inside a caller's scan budget, so it carries its own
 * wall-clock deadline instead of inheriting the much longer socket idle
 * timeouts of the mail clients.
 */
export const DEFAULT_INVENTORY_TIMEOUT_MS = 20_000;
export const MIN_INVENTORY_TIMEOUT_MS = 1_000;
export const MAX_INVENTORY_TIMEOUT_MS = 60_000;

export const clampInventoryTimeout = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_INVENTORY_TIMEOUT_MS;
  }
  return Math.max(MIN_INVENTORY_TIMEOUT_MS, Math.min(MAX_INVENTORY_TIMEOUT_MS, Math.trunc(value)));
};

/**
 * Rejects with a retryable `MAIL_INVENTORY_TIMEOUT` once `timeoutMs` passes,
 * after calling `onTimeout` so the caller can tear down its connection.
 */
export const withInventoryDeadline = async <T>(
  timeoutMs: number,
  work: Promise<T>,
  onTimeout: () => void,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout();
      } catch {
        // Tear-down is best effort; the deadline must reject regardless.
      }
      reject(
        new SovereignToolError(
          "MAIL_INVENTORY_TIMEOUT",
          `Mail inventory did not finish within ${String(timeoutMs)} ms`,
          true,
          { timeoutMs },
        ),
      );
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
};

/** Ascending, de-duplicated UIDs as inclusive `[first, last]` runs. */
export const compressUidRanges = (uids: readonly number[]): Array<[number, number]> => {
  const sorted = Uint32Array.from(uids).sort();
  const ranges: Array<[number, number]> = [];
  for (const uid of sorted) {
    const last = ranges[ranges.length - 1];
    if (last !== undefined && uid <= last[1] + 1) {
      last[1] = uid;
    } else {
      ranges.push([uid, uid]);
    }
  }
  return ranges;
};

/**
 * Counts UIDs in `(lowerBound, upperBound]` that are not covered by `ranges`.
 * IMAP assigns UIDs strictly ascending, so each one is a message that was
 * expunged before this census saw it, or a UID the server skipped.
 */
export const countUidGaps = (
  ranges: ReadonlyArray<readonly [number, number]>,
  lowerBound: number,
  upperBound: number,
): number => {
  let listed = 0;
  for (const [first, last] of ranges) {
    const from = Math.max(first, lowerBound + 1);
    const to = Math.min(last, upperBound);
    if (to >= from) {
      listed += to - from + 1;
    }
  }
  return Math.max(0, upperBound - lowerBound - listed);
};

/** Some servers derive UIDLs from host or file names; only a short hash leaves the tool. */
export const hashUidl = (uidl: string): string =>
  createHash("sha256").update(uidl).digest("hex").slice(0, 12);

export const formatMailInventoryResult = (result: MailInventoryResult): string => {
  if (result.protocol === "imap") {
    const validity = result.uidValidity === undefined ? "" : `, UIDVALIDITY ${result.uidValidity}`;
    const lines = [
      `Inventory of ${result.mailbox} (imap${validity}): ${String(result.messageCount)} message(s) on the server.`,
      result.afterUid === 0
        ? `Full census: ${String(result.count)} UID(s) in ${String(result.uidRanges.length)} range(s).`
        : `${String(result.count)} UID(s) above ${String(result.afterUid)} in ${String(result.uidRanges.length)} range(s).`,
      `UID gaps: ${String(result.uidGaps)}.`,
    ];
    if (result.uidValidityChanged) {
      lines.push("UIDVALIDITY changed since the previous inventory: this is a new key space.");
    }
    return lines.join("\n");
  }
  const validity = result.uidValidity === undefined ? "" : `, index ${result.uidValidity}`;
  return [
    `Inventory of ${result.mailbox} (pop3${validity}): ${String(result.messageCount)} message(s) on the server.`,
    `${String(result.count)} UIDL(s) listed, ${String(result.unindexedCount)} not yet in the message index (index ${result.index}).`,
  ].join("\n");
};
