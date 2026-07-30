/**
 * Product-safe diagnostics presentation model.
 *
 * This is the single mapping from internal health surfaces (doctor report,
 * sovereign status, Mail Sentinel state, updater state) to what a design
 * partner is allowed to see: fixed component ids, fixed states, fixed
 * summary/action sentences and stable SAN codes. Every consumer that shows
 * health to a partner — the `sovereign-node diagnostics` CLI, the Pro
 * diagnostics API behind the Node Status page, and the Node Operator Matrix
 * bot — renders THIS model, never raw doctor output.
 *
 * Safety is by construction, not by redaction: no value from a check message,
 * command output, path, or error ever reaches the model. The only dynamic
 * values are enum states, SAN ids from the local registry, and ISO timestamps
 * that are re-serialised through Date so a poisoned state file cannot smuggle
 * arbitrary text through a timestamp field.
 */

import { z } from "zod";

import { CONTRACT_VERSION } from "../contracts/common.js";
import type { DoctorReport, SovereignStatus } from "../contracts/index.js";
import { lookupSanError } from "./codes.js";

export const DIAGNOSTICS_COMPONENT_IDS = [
  "sovereign-ai-node",
  "matrix",
  "node-operator",
  "mail-sentinel",
  "mailbox",
  "classification-provider",
  "relay",
  "update-service",
] as const;

export type DiagnosticsComponentId = (typeof DIAGNOSTICS_COMPONENT_IDS)[number];

export const diagnosticsComponentStatusSchema = z.enum([
  "healthy",
  "degraded",
  "failed",
  "unknown",
]);
export type DiagnosticsComponentStatus = z.infer<typeof diagnosticsComponentStatusSchema>;

export const diagnosticsOverallSchema = z.enum([
  "healthy",
  "degraded",
  "action_required",
  "unavailable",
]);
export type DiagnosticsOverall = z.infer<typeof diagnosticsOverallSchema>;

export const diagnosticsComponentSchema = z.object({
  id: z.enum(DIAGNOSTICS_COMPONENT_IDS),
  label: z.string().min(1),
  status: diagnosticsComponentStatusSchema,
  lastSuccessAt: z.string().min(1).optional(),
  code: z.string().min(1).optional(),
  summary: z.string().min(1),
  action: z.string().min(1).optional(),
});
export type DiagnosticsComponent = z.infer<typeof diagnosticsComponentSchema>;

export const diagnosticsPresentationSchema = z.object({
  /** Contract version of the producing node, so consumers can detect drift. */
  contractVersion: z.string().min(1),
  overall: diagnosticsOverallSchema,
  checkedAt: z.string().min(1),
  headline: z.string().min(1),
  components: z.array(diagnosticsComponentSchema),
});
export type DiagnosticsPresentation = z.infer<typeof diagnosticsPresentationSchema>;

/**
 * Updater state as the caller understands it. Core deliberately knows nothing
 * about the Pro updater's status-file schema — the Pro API maps its own
 * durable record into this shape before calling in.
 */
export type UpdateServiceSummary = {
  status: "ok" | "running" | "failed" | "unknown";
  lastSuccessAt?: string | undefined;
};

export type DiagnosticsInputs = {
  now: Date;
  status?: SovereignStatus | undefined;
  doctorReport?: DoctorReport | undefined;
  /** Parsed Mail Sentinel state file contents; treated as untrusted. */
  mailSentinelState?: unknown;
  update?: UpdateServiceSummary | undefined;
};

const COMPONENT_LABELS: Record<DiagnosticsComponentId, string> = {
  "sovereign-ai-node": "Sovereign AI Node",
  matrix: "Matrix",
  "node-operator": "Node Operator",
  "mail-sentinel": "Mail Sentinel",
  mailbox: "Mailbox",
  "classification-provider": "Semantic classification",
  relay: "Relay",
  "update-service": "Update service",
};

/**
 * Fixed sentence tables. Nothing outside these strings (plus SAN ids and
 * timestamps) may appear in a summary or action.
 */
const SUMMARIES: Record<
  DiagnosticsComponentId,
  Partial<Record<DiagnosticsComponentStatus, string>>
