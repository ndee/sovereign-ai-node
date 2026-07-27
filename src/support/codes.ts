/**
 * SAN-* error taxonomy.
 *
 * # Why this is small
 *
 * The audit (§6.3) proposed ~15 codes; this registry defines only the codes that
 * a shipped surface actually emits today. A code with no emitter is documentation
 * of an imaginary state: it cannot be tested, it drifts, and it teaches the
 * founder to look for signals the node never sends. Codes are added when the
 * emitting path is added, never in advance.
 *
 * # Single source of truth
 *
 * Every surface (CLI, Matrix, web, support bundle, playbooks) renders from this
 * registry. Nothing hardcodes an explanation. `explain <code>` is a lookup here,
 * and `docs/supportability/error-codes.md` is generated against it — a test
 * asserts the two agree, so documentation cannot silently drift from behaviour.
 *
 * # Privacy classification
 *
 * `privacy` describes what the code's *evidence* may contain, so a caller can
 * decide whether it is safe to place in a bundle or a Matrix message:
 *  - `safe`      — no user data; renderable anywhere
 *  - `technical` — host/config detail; safe locally, redact before sharing
 *  - `sensitive` — may reference mail metadata; never rendered to Matrix
 */

/** Severity of the condition the code describes. */
export type SanSeverity = "critical" | "degraded" | "warning";

/** Privacy class of the evidence associated with a code. */
export type SanPrivacy = "safe" | "technical" | "sensitive";

/** Component that emits the code. */
export type SanComponent = "mail" | "llm" | "matrix" | "imap" | "update" | "system";

export interface SanErrorDefinition {
  /** Stable identifier. Never renumbered or reused once shipped. */
  readonly id: string;
  readonly component: SanComponent;
  /** Short user-facing title. One line, no trailing period. */
  readonly title: string;
  /** Plain-language explanation of what is happening, in user terms. */
  readonly explanation: string;
  /** The most probable cause, stated concretely. */
  readonly likelyCause: string;
  /** What the partner can safely do without the founder. */
  readonly userAction: string;
  /** What the founder does with the evidence. */
  readonly supportAction: string;
  /** Whether the condition may clear on its own. */
  readonly retryable: boolean;
  readonly severity: SanSeverity;
  readonly privacy: SanPrivacy;
  /** Anchor in docs/supportability/playbooks/. */
  readonly docAnchor: string;
}

/**
 * The registry.
 *
 * Emitters, so a reviewer can confirm each code is real:
 *  - SAN-LLM-001, SAN-MAIL-001 — mail-sentinel degradation notice (bots repo)
 *  - SAN-MATRIX-003            — doctor `gateway-service-health`
 *  - SAN-IMAP-001/002          — ImapConnectionError (system/imap-client.ts)
 *  - SAN-SYSTEM-001/002        — doctor `disk-space-root`, preflight clock check
 *  - SAN-UPDATE-001            — updater status file `result: failed`
 */
