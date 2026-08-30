/**
 * Allowlisted evidence collectors for the support bundle.
 *
 * # The allowlist principle
 *
 * Each collector NAMES the evidence it produces and builds a value for it. No
 * collector walks a directory, tars a config file wholesale, reads
 * `/etc/sovereign-node/secrets/**`, or runs an unfiltered `journalctl`. This is
 * the primary privacy control; `redact.ts` is a second layer for secrets that
 * arrive inside otherwise-legitimate values.
 *
 * The inverse design — dump everything and redact — is what `snapshot-node.sh`
 * does, and it is why that script cannot be given to a design partner.
 *
 * # Failure semantics
 *
 * A collector never throws. It returns a result whose status records what
 * happened, so a partial bundle is visibly partial. Silently omitting a section
 * would let the founder draw conclusions from evidence that was never collected.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { redactText, redactValue } from "./redact.js";

const execFileAsync = promisify(execFile);

/** Per-collector wall-clock bound. Diagnostics must never hang a support call. */
export const COLLECTOR_TIMEOUT_MS = 10_000;

/** Hard cap on journal lines per unit. Bounds both privacy and bundle size. */
export const JOURNAL_LINE_LIMIT = 200;

/** Cap on any single collected text artifact. */
export const MAX_ARTIFACT_BYTES = 256 * 1024;

export type CollectorStatus = "collected" | "unavailable" | "skipped" | "failed";

export interface CollectorResult {
  /** Stable artifact name; becomes the filename inside the bundle. */
  readonly name: string;
  /** Why this artifact exists, for the manifest. */
  readonly purpose: string;
  readonly status: CollectorStatus;
  /** Privacy class of the produced content. */
  readonly privacy: "safe" | "technical";
  /** JSON-serialisable content, already redacted. Absent when not collected. */
  readonly content?: unknown;
  /** Human-readable reason when status is not `collected`. */
  readonly reason?: string;
}

