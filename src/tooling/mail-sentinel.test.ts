import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FetchMessageObject } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeConfig } from "../installer/real-service-shared.js";
import type { ImapClientLike } from "../system/imap-client.js";
import {
  MailSentinelToolService,
  readMailSentinelStatusSummary,
  resolveMailSentinelStatePath,
} from "./mail-sentinel.js";

const TEST_MATRIX_TOKEN = "TEST_MAIL_SENTINEL_MATRIX_TOKEN";
const TEST_IMAP_PASSWORD = "TEST_MAIL_SENTINEL_IMAP_PASSWORD";
const tempRoots: string[] = [];

type MessageFixture = {
  uid: number;
  subject: string;
  fromName?: string;
  fromAddress: string;
  date: string;
  messageId: string;
  text: string;
  headers?: Record<string, string>;
};

afterEach(async () => {
  delete process.env[TEST_MATRIX_TOKEN];
  delete process.env[TEST_IMAP_PASSWORD];
  await Promise.all(tempRoots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
});

const buildRawEmail = (fixture: MessageFixture): Buffer => {
  const headerLines = [
    `From: ${fixture.fromName === undefined ? fixture.fromAddress : `${fixture.fromName} <${fixture.fromAddress}>`}`,
    "To: Operator <operator@example.org>",
    `Subject: ${fixture.subject}`,
    `Message-ID: ${fixture.messageId}`,
    `Date: ${fixture.date}`,
    ...Object.entries(fixture.headers ?? {}).map(([key, value]) => `${key}: ${value}`),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    fixture.text,
    "",
  ];
  return Buffer.from(headerLines.join("\r\n"), "utf8");
};

const buildFetchMessage = (fixture: MessageFixture): FetchMessageObject => ({
  seq: fixture.uid,
  uid: fixture.uid,
  envelope: {
    subject: fixture.subject,
    messageId: fixture.messageId,
    from: [
      {
        address: fixture.fromAddress,
        ...(fixture.fromName === undefined ? {} : { name: fixture.fromName }),
      },
    ],
    to: [{ address: "operator@example.org", name: "Operator" }],
  },
  flags: new Set(),
  internalDate: fixture.date,
  size: buildRawEmail(fixture).byteLength,
  source: buildRawEmail(fixture),
});

const createClient = (fixtures: MessageFixture[]): ImapClientLike => {
  const messages = fixtures.map((fixture) => buildFetchMessage(fixture));
  return {
    authenticated: "bridge-user",
    capabilities: new Map(),
    close: () => {},
    connect: async () => {},
    fetchAll: async (range) => {
      if (typeof range === "string") {
        const start = Number.parseInt(range.split(":", 1)[0] ?? "1", 10);
        return messages.filter((message) => message.uid >= start);
      }
      return messages;
    },
    fetchOne: async () => false,
    getMailboxLock: async () => ({
      path: "INBOX",
      release: () => {},
    }),
    logout: async () => {},
    mailboxOpen: async () => ({
      path: "INBOX",
      delimiter: "/",
      flags: new Set(),
      uidValidity: 1n,
      uidNext: (messages.at(-1)?.uid ?? 0) + 1,
      exists: messages.length,
    }),
    search: async () => [],
  };
};

const buildRuntimeConfig = (workspaceDir: string, imapConfigured = true): RuntimeConfig => ({
  openrouter: {
    model: "qwen/qwen-2.5-32b-instruct",
    apiKeySecretRef: "env:OPENROUTER_API_KEY",
  },
  openclaw: {
    managedInstallation: true,
    installMethod: "install_sh",
    requestedVersion: "0.3.0",
    openclawHome: "/tmp/openclaw",
    runtimeConfigPath: "/tmp/openclaw.json5",
    runtimeProfilePath: "/tmp/openclaw-profile.json5",
    gatewayEnvPath: "/tmp/openclaw.env",
  },
  openclawProfile: {
    plugins: {
      allow: ["matrix"],
    },
    session: {
      dmScope: "per-peer",
    },
    agents: [
      {
        id: "mail-sentinel",
        workspace: workspaceDir,
        model: "qwen/qwen-2.5-32b-instruct",
        templateRef: "mail-sentinel@1.0.0",
        botId: "mail-sentinel",
        toolInstanceIds: ["mail-sentinel-core"],
        matrix: {
          localpart: "mail-sentinel",
          userId: "@mail-sentinel:matrix.example.org",
          accessTokenSecretRef: `env:${TEST_MATRIX_TOKEN}`,
        },
      },
    ],
    crons: [],
  },
  imap: imapConfigured
    ? {
        status: "configured",
        host: "127.0.0.1",
        port: 1143,
        tls: true,
        username: "bridge-user",
        mailbox: "INBOX",
        secretRef: `env:${TEST_IMAP_PASSWORD}`,
      }
    : {
        status: "pending",
        host: "127.0.0.1",
        port: 1143,
        tls: true,
        username: "bridge-user",
        mailbox: "INBOX",
        secretRef: `env:${TEST_IMAP_PASSWORD}`,
      },
  bots: {
    config: {
      "mail-sentinel": {
        statePath: "data/mail-sentinel-state.json",
        rulesPath: "config/default-rules.json",
        lookbackWindow: "2d",
        defaultReminderDelay: "4h",
      },
    },
  },
  matrix: {
    accessMode: "direct",
    homeserverDomain: "matrix.example.org",
    federationEnabled: false,
    publicBaseUrl: "https://matrix.example.org",
    adminBaseUrl: "https://matrix.example.org",
    operator: {
      userId: "@operator:matrix.example.org",
    },
    bot: {
      userId: "@sovereign-bot:matrix.example.org",
      accessTokenSecretRef: `env:${TEST_MATRIX_TOKEN}`,
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
        id: "mail-sentinel-core",
        templateRef: "mail-sentinel-tool@1.0.0",
        capabilities: ["mail-sentinel.scan", "mail-sentinel.feedback", "mail-sentinel.alerts.read"],
        config: {
          agentId: "mail-sentinel",
          statePath: "data/mail-sentinel-state.json",
          rulesPath: "config/default-rules.json",
          lookbackWindow: "2d",
          defaultReminderDelay: "4h",
        },
        secretRefs: {},
        createdAt: "2026-03-13T00:00:00.000Z",
        updatedAt: "2026-03-13T00:00:00.000Z",
      },
    ],
  },
});