> = {
  "sovereign-ai-node": {
    healthy: "The node service is running normally.",
    degraded: "The node is running, but at least one system check reports a warning.",
    failed: "At least one node system check is failing.",
    unknown: "The node's own health could not be determined.",
  },
  matrix: {
    healthy: "The Matrix homeserver is reachable and the alert room is available.",
    degraded: "Matrix is reachable, but the alert room could not be confirmed.",
    failed: "Bots are not responding in Matrix.",
    unknown: "Matrix health could not be determined.",
  },
  "node-operator": {
    healthy: "Node Operator is registered and its messaging runtime is running.",
    degraded: "Node Operator is registered, but its messaging runtime reports a warning.",
    failed: "Node Operator is not able to respond in Matrix.",
    unknown: "Node Operator state could not be determined.",
  },
  "mail-sentinel": {
    healthy: "Mail Sentinel is running.",
    degraded: "Mail Sentinel is running with warnings.",
    failed: "Mail Sentinel scans are failing.",
    unknown: "Mail Sentinel state could not be determined.",
  },
  mailbox: {
    healthy: "Mail is being retrieved from the mailbox.",
    degraded: "The mailbox connection reports a warning.",
    failed: "New mail is not being retrieved from the mailbox.",
    unknown: "Mailbox state could not be determined.",
  },
  "classification-provider": {
    healthy: "Semantic classification is available.",
    degraded: "Semantic classification is unavailable; alerts continue at reduced confidence.",
    failed: "Semantic classification is unavailable.",
    unknown: "Semantic classification state could not be determined.",
  },
  relay: {
    healthy: "The relay tunnel is connected.",
    degraded: "The relay tunnel is not connected.",
    failed: "The relay tunnel service is failing.",
    unknown: "Relay state could not be determined.",
  },
  "update-service": {
    healthy: "The update service is ready.",
    degraded: "The last update did not complete.",
    failed: "The last update did not complete.",
    unknown: "Update service state could not be determined.",
  },
};

const GENERIC_ACTION = "Open Node Status for details.";

const ACTIONS_BY_CODE: Record<string, string> = {
  "SAN-LLM-001": "Check the classification provider key on the Node Status page, then retry.",
  "SAN-MAIL-001": "Check the mailbox connection on the Node Status page.",
  "SAN-IMAP-001": "Re-enter the mailbox password in the local web interface.",
  "SAN-IMAP-002": "Check that the mail server is reachable, then retry.",
  "SAN-MATRIX-003":
    "Open Node Status and run diagnostics; restarting the node usually recovers this.",
  "SAN-SYSTEM-001": "Free disk space on the node, then run diagnostics again.",
  "SAN-UPDATE-001": "Open the update page and retry the update.",
};

const HEADLINES_BY_CODE: Record<string, string> = {
  "SAN-LLM-001":
    "Mail is still being retrieved, but semantic classification is currently unavailable, so alert quality may be reduced.",
  "SAN-MAIL-001": "New mail is not being retrieved, so no alerts are being raised.",
  "SAN-IMAP-001": "The mailbox sign-in was rejected, so mail is not being retrieved.",
  "SAN-IMAP-002": "The mail server cannot be reached, so mail is not being retrieved.",
  "SAN-MATRIX-003": "Bots are not responding in Matrix.",
  "SAN-SYSTEM-001": "The node is running low on disk space.",
  "SAN-UPDATE-001": "The last update did not complete.",
};

const OVERALL_HEADLINES: Record<DiagnosticsOverall, string> = {
  healthy: "All components are working normally.",
  degraded: "The node is running, but one or more components are degraded.",
  action_required: "One or more components need attention.",
  unavailable: "The node's health could not be determined.",
};

/**
 * Freshness policies: a component whose last success is older than its
 * policy window must not keep reporting healthy indefinitely — silence is a
 * failure mode (audit F-01), not health.
 *
 * Policies exist only for components whose timestamp is EXPECTED to refresh
 * continuously. The mailbox card's `lastCredentialTestAt`, for example, is a
 * point-in-time credential test, so no policy applies there.
 */
const STALE_AFTER_MS: Partial<Record<DiagnosticsComponentId, number>> = {
  // The scan timer fires every 30 minutes; two hours of silence means scans
  // have stopped even if nothing reported an error.
  "mail-sentinel": 2 * 60 * 60 * 1000,
};

const STALE_SUMMARIES: Partial<Record<DiagnosticsComponentId, string>> = {
  "mail-sentinel": "Mail Sentinel has not completed a scan recently.",
};

/** Re-serialise a timestamp through Date so only real ISO strings pass. */
const safeTimestamp = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) {
    return undefined;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
};

/** Attach a SAN code only when the registry knows it — never invent ids. */
const knownCode = (id: string): string | undefined =>
  lookupSanError(id) === undefined ? undefined : id;

type ComponentDraft = {
  id: DiagnosticsComponentId;
  status: DiagnosticsComponentStatus;
  code?: string | undefined;
  lastSuccessAt?: string | undefined;
};