/** Injectable process runner so tests never touch the real system. */
export type RunCommand = (
  file: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<{ stdout: string; stderr: string }>;

/**
 * Default runner: `execFile` with a hard timeout and no shell.
 *
 * `execFile` (never `exec`) means argv is passed directly to the kernel — there
 * is no shell to interpolate into, so no argument can be turned into a command.
 * Every call site passes constant argv.
 */
export const defaultRunCommand: RunCommand = async (file, args, timeoutMs) => {
  const { stdout, stderr } = await execFileAsync(file, [...args], {
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: MAX_ARTIFACT_BYTES,
    // Deliberately no `shell` option; deliberately no inherited env beyond what
    // the parent already has (we never pass secrets as arguments or env here).
  });
  return { stdout, stderr };
};

const truncate = (value: string): string =>
  value.length > MAX_ARTIFACT_BYTES ? `${value.slice(0, MAX_ARTIFACT_BYTES)}\n…[truncated]` : value;

/**
 * Collect systemd unit state for a fixed set of units.
 *
 * Units are a compile-time constant list — a caller cannot ask for an arbitrary
 * unit, which keeps this off the path of user-controlled argv entirely.
 */
export const SUPPORTED_UNITS = [
  "sovereign-node-api",
  "sovereign-pro-api",
  "sovereign-openclaw-gateway",
  "sovereign-protonmail-bridge",
  "sovereign-matrix-relay-tunnel",
] as const;

export const collectUnitStates = async (
  run: RunCommand = defaultRunCommand,
): Promise<CollectorResult> => {
  const states: Record<string, unknown> = {};
  let anySucceeded = false;
  for (const unit of SUPPORTED_UNITS) {
    try {
      const { stdout } = await run(
        "systemctl",
        [
          "show",
          unit,
          "-p",
          // Restart counters matter: they distinguish "stopped" from "crash-looping",
          // which the audit calls out as an undiagnosable state today.
          "LoadState,ActiveState,SubState,Result,NRestarts,ExecMainStatus,UnitFileState",
        ],
        COLLECTOR_TIMEOUT_MS,
      );
      const parsed: Record<string, string> = {};
      for (const line of stdout.split("\n")) {
        const index = line.indexOf("=");
        if (index > 0) {
          parsed[line.slice(0, index)] = line.slice(index + 1).trim();
        }
      }
      states[unit] = parsed;
      anySucceeded = true;
    } catch (error) {
      states[unit] = { error: redactText(error instanceof Error ? error.message : String(error)) };
    }
  }
  return {
    name: "service-states.json",
    purpose: "systemd unit load/active/restart state for the node's services",
    status: anySucceeded ? "collected" : "unavailable",
    privacy: "safe",
    content: redactValue(states),
    ...(anySucceeded ? {} : { reason: "systemctl unavailable or no units known" }),
  };
};

/**
 * Collect a bounded, redacted journal tail for one unit.
 *
 * Journal content is the highest-risk artifact in the bundle: it is free text
 * the node does not control, it can contain anything a component logged, and it
 * is where secrets accidentally end up. Three controls apply: a hard line cap,
 * a byte cap, and full redaction including control-character stripping.
 */
export const collectJournalTail = async (
  unit: (typeof SUPPORTED_UNITS)[number],
  run: RunCommand = defaultRunCommand,
): Promise<CollectorResult> => {
  const name = `journal-${unit}.txt`;
  const purpose = `Last ${JOURNAL_LINE_LIMIT} journal lines for ${unit}, redacted`;
  try {
    const { stdout } = await run(
      "journalctl",
      [
        "-u",
        unit,
        "-n",
        String(JOURNAL_LINE_LIMIT),
        "--no-pager",
        // No --output=json: the JSON form embeds far more metadata than we need
        // and is harder to bound. Plain short form keeps the surface small.
        "--output=short-iso",
      ],
      COLLECTOR_TIMEOUT_MS,
    );
    return {
      name,
      purpose,
      status: "collected",
      privacy: "technical",
      content: truncate(redactText(stdout)),
    };
  } catch (error) {
    return {
      name,
      purpose,
      status: "unavailable",
      privacy: "technical",
      reason: redactText(
        error instanceof Error ? error.message : "journalctl unavailable or permission denied",
      ),
    };
  }
};

/**
 * Detect the "gateway orphaned by a Synapse restart" condition (audit F-03).
 *
 * This is the single most frequent documented incident: restarting the Matrix
 * homeserver without restarting the OpenClaw gateway leaves the gateway's sync
 * connection orphaned. Every bot — including node-operator, the support surface
 * itself — then syncs but never replies, which is indistinguishable from "the
 * bots are broken" unless you compare start times.
 *
 * The in-code path is already correct: `reconfigureMatrix` restarts the gateway
 * after `updateFederationConfig`. The exposure is OUT-OF-BAND restarts — a
 * `docker compose restart synapse` by hand, a container crash-loop, or a host
 * reboot that races the two units. No code path can prevent those, and the
 * gateway unit is generated by the OpenClaw CLI (outside these repos), so a
 * systemd `PartOf=` binding cannot be added here either.
 *
 * So this does not *fix* the condition — it makes it diagnosable in one glance
 * instead of a support call. `suspected: true` means Synapse started AFTER the
 * gateway, which is exactly the ordering that produces the incident.
 *
 * Deliberately reports `suspected`, not `confirmed`: a benign restart ordering
 * looks identical, and a diagnostic that overstates its certainty sends the
 * founder down the wrong path.
 */
export const collectGatewaySyncOrdering = async (
  run: RunCommand = defaultRunCommand,
): Promise<CollectorResult> => {
  const name = "gateway-sync-ordering.json";
  const purpose =
    "Relative start times of the agent gateway and the Matrix homeserver (audit F-03)";
  try {
    const { stdout: gatewayOut } = await run(
      "systemctl",
      ["show", "sovereign-openclaw-gateway", "-p", "ActiveEnterTimestamp,ActiveState"],
      COLLECTOR_TIMEOUT_MS,
    );
    const gatewayStarted = /ActiveEnterTimestamp=(.*)/u.exec(gatewayOut)?.[1]?.trim() ?? "";
    const gatewayActive = /ActiveState=(.*)/u.exec(gatewayOut)?.[1]?.trim() ?? "unknown";

    // Synapse runs in the bundled-matrix compose project, so its start time
    // comes from the container rather than from systemd.
    const { stdout: synapseOut } = await run(
      "docker",
      ["inspect", "-f", "{{.State.StartedAt}}", "synapse"],
      COLLECTOR_TIMEOUT_MS,
    );
    const synapseStarted = synapseOut.trim();

    const gatewayTime = Date.parse(gatewayStarted);
    const synapseTime = Date.parse(synapseStarted);
    const comparable = Number.isFinite(gatewayTime) && Number.isFinite(synapseTime);

    return {
      name,
      purpose,
      status: "collected",
      privacy: "safe",
      content: {
        gatewayActiveState: gatewayActive,
        gatewayStartedAt: gatewayStarted === "" ? null : gatewayStarted,
        synapseStartedAt: synapseStarted === "" ? null : synapseStarted,
        suspected: comparable && synapseTime > gatewayTime,
        note: comparable
          ? synapseTime > gatewayTime
            ? "Matrix homeserver started AFTER the agent gateway. The gateway's sync " +
              "connection may be orphaned: bots will appear online but never reply. " +
              "Restarting the gateway is the known fix (SAN-MATRIX-003)."
            : "Start order looks correct (gateway started after the homeserver)."
          : "Start times unavailable; ordering could not be determined.",
      },
    };
  } catch (error) {
    return {
      name,
      purpose,
      status: "unavailable",
      privacy: "safe",
      reason: redactText(
        error instanceof Error ? error.message : "systemctl or docker unavailable",
      ),
    };
  }
};

/** Disk and memory summary. Numbers only — no paths beyond the root filesystem. */
export const collectSystemResources = async (
  run: RunCommand = defaultRunCommand,
): Promise<CollectorResult> => {
  const content: Record<string, unknown> = {};
  try {
    const { stdout } = await run("df", ["-Pk", "/"], COLLECTOR_TIMEOUT_MS);
    const line = stdout.trim().split("\n")[1] ?? "";
    const fields = line.split(/\s+/u);
    content.rootFilesystem = {
      totalKb: Number(fields[1] ?? 0),
      usedKb: Number(fields[2] ?? 0),
      availableKb: Number(fields[3] ?? 0),
      usePercent: fields[4] ?? "unknown",
    };
  } catch {
    content.rootFilesystem = { error: "df unavailable" };
  }
  try {
    const { totalmem, freemem, loadavg } = await import("node:os");
    content.memory = { totalBytes: totalmem(), freeBytes: freemem() };
    content.loadAverage = loadavg();
  } catch {
    /* v8 ignore next -- node:os is always present; defensive only. */
    content.memory = { error: "unavailable" };
  }
  return {
    name: "system-resources.json",
    purpose: "Root filesystem capacity, memory, and load average",
    status: "collected",
    privacy: "safe",
    content: redactValue(content),
  };
};

/**
 * Clock synchronisation state.
 *
 * The audit (F-24) notes this is checked at install but absent from `doctor`.
 * It belongs in every bundle: clock drift makes TLS and token failures appear
 * across several unrelated components at once, and is otherwise a slow diagnosis.
 */
export const collectClockState = async (
  run: RunCommand = defaultRunCommand,
): Promise<CollectorResult> => {
  try {
    const { stdout } = await run(
      "timedatectl",
      ["show", "-p", "NTPSynchronized", "-p", "Timezone", "-p", "TimeUSec"],
      COLLECTOR_TIMEOUT_MS,
    );
    const parsed: Record<string, string> = {};
    for (const line of stdout.split("\n")) {
      const index = line.indexOf("=");
      if (index > 0) {
        parsed[line.slice(0, index)] = line.slice(index + 1).trim();
      }
    }
    return {
      name: "clock.json",
      purpose: "NTP synchronisation state and timezone",
      status: "collected",
      privacy: "safe",
      content: { ...(redactValue(parsed) as object), observedAt: new Date().toISOString() },
    };
  } catch (error) {
    return {
      name: "clock.json",
      purpose: "NTP synchronisation state and timezone",
      status: "unavailable",
      privacy: "safe",
      reason: redactText(error instanceof Error ? error.message : "timedatectl unavailable"),
    };
  }
};

/**
 * Reduce Mail Sentinel state to non-identifying counters.
 *
 * This is the single most privacy-sensitive input to the bundle: the state file
 * holds up to 5000 messages with subjects, sender addresses, and 500-character
 * body snippets, plus weight maps KEYED BY email address and domain.
 *
 * Rather than redacting that structure, we discard it and emit only counts,
 * zones and timestamps — the founder needs to know "is it scanning, is it
 * classifying, when did it last succeed", none of which requires message
 * content.
 *
 * # Every value here is CONSTRUCTED, never passed through
 *
 * An adversarial review found that this function previously copied several
 * fields straight from the state file (`lastPollAt`, `degradationState`,
 * `lastImapSuccessAt`, `lastError.code`) and promoted attacker-influenceable
 * `zone` strings to output object KEYS. A crafted or merely corrupt state file
 * therefore leaked email body text, addresses and credentials into the bundle
 * while it still reported `complete: true`.
 *
 * That was possible because this is the one collector whose input is not
 * schema-validated: `support-bundle.ts` does a bare `JSON.parse` of the state
 * file, and Mail Sentinel's own loader only checks `Array.isArray` — `zone` is
 * a compile-time union with no runtime enforcement. So the input must be
 * treated as hostile.
 *
 * Two rules now hold, and both are load-bearing:
 *
 *  1. **Zones are allowlisted**, not counted by whatever string appears.
 *     Anything unrecognised is tallied under `other`, which also bounds
 *     cardinality (an unbounded key space could inflate or abort the bundle).
 *  2. **Scalars are type-guarded and redacted**, never `?? null`-passed. A
 *     field that should hold a timestamp but holds an object or a token is
 *     reported as `null`, not echoed.
 *
 * Wrapping the result in `redactValue` was considered and is NOT sufficient on
 * its own: it rewrites values but not arbitrary keys, so body text inside a
 * zone name would survive — and it would corrupt `scoredSenderCount` into a
 * PII marker, since "sender" matches a PII key fragment. Construction is the
 * control; redaction of the free-text `message` field is the second layer.
 */
/**
 * Zones Mail Sentinel actually assigns; anything else is counted as `other`.
 *
 * Mirrors `Zone` in `sovereign-ai-bots` (`bots/mail-sentinel/src/types.ts:1`).
 * Kept as a literal rather than imported because this repo does not depend on
 * the bots package. A future zone would degrade to `other` — safe, and visible.
 */
const KNOWN_ZONES = ["gray", "amber", "red"] as const;

/**
 * Degradation states the health module emits; anything else becomes `unknown`.
 *
 * Mirrors `DegradationState`
 * (`sovereign-ai-bots/bots/mail-sentinel/src/health/degradation.ts:27`).
 */
const KNOWN_DEGRADATION_STATES = ["healthy", "classification-degraded", "scans-failing"] as const;

/**
 * Accept a value only if it looks like an ISO-8601 timestamp.
 *
 * The founder needs "when did this last succeed"; a value that is not a
 * timestamp cannot answer that, so echoing it has no diagnostic upside and an
 * unbounded privacy downside.
 */
const safeTimestamp = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length > 40) {
    return null;
  }
  return Number.isFinite(Date.parse(value)) ? value : null;
};

