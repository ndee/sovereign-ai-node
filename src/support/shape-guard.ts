/**
 * Fail-closed shape guard.
 *
 * Runs on text that has ALREADY been through known-secret scrubbing and
 * pattern redaction. If anything shaped like a credential is still there, the
 * redactor missed it — so the caller withholds the whole artifact instead of
 * shipping it. A withheld file is listed in the manifest with the rule that
 * fired; a leaked credential cannot be un-shipped.
 *
 * The guard is deliberately stricter than the redactor:
 *
 * - it matches the high-confidence vendor prefixes WITHOUT the "not preceded
 *   by a letter" boundary the redactor uses, so `xsk-or-v1-…` or
 *   `session_syt_…`-style near misses are caught;
 * - it matches the text AND a decoded copy in which percent-escapes (`%2D`),
 *   JSON / JS escapes (`\u002d`, `\x2d`) and doubled backslashes are resolved,
 *   so an encoded key cannot slip through as a harmless-looking string.
 *
 * False positives cost a withheld file (visible, explained). False negatives
 * cost a leaked credential. The balance is intentional.
 */

interface ShapeRule {
  readonly id: string;
  readonly re: RegExp;
}

/** `(?!\[REDACTED)` keeps already-redacted assignments from tripping a rule. */
const NOT_REDACTED = String.raw`(?!\[REDACTED)`;

const SHAPE_RULES: readonly ShapeRule[] = [
  { id: "openrouter-key", re: /sk-or-v1-[A-Za-z0-9]{8,}/iu },
  { id: "anthropic-key", re: /sk-ant-[A-Za-z0-9_-]{8,}/iu },
  { id: "provider-api-key", re: /(?<![A-Za-z0-9])sk-(?:proj-)?[A-Za-z0-9_-]{20,}/u },
  { id: "matrix-access-token", re: /syt_[A-Za-z0-9_-]{8,}/u },
  { id: "github-token", re: /gh[pousr]_[A-Za-z0-9]{16,}/u },
  { id: "slack-token", re: /xox[abprs]-[A-Za-z0-9-]{10,}/u },
  { id: "aws-access-key", re: /AKIA[0-9A-Z]{16}/u },
  { id: "pem-private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
  {
    id: "npm-auth-token",
    re: new RegExp(String.raw`_auth(?:Token)?\s*=\s*${NOT_REDACTED}[^\s"']{6,}`, "iu"),
  },
  {
    id: "bearer-credential",
    re: new RegExp(String.raw`\bbearer\s+${NOT_REDACTED}[A-Za-z0-9._~+/-]{16,}`, "iu"),
  },
  {
    id: "url-userinfo",
    re: new RegExp(String.raw`[a-z][a-z0-9+.-]*://[^/\s:@]+:${NOT_REDACTED}[^/\s@]{3,}@`, "iu"),
  },
];

/**
 * Resolve the escape forms a credential can hide behind. Applied to a copy —
 * the artifact itself is never rewritten by the guard.
 */
export const decodeEscapes = (text: string): string => {
  let decoded = text.replace(/\\\\/gu, "\\");
  decoded = decoded.replace(/\\u([0-9a-fA-F]{4})/gu, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
  decoded = decoded.replace(/\\x([0-9a-fA-F]{2})/gu, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
  decoded = decoded.replace(/%([0-9a-fA-F]{2})/gu, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
  return decoded;
};

/**
 * Ids of every shape rule that matches `text` or its decoded copy. Empty
 * means the text may be shipped.
 */
export const findSecretShapes = (text: string): string[] => {
  const decoded = decodeEscapes(text);
  const candidates = decoded === text ? [text] : [text, decoded];
  const hits = new Set<string>();
  for (const rule of SHAPE_RULES) {
    if (candidates.some((candidate) => rule.re.test(candidate))) {
      hits.add(rule.id);
    }
  }
  return [...hits];
};
