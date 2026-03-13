import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import type { FetchMessageObject, MailboxLockObject, MessageAddressObject } from "imapflow";
import PostalMime, { type Email as PostalMimeEmail } from "postal-mime";
import { z } from "zod";

import { DEFAULT_PATHS } from "../config/paths.js";
import type {
  MailSentinelCategory,
  MailSentinelFeedbackResult,
  MailSentinelListAlertsResult,
  MailSentinelScanResult,
} from "../contracts/tool.js";
import type { RuntimeConfig } from "../installer/real-service-shared.js";
import { parseRuntimeConfigDocument } from "../installer/real-service-shared.js";
import type { ImapAccountCredentials, ImapClientLike } from "../system/imap-client.js";
import { runWithImapClient } from "../system/imap-client.js";
import { parseTemplateRef } from "../templates/catalog.js";

const MAIL_SENTINEL_TOOL_TEMPLATE_ID = "mail-sentinel-tool";
const MAIL_SENTINEL_AGENT_ID = "mail-sentinel";
const DEFAULT_STATE_PATH = "data/mail-sentinel-state.json";
const DEFAULT_RULES_PATH = "config/default-rules.json";
const DEFAULT_LOOKBACK_WINDOW = "15m";
const DEFAULT_REMINDER_DELAY = "4h";
const DEFAULT_MAX_SCAN_MESSAGES = 50;
const DEFAULT_LOCK_RETRY_DELAY_MS = 50;
const DEFAULT_LOCK_RETRY_ATTEMPTS = 200;

const mailSentinelCategoryLabel: Record<MailSentinelCategory, string> = {
  "decision-required": "Decision Required",
  "financial-relevance": "Financial Relevance",
  "risk-escalation": "Risk / Escalation",
};

type ToolRunner = <T>(
  account: ImapAccountCredentials,
  handler: (client: ImapClientLike) => Promise<T>,
) => Promise<T>;

type RuntimeConfigLoader = (configPath: string) => Promise<RuntimeConfig>;

type MailSentinelStatusSummary = {
  lastPollAt?: string;
  lastAlertAt?: string;
  lastError?: {
    code: string;
    message: string;
    retryable: boolean;
  };
  consecutiveFailures: number;
};

type ResolvedMailSentinelToolInstance = {
  instanceId: string;
  configPath: string;
  runtimeConfig: RuntimeConfig;
  agentId: string;
  workspaceDir: string;
  statePath: string;
  rulesPath: string;
  lookbackWindow: string;
  defaultReminderDelay: string;
  matrix: {
    adminBaseUrl: string;
    roomId: string;
    accessToken: string;
  };
  imap:
    | ({
        mailbox: string;
      } & ImapAccountCredentials)
    | null;
};

const rulesThresholdsSchema = z.object({
  alert: z.number().finite().default(4),
  category: z.number().finite().default(4),
});

const categorySchema = z.enum(["decision-required", "financial-relevance", "risk-escalation"]);

const rulesRuleSchema = z.object({
  id: z.string().min(1),
  field: z.enum(["subject", "text", "from", "domain", "header"]),
  headerName: z.string().min(1).optional(),
  pattern: z.string().min(1),
  flags: z.string().optional(),
  weight: z.number().finite(),
  categories: z.array(categorySchema).default([]),
  reason: z.string().min(1),
});

const rulesFileSchema = z.object({
  version: z.literal(1),
  thresholds: rulesThresholdsSchema.default({ alert: 4, category: 4 }),
  defaultReminderDelay: z.string().min(1).optional(),
  senderWeights: z.record(z.string(), z.number().finite()).default({}),
  domainWeights: z.record(z.string(), z.number().finite()).default({}),
  rules: z.array(rulesRuleSchema).default([]),
});

type MailSentinelRules = z.infer<typeof rulesFileSchema>;

const messageStateSchema = z.object({
  key: z.string().min(1),
  uid: z.number().int().positive(),
  messageId: z.string().min(1).optional(),
  subject: z.string(),
  from: z.string(),
  fromAddress: z.string().min(1).optional(),
  domain: z.string().min(1).optional(),
  date: z.string().min(1).optional(),
  firstSeenAt: z.string().min(1),
  lastSeenAt: z.string().min(1),
  alertId: z.string().min(1).optional(),
});

const alertStateSchema = z.object({
  alertId: z.string().min(1),
  messageKey: z.string().min(1),
  uid: z.number().int().positive(),
  messageId: z.string().min(1).optional(),
  category: categorySchema,
  subject: z.string(),
  from: z.string(),
  fromAddress: z.string().min(1).optional(),
  domain: z.string().min(1).optional(),
  why: z.string().min(1),
  sentAt: z.string().min(1),
  score: z.number().finite(),
  categoryScores: z.record(categorySchema, z.number().finite()),
  reasons: z.array(z.string().min(1)).default([]),
  matchedRuleIds: z.array(z.string().min(1)).default([]),
  feedbackState: z.enum(["pending", "important", "not-important", "less-often"]).default(
    "pending",
  ),
  feedbackAt: z.string().min(1).optional(),
  reminderDueAt: z.string().min(1).optional(),
  lastReminderAt: z.string().min(1).optional(),
});

const feedbackStateSchema = z.object({
  alertId: z.string().min(1),
  action: z.enum(["important", "not-important", "less-often", "remind-later"]),
  at: z.string().min(1),
  delay: z.string().min(1).optional(),
});

