import type { FetchMessageObject } from "imapflow";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mailInventoryResultSchema } from "../contracts/tool.js";

import type { RuntimeConfig } from "../installer/real-service-shared.js";
import type { ImapClientLike } from "../system/imap-client.js";
import {
  buildImapSearchQuery,
  ImapReadonlyToolService,
  normalizeImapSearchQuery,
} from "./imap-readonly.js";
import type { Pop3ReadonlyToolService } from "./pop3-readonly.js";

const TEST_SECRET_ENV = "SOVEREIGN_TEST_IMAP_PASSWORD";

const buildRuntimeConfig = (secretRef: string): RuntimeConfig => ({
  openrouter: {
    model: "qwen/qwen-2.5-7b-instruct",
    apiKeySecretRef: "env:OPENROUTER_API_KEY",
    privacy: { zdr: true, dataCollection: "deny", allowFallbacks: false },
  },
  openclaw: {
    managedInstallation: true,
    installMethod: "install_sh",
    requestedVersion: "pinned-by-sovereign",
    openclawHome: "/tmp/openclaw-home",
    runtimeConfigPath: "/tmp/openclaw.json5",
    runtimeProfilePath: "/tmp/sovereign-runtime-profile.json5",
    gatewayEnvPath: "/tmp/gateway.env",
  },
  openclawProfile: {
    plugins: {
      allow: ["matrix", "imap-readonly"],
    },
    agents: [],
    crons: [],
    cron: {
      id: "mail-sentinel-poll",
      every: "5m",
    },
  },
  imap: {
    status: "configured",
    protocol: "imap",
    host: "127.0.0.1",
    port: 1143,
    tls: true,
    username: "bridge-user",
    mailbox: "INBOX",
    secretRef,
  },
  bots: {
    config: {
      "mail-sentinel": {
        pollInterval: "30m",
        lookbackWindow: "1h",
        e2eeAlertRoom: false,
      },
    },
    instances: [],
  },
  matrix: {
    accessMode: "relay",
    homeserverDomain: "matrix.example.org",
    federationEnabled: false,
    publicBaseUrl: "https://matrix.example.org",
    adminBaseUrl: "https://matrix.example.org",
    operator: {
      userId: "@operator:matrix.example.org",
    },
    bot: {
      userId: "@mail-sentinel:matrix.example.org",
      accessTokenSecretRef: "env:MATRIX_BOT_TOKEN",
    },
    alertRoom: {
      roomId: "!alerts:matrix.example.org",
      roomName: "Sovereign Alerts",
    },
  },
  templates: {
    installed: [],
  },
  sovereignTools: {
    instances: [
      {
        id: "mail-sentinel-imap",
        templateRef: "imap-readonly@1.0.0",
        capabilities: ["imap.read-mail", "imap.search-mail", "imap.fetch-headers"],
        config: {
          host: "127.0.0.1",
          port: "1143",
          tls: "true",
          username: "bridge-user",
          mailbox: "INBOX",
        },
        secretRefs: {
          password: secretRef,
        },
        createdAt: "2026-03-06T00:00:00.000Z",
        updatedAt: "2026-03-06T00:00:00.000Z",
      },
    ],
  },
});

const createNoopClient = (): ImapClientLike => ({
  authenticated: "bridge-user",
  capabilities: new Map(),
  close: () => {},
  connect: async () => {},
  fetchAll: async () => [],
  fetchOne: async () => false,
  getMailboxLock: async () => ({
    path: "INBOX",
    release: () => {},
  }),
  logout: async () => {},
  mailbox: {
    path: "INBOX",
    delimiter: "/",
    flags: new Set(),
    uidValidity: 1n,
    uidNext: 1,
    exists: 0,
  },
  mailboxOpen: async () => ({
    path: "INBOX",
    delimiter: "/",
    flags: new Set(),
    uidValidity: 1n,
    uidNext: 1,
    exists: 0,
  }),
  search: async () => [],
  status: async () => ({ path: "INBOX" }),
});

afterEach(() => {
  delete process.env[TEST_SECRET_ENV];
});

