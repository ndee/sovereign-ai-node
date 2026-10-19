import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mailInventoryResultSchema } from "../contracts/tool.js";

import type { Pop3AccountCredentials, Pop3ClientLike } from "../system/pop3-client.js";
import { hashUidl } from "./mail-inventory.js";
import {
  accountFingerprint,
  buildStuckWindowNote,
  Pop3ReadonlyToolService,
  parseSinceBound,
  STUCK_WINDOW_MARGIN_MS,
} from "./pop3-readonly.js";

type FakeMessage = { uidl: string; raw: string };

const buildRaw = (input: { id: string; subject: string; date: string; body?: string }): string =>
  [
    "From: Alice <alice@example.org>",
    "To: ops@example.org",
    `Subject: ${input.subject}`,
    `Message-ID: <${input.id}>`,
    `Date: ${input.date}`,
    "",
    input.body ?? "hello",
    "",
  ].join("\r\n");

const createFakeClient = (messages: FakeMessage[], commands: string[]): Pop3ClientLike => ({
  capa: async () => ["UIDL", "TOP"],
  stat: async () => ({ count: messages.length, sizeBytes: 0 }),
  list: async () => {
    commands.push("LIST");
    return messages.map((entry, index) => ({ number: index + 1, size: entry.raw.length }));
  },
  uidl: async () => {
    commands.push("UIDL");
    return messages.map((entry, index) => ({ number: index + 1, uidl: entry.uidl }));
  },
  top: async (number) => {
    commands.push(`TOP ${String(number)}`);
    const raw = messages[number - 1]?.raw ?? "";
    return Buffer.from(`${raw.split("\r\n\r\n")[0] ?? raw}\r\n\r\n`);
  },
  retr: async (number) => {
    commands.push(`RETR ${String(number)}`);
    return Buffer.from(messages[number - 1]?.raw ?? "");
  },
  quit: async () => {
    commands.push("QUIT");
  },
});

const account: Pop3AccountCredentials = {
  host: "pop.example.org",
  port: 995,
  tls: true,
  username: "ops@example.org",
  password: "secret",
};