const mailSentinelStateSchema = z.object({
  version: z.literal(1),
  lastPollAt: z.string().min(1).optional(),
  lastAlertAt: z.string().min(1).optional(),
  lastImapSuccessAt: z.string().min(1).optional(),
  lastError: z
    .object({
      code: z.string().min(1),
      message: z.string().min(1),
      retryable: z.boolean(),
    })
    .optional(),
  consecutiveFailures: z.number().int().min(0).default(0),
  mailbox: z
    .object({
      uidValidity: z.string().min(1).optional(),
      lastSeenUid: z.number().int().positive().optional(),
    })
    .default({}),
  messages: z.record(z.string(), messageStateSchema).default({}),
  alerts: z.array(alertStateSchema).default([]),
  feedback: z.array(feedbackStateSchema).default([]),
  learning: z
    .object({
      senderWeights: z.record(z.string(), z.number().finite()).default({}),
      domainWeights: z.record(z.string(), z.number().finite()).default({}),
      ruleAdjustments: z.record(z.string(), z.number().finite()).default({}),
    })
    .default({ senderWeights: {}, domainWeights: {}, ruleAdjustments: {} }),
});

type MailSentinelState = z.infer<typeof mailSentinelStateSchema>;
type MailSentinelAlertState = z.infer<typeof alertStateSchema>;

type ParsedMail = {
  key: string;
  uid: number;
  messageId?: string;
  subject: string;
  from: string;
  fromAddress?: string;
  domain?: string;
  date?: string;
  text: string;
  headers: Record<string, string[]>;
  inReplyTo?: string;
  references: string[];
};

type RuleMatch = {
  ruleId: string;
  reason: string;
  weight: number;
  categories: MailSentinelCategory[];
};

type ScoreResult = {
  relevant: boolean;
  score: number;
  category: MailSentinelCategory;
  categoryScores: Record<MailSentinelCategory, number>;
  reasons: string[];
  matchedRuleIds: string[];
};

type ScanSummaryAlert = MailSentinelScanResult["alerts"][number];

export class MailSentinelToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly details?: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MailSentinelToolError";
  }
}

const defaultRuntimeConfigLoader: RuntimeConfigLoader = async (configPath) => {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    throw new MailSentinelToolError(
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
    throw new MailSentinelToolError(
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

const defaultConfigPath = (): string => process.env.SOVEREIGN_NODE_CONFIG ?? DEFAULT_PATHS.configPath;

const defaultNow = (): Date => new Date();

const defaultFetchImpl: typeof fetch = async (input, init) => await fetch(input, init);

const stripSingleTrailingNewline = (value: string): string => value.replace(/\r?\n$/, "");

const nowIso = (clock: () => Date): string => clock().toISOString();

const resolveRelativeToBase = (value: string, baseDir: string): string =>
  isAbsolute(value) ? value : resolve(baseDir, value);

const normalizeEmailAddress = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const match = value.match(/<([^>]+)>/);
  const candidate = (match?.[1] ?? value).trim().toLowerCase();
  return candidate.length === 0 ? undefined : candidate;
};

const normalizeMessageId = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    return trimmed.toLowerCase();
  }
  return trimmed.includes("@") ? `<${trimmed.toLowerCase()}>` : trimmed.toLowerCase();
};

const parseReferences = (value: string | undefined): string[] => {
  if (value === undefined) {
    return [];
  }
  const matches = value.match(/<[^>]+>/g) ?? [];
  const normalized = matches
    .map((entry) => normalizeMessageId(entry))
    .filter((entry): entry is string => entry !== undefined);
  return Array.from(new Set(normalized));
};

const extractDomain = (address: string | undefined): string | undefined => {
  if (address === undefined) {
    return undefined;
  }
  const separatorIndex = address.lastIndexOf("@");
  if (separatorIndex < 0 || separatorIndex === address.length - 1) {
    return undefined;
  }
  return address.slice(separatorIndex + 1).toLowerCase();
};

const formatAddress = (address: MessageAddressObject): string => {
  if (address.name !== undefined && address.name.length > 0 && address.address !== undefined) {
    return `${address.name} <${address.address}>`;
  }
  return address.address ?? address.name ?? "(unknown)";
};

const extractFromDisplay = (
  envelope: Pick<FetchMessageObject, "envelope">,
  parsed: Pick<PostalMimeEmail, "from">,
): string => {
  if (envelope.envelope?.from?.[0] !== undefined) {
    return formatAddress(envelope.envelope.from[0]);
  }
  if (parsed.from !== undefined && "address" in parsed.from && parsed.from.address !== undefined) {
    return parsed.from.name !== undefined && parsed.from.name.length > 0
      ? `${parsed.from.name} <${parsed.from.address}>`
      : parsed.from.address;
  }
  return "(unknown sender)";
};

const stripHtmlTags = (value: string): string =>
  value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const describeErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const buildMessageKey = (messageId: string | undefined, uidValidity: string, uid: number): string =>
  messageId !== undefined ? `msg:${messageId}` : `uid:${uidValidity}:${String(uid)}`;