describe("imap-readonly tool service", () => {
  it("builds field-aware IMAP search queries", () => {
    expect(
      buildImapSearchQuery('from:alerts@example.org subject:"Quarterly Report" is:unseen'),
    ).toEqual({
      from: "alerts@example.org",
      subject: "Quarterly Report",
      seen: false,
    });
  });

  it("normalizes a redundant mailbox prefix in IMAP search queries", () => {
    expect(normalizeImapSearchQuery("INBOX ALL", "INBOX")).toBe("ALL");
    expect(normalizeImapSearchQuery("INBOX is:unseen", "INBOX")).toBe("is:unseen");
  });

  it("searches mail through a bound read-only instance", async () => {
    process.env[TEST_SECRET_ENV] = "bridge-pass";

    const lockCalls: Array<{ mailbox: string; readOnly?: boolean; description?: string }> = [];
    const searchQueries: unknown[] = [];
    const runnerAccounts: Array<{
      host: string;
      port: number;
      tls: boolean;
      username: string;
      password: string;
      mailbox?: string;
    }> = [];
    const runtimeConfig = buildRuntimeConfig(`env:${TEST_SECRET_ENV}`);
    const service = new ImapReadonlyToolService({
      configLoader: async () => runtimeConfig,
      runner: async (account, handler) => {
        runnerAccounts.push(account);
        const client: ImapClientLike = {
          ...createNoopClient(),
          getMailboxLock: async (mailbox, options) => {
            lockCalls.push({
              mailbox: typeof mailbox === "string" ? mailbox : mailbox.join("/"),
              ...(options?.readOnly === undefined ? {} : { readOnly: options.readOnly }),
              ...(options?.description === undefined ? {} : { description: options.description }),
            });
            return {
              path: "INBOX",
              release: () => {},
            };
          },
          search: async (query) => {
            searchQueries.push(query);
            return [12, 27];
          },
          fetchAll: async (): Promise<FetchMessageObject[]> => [
            {
              seq: 1,
              uid: 12,
              envelope: {
                subject: "Older update",
                from: [{ address: "alerts@example.org", name: "Alerts" }],
              },
              flags: new Set(["\\Seen"]),
              internalDate: "2026-03-05T09:00:00.000Z",
              size: 512,
            },
            {
              seq: 2,
              uid: 27,
              envelope: {
                subject: "Quarterly Report",
                from: [{ address: "alerts@example.org", name: "Alerts" }],
              },
              flags: new Set(),
              internalDate: "2026-03-06T09:30:00.000Z",
              size: 1024,
            },
          ],
        };

        return await handler(client);
      },
    });

    const result = await service.searchMail({
      instanceId: "mail-sentinel-imap",
      query: 'subject:"Quarterly Report" is:unseen',
      limit: 5,
    });

    expect(runnerAccounts).toEqual([
      {
        host: "127.0.0.1",
        port: 1143,
        tls: true,
        username: "bridge-user",
        password: "bridge-pass",
        mailbox: "INBOX",
      },
    ]);
    expect(lockCalls).toEqual([
      {
        mailbox: "INBOX",
        readOnly: true,
        description: "sovereign-tool:mail-sentinel-imap:search",
      },
    ]);
    expect(searchQueries).toEqual([
      {
        subject: "Quarterly Report",
        seen: false,
      },
    ]);
    expect(result.totalMatches).toBe(2);
    expect(result.messages.map((message) => message.uid)).toEqual([27, 12]);
    expect(result.messages[0]?.subject).toBe("Quarterly Report");
    expect(result.uidValidity).toBe("1");
  });

  it("omits uidValidity when the client does not expose an open mailbox", async () => {
    process.env[TEST_SECRET_ENV] = "bridge-pass";

    const runtimeConfig = buildRuntimeConfig(`env:${TEST_SECRET_ENV}`);
    const service = new ImapReadonlyToolService({
      configLoader: async () => runtimeConfig,
      runner: async (_account, handler) => {
        const client: ImapClientLike = {
          ...createNoopClient(),
          mailbox: false,
          search: async () => [],
        };
        return await handler(client);
      },
    });

    const result = await service.searchMail({
      instanceId: "mail-sentinel-imap",
      query: "ALL",
      limit: 5,
    });

    expect(result.uidValidity).toBeUndefined();
  });

  it("treats a leading configured mailbox token as redundant during search", async () => {
    process.env[TEST_SECRET_ENV] = "bridge-pass";

    const searchQueries: unknown[] = [];
    const runtimeConfig = buildRuntimeConfig(`env:${TEST_SECRET_ENV}`);
    const service = new ImapReadonlyToolService({
      configLoader: async () => runtimeConfig,
      runner: async (_account, handler) => {
        const client: ImapClientLike = {
          ...createNoopClient(),
          search: async (query) => {
            searchQueries.push(query);
            return [];
          },
        };
        return await handler(client);
      },
    });

    await service.searchMail({
      instanceId: "mail-sentinel-imap",
      query: "INBOX ALL",
      limit: 3,
    });

    expect(searchQueries).toEqual([
      {
        all: true,
      },
    ]);
  });

  it("reads a message by RFC 5322 Message-ID without write access", async () => {
    process.env[TEST_SECRET_ENV] = "bridge-pass";

    const searchQueries: unknown[] = [];
    const lockCalls: Array<{ mailbox: string; readOnly?: boolean; description?: string }> = [];
    const runtimeConfig = buildRuntimeConfig(`env:${TEST_SECRET_ENV}`);
    const rawEmail = Buffer.from(
      [
        "From: Alerts <alerts@example.org>",
        "To: Operator <operator@example.org>",
        "Subject: Proton Bridge Test",
        "Message-ID: <bridge-test@example.org>",
        "Date: Fri, 06 Mar 2026 10:00:00 +0000",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="boundary42"',
        "",
        "--boundary42",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Hello from Proton Bridge.",
        "",
        "--boundary42",
        "Content-Type: application/pdf",
        'Content-Disposition: attachment; filename="report.pdf"',
        "Content-Transfer-Encoding: base64",
        "",
        "SGVsbG8=",
        "--boundary42--",
        "",
      ].join("\r\n"),
      "utf8",
    );

    const service = new ImapReadonlyToolService({
      configLoader: async () => runtimeConfig,
      runner: async (_account, handler) => {
        const client: ImapClientLike = {
          ...createNoopClient(),
          getMailboxLock: async (mailbox, options) => {
            lockCalls.push({
              mailbox: typeof mailbox === "string" ? mailbox : mailbox.join("/"),
              ...(options?.readOnly === undefined ? {} : { readOnly: options.readOnly }),
              ...(options?.description === undefined ? {} : { description: options.description }),
            });
            return {
              path: "INBOX",
              release: () => {},
            };
          },
          search: async (query) => {
            searchQueries.push(query);
            return [41];
          },
          fetchOne: async () => ({
            seq: 1,
            uid: 41,
            envelope: {
              messageId: "<bridge-test@example.org>",
              subject: "Proton Bridge Test",
              from: [{ address: "alerts@example.org", name: "Alerts" }],
              to: [{ address: "operator@example.org", name: "Operator" }],
            },
            flags: new Set(["\\Seen"]),
            internalDate: "2026-03-06T10:00:00.000Z",
            size: rawEmail.byteLength,
            source: rawEmail,
          }),
        };

        return await handler(client);
      },
    });

    const result = await service.readMail({
      instanceId: "mail-sentinel-imap",
      messageId: "bridge-test@example.org",
    });

    expect(lockCalls).toEqual([
      {
        mailbox: "INBOX",
        readOnly: true,
        description: "sovereign-tool:mail-sentinel-imap:read",
      },
    ]);
    expect(searchQueries).toEqual([
      {
        header: {
          "message-id": "<bridge-test@example.org>",
        },
      },
    ]);
    expect(result.selectedBy).toBe("message-id");
    expect(result.message.uid).toBe(41);
    expect(result.message.subject).toBe("Proton Bridge Test");
    expect(result.message.text).toContain("Hello from Proton Bridge.");
    expect(result.message.attachments).toEqual([
      {
        filename: "report.pdf",
        mimeType: "application/pdf",
        disposition: "attachment",
        related: false,
        sizeBytes: 5,
      },
    ]);
  });
});