describe("Pop3ReadonlyToolService", () => {
  let indexDir: string;
  let commands: string[];
  let messages: FakeMessage[];
  let service: Pop3ReadonlyToolService;

  beforeEach(async () => {
    indexDir = await mkdtemp(join(tmpdir(), "pop3-index-"));
    commands = [];
    messages = [
      {
        uidl: "u-old",
        raw: buildRaw({ id: "old@x", subject: "Old", date: "Mon, 01 Jan 2024 10:00:00 +0000" }),
      },
      {
        uidl: "u-1",
        raw: buildRaw({ id: "one@x", subject: "One", date: "Mon, 10 Aug 2026 10:00:00 +0000" }),
      },
      {
        uidl: "u-2",
        raw: buildRaw({ id: "two@x", subject: "Two", date: "Mon, 10 Aug 2026 11:00:00 +0000" }),
      },
    ];
    service = new Pop3ReadonlyToolService({
      indexDir,
      runner: async (_account, handler) => await handler(createFakeClient(messages, commands)),
    });
  });

  afterEach(async () => {
    await rm(indexDir, { recursive: true, force: true });
  });

  it("assigns monotonic synthetic uids and filters by the since bound", async () => {
    const result = await service.searchMail({
      instanceId: "ms-pop",
      account,
      query: "since:2026-08-01",
      limit: 10,
    });

    expect(result.mailbox).toBe("INBOX");
    expect(result.messages.map((entry) => entry.subject)).toEqual(["Two", "One"]);
    expect(result.messages.map((entry) => entry.uid)).toEqual([3, 2]);
    expect(result.messages[0]?.messageId).toBe("<two@x>");
    expect(result.totalMatches).toBe(2);
    expect(result.uidValidity).toMatch(new RegExp(`^${accountFingerprint(account)}:`));
    expect(commands.filter((entry) => entry.startsWith("DELE"))).toEqual([]);

    const indexStat = await stat(join(indexDir, "ms-pop.json"));
    expect(indexStat.mode & 0o777).toBe(0o600);
    const raw = await readFile(join(indexDir, "ms-pop.json"), "utf8");
    expect(raw).not.toContain("secret");
  });

  it("does not re-fetch or re-report already indexed messages across restarts", async () => {
    const first = await service.searchMail({
      instanceId: "ms-pop",
      account,
      query: "since:2026-08-01",
    });
    const topCallsAfterFirst = commands.filter((entry) => entry.startsWith("TOP")).length;

    // Simulate a fresh process: new service instance, same index dir.
    const restarted = new Pop3ReadonlyToolService({
      indexDir,
      runner: async (_account, handler) => await handler(createFakeClient(messages, commands)),
    });
    messages.push({
      uidl: "u-3",
      raw: buildRaw({ id: "three@x", subject: "Three", date: "Mon, 11 Aug 2026 09:00:00 +0000" }),
    });
    const second = await restarted.searchMail({
      instanceId: "ms-pop",
      account,
      query: "since:2026-08-01",
    });

    expect(commands.filter((entry) => entry.startsWith("TOP")).length).toBe(topCallsAfterFirst + 1);
    expect(second.uidValidity).toBe(first.uidValidity);
    expect(second.messages.map((entry) => entry.uid)).toEqual([4, 3, 2]);
    expect(Math.max(...second.messages.map((entry) => entry.uid))).toBeGreaterThan(
      Math.max(...first.messages.map((entry) => entry.uid)),
    );
  });

  it("drops server-side deleted messages from the index without reusing uids", async () => {
    await service.searchMail({ instanceId: "ms-pop", account, query: "since:2026-08-01" });
    messages.splice(1, 1); // user deleted "One" in their mail client
    messages.push({
      uidl: "u-4",
      raw: buildRaw({ id: "four@x", subject: "Four", date: "Mon, 12 Aug 2026 09:00:00 +0000" }),
    });
    const result = await service.searchMail({
      instanceId: "ms-pop",
      account,
      query: "since:2026-08-01",
    });
    expect(result.messages.map((entry) => [entry.subject, entry.uid])).toEqual([
      ["Four", 4],
      ["Two", 3],
    ]);
  });

  it("changes uidValidity when the account changes or the index is lost", async () => {
    const first = await service.searchMail({
      instanceId: "ms-pop",
      account,
      query: "since:2026-08-01",
    });
    const other = await service.searchMail({
      instanceId: "ms-pop",
      account: { ...account, username: "someone-else@example.org" },
      query: "since:2026-08-01",
    });
    expect(other.uidValidity).not.toBe(first.uidValidity);

    await rm(join(indexDir, "ms-pop.json"));
    const rebuilt = await service.searchMail({
      instanceId: "ms-pop",
      account,
      query: "since:2026-08-01",
    });
    expect(rebuilt.uidValidity).not.toBe(first.uidValidity);
  });

  it("reads a message by synthetic uid and by Message-ID with RETR only", async () => {
    await service.searchMail({ instanceId: "ms-pop", account, query: "since:2026-08-01" });
    const byUid = await service.readMail({ instanceId: "ms-pop", account, messageId: "3" });
    expect(byUid.selectedBy).toBe("uid");
    expect(byUid.message.subject).toBe("Two");
    expect(byUid.message.text).toBe("hello");
    expect(byUid.message.headers.subject).toBe("Two");

    const byMessageId = await service.readMail({
      instanceId: "ms-pop",
      account,
      messageId: "<one@x>",
    });
    expect(byMessageId.selectedBy).toBe("message-id");
    expect(byMessageId.message.uid).toBe(2);
    expect(commands.filter((entry) => entry.startsWith("DELE"))).toEqual([]);
  });

  it("fails cleanly for unknown selectors and messages removed from the server", async () => {
    await service.searchMail({ instanceId: "ms-pop", account, query: "since:2026-08-01" });
    await expect(
      service.readMail({ instanceId: "ms-pop", account, messageId: "999" }),
    ).rejects.toMatchObject({ code: "IMAP_MESSAGE_NOT_FOUND" });
    messages.splice(2, 1);
    await expect(
      service.readMail({ instanceId: "ms-pop", account, messageId: "3" }),
    ).rejects.toMatchObject({ code: "IMAP_MESSAGE_NOT_FOUND" });
  });

  it("enforces the message size limit", async () => {
    const limited = new Pop3ReadonlyToolService({
      indexDir,
      maxMessageBytes: 10,
      runner: async (_account, handler) => await handler(createFakeClient(messages, commands)),
    });
    await limited.searchMail({ instanceId: "ms-pop", account, query: "since:2026-08-01" });
    await expect(
      limited.readMail({ instanceId: "ms-pop", account, messageId: "3" }),
    ).rejects.toMatchObject({ code: "IMAP_MESSAGE_TOO_LARGE" });
  });

  it("records old messages as baseline after a run of out-of-window headers", async () => {
    const many: FakeMessage[] = [];
    for (let index = 0; index < 30; index += 1) {
      many.push({
        uidl: `old-${String(index)}`,
        raw: buildRaw({
          id: `old${String(index)}@x`,
          subject: `Old ${String(index)}`,
          date: "Mon, 01 Jan 2024 10:00:00 +0000",
        }),
      });
    }
    many.push({
      uidl: "fresh",
      raw: buildRaw({ id: "fresh@x", subject: "Fresh", date: "Mon, 10 Aug 2026 11:00:00 +0000" }),
    });
    const bounded = new Pop3ReadonlyToolService({
      indexDir,
      runner: async (_account, handler) => await handler(createFakeClient(many, commands)),
    });
    const result = await bounded.searchMail({
      instanceId: "ms-pop",
      account,
      query: "since:2026-08-01",
    });
    expect(result.messages.map((entry) => entry.subject)).toEqual(["Fresh"]);
    const topCalls = commands.filter((entry) => entry.startsWith("TOP")).length;
    expect(topCalls).toBeLessThan(many.length);
    // Every UIDL is now indexed: a second run fetches nothing new.
    commands.length = 0;
    await bounded.searchMail({ instanceId: "ms-pop", account, query: "since:2026-08-01" });
    expect(commands.filter((entry) => entry.startsWith("TOP"))).toEqual([]);
  });

  it("reports a stuck POP3 window with Gmail remediation when the visible mail is years old", async () => {
    // Gmail "all mail" POP mode: the server presents an old slice of the
    // mailbox and never advances it for a read-only client. The scan must not
    // look like a healthy quiet mailbox.
    const gmailAccount: Pop3AccountCredentials = {
      ...account,
      host: "pop.gmail.com",
      username: "ops@gmail.com",
    };
    const old: FakeMessage[] = [];
    for (let index = 0; index < 12; index += 1) {
      old.push({
        uidl: `ancient-${String(index)}`,
        raw: buildRaw({
          id: `ancient${String(index)}@x`,
          subject: `Ancient ${String(index)}`,
          date: "Wed, 30 Jan 2008 20:54:28 +0100",
        }),
      });
    }
    const stuck = new Pop3ReadonlyToolService({
      indexDir,
      runner: async (_account, handler) => await handler(createFakeClient(old, commands)),
    });
    const result = await stuck.searchMail({
      instanceId: "ms-pop",
      account: gmailAccount,
      query: "since:2026-08-25",
    });
    expect(result.messages).toEqual([]);
    expect(result.note).toContain("appears to exclude recent mail");
    expect(result.note).toContain("recent:ops@gmail.com");
    // The condition persists, so the note does too.
    const again = await stuck.searchMail({
      instanceId: "ms-pop",
      account: gmailAccount,
      query: "since:2026-08-25",
    });
    expect(again.note).toContain("recent:ops@gmail.com");
  });

  it("emits no note for a mailbox that is merely quiet", async () => {
    const result = await service.searchMail({
      instanceId: "ms-pop",
      account,
      // Both 2026 messages fall inside the margin even though they are older
      // than the bound itself.
      query: "since:2026-08-25",
    });
    expect(result.messages).toEqual([]);
    expect(result.note).toBeUndefined();
  });
});