const parseDurationMs = (value: string): number => {
  const match = value.trim().toLowerCase().match(/^([0-9]+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/);
  if (match === null) {
    throw new MailSentinelToolError(
      "MAIL_SENTINEL_DURATION_INVALID",
      `Unsupported duration '${value}'`,
      false,
      {
        value,
      },
    );
  }
  const amount = Number.parseInt(match[1] ?? "0", 10);
  const unit = match[2] ?? "m";
  const multiplier = unit.startsWith("d")
    ? 24 * 60 * 60 * 1000
    : unit.startsWith("h")
      ? 60 * 60 * 1000
      : 60 * 1000;
  return amount * multiplier;
};

const createDefaultState = (): MailSentinelState => ({
  version: 1,
  consecutiveFailures: 0,
  mailbox: {},
  messages: {},
  alerts: [],
  feedback: [],
  learning: {
    senderWeights: {},
    domainWeights: {},
    ruleAdjustments: {},
  },
});

const buildHeadersMap = (headers: PostalMimeEmail["headers"]): Record<string, string[]> => {
  const grouped = new Map<string, string[]>();
  for (const header of headers) {
    const key = header.key.toLowerCase();
    const values = grouped.get(key) ?? [];
    values.push(header.value);
    grouped.set(key, values);
  }
  return Object.fromEntries(grouped.entries());
};

const summarizePositiveReasons = (matches: RuleMatch[]): string[] => {
  const unique = new Set<string>();
  return matches
    .filter((entry) => entry.weight > 0)
    .sort((left, right) => Math.abs(right.weight) - Math.abs(left.weight))
    .flatMap((entry) => {
      if (unique.has(entry.reason)) {
        return [];
      }
      unique.add(entry.reason);
      return [entry.reason];
    })
    .slice(0, 3);
};

const renderAlertWhy = (matches: RuleMatch[]): string => {
  const reasons = summarizePositiveReasons(matches);
  if (reasons.length === 0) {
    return "matched Mail Sentinel relevance rules";
  }
  return reasons.slice(0, 2).join("; ");
};

const startOfLocalDay = (value: Date): number => {
  const local = new Date(value);
  local.setHours(0, 0, 0, 0);
  return local.getTime();
};

const isSameLocalDay = (value: string, reference: Date): boolean => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }
  return startOfLocalDay(parsed) === startOfLocalDay(reference);
};

const compactText = (value: string): string => value.replace(/\s+/g, " ").trim();

const mapAlertToSummary = (
  alert: MailSentinelAlertState,
  kind: "new-alert" | "reminder" = "new-alert",
): ScanSummaryAlert => ({
  alertId: alert.alertId,
  kind,
  category: alert.category,
  subject: alert.subject,
  from: alert.from,
  why: alert.why,
  sentAt: kind === "reminder" ? (alert.lastReminderAt ?? alert.sentAt) : alert.sentAt,
  ...(alert.messageId === undefined ? {} : { messageId: alert.messageId }),
  ...(alert.feedbackState === "pending" ? {} : { feedbackState: alert.feedbackState }),
});

const formatAlertLine = (alert: ScanSummaryAlert): string =>
  `- [${alert.alertId}] ${mailSentinelCategoryLabel[alert.category]} | ${alert.from} | ${alert.subject}`;

const resolveMailSentinelStatusSummary = (state: MailSentinelState): MailSentinelStatusSummary => ({
  ...(state.lastPollAt === undefined ? {} : { lastPollAt: state.lastPollAt }),
  ...(state.lastAlertAt === undefined ? {} : { lastAlertAt: state.lastAlertAt }),
  ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
  consecutiveFailures: state.consecutiveFailures,
});

export const resolveMailSentinelStatePath = (
  runtimeConfig: RuntimeConfig,
  agentId = MAIL_SENTINEL_AGENT_ID,
): string | null => {
  const agent = runtimeConfig.openclawProfile.agents.find((entry) => entry.id === agentId);
  if (agent === undefined) {
    return null;
  }
  const configured = runtimeConfig.bots.config[agentId]?.statePath;
  const statePath = typeof configured === "string" && configured.trim().length > 0 ? configured : DEFAULT_STATE_PATH;
  return resolveRelativeToBase(statePath, agent.workspace);
};