describe("ImapReadonlyToolService protocol dispatch", () => {
  it("routes pop3-bound tool instances to the POP3 backend and resolves the secret", async () => {
    process.env[TEST_SECRET_ENV] = "pop3-secret";
    const runtimeConfig = buildRuntimeConfig(`env:${TEST_SECRET_ENV}`);
    const instance = runtimeConfig.sovereignTools.instances[0];
    if (instance === undefined) {
      throw new Error("fixture missing tool instance");
    }
    instance.config = { ...instance.config, protocol: "pop3", port: "995" };
    const calls: unknown[] = [];
    const pop3 = {
      searchMail: async (input: unknown) => {
        calls.push(input);
        return {
          instanceId: "mail-sentinel-imap",
          mailbox: "INBOX",
          query: "since:2026-08-01",
          totalMatches: 0,
          messages: [],
          uidValidity: "abc:def",
        };
      },
      readMail: async (input: unknown) => {
        calls.push(input);
        throw new Error("not reached");
      },
    } as unknown as Pop3ReadonlyToolService;
    const service = new ImapReadonlyToolService({
      configLoader: async () => runtimeConfig,
      runner: async () => {
        throw new Error("IMAP runner must not be used for POP3 instances");
      },
      pop3,
    });
    try {
      const result = await service.searchMail({
        instanceId: "mail-sentinel-imap",
        query: "since:2026-08-01",
        limit: 5,
      });
      expect(result.uidValidity).toBe("abc:def");
      expect(calls[0]).toMatchObject({
        instanceId: "mail-sentinel-imap",
        query: "since:2026-08-01",
        limit: 5,
        account: {
          host: "127.0.0.1",
          port: 995,
          tls: true,
          username: "bridge-user",
          password: "pop3-secret",
        },
      });
    } finally {
      delete process.env[TEST_SECRET_ENV];
    }
  });

  it("rejects unknown protocol bindings", async () => {
    const runtimeConfig = buildRuntimeConfig("env:UNUSED");
    const instance = runtimeConfig.sovereignTools.instances[0];
    if (instance === undefined) {
      throw new Error("fixture missing tool instance");
    }
    instance.config = { ...instance.config, protocol: "nntp" };
    const service = new ImapReadonlyToolService({ configLoader: async () => runtimeConfig });
    await expect(
      service.searchMail({ instanceId: "mail-sentinel-imap", query: "ALL" }),
    ).rejects.toMatchObject({ code: "TOOL_INSTANCE_INVALID" });
  });
});

