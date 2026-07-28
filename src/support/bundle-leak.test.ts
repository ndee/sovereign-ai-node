/**
 * End-to-end secret-leak regression test.
 *
 * Unit tests assert that individual functions redact. This test asserts the
 * property that actually matters: after the whole pipeline runs and a real
 * `tar` archive is written to disk, planted sentinel values are absent from
 * both the extracted files AND the raw compressed bytes.
 *
 * It is deliberately end-to-end rather than mocked. A redaction bug that only
 * manifests in composition — a collector that bypasses `redactValue`, a new
 * artifact added without redaction, a manifest field that echoes input — would
 * pass every unit test and fail here. That is precisely the class of bug that
 * would put a design partner's mail or credentials in the founder's inbox.
 *
 * The negative control below is load-bearing: it proves the assertion is
 * capable of failing. Without it, a bug that made the search itself vacuous
 * (wrong path, empty file list) would render every other assertion here
 * meaningless while still reporting green.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { generateSupportBundle } from "./bundle.js";
import type { RunCommand } from "./collectors.js";
import { buildVersionInventory } from "./version-inventory.js";

const execFileAsync = promisify(execFile);

/** Fake secrets. If any of these reaches an artifact, the bundle is unsafe. */
const SENTINELS = {
  openrouter: "TEST_OPENROUTER_SECRET_DO_NOT_LEAK",
  matrix: "TEST_MATRIX_TOKEN_DO_NOT_LEAK",
  imap: "TEST_IMAP_PASSWORD_DO_NOT_LEAK",
  activation: "TEST_ACTIVATION_CODE_DO_NOT_LEAK",
  emailBody: "TEST_EMAIL_BODY_DO_NOT_LEAK",
  emailAddress: "victim.person@private-domain.example",
} as const;

const S = SENTINELS;

/**
 * Mail Sentinel state with PII in every shape the real schema allows —
 * including sender/domain WEIGHT MAP KEYS, which a value-only redactor misses.
 */
const mailStateWithPii = {
  version: 3,
  lastPollAt: "2026-07-27T08:00:00Z",
  // Scalars that were previously copied straight out of the state file.
  lastImapSuccessAt: S.matrix,
  lastAlertAt: { nested: `OPENROUTER_API_KEY=${S.openrouter}` },
  consecutiveFailures: 2,
  lastScanLlmFailures: 4,
  degradationState: `llm key ${S.openrouter} rejected`,
  lastError: {
    code: "IMAP_AUTH_FAILED",
    message: `login failed for ${S.emailAddress} password ${S.imap}`,
    retryable: false,
  },
  messages: Object.fromEntries(
    [1, 2, 3].map((index) => [
      `k${index}`,
      {
        key: `k${index}`,
        uid: index,
        subject: `Invoice ${index} ${S.emailBody}`,
        from: `Sender <${S.emailAddress}>`,
        fromAddress: S.emailAddress,
        domain: "private-domain.example",
        snippet: `body text ${S.emailBody} more`,
        toAddresses: [S.emailAddress],
        messageId: `<msg-${index}@private-domain.example>`,
      },
    ]),
  ),
  alerts: [
    // An adversarial review showed the original fixture only planted PII in
    // fields summarizeMailState DISCARDS, so it passed while a real leak
    // existed. These two plant markers where the leak actually was: in the
    // `zone` string, which became an OUTPUT OBJECT KEY.
    { alertId: "hostile-1", zone: `red: ${S.emailBody}` },
    { alertId: "hostile-2", zone: S.emailAddress },
    {
      alertId: "a1",
      zone: "red",
      subject: `URGENT ${S.emailBody}`,
      from: S.emailAddress,
      why: `mentions ${S.emailBody}`,
      excerpt: S.emailBody,
      llmResult: { reason: `about ${S.emailBody}`, suggestedZone: "red" },
    },
  ],
  learning: {
    senderWeights: { [S.emailAddress]: 5, "boss@corp.example": 3 },
    domainWeights: { "private-domain.example": 2 },
  },
  zoneHistory: [{ at: "2026-07-27T08:00:00Z", messageKey: "k1", zone: "red", reason: S.emailBody }],
};

