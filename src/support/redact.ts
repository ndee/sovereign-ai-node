/**
 * Redaction engine for diagnostic output.
 *
 * # Threat model
 *
 * This module is the LAST line of defence, not the first. The support bundle
 * builds its contents by allowlist (see `collectors.ts`): every value in a
 * bundle is one a collector deliberately produced, and secret-bearing files
 * (`/etc/sovereign-node/secrets/**`, env files, tokens) are never read at all.
 * Redaction exists to catch secrets that arrive *inside* otherwise-legitimate
 * values — an API key echoed into a log line, a token in an error message, a
 * password in a connection URL.
 *
 * Attempting to redact an unrestricted filesystem dump is unbounded work with an
 * unbounded failure mode; we do not do that, and callers must not use this
 * module to justify collecting something risky.
 *
 * # Why redaction is key-aware
 *
 * Mail Sentinel stores `learning.senderWeights` and `learning.domainWeights` as
 * `Record<string, number>` KEYED BY EMAIL ADDRESS AND DOMAIN. A redactor that
 * walked only values would faithfully preserve every sender the node has ever
 * scored. So `redactValue` rewrites keys as well as values, and structured
 * collectors additionally reduce those maps to counts before they ever reach
 * this module (defence in depth).
 *
 * # Ordering
 *
 * Pattern order matters. Assignment-style rules run before free-standing token
 * rules so that `password=hunter2` redacts the value rather than being partially
 * consumed by a looser rule, and multi-line continuations are folded before
 * single-line rules run.
 */

/** Marker written in place of a redacted secret. Stable, greppable, and never a valid secret. */
export const REDACTED = "[REDACTED]";

/** Marker for a value withheld because it is personal data rather than a secret. */
export const REDACTED_PII = "[REDACTED:PII]";

/**
 * Upper bound on any single redacted string.
 *
 * Log lines from a compromised or merely broken component can be arbitrarily
 * long; a diagnostic path must not become a memory amplifier.
 */
export const MAX_VALUE_LENGTH = 8_000;

/** Depth bound for structural walks — guards against hostile/cyclic nesting. */
const MAX_DEPTH = 12;

/**
 * Key names whose values are always secret, matched case-insensitively as a
 * substring of the key.
 *
 * Substring matching is deliberate: `openrouterApiKey`, `OPENROUTER_API_KEY`
 * and `imap_password` must all match without enumerating every spelling.
 */
const SECRET_KEY_FRAGMENTS = [
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "api_key",
  "accesskey",
  "access_key",
  "privatekey",
  "private_key",
  "credential",
  "authorization",
  "auth_header",
  "sessionid",
  "session_id",
  "cookie",
  "activationcode",
  "activation_code",
  "claimcode",
  "claim_code",
  "bootstraptoken",
  "signingkey",
  "passphrase",
  "salt",
] as const;

/**
 * Key names whose values are personal data rather than credentials.
 *
 * Kept separate from secrets so the manifest can report *why* something was
 * withheld, and so a reviewer can tell a leak-class bug from a privacy-class one.
 */
const PII_KEY_FRAGMENTS = [
  "subject",
  "snippet",
  "excerpt",
  "body",
  "sender",
  "fromaddress",
  "from_address",
  "toaddress",
  "to_address",
  "recipient",
  "emailaddress",
  "email_address",
  "mailfrom",
  "messageid",
  "message_id",
] as const;

/**
 * Compare a key against a fragment list with separators removed from BOTH sides.
 *
 * Normalizing only the fragment (and leaving `_` in the key) silently defeats
 * every multi-word fragment: `api_key` normalizes to `apikey`, which is not a
 * substring of `openrouter_api_key`, so `OPENROUTER_API_KEY` — the single most
 * likely secret-bearing key on this system — was not matched at all. Both sides
 * must be normalized identically.
 */
const stripSeparators = (value: string): string => value.toLowerCase().replace(/[-_\s]/gu, "");

const containsFragment = (key: string, fragments: readonly string[]): boolean => {
  const normalized = stripSeparators(key);
  return fragments.some((fragment) => normalized.includes(stripSeparators(fragment)));
};

/** True when a key's value must be treated as a credential. */
export const isSecretKey = (key: string): boolean => containsFragment(key, SECRET_KEY_FRAGMENTS);

