import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import type { InstallRequest } from "../contracts/index.js";

const IMAP_SECRET_FILE_NAME = "imap-password";
const OPENROUTER_SECRET_FILE_NAME = "openrouter-api-key";

const DEFAULT_KEEP_NEWEST = 20;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TERMINAL_JOB_STATES = new Set(["succeeded", "failed", "canceled"]);

/**
 * Returns a copy of the install request with every inline secret removed so
 * the request can be persisted (install job records, the saved install
 * request) without leaking credentials to disk. Inline values that the
 * installer materializes into the managed secrets directory are replaced by
 * the matching `file:` secretRef so a re-run from the persisted request keeps
 * working.
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