/** Accept a finite non-negative integer, or report nothing. */
const safeCount = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;

/** Accept only a known degradation state. */
const safeDegradationState = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  return (KNOWN_DEGRADATION_STATES as readonly string[]).includes(value) ? value : "unknown";
};

/**
 * Bound and redact an error code.
 *
 * Codes are conventionally `SCREAMING_SNAKE`, but this one comes from an
 * unvalidated file, so it is treated as free text: redacted, then truncated.
 */
const safeCode = (value: unknown): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "unknown";
  }
  return redactText(value).slice(0, 80);
};

export const summarizeMailState = (state: unknown): CollectorResult => {
  const name = "mail-sentinel-summary.json";
  const purpose = "Mail Sentinel activity counters, zones and timestamps — no message content";
  if (typeof state !== "object" || state === null) {
    return {
      name,
      purpose,
      status: "unavailable",
      privacy: "safe",
      reason: "state file absent or unreadable",
    };
  }
  const record = state as Record<string, unknown>;
  const countOf = (value: unknown): number =>
    Array.isArray(value)
      ? value.length
      : typeof value === "object" && value !== null
        ? Object.keys(value).length
        : 0;

  // Counted with a null-prototype map so a zone named "constructor" or
  // "__proto__" cannot reach Object.prototype through the `?? 0` lookup.
  const zoneCounts: Record<string, number> = Object.create(null) as Record<string, number>;
  const alerts = record.alerts;
  if (Array.isArray(alerts)) {
    for (const alert of alerts) {
      if (typeof alert === "object" && alert !== null) {
        const zone = (alert as { zone?: unknown }).zone;
        // Allowlist: an unrecognised zone is tallied, never echoed as a key.
        const bucket =
          typeof zone === "string" && (KNOWN_ZONES as readonly string[]).includes(zone)
            ? zone
            : "other";
        zoneCounts[bucket] = (zoneCounts[bucket] ?? 0) + 1;
      }
    }
  }

  const lastError = record.lastError;
  const errorSummary =
    typeof lastError === "object" && lastError !== null
      ? {
          // The code is the diagnostic value, but it is still a string from an
          // unvalidated file: bound and redact it rather than trusting that it
          // looks like an identifier.
          code: safeCode((lastError as { code?: unknown }).code),
          retryable: Boolean((lastError as { retryable?: unknown }).retryable),
          // Free text that has previously contained addresses and credentials.
          // Redacted rather than dropped — "certificate expired" is genuinely
          // useful to a founder.
          message: redactText(
            typeof (lastError as { message?: unknown }).message === "string"
              ? (lastError as { message: string }).message
              : "",
          ),
        }
      : null;

  return {
    name,
    purpose,
    status: "collected",
    privacy: "safe",
    content: {
      messageCount: countOf(record.messages),
      alertCount: countOf(record.alerts),
      feedbackCount: countOf(record.feedback),
      zoneHistoryCount: countOf(record.zoneHistory),
      zoneCounts,
      // Cardinality only — the maps themselves are keyed by address/domain.
      scoredSenderCount: countOf(
        (record.learning as { senderWeights?: unknown } | undefined)?.senderWeights,
      ),
      scoredDomainCount: countOf(
        (record.learning as { domainWeights?: unknown } | undefined)?.domainWeights,
      ),
      // Type-guarded, never passed through. A field holding something other
      // than its declared type is reported as null rather than echoed.
      lastPollAt: safeTimestamp(record.lastPollAt),
      lastAlertAt: safeTimestamp(record.lastAlertAt),
      lastImapSuccessAt: safeTimestamp(record.lastImapSuccessAt),
      consecutiveFailures: safeCount(record.consecutiveFailures),
      lastScanLlmFailures: safeCount(record.lastScanLlmFailures),
      degradationState: safeDegradationState(record.degradationState),
      lastError: errorSummary,
    },
  };
};