describe("buildStuckWindowNote", () => {
  const base = {
    account: { host: "pop.example.org", username: "ops@example.org" },
    since: new Date("2026-08-25T00:00:00.000Z"),
    matchingCount: 0,
    visibleCount: 269,
    newestKnownDate: new Date("2008-02-02T03:28:53.000Z"),
  };

  it("names the stuck window generically for non-Gmail hosts", () => {
    const note = buildStuckWindowNote(base);
    expect(note).toContain("269 message(s)");
    expect(note).toContain("2008-02-02");
    expect(note).toContain("POP3 download-window settings");
    expect(note).not.toContain("recent:");
  });

  it("adds Gmail remediation for gmail hosts without the recent: prefix", () => {
    const note = buildStuckWindowNote({
      ...base,
      account: { host: "POP.GMAIL.COM", username: "ops@gmail.com" },
    });
    expect(note).toContain("recent:ops@gmail.com");
    expect(
      buildStuckWindowNote({
        ...base,
        account: { host: "pop.googlemail.com", username: "recent:ops@gmail.com" },
      }),
    ).toContain("download-window settings");
  });

  it("stays silent without a since bound, with matches, on empty mailboxes, and inside the margin", () => {
    expect(buildStuckWindowNote({ ...base, since: undefined })).toBeUndefined();
    expect(buildStuckWindowNote({ ...base, matchingCount: 1 })).toBeUndefined();
    expect(buildStuckWindowNote({ ...base, visibleCount: 0 })).toBeUndefined();
    expect(buildStuckWindowNote({ ...base, newestKnownDate: undefined })).toBeUndefined();
    expect(
      buildStuckWindowNote({
        ...base,
        newestKnownDate: new Date(base.since.getTime() - STUCK_WINDOW_MARGIN_MS),
      }),
    ).toBeUndefined();
    expect(
      buildStuckWindowNote({
        ...base,
        newestKnownDate: new Date(base.since.getTime() - STUCK_WINDOW_MARGIN_MS - 1),
      }),
    ).toBeDefined();
  });
});