/** True when a key's value must be treated as personal data. */
export const isPiiKey = (key: string): boolean => containsFragment(key, PII_KEY_FRAGMENTS);

/**
 * An email address anywhere in free text.
 *
 * Applied to *values*, and also used to detect address-shaped object KEYS,
 * which is the sender-weight leak described in the module header.
 *
 * # Why the quantifiers are bounded
 *
 * The unbounded form `[A-Za-z0-9._%+-]+@…` backtracks catastrophically on long
 * runs of local-part-legal characters with no `@` to anchor on — which is
 * exactly what a journal tail is. Cost grew quadratically: 64 KiB took 2s,
 * 256 KiB took 32s, and 512 KiB took over two minutes, on a path that runs over
 * up to `MAX_ARTIFACT_BYTES` of attacker-influenceable log text for every unit
 * in the bundle. Bounding each segment to its RFC 5321 maximum (64 for the local
 * part, 63 per label) caps the work the engine can do per starting position and
 * brings 512 KiB down to under 100ms, with no change to which addresses match.
 */
const EMAIL_RE =
  /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*\.[A-Za-z]{2,24}/gu;

/**
 * A bare hostname/domain used as an object KEY.
 *
 * Mail Sentinel's `learning.domainWeights` is keyed by correspondent domain,
 * which is identifying even without a local part ("this node talks to
 * acme-competitor.com"). Applied to keys only — matching bare domains inside
 * free text would destroy genuinely useful diagnostics like `imap.gmail.com`
 * in a connection error.
 */
const DOMAIN_KEY_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/u;

/**
 * Pattern rules applied to free text, in order.
 *
 * Each rule must anchor on structure (an assignment, a scheme, a header name)
 * rather than on the shape of the secret itself. Matching "a long random-looking
 * string" produces false positives on hashes, UUIDs and base64 payloads that are
 * genuinely useful in diagnostics.
 */