export const readMailSentinelStatusSummary = async (
  statePath: string,
): Promise<MailSentinelStatusSummary | null> => {
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = mailSentinelStateSchema.parse(JSON.parse(stripSingleTrailingNewline(raw)) as unknown);
    return resolveMailSentinelStatusSummary(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
};

const resolveSecretRefValue = async (secretRef: string): Promise<string> => {
  if (secretRef.startsWith("file:")) {
    const filePath = secretRef.slice("file:".length);
    try {
      const raw = await readFile(filePath, "utf8");
      const value = stripSingleTrailingNewline(raw);
      if (value.length > 0) {
        return value;
      }
      throw new MailSentinelToolError("SECRET_READ_FAILED", "Secret file is empty", false, {
        secretRef,
      });
    } catch (error) {
      if (error instanceof MailSentinelToolError) {
        throw error;
      }
      throw new MailSentinelToolError(
        "SECRET_READ_FAILED",
        `Failed to read secret file for ${secretRef}`,
        false,
        {
          secretRef,
          error: describeErrorMessage(error),
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
    throw new MailSentinelToolError(
      "SECRET_READ_FAILED",
      `Environment variable ${key} referenced by ${secretRef} is not set`,
      false,
      {
        secretRef,
      },
    );
  }

  throw new MailSentinelToolError(
    "SECRET_REF_UNSUPPORTED",
    `Unsupported secretRef format for ${secretRef}`,
    false,
    {
      secretRef,
    },
  );
};

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

const parseRegexFlags = (value: string | undefined): string => {
  const raw = value?.trim() ?? "iu";
  if (raw.length === 0) {
    return "iu";
  }
  return Array.from(new Set(raw.split("").filter((entry) => /[dgimsuvy]/.test(entry)))).join("");
};

const truncateRecords = <T>(items: T[], max: number): T[] =>
  items.length <= max ? items : items.slice(items.length - max);

const pruneState = (state: MailSentinelState): MailSentinelState => {
  const retainedMessages = Object.values(state.messages)
    .sort((left, right) => left.lastSeenAt.localeCompare(right.lastSeenAt))
    .slice(-5_000);
  state.messages = Object.fromEntries(retainedMessages.map((entry) => [entry.key, entry]));
  state.alerts = truncateRecords(
    state.alerts.sort((left, right) => left.sentAt.localeCompare(right.sentAt)),
    500,
  );
  state.feedback = truncateRecords(
    state.feedback.sort((left, right) => left.at.localeCompare(right.at)),
    1_000,
  );
  return state;
};

const compileRules = (rules: MailSentinelRules): Array<
  MailSentinelRules["rules"][number] & { regex: RegExp }
> =>
  rules.rules.map((rule) => {
    try {
      return {
        ...rule,
        regex: new RegExp(rule.pattern, parseRegexFlags(rule.flags)),
      };
    } catch (error) {
      throw new MailSentinelToolError(
        "MAIL_SENTINEL_RULES_INVALID",
        `Rule '${rule.id}' has an invalid regular expression`,
        false,
        {
          ruleId: rule.id,
          pattern: rule.pattern,
          flags: rule.flags,
          error: describeErrorMessage(error),
        },
      );
    }
  });

const createEmptyCategoryScores = (): Record<MailSentinelCategory, number> => ({
  "decision-required": 0,
  "financial-relevance": 0,
  "risk-escalation": 0,
});

const pickPrimaryCategory = (
  scores: Record<MailSentinelCategory, number>,
): MailSentinelCategory =>
  (Object.entries(scores)
    .sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }
      return left[0].localeCompare(right[0]);
    })
    .at(0)?.[0] ?? "decision-required") as MailSentinelCategory;

const buildRuleMatches = (input: {
  message: ParsedMail;
  state: MailSentinelState;
  rules: MailSentinelRules;
}): RuleMatch[] => {
  const matches: RuleMatch[] = [];
  const compiled = compileRules(input.rules);
  const senderAdjustment =
    (input.rules.senderWeights[input.message.fromAddress ?? ""] ?? 0) +
    (input.state.learning.senderWeights[input.message.fromAddress ?? ""] ?? 0);
  if (senderAdjustment !== 0 && input.message.fromAddress !== undefined) {
    matches.push({
      ruleId: `sender:${input.message.fromAddress}`,
      reason: senderAdjustment > 0 ? "sender has been rated as important before" : "sender has been down-weighted by feedback",
      weight: senderAdjustment,
      categories: [],
    });
  }

  const domainAdjustment =
    (input.rules.domainWeights[input.message.domain ?? ""] ?? 0) +
    (input.state.learning.domainWeights[input.message.domain ?? ""] ?? 0);
  if (domainAdjustment !== 0 && input.message.domain !== undefined) {
    matches.push({
      ruleId: `domain:${input.message.domain}`,
      reason: domainAdjustment > 0 ? "sender domain has been rated as important before" : "sender domain has been down-weighted by feedback",
      weight: domainAdjustment,
      categories: [],
    });
  }

  for (const rule of compiled) {
    const candidate =
      rule.field === "subject"
        ? input.message.subject
        : rule.field === "text"
          ? input.message.text
          : rule.field === "from"
            ? input.message.from
            : rule.field === "domain"
              ? (input.message.domain ?? "")
              : (input.message.headers[(rule.headerName ?? "").toLowerCase()] ?? []).join("\n");
    if (candidate.length === 0 || !rule.regex.test(candidate)) {
      continue;
    }
    const learnedAdjustment = input.state.learning.ruleAdjustments[rule.id] ?? 0;
    matches.push({
      ruleId: rule.id,
      reason: rule.reason,
      weight: rule.weight + learnedAdjustment,
      categories: rule.categories,
    });
  }

  const threadMatch = [input.message.inReplyTo, ...input.message.references]
    .map((entry) => normalizeMessageId(entry))
    .find((entry) =>
      entry !== undefined &&
      Object.values(input.state.messages).some((message) => message.messageId === entry && message.alertId !== undefined),
    );
  if (threadMatch !== undefined) {
    const priorAlert = input.state.alerts
      .slice()
      .reverse()
      .find((alert) => alert.messageId === threadMatch);
    matches.push({
      ruleId: "thread:known-alert-thread",
      reason: "continues a thread that already mattered before",
      weight: 2,
      categories: priorAlert === undefined ? ["decision-required"] : [priorAlert.category],
    });
  }

  return matches;
};

const scoreMessage = (input: {
  message: ParsedMail;
  state: MailSentinelState;
  rules: MailSentinelRules;
}): ScoreResult => {
  const matches = buildRuleMatches(input);
  const categoryScores = createEmptyCategoryScores();
  let score = 0;
  for (const match of matches) {
    score += match.weight;
    for (const category of match.categories) {
      categoryScores[category] += match.weight;
    }
  }
  const category = pickPrimaryCategory(categoryScores);
  const topCategoryScore = categoryScores[category];
  const relevant =
    score >= input.rules.thresholds.alert && topCategoryScore >= input.rules.thresholds.category;
  return {
    relevant,
    score,
    category,
    categoryScores,
    reasons: summarizePositiveReasons(matches),
    matchedRuleIds: matches.map((entry) => entry.ruleId),
  };
};

const buildAlertMessage = (alert: MailSentinelAlertState, kind: "new-alert" | "reminder"): string => {
  const title = kind === "reminder" ? "Mail Sentinel Reminder" : "Mail Sentinel Alert";
  const body = [
    `${title} [${alert.alertId}]`,
    `Kategorie: ${mailSentinelCategoryLabel[alert.category]}`,
    `Betreff: ${alert.subject}`,
    `Absender: ${alert.from}`,
    `Warum wichtig: ${alert.why}`,
    "Feedback: antworte mit 'War wichtig', 'Nicht wichtig', 'Nicht mehr so oft melden' oder 'Später erinnern'.",
  ];
  if (alert.messageId !== undefined) {
    body.push(`Mail-ID: ${alert.messageId}`);
  }
  return body.join("\n");
};

const applyLearningAdjustment = (
  target: Record<string, number>,
  key: string | undefined,
  delta: number,
): void => {
  if (key === undefined) {
    return;
  }
  const next = (target[key] ?? 0) + delta;
  if (next === 0) {
    delete target[key];
    return;
  }
  target[key] = next;
};

const describeToolError = (
  error: unknown,
): { code: string; message: string; retryable: boolean } =>
  error instanceof MailSentinelToolError
    ? {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      }
    : {
        code: "MAIL_SENTINEL_UNKNOWN_ERROR",
        message: describeErrorMessage(error),
        retryable: false,
      };

export class MailSentinelToolService {
  private readonly loadRuntimeConfig: RuntimeConfigLoader;

  private readonly runner: ToolRunner;

  private readonly fetchImpl: typeof fetch;

  private readonly clock: () => Date;

  constructor(
    private readonly options: {
      configLoader?: RuntimeConfigLoader;
      runner?: ToolRunner;
      fetchImpl?: typeof fetch;
      now?: () => Date;
      maxScanMessages?: number;
    } = {},
  ) {
    this.loadRuntimeConfig = options.configLoader ?? defaultRuntimeConfigLoader;
    this.runner = options.runner ?? defaultRunner;
    this.fetchImpl = options.fetchImpl ?? defaultFetchImpl;
    this.clock = options.now ?? defaultNow;
  }

  async scan(input: { instanceId: string; configPath?: string }): Promise<MailSentinelScanResult> {
    const instance = await this.resolveToolInstance(input.instanceId, input.configPath);
    const scanAt = nowIso(this.clock);
    return await this.withLockedState(instance.statePath, async () => {
      const state = await this.readState(instance.statePath);
      state.lastPollAt = scanAt;

      if (instance.imap === null) {
        state.lastError = undefined;
        state.consecutiveFailures = 0;
        await this.writeState(instance.statePath, state);
        return {
          instanceId: instance.instanceId,
          configured: false,
          lookbackWindow: instance.lookbackWindow,
          processedMessages: 0,
          newMessages: 0,
          alertsSent: 0,
          remindersSent: 0,
          lastPollAt: scanAt,
          note: "IMAP is not configured yet.",
          alerts: [],
        };
      }

      try {
        const rules = await this.readRules(instance.rulesPath);
        const reminderAlerts = await this.sendDueReminders(instance, state, scanAt);
        const scanned = await this.fetchScanCandidates(instance, state, scanAt);
        const alerts: ScanSummaryAlert[] = [...reminderAlerts];
        let alertsSent = 0;

        for (const message of scanned.messages) {
          state.messages[message.key] = {
            key: message.key,
            uid: message.uid,
            ...(message.messageId === undefined ? {} : { messageId: message.messageId }),
            subject: message.subject,
            from: message.from,
            ...(message.fromAddress === undefined ? {} : { fromAddress: message.fromAddress }),
            ...(message.domain === undefined ? {} : { domain: message.domain }),
            ...(message.date === undefined ? {} : { date: message.date }),
            firstSeenAt: state.messages[message.key]?.firstSeenAt ?? scanAt,
            lastSeenAt: scanAt,
            ...(state.messages[message.key]?.alertId === undefined
              ? {}
              : { alertId: state.messages[message.key]?.alertId }),
          };
          const existingAlert = state.alerts.find((alert) => alert.messageKey === message.key);
          if (existingAlert !== undefined) {
            continue;
          }
          const scored = scoreMessage({
            message,
            state,
            rules,
          });
          if (!scored.relevant) {
            continue;
          }
          const alert: MailSentinelAlertState = {
            alertId: randomUUID(),
            messageKey: message.key,
            uid: message.uid,
            ...(message.messageId === undefined ? {} : { messageId: message.messageId }),
            category: scored.category,
            subject: message.subject,
            from: message.from,
            ...(message.fromAddress === undefined ? {} : { fromAddress: message.fromAddress }),
            ...(message.domain === undefined ? {} : { domain: message.domain }),
            why: scored.reasons[0] === undefined ? "matched Mail Sentinel relevance rules" : scored.reasons.slice(0, 2).join("; "),
            sentAt: scanAt,
            score: scored.score,
            categoryScores: scored.categoryScores,
            reasons: scored.reasons,
            matchedRuleIds: scored.matchedRuleIds,
            feedbackState: "pending",
          };
          await this.sendMatrixRoomMessage(instance.matrix, buildAlertMessage(alert, "new-alert"));
          alertsSent += 1;
          state.lastAlertAt = scanAt;
          state.alerts.push(alert);
          state.messages[message.key] = {
            ...state.messages[message.key]!,
            alertId: alert.alertId,
          };
          alerts.push(mapAlertToSummary(alert, "new-alert"));
        }

        state.mailbox = {
          uidValidity: scanned.uidValidity,
          ...(scanned.lastSeenUid === undefined ? {} : { lastSeenUid: scanned.lastSeenUid }),
        };
        state.lastImapSuccessAt = scanAt;
        state.lastError = undefined;
        state.consecutiveFailures = 0;
        await this.writeState(instance.statePath, pruneState(state));

        return {
          instanceId: instance.instanceId,
          configured: true,
          lookbackWindow: instance.lookbackWindow,
          processedMessages: scanned.messages.length,
          newMessages: scanned.messages.length,
          alertsSent,
          remindersSent: reminderAlerts.length,
          lastPollAt: scanAt,
          alerts,
        };
      } catch (error) {
        state.lastError = describeToolError(error);
        state.consecutiveFailures += 1;
        await this.writeState(instance.statePath, pruneState(state));
        throw error;
      }
    });
  }

  async applyFeedback(input: {
    instanceId: string;
    action: "important" | "not-important" | "less-often" | "remind-later";
    alertId?: string;
    latest?: boolean;
    delay?: string;
    configPath?: string;
  }): Promise<MailSentinelFeedbackResult> {
    const instance = await this.resolveToolInstance(input.instanceId, input.configPath);
    return await this.withLockedState(instance.statePath, async () => {
      const state = await this.readState(instance.statePath);
      const alert =
        input.alertId !== undefined
          ? state.alerts.find((entry) => entry.alertId === input.alertId)
          : input.latest === true
            ? state.alerts.slice().sort((left, right) => right.sentAt.localeCompare(left.sentAt))[0]
            : undefined;
      if (alert === undefined) {
        throw new MailSentinelToolError(
          "MAIL_SENTINEL_ALERT_NOT_FOUND",
          "No matching Mail Sentinel alert was found",
          false,
          {
            instanceId: input.instanceId,
            alertId: input.alertId,
            latest: input.latest === true,
          },
        );
      }

      const appliedAt = nowIso(this.clock);
      let note = "Feedback recorded.";
      let nextReminderAt: string | undefined;
      if (input.action === "important") {
        const already = alert.feedbackState === "important";
        alert.feedbackState = "important";
        alert.feedbackAt = appliedAt;
        alert.reminderDueAt = undefined;
        applyLearningAdjustment(state.learning.senderWeights, alert.fromAddress, 2);
        applyLearningAdjustment(state.learning.domainWeights, alert.domain, 1);
        for (const ruleId of alert.matchedRuleIds) {
          applyLearningAdjustment(state.learning.ruleAdjustments, ruleId, 1);
        }
        note = already ? "Alert was already marked important." : "Alert marked as important.";
      } else if (input.action === "not-important") {
        const already = alert.feedbackState === "not-important";
        alert.feedbackState = "not-important";
        alert.feedbackAt = appliedAt;
        alert.reminderDueAt = undefined;
        applyLearningAdjustment(state.learning.senderWeights, alert.fromAddress, -2);
        applyLearningAdjustment(state.learning.domainWeights, alert.domain, -1);
        for (const ruleId of alert.matchedRuleIds) {
          applyLearningAdjustment(state.learning.ruleAdjustments, ruleId, -1);
        }
        note = already ? "Alert was already marked not important." : "Alert marked as not important.";
      } else if (input.action === "less-often") {
        const already = alert.feedbackState === "less-often";
        alert.feedbackState = "less-often";
        alert.feedbackAt = appliedAt;
        alert.reminderDueAt = undefined;
        applyLearningAdjustment(state.learning.senderWeights, alert.fromAddress, -4);
        applyLearningAdjustment(state.learning.domainWeights, alert.domain, -2);
        for (const ruleId of alert.matchedRuleIds) {
          applyLearningAdjustment(state.learning.ruleAdjustments, ruleId, -1);
        }
        note = already ? "Sender is already down-weighted." : "Future alerts from this sender will be down-weighted.";
      } else {
        const delay = input.delay ?? instance.defaultReminderDelay;
        nextReminderAt = new Date(this.clock().getTime() + parseDurationMs(delay)).toISOString();
        alert.reminderDueAt = nextReminderAt;
        note = `Reminder scheduled for ${nextReminderAt}.`;
      }
      state.feedback.push({
        alertId: alert.alertId,
        action: input.action,
        at: appliedAt,
        ...(input.action !== "remind-later" || nextReminderAt === undefined
          ? {}
          : { delay: input.delay ?? instance.defaultReminderDelay }),
      });
      await this.writeState(instance.statePath, pruneState(state));
      return {
        instanceId: instance.instanceId,
        alertId: alert.alertId,
        action: input.action,
        changed: true,
        note,
        ...(nextReminderAt === undefined ? {} : { nextReminderAt }),
      };
    });
  }

  async listAlerts(input: {
    instanceId: string;
    view: "today" | "recent";
    limit?: number;
    configPath?: string;
  }): Promise<MailSentinelListAlertsResult> {
    const instance = await this.resolveToolInstance(input.instanceId, input.configPath);
    const state = await this.readState(instance.statePath);
    const limit = Math.max(1, Math.min(20, Math.trunc(input.limit ?? 5)));
    const alerts = state.alerts
      .slice()
      .sort((left, right) => right.sentAt.localeCompare(left.sentAt))
      .filter((alert) => input.view === "recent" || isSameLocalDay(alert.sentAt, this.clock()))
      .slice(0, limit)
      .map((alert) => mapAlertToSummary(alert));
    return {
      instanceId: instance.instanceId,
      view: input.view,
      count: alerts.length,
      alerts,
    };
  }

  async readStatus(input: {
    instanceId: string;
    configPath?: string;
  }): Promise<MailSentinelStatusSummary> {
    const instance = await this.resolveToolInstance(input.instanceId, input.configPath);
    const state = await this.readState(instance.statePath);
    return resolveMailSentinelStatusSummary(state);
  }

  private async fetchScanCandidates(
    instance: ResolvedMailSentinelToolInstance,
    state: MailSentinelState,
    scanAt: string,
  ): Promise<{
    uidValidity: string;
    lastSeenUid: number | undefined;
    messages: ParsedMail[];
  }> {
    const maxScanMessages = this.options.maxScanMessages ?? DEFAULT_MAX_SCAN_MESSAGES;
    return await this.runner(instance.imap!, async (client) =>
      await withMailboxLock(
        client,
        instance.imap!.mailbox,
        `sovereign-tool:${instance.instanceId}:scan`,
        async () => {
          const mailbox = await client.mailboxOpen(instance.imap!.mailbox);
          const uidValidity = mailbox.uidValidity.toString();
          const selection =
            state.mailbox.uidValidity === uidValidity && state.mailbox.lastSeenUid !== undefined
              ? state.mailbox.lastSeenUid + 1 >= mailbox.uidNext
                ? null
                : (`${String(state.mailbox.lastSeenUid + 1)}:*` as const)
              : ({
                  since: new Date(this.clock().getTime() - parseDurationMs(instance.lookbackWindow)),
                } as const);
          if (selection === null) {
            return {
              uidValidity,
              lastSeenUid: state.mailbox.lastSeenUid,
              messages: [],
            };
          }

          const fetched = await client.fetchAll(
            selection,
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
          const sorted = fetched.sort((left, right) => left.uid - right.uid).slice(-maxScanMessages);
          const messages = (
            await Promise.all(
              sorted.map(async (message) => await this.parseFetchedMessage(message, uidValidity, scanAt)),
            )
          ).filter((entry): entry is ParsedMail => entry !== null);
          const lastSeenUid = sorted.at(-1)?.uid ?? state.mailbox.lastSeenUid;
          return {
            uidValidity,
            lastSeenUid,
            messages,
          };
        },
      ),
    );
  }

  private async parseFetchedMessage(
    message: FetchMessageObject,
    uidValidity: string,
    seenAt: string,
  ): Promise<ParsedMail | null> {
    if (message.source === undefined) {
      return null;
    }
    let parsed: PostalMimeEmail;
    try {
      parsed = await PostalMime.parse(message.source);
    } catch (error) {
      throw new MailSentinelToolError(
        "MAIL_SENTINEL_MAIL_PARSE_FAILED",
        `Failed to parse mail UID ${String(message.uid)}`,
        false,
        {
          uid: message.uid,
          error: describeErrorMessage(error),
        },
      );
    }
    const messageId = normalizeMessageId(parsed.messageId ?? message.envelope?.messageId);
    const from = extractFromDisplay(message, parsed);
    const fromAddress = normalizeEmailAddress(
      message.envelope?.from?.[0]?.address ?? (parsed.from !== undefined && "address" in parsed.from ? parsed.from.address : undefined),
    );
    const domain = extractDomain(fromAddress);
    const subject = compactText(parsed.subject ?? message.envelope?.subject ?? "(no subject)");
    const text = compactText(parsed.text ?? (typeof parsed.html === "string" ? stripHtmlTags(parsed.html) : ""));
    const inReplyTo = normalizeMessageId(parsed.inReplyTo);
    const date =
      typeof parsed.date === "string" && parsed.date.length > 0
        ? parsed.date
        : message.internalDate instanceof Date
          ? message.internalDate.toISOString()
          : typeof message.internalDate === "string" && message.internalDate.length > 0
            ? message.internalDate
            : undefined;
    return {
      key: buildMessageKey(messageId, uidValidity, message.uid),
      uid: message.uid,
      ...(messageId === undefined ? {} : { messageId }),
      subject,
      from,
      ...(fromAddress === undefined ? {} : { fromAddress }),
      ...(domain === undefined ? {} : { domain }),
      ...(date === undefined ? {} : { date }),
      text,
      headers: buildHeadersMap(parsed.headers),
      ...(inReplyTo === undefined ? {} : { inReplyTo }),
      references: parseReferences(parsed.references),
    };
  }

  private async sendDueReminders(
    instance: ResolvedMailSentinelToolInstance,
    state: MailSentinelState,
    scanAt: string,
  ): Promise<ScanSummaryAlert[]> {
    const due = state.alerts.filter(
      (alert) =>
        alert.reminderDueAt !== undefined &&
        alert.feedbackState === "pending" &&
        new Date(alert.reminderDueAt).getTime() <= this.clock().getTime(),
    );
    const sent: ScanSummaryAlert[] = [];
    for (const alert of due) {
      await this.sendMatrixRoomMessage(instance.matrix, buildAlertMessage(alert, "reminder"));
      alert.lastReminderAt = scanAt;
      alert.reminderDueAt = undefined;
      state.lastAlertAt = scanAt;
      sent.push(mapAlertToSummary(alert, "reminder"));
    }
    return sent;
  }

  private async sendMatrixRoomMessage(
    matrix: ResolvedMailSentinelToolInstance["matrix"],
    text: string,
  ): Promise<void> {
    const txnId = randomUUID();
    const endpoint = new URL(
      `/_matrix/client/v3/rooms/${encodeURIComponent(matrix.roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`,
      ensureTrailingSlash(matrix.adminBaseUrl),
    ).toString();
    const response = await this.fetchImpl(endpoint, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${matrix.accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        msgtype: "m.text",
        body: text,
      }),
    });
    if (!response.ok) {
      throw new MailSentinelToolError(
        "MAIL_SENTINEL_MATRIX_SEND_FAILED",
        "Failed to send a Matrix room message",
        true,
        {
          endpoint,
          status: response.status,
          body: compactText(await response.text()),
        },
      );
    }
  }

  private async resolveToolInstance(
    instanceId: string,
    configPathOverride: string | undefined,
  ): Promise<ResolvedMailSentinelToolInstance> {
    const configPath = configPathOverride ?? defaultConfigPath();
    const runtimeConfig = await this.loadRuntimeConfig(configPath);
    const tool = runtimeConfig.sovereignTools.instances.find((entry) => entry.id === instanceId);
    if (tool === undefined) {
      throw new MailSentinelToolError(
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
    if (parsedRef.id !== MAIL_SENTINEL_TOOL_TEMPLATE_ID) {
      throw new MailSentinelToolError(
        "TOOL_INSTANCE_TEMPLATE_MISMATCH",
        `Tool instance '${instanceId}' is not bound to a mail-sentinel template`,
        false,
        {
          instanceId,
          templateRef: tool.templateRef,
        },
      );
    }

    const agentId = tool.config.agentId ?? MAIL_SENTINEL_AGENT_ID;
    const agent = runtimeConfig.openclawProfile.agents.find((entry) => entry.id === agentId);
    if (agent === undefined) {
      throw new MailSentinelToolError(
        "MAIL_SENTINEL_AGENT_NOT_FOUND",
        `Mail Sentinel agent '${agentId}' is missing from the runtime config`,
        false,
        {
          instanceId,
          agentId,
        },
      );
    }
    if (agent.matrix?.accessTokenSecretRef === undefined) {
      throw new MailSentinelToolError(
        "MAIL_SENTINEL_MATRIX_IDENTITY_MISSING",
        `Mail Sentinel agent '${agentId}' has no Matrix access token binding`,
        false,
        {
          instanceId,
          agentId,
        },
      );
    }
    const statePath = resolveRelativeToBase(tool.config.statePath ?? DEFAULT_STATE_PATH, agent.workspace);
    const rulesPath = resolveRelativeToBase(tool.config.rulesPath ?? DEFAULT_RULES_PATH, agent.workspace);
    const lookbackWindow = tool.config.lookbackWindow ?? DEFAULT_LOOKBACK_WINDOW;
    const defaultReminderDelay = tool.config.defaultReminderDelay ?? DEFAULT_REMINDER_DELAY;

    const imap =
      runtimeConfig.imap.status !== "configured"
        ? null
        : {
            host: runtimeConfig.imap.host,
            port: runtimeConfig.imap.port,
            tls: runtimeConfig.imap.tls,
            username: runtimeConfig.imap.username,
            password: await resolveSecretRefValue(runtimeConfig.imap.secretRef),
            mailbox: runtimeConfig.imap.mailbox,
          };

    return {
      instanceId,
      configPath,
      runtimeConfig,
      agentId,
      workspaceDir: agent.workspace,
      statePath,
      rulesPath,
      lookbackWindow,
      defaultReminderDelay,
      matrix: {
        adminBaseUrl: runtimeConfig.matrix.adminBaseUrl,
        roomId: runtimeConfig.matrix.alertRoom.roomId,
        accessToken: await resolveSecretRefValue(agent.matrix.accessTokenSecretRef),
      },
      imap,
    };
  }

  private async readRules(path: string): Promise<MailSentinelRules> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      throw new MailSentinelToolError(
        "MAIL_SENTINEL_RULES_READ_FAILED",
        `Failed to read Mail Sentinel rules at ${path}`,
        false,
        {
          path,
          error: describeErrorMessage(error),
        },
        { cause: error instanceof Error ? error : undefined },
      );
    }
    try {
      return rulesFileSchema.parse(JSON.parse(stripSingleTrailingNewline(raw)) as unknown);
    } catch (error) {
      throw new MailSentinelToolError(
        "MAIL_SENTINEL_RULES_INVALID",
        `Mail Sentinel rules at ${path} are invalid`,
        false,
        {
          path,
          error: describeErrorMessage(error),
        },
        { cause: error instanceof Error ? error : undefined },
      );
    }
  }

  private async readState(path: string): Promise<MailSentinelState> {
    try {
      const raw = await readFile(path, "utf8");
      return mailSentinelStateSchema.parse(JSON.parse(stripSingleTrailingNewline(raw)) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return createDefaultState();
      }
      if (error instanceof z.ZodError) {
        throw new MailSentinelToolError(
          "MAIL_SENTINEL_STATE_INVALID",
          `Mail Sentinel state at ${path} is invalid`,
          false,
          {
            path,
            issues: error.issues,
          },
          { cause: error },
        );
      }
      throw error;
    }
  }

  private async writeState(path: string, state: MailSentinelState): Promise<void> {
    const dir = dirname(path);
    await mkdir(dir, { recursive: true });
    const tempPath = `${path}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tempPath, path);
  }

  private async withLockedState<T>(statePath: string, action: () => Promise<T>): Promise<T> {
    const lockPath = `${statePath}.lock`;
    let handle:
      | {
          close(): Promise<void>;
        }
      | undefined;
    for (let attempt = 0; attempt < DEFAULT_LOCK_RETRY_ATTEMPTS; attempt += 1) {
      try {
        await mkdir(dirname(lockPath), { recursive: true });
        handle = await open(lockPath, "wx");
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
          throw error;
        }
        await new Promise((resolveDelay) => {
          setTimeout(resolveDelay, DEFAULT_LOCK_RETRY_DELAY_MS);
        });
      }
    }
    if (handle === undefined) {
      throw new MailSentinelToolError(
        "MAIL_SENTINEL_STATE_LOCK_TIMEOUT",
        `Timed out while waiting for the Mail Sentinel state lock on ${statePath}`,
        true,
        {
          statePath,
        },
      );
    }
    try {
      return await action();
    } finally {
      await handle.close();
      await rm(lockPath, { force: true });
    }
  }
}

export const formatMailSentinelScanResult = (result: MailSentinelScanResult): string => {
  if (!result.configured) {
    return result.note ?? "IMAP is not configured yet.";
  }
  const lines = [
    `Mail Sentinel scan: ${String(result.newMessages)} new message(s), ${String(result.alertsSent)} alert(s), ${String(result.remindersSent)} reminder(s).`,
  ];
  if (result.alerts.length > 0) {
    lines.push(...result.alerts.map((alert) => formatAlertLine(alert)));
  }
  return lines.join("\n");
};

export const formatMailSentinelFeedbackResult = (result: MailSentinelFeedbackResult): string => {
  if (result.nextReminderAt !== undefined) {
    return `${result.note} Alert ${result.alertId} will be revisited at ${result.nextReminderAt}.`;
  }
  return `${result.note} Alert ${result.alertId}.`;
};

export const formatMailSentinelListAlertsResult = (result: MailSentinelListAlertsResult): string => {
  if (result.alerts.length === 0) {
    return result.view === "today"
      ? "No important Mail Sentinel alerts today."
      : "No Mail Sentinel alerts have been recorded yet.";
  }
  return [
    result.view === "today" ? "Important today:" : "Recent alerts:",
    ...result.alerts.map((alert) => formatAlertLine(alert)),
  ].join("\n");
};

const ensureTrailingSlash = (value: string): string => (value.endsWith("/") ? value : `${value}/`);
