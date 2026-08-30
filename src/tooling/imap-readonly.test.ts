import type { FetchMessageObject } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";

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