describe("parseSinceBound", () => {
  it("extracts the since date from the shared query syntax", () => {
    expect(parseSinceBound("since:2026-08-01")?.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(parseSinceBound("INBOX since:2026-08-01 from:alice")?.toISOString()).toBe(
      "2026-08-01T00:00:00.000Z",
    );
    expect(parseSinceBound("since:not-a-date")).toBeUndefined();
    expect(parseSinceBound("ALL")).toBeUndefined();
  });
});

describe("Pop3ReadonlyToolService.inventoryMail", () => {
  let indexDir: string;
  let messages: FakeMessage[];
  let service: Pop3ReadonlyToolService;

  const message = (uidl: string, id: string): FakeMessage => ({
    uidl,
    raw: buildRaw({ id, subject: `Subject ${id}`, date: "Mon, 10 Aug 2026 10:00:00 +0000" }),
  });

  /** Every file in the index directory with its bytes and mtime. */
  const snapshotDir = async (): Promise<Record<string, string>> => {
    const { readdir } = await import("node:fs/promises");
    const entries: Record<string, string> = {};
    for (const name of await readdir(indexDir)) {
      const path = join(indexDir, name);
      entries[name] = `${(await stat(path)).mtimeMs}:${await readFile(path, "utf8")}`;
    }
    return entries;
  };

  beforeEach(async () => {
    indexDir = await mkdtemp(join(tmpdir(), "pop3-inventory-"));
    messages = [message("u-a", "a@x"), message("u-b", "b@x")];
    service = new Pop3ReadonlyToolService({
      indexDir,
      runner: async (_account, handler) => await handler(createFakeClient(messages, [])),
    });
  });

  afterEach(async () => {
    await rm(indexDir, { recursive: true, force: true });
  });

  it("maps every UIDL through the index without writing it", async () => {
    const searched = await service.searchMail({ instanceId: "ms-pop", account, query: "ALL" });
    messages.push(message("u-c", "c@x"));
    const index = JSON.parse(await readFile(join(indexDir, "ms-pop.json"), "utf8")) as {
      entries: Record<string, { baseline?: true }>;
    };
    if (index.entries["u-a"] === undefined) {
      throw new Error("fixture: u-a must be indexed");
    }
    index.entries["u-a"].baseline = true;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(indexDir, "ms-pop.json"), JSON.stringify(index));
    const before = await snapshotDir();

    const result = await service.inventoryMail({
      instanceId: "ms-pop",
      account,
      timeoutMs: 20_000,
    });

    expect(mailInventoryResultSchema.parse(result)).toEqual(result);
    expect(result).toMatchObject({
      protocol: "pop3",
      instanceId: "ms-pop",
      mailbox: "INBOX",
      uidValidity: searched.uidValidity,
      index: "present",
      messageCount: 3,
      count: 3,
      unindexedCount: 1,
      messages: [
        { uidlHash: hashUidl("u-a"), uid: 1, baseline: true },
        { uidlHash: hashUidl("u-b"), uid: 2 },
        { uidlHash: hashUidl("u-c") },
      ],
    });
    expect(await snapshotDir()).toEqual(before);
    // UIDLs can embed server host or file names; only their hash is emitted.
    expect(JSON.stringify(result)).not.toMatch(/u-[abc]/);
  });

  it("never creates an index that does not exist yet", async () => {
    const result = await service.inventoryMail({
      instanceId: "ms-pop",
      account,
      timeoutMs: 20_000,
    });

    expect(result).toMatchObject({ index: "absent", count: 2, unindexedCount: 2 });
    expect(result).not.toHaveProperty("uidValidity");
    expect(await snapshotDir()).toEqual({});
  });

  it("reports a corrupt index as such and leaves it for the search to replace", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(indexDir, "ms-pop.json"), "{not json");
    const before = await snapshotDir();

    const corrupt = await service.inventoryMail({ instanceId: "ms-pop", account, timeoutMs: 1 });
    expect(corrupt).toMatchObject({ index: "corrupt", unindexedCount: 2 });
    expect(corrupt).not.toHaveProperty("uidValidity");
    expect(await snapshotDir()).toEqual(before);

    await writeFile(join(indexDir, "ms-pop.json"), JSON.stringify({ version: 99 }));
    expect(
      await service.inventoryMail({ instanceId: "ms-pop", account, timeoutMs: 1 }),
    ).toMatchObject({ index: "corrupt" });
  });

  it("does not resolve UIDLs through inherited object keys", async () => {
    await service.searchMail({ instanceId: "ms-pop", account, query: "ALL" });
    messages.push(message("constructor", "ctor@x"), message("__proto__", "proto@x"));

    const result = await service.inventoryMail({ instanceId: "ms-pop", account, timeoutMs: 1 });
    expect(result.messages.slice(2)).toEqual([
      { uidlHash: hashUidl("constructor") },
      { uidlHash: hashUidl("__proto__") },
    ]);
  });

  it("fails closed when the index exists but cannot be read", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(indexDir, "ms-pop.json"));
    await expect(
      service.inventoryMail({ instanceId: "ms-pop", account, timeoutMs: 1 }),
    ).rejects.toMatchObject({ code: "POP3_INDEX_READ_FAILED" });
  });

  it("lists a large mailbox in server order", async () => {
    messages = Array.from({ length: 5_000 }, (_, position) =>
      message(`uidl-${String(position)}`, `${String(position)}@x`),
    );
    const reversing = new Pop3ReadonlyToolService({
      indexDir,
      runner: async (_account, handler) => {
        const client = createFakeClient(messages, []);
        return await handler({ ...client, uidl: async () => (await client.uidl()).reverse() });
      },
    });

    const result = await reversing.inventoryMail({ instanceId: "ms-pop", account, timeoutMs: 1 });
    expect(result).toMatchObject({ messageCount: 5_000, count: 5_000, unindexedCount: 5_000 });
    expect(result.messages[0]).toEqual({ uidlHash: hashUidl("uidl-0") });
    expect(result.messages[4_999]).toEqual({ uidlHash: hashUidl("uidl-4999") });
  });

  it("leaves a concurrent search's index write intact", async () => {
    await Promise.all([
      service.searchMail({ instanceId: "ms-pop", account, query: "ALL" }),
      service.inventoryMail({ instanceId: "ms-pop", account, timeoutMs: 20_000 }),
    ]);
    const alone = await mkdtemp(join(tmpdir(), "pop3-inventory-alone-"));
    try {
      const reference = new Pop3ReadonlyToolService({
        indexDir: alone,
        runner: async (_account, handler) => await handler(createFakeClient(messages, [])),
      });
      await reference.searchMail({ instanceId: "ms-pop", account, query: "ALL" });
      const strip = (raw: string) => {
        const parsed = JSON.parse(raw) as { generation?: string };
        delete parsed.generation;
        return parsed;
      };
      expect(strip(await readFile(join(indexDir, "ms-pop.json"), "utf8"))).toEqual(
        strip(await readFile(join(alone, "ms-pop.json"), "utf8")),
      );
    } finally {
      await rm(alone, { recursive: true, force: true });
    }
  });

  it("aborts the connection when its deadline passes", async () => {
    vi.useFakeTimers();
    try {
      // The index is read from disk first; advance the clock only once the
      // session is actually waiting on the server.
      const stalledStat = (reached: () => void) => (): Promise<never> => {
        reached();
        return new Promise(() => {});
      };
      let aborted = 0;
      let reachedFirst: () => void = () => {};
      const firstReached = new Promise<void>((resolve) => {
        reachedFirst = resolve;
      });
      const stalled = new Pop3ReadonlyToolService({
        indexDir,
        runner: async (_account, handler) =>
          await handler({
            ...createFakeClient(messages, []),
            stat: stalledStat(reachedFirst),
            abort: () => {
              aborted += 1;
            },
          }),
      });
      const pending = stalled.inventoryMail({ instanceId: "ms-pop", account, timeoutMs: 3_000 });
      const outcome = expect(pending).rejects.toMatchObject({ code: "MAIL_INVENTORY_TIMEOUT" });
      await firstReached;
      await vi.advanceTimersByTimeAsync(3_000);
      await outcome;
      expect(aborted).toBe(1);

      // A client without `abort` still yields the timeout.
      let reachedSecond: () => void = () => {};
      const secondReached = new Promise<void>((resolve) => {
        reachedSecond = resolve;
      });
      const plain = new Pop3ReadonlyToolService({
        indexDir,
        runner: async (_account, handler) =>
          await handler({ ...createFakeClient(messages, []), stat: stalledStat(reachedSecond) }),
      });
      const second = expect(
        plain.inventoryMail({ instanceId: "ms-pop", account, timeoutMs: 3_000 }),
      ).rejects.toMatchObject({ code: "MAIL_INVENTORY_TIMEOUT" });
      await secondReached;
      await vi.advanceTimersByTimeAsync(3_000);
      await second;
    } finally {
      vi.useRealTimers();
    }
  });
});