/** Doctor and status payloads carrying credentials the way real ones might. */
const doctorReportWithSecrets = {
  overall: "warn",
  checks: [
    { id: "gateway", status: "warn", message: `probe failed: Bearer ${S.matrix}` },
    { id: "env", status: "pass", details: { OPENROUTER_API_KEY: S.openrouter } },
  ],
  suggestedCommands: [
    `curl -H 'Authorization: Bearer ${S.matrix}' https://x/api?code=${S.activation}`,
  ],
};

const statusWithSecrets = {
  matrix: {
    accessToken: S.matrix,
    homeserverUrl: `https://user:${S.imap}@matrix.example`,
  },
  imap: { host: "imap.example", password: S.imap, username: S.emailAddress },
  activationCode: S.activation,
};

/**
 * Fake the system probes, but let the REAL `tar` run.
 *
 * Stubbing tar too would mean testing a bundle that was never actually
 * archived — the compressed bytes are part of what we are asserting about.
 */
const runWithHostileOutput: RunCommand = async (file, args, timeoutMs) => {
  if (file === "tar") {
    return await execFileAsync(file, [...args], { timeout: timeoutMs });
  }
  return {
    stdout:
      file === "journalctl"
        ? `2026-07-27 ERROR api_key=${S.openrouter} for ${S.emailAddress}\nBearer ${S.matrix}`
        : "Key=value\n",
    stderr: "",
  };
};

const createdDirs: string[] = [];

const makeBundle = async (): Promise<{ archivePath: string; extractDir: string }> => {
  const outputDir = await mkdtemp(join(tmpdir(), "bundle-leak-"));
  createdDirs.push(outputDir);
  const result = await generateSupportBundle(outputDir, {
    inventory: buildVersionInventory({ provenance: null, contractVersion: "2.0.0" }),
    doctorReport: doctorReportWithSecrets,
    status: statusWithSecrets,
    mailState: mailStateWithPii,
    updateStatus: { result: "failed", errorSummary: `token ${S.matrix}` },
    run: runWithHostileOutput,
  });
  const extractDir = join(outputDir, "extracted");
  await mkdir(extractDir);
  await execFileAsync("tar", ["-xzf", result.path, "-C", extractDir]);
  return { archivePath: result.path, extractDir };
};

/** Every place a leak could surface: extracted files plus raw archive bytes. */
const gatherSearchableContent = async (
  archivePath: string,
  extractDir: string,
): Promise<{ label: string; content: string }[]> => {
  const entries = await readdir(extractDir);
  const contents = await Promise.all(
    entries.map(async (entry) => ({
      label: entry,
      content: await readFile(join(extractDir, entry), "utf8"),
    })),
  );
  const raw = await readFile(archivePath);
  return [...contents, { label: "<archive-raw-bytes>", content: raw.toString("latin1") }];
};

afterEach(async () => {
  await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("support bundle end-to-end leak safety", () => {
  it("emits no planted secret or email content in any artifact", async () => {
    const { archivePath, extractDir } = await makeBundle();
    const searchable = await gatherSearchableContent(archivePath, extractDir);

    const leaks: string[] = [];
    for (const [name, value] of Object.entries(SENTINELS)) {
      for (const { label, content } of searchable) {
        if (content.includes(value)) {
          leaks.push(`${name} leaked into ${label}`);
        }
      }
    }
    expect(leaks).toEqual([]);
  }, 30_000);

  it("detects a leak when one is present (negative control)", async () => {
    // Proves the assertion above can fail. If this test ever goes green while
    // the planted file genuinely contains the secret, the search is vacuous and
    // every other assertion in this file is worthless.
    const { archivePath, extractDir } = await makeBundle();
    await writeFile(join(extractDir, "planted.txt"), S.openrouter, { mode: 0o600 });

    const searchable = await gatherSearchableContent(archivePath, extractDir);
    const found = searchable.some(({ content }) => content.includes(S.openrouter));
    expect(found).toBe(true);
  }, 30_000);

  it("still reports the bundle as complete when every collector succeeded", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "bundle-leak-"));
    createdDirs.push(outputDir);
    const result = await generateSupportBundle(outputDir, {
      inventory: buildVersionInventory({ provenance: null, contractVersion: "2.0.0" }),
      doctorReport: doctorReportWithSecrets,
      status: statusWithSecrets,
      mailState: mailStateWithPii,
      run: runWithHostileOutput,
    });
    expect(result.complete).toBe(true);
    expect(result.manifest.files.every((file) => file.status === "collected")).toBe(true);
  }, 30_000);
});