const TEXT_RULES: readonly { readonly id: string; readonly re: RegExp; readonly to: string }[] = [
  // Secrets in query strings: ?token=..., &api_key=...
  //
  // MUST run before the assignment rule. The assignment rule's unquoted-value
  // branch matches every non-space character, so on `?token=abc&since=42` it
  // consumes the trailing `&since=42` too — the secret is still removed, but the
  // surrounding diagnostic parameters are destroyed with it. Anchoring on the
  // query separator first keeps the rest of the URL intact.
  {
    id: "url-query-secret",
    re: /([?&](?:password|passwd|secret|token|api[_-]?key|access[_-]?key|code|auth)=)[^&\s"']+/giu,
    to: `$1${REDACTED}`,
  },
  // Multi-line continuation: `KEY=value \<newline> more`. Folded first so the
  // single-line assignment rule below sees the whole logical value.
  //
  // The optional quote before the separator matches JSON object syntax
  // (`"token": "value"`), which is how most of this system's logs render
  // structured data — without it, every secret in a serialized JSON log line
  // passed through untouched.
  //
  // The unquoted-value branch excludes `&` so that a value already handled by
  // the query rule above is not re-consumed together with the query parameters
  // that follow it. `&` never appears in a bare shell/env assignment value
  // without quoting, so excluding it costs nothing on the shapes this targets.
  {
    id: "assignment-continuation",
    re: /(["']?(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|passphrase)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|(?:[^\s\\&]|\\\r?\n)+)/giu,
    to: `$1${REDACTED}`,
  },
  // Secret words followed by a space-separated value in prose, e.g. a log line
  // reading `login failed with password hunter2`. Narrower than the assignment
  // rule on purpose: it requires the very next token, so ordinary sentences
  // ("the password was rejected") keep their meaning while the value is lost.
  // Stop-words prevent eating the verb in phrases like `token is invalid`.
  {
    id: "secret-word-adjacent",
    re: /\b(password|passwd|passphrase|secret|token|api[_-]?key)\s+(?!(?:is|was|are|were|not|invalid|expired|missing|required|rejected|failed|for|from|to|in|on)\b)(?:"[^"]*"|'[^']*'|\S+)/giu,
    to: `$1 ${REDACTED}`,
  },
  // `Authorization: Bearer xyz`, `Authorization: Basic xyz`, and bare bearer tokens.
  {
    id: "authorization-header",
    re: /(authorization\s*[:=]\s*)(?:bearer|basic|token)?\s*\S+/giu,
    to: `$1${REDACTED}`,
  },
  {
    id: "bearer-token",
    re: /\bbearer\s+[A-Za-z0-9._~+/-]+=*/giu,
    to: `bearer ${REDACTED}`,
  },
  // Vendor token prefixes.
  //
  // These use a negative lookbehind for an alphanumeric rather than `\b`.
  // `\b` does NOT fire between `_` and `s`, because both are word characters —
  // so `CODE_WITH_secret_sk-or-v1-…` and `session_syt_…` passed through
  // completely unredacted. Secrets embedded in identifiers, log keys and file
  // names are exactly the shapes that reach a diagnostic bundle, so the
  // boundary must be "not preceded by alphanumeric", which still permits `_`
  // and `-` immediately before the prefix.
  //
  // Matrix access tokens have a stable, documented prefix.
  {
    id: "matrix-access-token",
    re: /(?<![A-Za-z0-9])syt_[A-Za-z0-9_-]+/gu,
    to: REDACTED,
  },
  // OpenRouter / OpenAI-style keys.
  {
    id: "provider-api-key",
    re: /(?<![A-Za-z0-9])sk-(?:or-)?[A-Za-z0-9_-]{8,}/giu,
    to: REDACTED,
  },
  // GitHub PATs (SD images historically baked one in — see audit F-23).
  {
    id: "github-token",
    re: /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{16,}/gu,
    to: REDACTED,
  },
  // Credentials embedded in a URL authority: scheme://user:pass@host
  {
    id: "url-userinfo",
    re: /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/giu,
    to: `$1${REDACTED}@`,
  },
  // PEM private key blocks, collapsed whole. The armor is assembled at
  // runtime so the BUILT bundle never contains the literal marker: the Pro
  // release pipeline's secret scan (build-release-bundle.sh) greps every
  // shipped file for the five-dash BEGIN/PRIVATE KEY armor, and a detector
  // that ships its own trigger string would fail every release build.
  {
    id: "pem-private-key",
    re: new RegExp(
      `${"-".repeat(5)}BEGIN [A-Z ]*PRIVATE KEY${"-".repeat(5)}[\\s\\S]*?${"-".repeat(5)}END [A-Z ]*PRIVATE KEY${"-".repeat(5)}`,
      "gu",
    ),
    to: REDACTED,
  },
];

/**
 * Strip ANSI escapes and C0/C1 control characters except tab and newline.
 *
 * `noControlCharactersInRegex` is suppressed below deliberately and narrowly:
 * matching control characters is precisely this function's job. The lint rule
 * exists to catch them appearing in a pattern by accident, which is the
 * opposite of the case here. Journal and subprocess output is
 * attacker-influenceable, so without this a crafted log line could move the
 * cursor, clear the screen, or retitle the window of any terminal that displays
 * a bundle. Rewriting these patterns to satisfy the linter would remove a real
 * security control rather than improve one.
 */
export const stripControlCharacters = (value: string): string =>
  value
    // ANSI CSI sequences (ESC [ ... final byte): log content is
    // attacker-influenceable and must not be able to move the cursor, clear the
    // screen, or recolour a founder's terminal when a bundle is catted.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is this function's purpose
    .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/gu, "")
    // OSC sequences (ESC ] ... BEL or ST) — these can retitle a terminal window.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is this function's purpose
    .replace(/\u001B\][\s\S]*?(?:\u0007|\u001B\\)/gu, "")
    // Remaining two-byte escape sequences (ESC + single final byte).
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is this function's purpose
    .replace(/\u001B[@-Z\\-_]/gu, "")
    // C0 controls except tab and newline, plus DEL and the C1 range.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is this function's purpose
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/gu, "");

export interface RedactTextOptions {
  /** Replace email addresses with a PII marker. Default true. */
  readonly redactEmails?: boolean;
}

/**
 * Redact free text: strip control characters, apply pattern rules, bound length.
 *
 * Always run this on anything sourced from a log, an error message, or a
 * subprocess — i.e. anything whose content we do not fully control.
 */
