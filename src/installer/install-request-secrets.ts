import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import type { InstallRequest } from "../contracts/index.js";

const IMAP_SECRET_FILE_NAME = "imap-password";
const OPENROUTER_SECRET_FILE_NAME = "openrouter-api-key";

const DEFAULT_KEEP_NEWEST = 20;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TERMINAL_JOB_STATES = new Set(["succeeded", "failed", "canceled"]);

/**
 * Every field of `InstallRequest` that can carry an inline secret value, as a
 * `"<section>.<path>"` key. This list is the contract this module is checked
 * against: `install-request-secrets.test.ts` walks the `InstallRequest` schema
 * and fails when a secret-ish field exists that is not named here, so a new
 * credential field cannot be added to the contract and silently persisted in
 * cleartext. Adding a key here without handling it in
 * `redactInstallRequestSecrets` also fails that test.
 *
 * Two redaction shapes exist, because the request contract models the two
 * groups differently:
 *
 *  - `replaced`: the field has a `secretRef` sibling in the contract and the
 *    installer materializes the value into the managed secrets dir, so the
 *    inline value is swapped for the matching `file:` ref and a re-run from
 *    the persisted request resolves it.
 *  - `dropped`: the field has NO secretRef sibling — the contract types it as
 *    a plaintext string only. Writing a `file:` ref into it would store a ref
 *    string where consumers expect a live credential, so the field is removed
 *    outright. Every such field is re-derived on re-run from the runtime
 *    config's own `tokenSecretRef` entries (see below), so dropping is lossless.
 */
export const INSTALL_REQUEST_SECRET_FIELDS = {
  "imap.password": "replaced",
  "openrouter.apiKey": "replaced",
  "operator.password": "dropped",
  // Relay credentials. None of these has a secretRef sibling in the request
  // contract, and none is read back out of the persisted request on a re-run:
  //  - `relay.tunnel.token` and `relay.dns01.token` are re-resolved from
  //    `runtimeConfig.relay.tunnel.tokenSecretRef` / `relay.dns01.tokenSecretRef`
  //    when the installer reuses an existing enrollment.
  //  - `relay.enrollmentToken` is a one-shot bearer token presented to the
  //    relay's enroll endpoint; a reused enrollment never re-presents it, and
  //    it is never written to a secret file, so a `file:` ref would dangle.
  "relay.enrollmentToken": "dropped",
  "relay.tunnel.token": "dropped",
  "relay.dns01.token": "dropped",
} as const satisfies Record<string, "replaced" | "dropped">;

export type InstallRequestSecretField = keyof typeof INSTALL_REQUEST_SECRET_FIELDS;

/**
 * Returns a copy of the install request with every inline secret removed so
 * the request can be persisted (install job records, the saved install
 * request) without leaking credentials to disk. Inline values that the
 * installer materializes into the managed secrets directory are replaced by
 * the matching `file:` secretRef so a re-run from the persisted request keeps
 * working; credentials with no secretRef form are dropped.
 *
 * Every field handled here is listed in `INSTALL_REQUEST_SECRET_FIELDS`, which
 * is enforced against the contract by tests.
 */
export function redactInstallRequestSecrets(
  request: InstallRequest,
  options: { secretsDir: string },
): InstallRequest {
  const redacted: InstallRequest = structuredClone(request);

  if (redacted.imap !== undefined) {
    const { password: _password, ...imap } = redacted.imap;
    redacted.imap = {
      ...imap,
      secretRef: imap.secretRef ?? `file:${join(options.secretsDir, IMAP_SECRET_FILE_NAME)}`,
    };
  }

  const { apiKey: _apiKey, ...openrouter } = redacted.openrouter;
  redacted.openrouter = {
    ...openrouter,
    secretRef:
      openrouter.secretRef ?? `file:${join(options.secretsDir, OPENROUTER_SECRET_FILE_NAME)}`,
  };

  const { password: _operatorPassword, ...operator } = redacted.operator;
  redacted.operator = operator;

  if (redacted.relay !== undefined) {
    const { enrollmentToken: _enrollmentToken, tunnel, dns01, ...relay } = redacted.relay;
    // `tunnel.token` is required by the request contract, so a redacted tunnel
    // is deliberately not a valid `relay.tunnel` any more: a consumer that
    // needs the token must resolve it from the runtime config's
    // `tokenSecretRef`, not from the persisted request. `tryUsePreEnrolledRelay`
    // already treats a tunnel without a token as "not pre-enrolled" and falls
    // through to that path.
    const redactedRelay: InstallRequest["relay"] & Record<string, unknown> = { ...relay };
    if (tunnel !== undefined) {
      const { token: _tunnelToken, ...tunnelWithoutToken } = tunnel;
      redactedRelay.tunnel = tunnelWithoutToken as typeof tunnel;
    }
    if (dns01 !== undefined) {
      const { token: _dns01Token, ...dns01WithoutToken } = dns01;
      redactedRelay.dns01 = dns01WithoutToken;
    }
    redacted.relay = redactedRelay;
  }

  return redacted;
}

/**
 * Deletes finished install job records that are older than `maxAgeMs` or
 * that fall outside the `keepNewest` most recent records. Records for jobs
 * that are still pending/running and the record named by `protectJobId` are
 * always kept. Returns the job ids whose records were removed.
 */
export async function pruneInstallJobRecords(
  dir: string,
  options: {
    now?: (() => number) | undefined;
    keepNewest?: number | undefined;
    maxAgeMs?: number | undefined;
    protectJobId?: string | undefined;
  } = {},
): Promise<string[]> {
  const now = options.now ?? Date.now;
  const keepNewest = options.keepNewest ?? DEFAULT_KEEP_NEWEST;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const records: Array<{ jobId: string; path: string; mtimeMs: number }> = [];
  for (const name of entries) {
    if (!name.startsWith("job_") || !name.endsWith(".json")) {
      continue;
    }
    const path = join(dir, name);
    const info = await stat(path);
    records.push({ jobId: name.slice(0, -".json".length), path, mtimeMs: info.mtimeMs });
  }
  records.sort((left, right) => right.mtimeMs - left.mtimeMs);

  const removed: string[] = [];
  const cutoff = now() - maxAgeMs;
  for (const [index, record] of records.entries()) {
    if (record.jobId === options.protectJobId) {
      continue;
    }
    if (index < keepNewest && record.mtimeMs >= cutoff) {
      continue;
    }
    if (await isActiveJobRecord(record.path)) {
      continue;
    }
    await rm(record.path, { force: true });
    removed.push(record.jobId);
  }
  return removed;
}

async function isActiveJobRecord(path: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as {
      response?: { job?: { state?: string } };
    };
    const state = parsed.response?.job?.state;
    return typeof state === "string" && !TERMINAL_JOB_STATES.has(state);
  } catch {
    // Unreadable records carry no recoverable state; treat them as prunable.
    return false;
  }
}