describe("ImapReadonlyToolService.inventoryMail", () => {
  type Mailbox = Exclude<ImapClientLike["mailbox"], false>;

  const openMailbox = (overrides: Partial<Mailbox> = {}): Mailbox => ({
    path: "INBOX",
    delimiter: "/",
    flags: new Set(),
    uidValidity: 7n,
    uidNext: 101,
    exists: 3,
    ...overrides,
  });

  const createInventoryService = (input: {
    uids: number[] | false;
    mailbox?: ImapClientLike["mailbox"];
    statusMessages?: number | false;
    log?: { searches: unknown[]; locks: unknown[]; statuses: unknown[] };
  }): ImapReadonlyToolService => {
    process.env[TEST_SECRET_ENV] = "bridge-pass";
    const runtimeConfig = buildRuntimeConfig(`env:${TEST_SECRET_ENV}`);
    return new ImapReadonlyToolService({
      configLoader: async () => runtimeConfig,
      runner: async (_account, handler) =>
        await handler({
          ...createNoopClient(),
          mailbox: input.mailbox ?? openMailbox(),
          getMailboxLock: async (mailbox, options) => {
            input.log?.locks.push({ mailbox, ...options });
            return { path: "INBOX", release: () => {} };
          },
          status: (async (mailbox: string, query: unknown) => {
            input.log?.statuses.push({ mailbox, query });
            return input.statusMessages === false
              ? false
              : { path: "INBOX", messages: input.statusMessages ?? 3 };
          }) as unknown as ImapClientLike["status"],
          search: async (query) => {
            input.log?.searches.push(query);
            return input.uids;
          },
        }),
    });
  };

  it("takes a full read-only census with UIDVALIDITY, STATUS count and internal gaps", async () => {
    const log = { searches: [] as unknown[], locks: [] as unknown[], statuses: [] as unknown[] };
    const service = createInventoryService({ uids: [12, 10, 11, 15, 20], log, statusMessages: 5 });
    const result = await service.inventoryMail({ instanceId: "mail-sentinel-imap" });

    expect(mailInventoryResultSchema.parse(result)).toEqual(result);
    expect(result).toMatchObject({
      protocol: "imap",
      instanceId: "mail-sentinel-imap",
      mailbox: "INBOX",
      uidValidity: "7",
      uidValidityChanged: false,
      afterUid: 0,
      uidNext: 101,
      messageCount: 5,
      count: 5,
      highestUid: 20,
      uidRanges: [
        [10, 12],
        [15, 15],
        [20, 20],
      ],
      // 13, 14 and 16-19: holes between listed UIDs. History below UID 10 and
      // the tail up to UIDNEXT are not arrivals of this census.
      uidGaps: 6,
    });
    expect(Number.isFinite(Date.parse(result.inventoriedAt))).toBe(true);
    expect(log.searches).toEqual([{ uid: "1:*" }]);
    expect(log.statuses).toEqual([{ mailbox: "INBOX", query: { messages: true } }]);
    expect(log.locks).toEqual([
      {
        mailbox: "INBOX",
        readOnly: true,
        description: "sovereign-tool:mail-sentinel-imap:inventory",
      },
    ]);
  });

  it("continues from the last inventoried UID and counts every vanished UID since", async () => {
    const log = { searches: [] as unknown[], locks: [] as unknown[], statuses: [] as unknown[] };
    // `41:*` also returns UID 40 when nothing is above it (RFC 3501): it must be dropped.
    const service = createInventoryService({
      uids: [40, 43, 44, 47],
      log,
      mailbox: openMailbox({ uidNext: 50 }),
    });
    const result = await service.inventoryMail({
      instanceId: "mail-sentinel-imap",
      afterUid: 40,
      uidValidity: "7",
    });

    expect(log.searches).toEqual([{ uid: "41:*" }]);
    expect(result).toMatchObject({
      afterUid: 40,
      uidValidityChanged: false,
      count: 3,
      highestUid: 47,
      uidRanges: [
        [43, 44],
        [47, 47],
      ],
      // 41, 42, 45, 46, 48, 49: assigned after UID 40 but no longer listed.
      uidGaps: 6,
    });
  });

  it("starts a new key space with a full census when UIDVALIDITY changed", async () => {
    const log = { searches: [] as unknown[], locks: [] as unknown[], statuses: [] as unknown[] };
    const service = createInventoryService({
      uids: [1, 2, 3],
      log,
      mailbox: openMailbox({ uidValidity: 99n, uidNext: 4 }),
    });
    const result = await service.inventoryMail({
      instanceId: "mail-sentinel-imap",
      afterUid: 500,
      uidValidity: "7",
    });

    expect(log.searches).toEqual([{ uid: "1:*" }]);
    expect(result).toMatchObject({
      uidValidity: "99",
      uidValidityChanged: true,
      afterUid: 0,
      count: 3,
      uidRanges: [[1, 3]],
      uidGaps: 0,
    });
  });

  it("skips the search when nothing arrived since the last census", async () => {
    const log = { searches: [] as unknown[], locks: [] as unknown[], statuses: [] as unknown[] };
    const service = createInventoryService({
      uids: [1],
      log,
      mailbox: openMailbox({ uidNext: 31 }),
    });
    const result = await service.inventoryMail({
      instanceId: "mail-sentinel-imap",
      afterUid: 30,
      uidValidity: "7",
    });

    expect(log.searches).toEqual([]);
    expect(result).toMatchObject({ count: 0, uidRanges: [], uidGaps: 0 });
    expect(result).not.toHaveProperty("highestUid");
  });

  it("reports an empty mailbox as zero messages and zero gaps", async () => {
    const service = createInventoryService({
      uids: [],
      statusMessages: 0,
      mailbox: openMailbox({ uidNext: 900, exists: 0 }),
    });
    const result = await service.inventoryMail({ instanceId: "mail-sentinel-imap" });

    expect(result).toMatchObject({ messageCount: 0, count: 0, uidRanges: [], uidGaps: 0 });
    expect(result).not.toHaveProperty("highestUid");
  });

  it("lists a large mailbox without a result limit", async () => {
    // 120 000 UIDs, every 1000th one expunged.
    const uids = Array.from({ length: 120_000 }, (_, index) => index + 1).filter(
      (uid) => uid % 1000 !== 0,
    );
    const service = createInventoryService({
      uids,
      statusMessages: uids.length,
      mailbox: openMailbox({ uidNext: 120_001 }),
    });
    const result = await service.inventoryMail({ instanceId: "mail-sentinel-imap" });

    expect(result.protocol).toBe("imap");
    if (result.protocol !== "imap") {
      return;
    }
    expect(result.count).toBe(uids.length);
    expect(result.messageCount).toBe(uids.length);
    expect(result.uidRanges).toHaveLength(120);
    expect(result.uidGaps).toBe(119);
    expect(result.highestUid).toBe(119_999);
  });

  it("falls back to EXISTS when STATUS is refused, and copes with a missing open mailbox", async () => {
    const refused = await createInventoryService({
      uids: [],
      statusMessages: false,
      mailbox: openMailbox({ exists: 9 }),
    }).inventoryMail({ instanceId: "mail-sentinel-imap" });
    expect(refused).toMatchObject({ messageCount: 9, count: 0 });

    const log = { searches: [] as unknown[], locks: [] as unknown[], statuses: [] as unknown[] };
    const closed = await createInventoryService({
      uids: [5, 6],
      statusMessages: false,
      mailbox: false,
      log,
    }).inventoryMail({ instanceId: "mail-sentinel-imap", afterUid: 4, uidValidity: "7" });
    // Without a UIDVALIDITY to compare, the caller's key space cannot be trusted.
    expect(log.searches).toEqual([{ uid: "1:*" }]);
    expect(closed).toMatchObject({ messageCount: 2, count: 2, uidValidityChanged: true });
    expect(closed).not.toHaveProperty("uidValidity");
    expect(closed).not.toHaveProperty("uidNext");
  });

  it("counts gaps up to the highest listed UID when UIDNEXT is unknown", async () => {
    const result = await createInventoryService({
      uids: [12, 14],
      mailbox: openMailbox({ uidNext: 0 }),
    }).inventoryMail({ instanceId: "mail-sentinel-imap", afterUid: 10, uidValidity: "7" });
    expect(result).toMatchObject({ uidGaps: 2 });
    expect(result).not.toHaveProperty("uidNext");
  });

  it("refuses --after-uid without its UIDVALIDITY or outside the UID range", async () => {
    const service = createInventoryService({ uids: [] });
    for (const afterUid of [3, -1, 1.5, 4_294_967_296]) {
      await expect(
        service.inventoryMail({
          instanceId: "mail-sentinel-imap",
          afterUid,
          ...(afterUid === 3 ? {} : { uidValidity: "7" }),
        }),
      ).rejects.toMatchObject({ code: "MAIL_INVENTORY_INVALID_ARGUMENT", retryable: false });
    }
  });

  it("fails instead of reporting an empty census when the UID search fails", async () => {
    const service = createInventoryService({ uids: false });
    await expect(
      service.inventoryMail({ instanceId: "mail-sentinel-imap", afterUid: 10, uidValidity: "7" }),
    ).rejects.toMatchObject({
      code: "MAIL_INVENTORY_SEARCH_FAILED",
      retryable: true,
      details: { mailbox: "INBOX", afterUid: 10 },
    });
  });

  it("enforces its own deadline and closes the connection", async () => {
    vi.useFakeTimers();
    try {
      process.env[TEST_SECRET_ENV] = "bridge-pass";
      const runtimeConfig = buildRuntimeConfig(`env:${TEST_SECRET_ENV}`);
      let closed = 0;
      const service = new ImapReadonlyToolService({
        configLoader: async () => runtimeConfig,
        runner: async (_account, handler) =>
          await handler({
            ...createNoopClient(),
            close: () => {
              closed += 1;
            },
            status: (() => new Promise(() => {})) as unknown as ImapClientLike["status"],
          }),
      });
      const pending = service.inventoryMail({ instanceId: "mail-sentinel-imap", timeoutMs: 5_000 });
      const outcome = expect(pending).rejects.toMatchObject({
        code: "MAIL_INVENTORY_TIMEOUT",
        retryable: true,
        details: { timeoutMs: 5_000 },
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await outcome;
      expect(closed).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes pop3-bound instances to the POP3 inventory with the clamped deadline", async () => {
    process.env[TEST_SECRET_ENV] = "pop3-secret";
    const runtimeConfig = buildRuntimeConfig(`env:${TEST_SECRET_ENV}`);
    const instance = runtimeConfig.sovereignTools.instances[0];
    if (instance === undefined) {
      throw new Error("fixture missing tool instance");
    }
    instance.config = { ...instance.config, protocol: "pop3", port: "995" };
    const calls: unknown[] = [];
    const pop3 = {
      inventoryMail: async (input: unknown) => {
        calls.push(input);
        return { protocol: "pop3" };
      },
    } as unknown as Pop3ReadonlyToolService;
    const service = new ImapReadonlyToolService({
      configLoader: async () => runtimeConfig,
      runner: async () => {
        throw new Error("IMAP runner must not be used for POP3 instances");
      },
      pop3,
    });
    // POP3 has no UID ranges: --after-uid is ignored, so it needs no UIDVALIDITY.
    await service.inventoryMail({
      instanceId: "mail-sentinel-imap",
      timeoutMs: 999_999,
      afterUid: 5,
    });
    expect(calls).toEqual([
      {
        instanceId: "mail-sentinel-imap",
        timeoutMs: 60_000,
        account: expect.objectContaining({ port: 995, password: "pop3-secret" }),
      },
    ]);
  });
});