const writeRulesFile = async (workspaceDir: string): Promise<void> => {
  await mkdir(join(workspaceDir, "config"), { recursive: true });
  const rulesPath = join(workspaceDir, "config", "default-rules.json");
  await writeFile(
    rulesPath,
    `${JSON.stringify(
      {
        version: 1,
        thresholds: {
          alert: 4,
          category: 4,
        },
        rules: [
          {
            id: "financial-invoice-subject",
            field: "subject",
            pattern: "rechnung|invoice|zahlung|bezahlen",
            weight: 5,
            categories: ["financial-relevance"],
            reason: "subject mentions an invoice or payment",
          },
          {
            id: "decision-approval-subject",
            field: "subject",
            pattern: "freigabe|approve|entscheidung|decision",
            weight: 5,
            categories: ["decision-required"],
            reason: "subject asks for an approval or decision",
          },
          {
            id: "risk-deadline-text",
            field: "text",
            pattern: "deadline|frist|morgen|urgent|beschwerde",
            weight: 5,
            categories: ["risk-escalation"],
            reason: "body mentions urgency, a deadline, or a complaint",
          },
          {
            id: "bulk-negative",
            field: "header",
            headerName: "precedence",
            pattern: "bulk|list",
            weight: -6,
            reason: "bulk mail headers suggest a newsletter or mailing list",
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
};

describe("mail-sentinel tool service", () => {
  it("scans new mail, sends a financial alert, and exposes status summary", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "mail-sentinel-test-"));
    tempRoots.push(tempRoot);
    const workspaceDir = join(tempRoot, "workspace");
    await writeRulesFile(workspaceDir);

    process.env[TEST_MATRIX_TOKEN] = "matrix-token";
    process.env[TEST_IMAP_PASSWORD] = "bridge-password";
    const sentMessages: string[] = [];
    const service = new MailSentinelToolService({
      configLoader: async () => buildRuntimeConfig(workspaceDir),
      runner: async (_account, handler) =>
        await handler(
          createClient([
            {
              uid: 41,
              subject: "Rechnung 2026-0042 bitte bezahlen",
              fromName: "Acme Billing",
              fromAddress: "billing@example.org",
              date: "Fri, 13 Mar 2026 10:00:00 +0000",
              messageId: "<invoice-42@example.org>",
              text: "Bitte begleichen Sie die Rechnung bis morgen.",
            },
          ]),
        ),
      fetchImpl: async (_url, init) => {
        sentMessages.push(String(init?.body ?? ""));
        return new Response(JSON.stringify({ event_id: "$evt-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
      now: () => new Date("2026-03-13T10:05:00.000Z"),
    });

    const result = await service.scan({ instanceId: "mail-sentinel-core" });
    expect(result.configured).toBe(true);
    expect(result.alertsSent).toBe(1);
    expect(result.alerts[0]?.category).toBe("financial-relevance");
    expect(sentMessages[0]).toContain("Financial Relevance");
    expect(sentMessages[0]).toContain("Rechnung 2026-0042 bitte bezahlen");

    const statePath = resolveMailSentinelStatePath(buildRuntimeConfig(workspaceDir));
    expect(statePath).not.toBeNull();
    const status = await readMailSentinelStatusSummary(statePath!);
    expect(status).toMatchObject({
      lastPollAt: "2026-03-13T10:05:00.000Z",
      lastAlertAt: "2026-03-13T10:05:00.000Z",
      consecutiveFailures: 0,
    });
  });

  it("does not send duplicate alerts after the first successful scan", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "mail-sentinel-test-"));
    tempRoots.push(tempRoot);
    const workspaceDir = join(tempRoot, "workspace");
    await writeRulesFile(workspaceDir);

    process.env[TEST_MATRIX_TOKEN] = "matrix-token";
    process.env[TEST_IMAP_PASSWORD] = "bridge-password";
    let deliveries = 0;
    const fixtures = [
      {
        uid: 7,
        subject: "Approve the new budget",
        fromAddress: "ceo@example.org",
        date: "Fri, 13 Mar 2026 08:00:00 +0000",
        messageId: "<decision-7@example.org>",
        text: "Please approve the budget direction today.",
      },
    ] satisfies MessageFixture[];
    const service = new MailSentinelToolService({
      configLoader: async () => buildRuntimeConfig(workspaceDir),
      runner: async (_account, handler) => await handler(createClient(fixtures)),
      fetchImpl: async () => {
        deliveries += 1;
        return new Response(JSON.stringify({ event_id: "$evt-2" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
      now: () => new Date("2026-03-13T09:00:00.000Z"),
    });

    const first = await service.scan({ instanceId: "mail-sentinel-core" });
    const second = await service.scan({ instanceId: "mail-sentinel-core" });
    expect(first.alertsSent).toBe(1);
    expect(second.alertsSent).toBe(0);
    expect(second.newMessages).toBe(0);
    expect(deliveries).toBe(1);
  });

  it("learns from important feedback and exposes recent alerts with feedback state", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "mail-sentinel-test-"));
    tempRoots.push(tempRoot);
    const workspaceDir = join(tempRoot, "workspace");
    await writeRulesFile(workspaceDir);

    process.env[TEST_MATRIX_TOKEN] = "matrix-token";
    process.env[TEST_IMAP_PASSWORD] = "bridge-password";
    const service = new MailSentinelToolService({
      configLoader: async () => buildRuntimeConfig(workspaceDir),
      runner: async (_account, handler) =>
        await handler(
          createClient([
            {
              uid: 12,
              subject: "Approve vendor contract",
              fromAddress: "legal@example.org",
              date: "Fri, 13 Mar 2026 07:00:00 +0000",
              messageId: "<contract-12@example.org>",
              text: "Please approve this contract decision today.",
            },
          ]),
        ),
      fetchImpl: async () =>
        new Response(JSON.stringify({ event_id: "$evt-3" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      now: () => new Date("2026-03-13T07:05:00.000Z"),
    });

    await service.scan({ instanceId: "mail-sentinel-core" });
    const feedback = await service.applyFeedback({
      instanceId: "mail-sentinel-core",
      action: "important",
      latest: true,
    });
    expect(feedback.note).toContain("important");

    const stateRaw = await readFile(join(workspaceDir, "data", "mail-sentinel-state.json"), "utf8");
    const state = JSON.parse(stateRaw) as {
      learning?: { senderWeights?: Record<string, number>; ruleAdjustments?: Record<string, number> };
    };
    expect(state.learning?.senderWeights?.["legal@example.org"]).toBe(2);
    expect(state.learning?.ruleAdjustments?.["decision-approval-subject"]).toBe(1);

    const recent = await service.listAlerts({
      instanceId: "mail-sentinel-core",
      view: "recent",
    });
    expect(recent.count).toBe(1);
    expect(recent.alerts[0]?.feedbackState).toBe("important");
  });

  it("schedules reminder feedback and emits a reminder on the next scan", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "mail-sentinel-test-"));
    tempRoots.push(tempRoot);
    const workspaceDir = join(tempRoot, "workspace");
    await writeRulesFile(workspaceDir);

    process.env[TEST_MATRIX_TOKEN] = "matrix-token";
    process.env[TEST_IMAP_PASSWORD] = "bridge-password";
    let now = new Date("2026-03-13T06:00:00.000Z");
    let deliveries = 0;
    const service = new MailSentinelToolService({
      configLoader: async () => buildRuntimeConfig(workspaceDir),
      runner: async (_account, handler) =>
        await handler(
          createClient([
            {
              uid: 3,
              subject: "Invoice reminder",
              fromAddress: "billing@example.org",
              date: "Fri, 13 Mar 2026 05:45:00 +0000",
              messageId: "<invoice-reminder@example.org>",
              text: "Invoice is due today.",
            },
          ]),
        ),
      fetchImpl: async () => {
        deliveries += 1;
        return new Response(JSON.stringify({ event_id: `$evt-${String(deliveries)}` }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
      now: () => now,
    });

    await service.scan({ instanceId: "mail-sentinel-core" });
    const reminder = await service.applyFeedback({
      instanceId: "mail-sentinel-core",
      action: "remind-later",
      latest: true,
      delay: "30m",
    });
    expect(reminder.nextReminderAt).toBe("2026-03-13T06:30:00.000Z");

    now = new Date("2026-03-13T06:31:00.000Z");
    const secondScan = await service.scan({ instanceId: "mail-sentinel-core" });
    expect(secondScan.remindersSent).toBe(1);
    expect(secondScan.alerts[0]?.kind).toBe("reminder");
    expect(deliveries).toBe(2);
  });

  it("returns a clear note when IMAP is not configured", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "mail-sentinel-test-"));
    tempRoots.push(tempRoot);
    const workspaceDir = join(tempRoot, "workspace");
    await writeRulesFile(workspaceDir);

    process.env[TEST_MATRIX_TOKEN] = "matrix-token";
    process.env[TEST_IMAP_PASSWORD] = "bridge-password";
    const service = new MailSentinelToolService({
      configLoader: async () => buildRuntimeConfig(workspaceDir, false),
      now: () => new Date("2026-03-13T11:00:00.000Z"),
    });

    const result = await service.scan({ instanceId: "mail-sentinel-core" });
    expect(result).toMatchObject({
      configured: false,
      alertsSent: 0,
      note: "IMAP is not configured yet.",
    });
  });
});