const finishComponent = (draft: ComponentDraft): DiagnosticsComponent => {
  const summary =
    SUMMARIES[draft.id][draft.status] ?? SUMMARIES[draft.id].unknown ?? "State unknown.";
  const action =
    draft.status === "healthy"
      ? undefined
      : ((draft.code !== undefined ? ACTIONS_BY_CODE[draft.code] : undefined) ?? GENERIC_ACTION);
  return {
    id: draft.id,
    label: COMPONENT_LABELS[draft.id],
    status: draft.status,
    ...(draft.lastSuccessAt === undefined ? {} : { lastSuccessAt: draft.lastSuccessAt }),
    ...(draft.code === undefined ? {} : { code: draft.code }),
    summary,
    ...(action === undefined ? {} : { action }),
  };
};

const checkStatus = (
  report: DoctorReport | undefined,
  checkId: string,
): "pass" | "warn" | "fail" | "skip" | undefined =>
  report?.checks.find((c) => c.id === checkId)?.status;

const readDegradationState = (state: unknown): string | undefined => {
  if (typeof state !== "object" || state === null) {
    return undefined;
  }
  const value = (state as { degradationState?: unknown }).degradationState;
  return value === "healthy" || value === "classification-degraded" || value === "scans-failing"
    ? value
    : undefined;
};

const readLastScanAt = (state: unknown): string | undefined => {
  if (typeof state !== "object" || state === null) {
    return undefined;
  }
  return safeTimestamp((state as { lastScanAt?: unknown }).lastScanAt);
};

const mapHealth = (
  health: "healthy" | "degraded" | "unhealthy" | "unknown" | undefined,
): DiagnosticsComponentStatus => {
  switch (health) {
    case "healthy":
      return "healthy";
    case "degraded":
      return "degraded";
    case "unhealthy":
      return "failed";
    default:
      return "unknown";
  }
};

