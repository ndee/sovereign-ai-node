import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clampInventoryTimeout,
  compressUidRanges,
  countUidGaps,
  DEFAULT_INVENTORY_TIMEOUT_MS,
  formatMailInventoryResult,
  hashUidl,
  MAX_INVENTORY_TIMEOUT_MS,
  MIN_INVENTORY_TIMEOUT_MS,
  withInventoryDeadline,
} from "./mail-inventory.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("clampInventoryTimeout", () => {
  it("defaults, truncates and clamps the deadline", () => {
    expect(clampInventoryTimeout(undefined)).toBe(DEFAULT_INVENTORY_TIMEOUT_MS);
    expect(clampInventoryTimeout(Number.NaN)).toBe(DEFAULT_INVENTORY_TIMEOUT_MS);
    expect(clampInventoryTimeout(5_000.9)).toBe(5_000);
    expect(clampInventoryTimeout(1)).toBe(MIN_INVENTORY_TIMEOUT_MS);
    expect(clampInventoryTimeout(10_000_000)).toBe(MAX_INVENTORY_TIMEOUT_MS);
  });
});

describe("withInventoryDeadline", () => {
  it("returns the work's result and clears its timer", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    await expect(withInventoryDeadline(1_000, Promise.resolve("done"), onTimeout)).resolves.toBe(
      "done",
    );
    expect(vi.getTimerCount()).toBe(0);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("tears down and rejects with a retryable timeout once the deadline passes", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const pending = withInventoryDeadline(2_000, new Promise(() => {}), onTimeout);
    const outcome = expect(pending).rejects.toMatchObject({
      name: "SovereignToolError",
      code: "MAIL_INVENTORY_TIMEOUT",
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await outcome;
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });
  it("still rejects when tearing down the connection throws", async () => {
    vi.useFakeTimers();
    const pending = withInventoryDeadline(1_000, new Promise(() => {}), () => {
      throw new Error("already closed");
    });
    const outcome = expect(pending).rejects.toMatchObject({ code: "MAIL_INVENTORY_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(1_000);
    await outcome;
  });
});

describe("compressUidRanges", () => {
  it("sorts, de-duplicates and merges consecutive UIDs", () => {
    expect(compressUidRanges([])).toEqual([]);
    expect(compressUidRanges([9, 3, 4, 4, 5, 7, 8, 12])).toEqual([
      [3, 5],
      [7, 9],
      [12, 12],
    ]);
  });

  it("handles UIDs up to the IMAP maximum", () => {
    expect(compressUidRanges([4_294_967_295, 4_294_967_294])).toEqual([
      [4_294_967_294, 4_294_967_295],
    ]);
  });
});

describe("countUidGaps", () => {
  it("counts unlisted UIDs inside the bounds only", () => {
    const ranges: Array<[number, number]> = [
      [3, 5],
      [8, 8],
    ];
    expect(countUidGaps(ranges, 0, 10)).toBe(6);
    expect(countUidGaps(ranges, 4, 8)).toBe(2);
    expect(countUidGaps([], 10, 10)).toBe(0);
    expect(countUidGaps([], 10, 4)).toBe(0);
  });
});

describe("hashUidl", () => {
  it("is a stable 12-hex-digit digest", () => {
    expect(hashUidl("u-1")).toMatch(/^[0-9a-f]{12}$/);
    expect(hashUidl("u-1")).toBe(hashUidl("u-1"));
    expect(hashUidl("u-1")).not.toBe(hashUidl("u-2"));
  });
});

describe("formatMailInventoryResult", () => {
  const imap = {
    protocol: "imap" as const,
    instanceId: "mail",
    mailbox: "INBOX",
    inventoriedAt: "2026-10-19T08:00:00.000Z",
    messageCount: 41,
    count: 3,
    uidValidityChanged: false,
    afterUid: 0,
    uidRanges: [[1, 3]] as Array<[number, number]>,
    uidGaps: 0,
  };

  it("summarises an IMAP census", () => {
    expect(formatMailInventoryResult({ ...imap, uidValidity: "7" })).toBe(
      [
        "Inventory of INBOX (imap, UIDVALIDITY 7): 41 message(s) on the server.",
        "Full census: 3 UID(s) in 1 range(s).",
        "UID gaps: 0.",
      ].join("\n"),
    );
    expect(
      formatMailInventoryResult({ ...imap, afterUid: 10, uidGaps: 2, uidValidityChanged: true }),
    ).toBe(
      [
        "Inventory of INBOX (imap): 41 message(s) on the server.",
        "3 UID(s) above 10 in 1 range(s).",
        "UID gaps: 2.",
        "UIDVALIDITY changed since the previous inventory: this is a new key space.",
      ].join("\n"),
    );
  });

  it("summarises a POP3 listing", () => {
    const pop3 = {
      protocol: "pop3" as const,
      instanceId: "mail",
      mailbox: "INBOX",
      inventoriedAt: "2026-10-19T08:00:00.000Z",
      messageCount: 2,
      count: 2,
      index: "absent" as const,
      messages: [],
      unindexedCount: 2,
    };
    expect(formatMailInventoryResult(pop3)).toBe(
      [
        "Inventory of INBOX (pop3): 2 message(s) on the server.",
        "2 UIDL(s) listed, 2 not yet in the message index (index absent).",
      ].join("\n"),
    );
    expect(
      formatMailInventoryResult({ ...pop3, index: "present", uidValidity: "ab:cd" }),
    ).toContain("(pop3, index ab:cd)");
  });
});