export const SAN_ERRORS: readonly SanErrorDefinition[] = [
  {
    id: "SAN-LLM-001",
    component: "llm",
    title: "Classification degraded — semantic reviewer unavailable",
    explanation:
      "Mail is still being retrieved and basic rules still apply, but the semantic reviewer " +
      "is not responding, so messages are not being escalated to the red zone. You may see " +
      "fewer high-priority alerts than usual.",
    likelyCause:
      "The configured LLM provider is unreachable, out of credits, rate-limited, or the " +
      "configured model has been withdrawn.",
    userAction:
      "Check that the provider account has credits and that the configured model is still " +
      "available. The node retries automatically on the next scan.",
    supportAction:
      "Confirm provider reachability and model availability; check the provider key is still " +
      "valid. Distinguish from SAN-IMAP-* — the mailbox is fine in this state.",
    retryable: true,
    severity: "degraded",
    privacy: "safe",
    docAnchor: "mail-sentinel-stopped-alerting.md#classification-degraded",
  },
  {
    id: "SAN-MAIL-001",
    component: "mail",
    title: "Mail scans are failing",
    explanation:
      "The mailbox scan has failed several times in a row. New mail is not being examined, " +
      "so no alerts of any kind are being produced.",
    likelyCause:
      "Mailbox credentials were rejected, the mail server or Proton Bridge is unreachable, " +
      "or the stored scan state is unreadable.",
    userAction:
      "Check that the mail password or app password is still valid. If using Proton Mail, " +
      "confirm Proton Bridge is running and still signed in.",
    supportAction:
      "Read the recorded error code in the bundle's mail section; it distinguishes auth " +
      "failure from connectivity failure from corrupt state.",
    retryable: true,
    severity: "critical",
    privacy: "safe",
    docAnchor: "mail-sentinel-stopped-alerting.md#scans-failing",
  },
  {
    id: "SAN-IMAP-001",
    component: "imap",
    title: "Mailbox sign-in was rejected",
    explanation:
      "The mail server refused the stored credentials, so no mail can be read. This does not " +
      "clear by itself.",
    likelyCause:
      "The password or app password was changed or revoked, or the provider now requires an " +
      "app-specific password.",
    userAction:
      "Generate a fresh app password with your mail provider and re-enter it in the node's " +
      "settings.",
    supportAction:
      "Confirm the failure is authentication rather than connectivity before reconfiguring.",
    retryable: false,
    severity: "critical",
    privacy: "technical",
    docAnchor: "imap-authentication-failure.md",
  },
  {
    id: "SAN-IMAP-002",
    component: "imap",
    title: "Cannot reach the mail server",
    explanation:
      "The node could not open a connection to the mail server. Mail is not being read while " +
      "this persists.",
    likelyCause:
      "Network or DNS failure, the mail host or port is wrong, or Proton Bridge is not running.",
    userAction:
      "Check the node has working internet. If using Proton Mail, confirm Proton Bridge is " +
      "running on this machine.",
    supportAction:
      "Check the bridge unit state and the recorded host/port in the bundle's redacted config " +
      "summary. Unlike SAN-IMAP-001 this is retryable and often transient.",
    retryable: true,
    severity: "critical",
    privacy: "technical",
    docAnchor: "proton-bridge-unavailable.md",
  },
  {
    id: "SAN-MATRIX-003",
    component: "matrix",
    title: "Bots are not responding in Matrix",
    explanation:
      "The agent runtime is not healthy, so no bot — including the operator assistant — will " +
      "answer messages. Alerts may also stop being delivered.",
    likelyCause:
      "The Matrix homeserver was restarted without restarting the agent gateway, leaving the " +
      "gateway's sync connection orphaned. This is the most common incident on this system.",
    userAction:
      "Restart the node, or ask the founder to restart the agent gateway. Mail continues to " +
      "be collected while this is broken.",
    supportAction:
      "Restart the gateway after Synapse. Verify with a bot mention; expect a reply within " +
      "about three minutes.",
    retryable: true,
    severity: "critical",
    privacy: "safe",
    docAnchor: "bots-not-responding.md",
  },
  {
    id: "SAN-SYSTEM-001",
    component: "system",
    title: "Low disk space",
    explanation:
      "The node is running low on free disk. Below a small margin, mail scanning, the database, " +
      "and updates will all begin to fail.",
    likelyCause: "Accumulated logs, container images, or backups.",
    userAction: "Ask the founder to reclaim space before the node runs out.",
    supportAction: "Check log rotation, old backups, and unused container images.",
    retryable: false,
    severity: "warning",
    privacy: "safe",
    docAnchor: "disk-full.md",
  },
  {
    id: "SAN-SYSTEM-002",
    component: "system",
    title: "System clock is not synchronised",
    explanation:
      "The machine's clock is not confirmed against a time source. Clock drift causes TLS " +
      "connections and access tokens to be rejected, which looks like an authentication failure " +
      "in every other component.",
    likelyCause: "NTP is disabled, or the machine was offline or suspended for a long period.",
    userAction: "Ask the founder to enable time synchronisation.",
    supportAction:
      "Check this FIRST when several unrelated components report auth failures at once — it is " +
      "a common single cause behind confusing multi-component symptoms.",
    retryable: false,
    severity: "warning",
    privacy: "safe",
    docAnchor: "clock-incorrect.md",
  },
  {
    id: "SAN-UPDATE-001",
    component: "update",
    title: "The last update did not complete",
    explanation:
      "An update run ended without finishing. The node may still be running the previous " +
      "version, or may be in a partially updated state.",
    likelyCause:
      "The update was interrupted, a download failed, or a component failed verification after " +
      "installation.",
    userAction: "Do not re-run the update repeatedly. Share a support bundle with the founder.",
    supportAction:
      "Read the durable update status record for phase and exit status; recover by re-running " +
      "the updater pinned to the last known-good release.",
    retryable: true,
    severity: "critical",
    privacy: "technical",
    docAnchor: "update-failed.md",
  },
];

/** Index for O(1) lookup. Built once at module load. */
const BY_ID = new Map(SAN_ERRORS.map((definition) => [definition.id, definition]));

/**
 * Look up a code.
 *
 * Returns `undefined` for unknown codes rather than throwing: this is called
 * with operator-supplied input (`explain <code>`), and an unknown code is a
 * normal outcome to be rendered, not an exception.
 */
export const lookupSanError = (id: string): SanErrorDefinition | undefined =>
  BY_ID.get(id.trim().toUpperCase());

/** All known ids, sorted — used by docs generation and by `explain` with no argument. */
export const listSanErrorIds = (): string[] => SAN_ERRORS.map((entry) => entry.id).sort();