export const buildDiagnosticsPresentation = (
  inputs: DiagnosticsInputs,
): DiagnosticsPresentation => {
  const { status, doctorReport, mailSentinelState, update } = inputs;
  const checkedAt = inputs.now.toISOString();

  if (status === undefined && doctorReport === undefined) {
    return {
      contractVersion: CONTRACT_VERSION,
      overall: "unavailable",
      checkedAt,
      headline: OVERALL_HEADLINES.unavailable,
      components: [],
    };
  }

  const components: DiagnosticsComponent[] = [];
  const degradation = readDegradationState(mailSentinelState);

  // Sovereign AI Node — the node's own checks, minus component-specific ones
  // that get their own card below.
  {
    const disk = checkStatus(doctorReport, "disk-space-root");
    const draft: ComponentDraft = { id: "sovereign-ai-node", status: "healthy" };
    if (doctorReport === undefined) {
      draft.status = "unknown";
    } else if (disk === "fail") {
      draft.status = "failed";
      draft.code = knownCode("SAN-SYSTEM-001");
    } else if (disk === "warn") {
      draft.status = "degraded";
      draft.code = knownCode("SAN-SYSTEM-001");
    } else if (doctorReport.overall === "fail") {
      // Some check is failing; component cards below carry the specifics.
      draft.status = "degraded";
    } else if (doctorReport.overall === "warn") {
      draft.status = "degraded";
    }
    components.push(finishComponent(draft));
  }

  // Matrix — homeserver health plus the gateway that lets bots respond.
  {
    const gateway = checkStatus(doctorReport, "gateway-service-health");
    const draft: ComponentDraft = { id: "matrix", status: mapHealth(status?.matrix.health) };
    if (gateway === "fail" || draft.status === "failed") {
      draft.status = "failed";
      draft.code = knownCode("SAN-MATRIX-003");
    } else if (status !== undefined && !status.matrix.roomReachable) {
      draft.status = draft.status === "healthy" ? "degraded" : draft.status;
    } else if (gateway === "warn" && draft.status === "healthy") {
      draft.status = "degraded";
    }
    components.push(finishComponent(draft));
  }

  // Node Operator — only when the bot is part of this installation.
  const operatorBot = status?.bots["node-operator"];
  if (operatorBot !== undefined) {
    const registration = checkStatus(doctorReport, "managed-bot-registration");
    const gateway = checkStatus(doctorReport, "gateway-service-health");
    const draft: ComponentDraft = { id: "node-operator", status: mapHealth(operatorBot.health) };
    if (gateway === "fail" || registration === "fail" || draft.status === "failed") {
      draft.status = "failed";
      draft.code = knownCode("SAN-MATRIX-003");
    } else if (registration === "warn" && draft.status === "healthy") {
      draft.status = "degraded";
    }
    components.push(finishComponent(draft));
  }

  // Mail Sentinel — module state; scan failures take priority.
  const mailSentinelBot = status?.bots["mail-sentinel"];
  if (mailSentinelBot !== undefined) {
    const draft: ComponentDraft = {
      id: "mail-sentinel",
      status: mapHealth(mailSentinelBot.health),
      lastSuccessAt: readLastScanAt(mailSentinelState),
    };
    if (degradation === "scans-failing") {
      draft.status = "failed";
      draft.code = knownCode("SAN-MAIL-001");
    }
    components.push(finishComponent(draft));
  }

  // Mailbox — distinct from the module so a partner can tell "the mailbox is
  // broken" apart from "the classifier is broken".
  const imap = status?.imap;
  if (imap !== undefined && (imap.authStatus !== "unknown" || imap.host !== undefined)) {
    const draft: ComponentDraft = {
      id: "mailbox",
      status: "healthy",
      lastSuccessAt: safeTimestamp(imap.lastCredentialTestAt),
    };
    if (imap.authStatus === "failed") {
      draft.status = "failed";
      draft.code = knownCode("SAN-IMAP-001");
    } else if (degradation === "scans-failing") {
      draft.status = "failed";
      draft.code = knownCode("SAN-MAIL-001");
    } else if (imap.authStatus === "unknown") {
      draft.status = "unknown";
    }
    components.push(finishComponent(draft));
  }

  // Semantic classification — present whenever Mail Sentinel is, because the
  // provider only matters to the module that calls it.
  if (mailSentinelBot !== undefined) {
    const draft: ComponentDraft = { id: "classification-provider", status: "healthy" };
    if (degradation === "classification-degraded") {
      draft.status = "degraded";
      draft.code = knownCode("SAN-LLM-001");
    } else if (degradation === undefined) {
      draft.status = "unknown";
    }
    components.push(finishComponent(draft));
  }

  // Relay — only when configured.
  if (status?.relay?.enabled === true) {
    const relay = status.relay;
    const draft: ComponentDraft = { id: "relay", status: "healthy" };
    if (relay.serviceState === "failed") {
      draft.status = "failed";
    } else if (!relay.connected) {
      draft.status = "degraded";
    }
    components.push(finishComponent(draft));
  }

  // Update service — only when the caller supplied updater state.
  if (update !== undefined) {
    const draft: ComponentDraft = {
      id: "update-service",
      status: "healthy",
      lastSuccessAt: safeTimestamp(update.lastSuccessAt),
    };
    if (update.status === "failed") {
      draft.status = "degraded";
      draft.code = knownCode("SAN-UPDATE-001");
    } else if (update.status === "unknown") {
      draft.status = "unknown";
    }
    components.push(finishComponent(draft));
  }

  // Freshness: a healthy card with an expired last-success window degrades
  // to a fixed stale summary. Applied before the overall verdict so a stale
  // component makes the node degraded.
  const nowMs = inputs.now.getTime();
  const freshened = components.map((component) => {
    const policy = STALE_AFTER_MS[component.id];
    if (
      policy === undefined ||
      component.status !== "healthy" ||
      component.lastSuccessAt === undefined
    ) {
      return component;
    }
    const lastSuccessMs = Date.parse(component.lastSuccessAt);
    if (Number.isNaN(lastSuccessMs) || nowMs - lastSuccessMs <= policy) {
      return component;
    }
    return {
      ...component,
      status: "degraded" as const,
      summary:
        STALE_SUMMARIES[component.id] ?? SUMMARIES[component.id].degraded ?? component.summary,
      action: GENERIC_ACTION,
    };
  });

  const anyFailed = freshened.some((c) => c.status === "failed");
  const anyDegraded = freshened.some((c) => c.status === "degraded");
  const overall: DiagnosticsOverall = anyFailed
    ? "action_required"
    : anyDegraded
      ? "degraded"
      : "healthy";

  const leadCode =
    freshened.find((c) => c.status === "failed")?.code ??
    freshened.find((c) => c.status === "degraded")?.code;
  const headline =
    (leadCode !== undefined ? HEADLINES_BY_CODE[leadCode] : undefined) ??
    OVERALL_HEADLINES[overall];

  return {
    contractVersion: CONTRACT_VERSION,
    overall,
    checkedAt,
    headline,
    components: freshened,
  };
};