export const redactText = (input: string, options: RedactTextOptions = {}): string => {
  const redactEmails = options.redactEmails ?? true;
  let value = stripControlCharacters(input);

  for (const rule of TEXT_RULES) {
    // Rules carry the global flag; reset lastIndex so a shared regex object
    // cannot leak match state between calls.
    rule.re.lastIndex = 0;
    value = value.replace(rule.re, rule.to);
  }

  if (redactEmails) {
    EMAIL_RE.lastIndex = 0;
    value = value.replace(EMAIL_RE, REDACTED_PII);
  }

  if (value.length > MAX_VALUE_LENGTH) {
    value = `${value.slice(0, MAX_VALUE_LENGTH)}…[truncated]`;
  }
  return value;
};

/**
 * Redact an arbitrary JSON-like value, rewriting both keys and values.
 *
 * Key handling is the important part:
 *  - a secret-named key has its value replaced wholesale, whatever the type
 *    (a number-valued `token` is still a token);
 *  - a PII-named key has its value replaced with the PII marker;
 *  - an address-shaped KEY is itself rewritten, which is what stops the
 *    sender-weight map from leaking.
 *
 * Cycles and excessive depth collapse to a marker rather than throwing: this
 * runs on a diagnostic path that must not fail because state was odd.
 */
export const redactValue = (input: unknown, depth = 0, seen = new WeakSet<object>()): unknown => {
  if (depth > MAX_DEPTH) {
    return "[REDACTED:DEPTH]";
  }
  if (input === null || input === undefined) {
    return input;
  }
  if (typeof input === "string") {
    return redactText(input);
  }
  if (typeof input === "number" || typeof input === "boolean") {
    return input;
  }
  if (typeof input === "bigint") {
    return input.toString();
  }
  if (typeof input === "function" || typeof input === "symbol") {
    return "[REDACTED:UNSUPPORTED]";
  }

  if (typeof input === "object") {
    if (seen.has(input)) {
      return "[REDACTED:CYCLE]";
    }
    // Tracks ANCESTORS, not every object ever visited. The set is unwound in
    // the `finally` below so that a DAG — the same object referenced twice
    // without a cycle — is rendered both times instead of the second
    // occurrence silently becoming a marker. That distinction matters on a
    // diagnostic path: a founder reads an absent section as absent data, not
    // as a redactor artifact.
    seen.add(input);
    try {
      return redactObjectOrArray(input, depth, seen);
    } finally {
      seen.delete(input);
    }
  }

  /* v8 ignore next 2 -- exhaustive: every typeof branch is handled above. */
  return "[REDACTED:UNSUPPORTED]";
};

/** Structural half of `redactValue`, split out so cycle bookkeeping stays clear. */
const redactObjectOrArray = (input: object, depth: number, seen: WeakSet<object>): unknown => {
  {
    if (Array.isArray(input)) {
      return input.map((entry) => redactValue(entry, depth + 1, seen));
    }

    const output: Record<string, unknown> = {};
    // Address- and domain-shaped keys are themselves identifying (Mail
    // Sentinel's sender/domain weight maps are keyed by them). Collapsing each
    // one to the same marker key would silently merge them and lose the only
    // useful signal — how many correspondents the node has scored — so count
    // them and emit a single cardinality entry instead.
    let identifyingKeyCount = 0;
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      EMAIL_RE.lastIndex = 0;
      if (EMAIL_RE.test(key) || DOMAIN_KEY_RE.test(key)) {
        identifyingKeyCount += 1;
        continue;
      }
      if (isSecretKey(key)) {
        output[key] = REDACTED;
        continue;
      }
      if (isPiiKey(key)) {
        output[key] = REDACTED_PII;
        continue;
      }
      output[key] = redactValue(value, depth + 1, seen);
    }
    if (identifyingKeyCount > 0) {
      output[REDACTED_PII] = `${identifyingKeyCount} identifying key(s) withheld`;
    }
    return output;
  }
};

/**
 * Summary of what a redaction pass changed, for the bundle manifest.
 *
 * The founder needs to know a file was redacted and roughly how much, without
 * the summary itself becoming a side channel that reveals the secret.
 */
export interface RedactionSummary {
  readonly secretsRedacted: number;
  readonly piiRedacted: number;
}

/** Count redaction markers in already-redacted output. */
export const summarizeRedactions = (redacted: string): RedactionSummary => ({
  secretsRedacted: redacted.split(REDACTED).length - 1,
  piiRedacted: redacted.split(REDACTED_PII).length - 1,
});
