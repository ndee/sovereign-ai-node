import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { InstallRequest } from "../contracts/index.js";
import { pruneInstallJobRecords, redactInstallRequestSecrets } from "./install-request-secrets.js";

const buildRequest = (): InstallRequest => ({
  mode: "bundled_matrix",
  openrouter: { model: "qwen/qwen-2.5-7b-instruct", apiKey: "sk-or-inline-key" },
  imap: {
    host: "imap.example.org",
    port: 993,
    tls: true,
    username: "operator@example.org",
    password: "imap-inline-password",
  },
  matrix: { homeserverDomain: "matrix.example.org", publicBaseUrl: "https://matrix.example.org" },
  operator: { username: "operator", password: "operator-inline-password" },
  bots: {
    instances: [
      {
        id: "mail-sentinel",
        packageId: "mail-sentinel",
        secretRefs: { imapPassword: "file:/etc/sovereign-node/secrets/imap-password" },
      },
    ],
  },
});

describe("redactInstallRequestSecrets", () => {
  it("strips inline secrets and keeps only secretRef forms", () => {
    const original = buildRequest();
    const redacted = redactInstallRequestSecrets(original, { secretsDir: "/secrets" });
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toMatch(/sk-or-|"password"|inline/);
    expect(redacted.imap).toEqual({
      host: "imap.example.org",
      port: 993,
      tls: true,
      username: "operator@example.org",
      secretRef: "file:/secrets/imap-password",
    });
    expect(redacted.openrouter).toEqual({
      model: "qwen/qwen-2.5-7b-instruct",
      secretRef: "file:/secrets/openrouter-api-key",
    });
    expect(redacted.operator).toEqual({ username: "operator" });
    expect(redacted.bots?.instances?.[0]?.secretRefs).toEqual({
      imapPassword: "file:/etc/sovereign-node/secrets/imap-password",
    });

    // The caller's request object is left untouched.
    expect(original.imap?.password).toBe("imap-inline-password");
    expect(original.openrouter.apiKey).toBe("sk-or-inline-key");
    expect(original.operator.password).toBe("operator-inline-password");
  });

  it("keeps existing secretRefs and tolerates requests without optional sections", () => {
    const request: InstallRequest = {
      mode: "bundled_matrix",
      openrouter: { secretRef: "env:OPENROUTER_API_KEY", apiKey: "sk-or-ignored" },
      imap: {
        host: "imap.example.org",
        port: 993,
        tls: true,
        username: "operator@example.org",
        secretRef: "file:/custom/imap",
        password: "ignored",
      },
      matrix: {
        homeserverDomain: "matrix.example.org",
        publicBaseUrl: "https://matrix.example.org",
      },
      operator: { username: "operator" },
    };
    const redacted = redactInstallRequestSecrets(request, { secretsDir: "/secrets" });
    expect(redacted.openrouter).toEqual({ secretRef: "env:OPENROUTER_API_KEY" });
    expect(redacted.imap?.secretRef).toBe("file:/custom/imap");
    expect(redacted.imap?.password).toBeUndefined();
    expect(redacted.bots).toBeUndefined();

    const withoutImap = redactInstallRequestSecrets(
      { ...request, imap: undefined },
      { secretsDir: "/secrets" },
    );
    expect(withoutImap.imap).toBeUndefined();
  });
});

describe("pruneInstallJobRecords", () => {
  const HOUR_MS = 60 * 60 * 1000;

  const writeRecord = async (
    dir: string,
    jobId: string,
    state: string,
    ageMs: number,
    now: number,
  ): Promise<void> => {
    const path = join(dir, `${jobId}.json`);
    await writeFile(path, JSON.stringify({ response: { job: { jobId, state } } }), "utf8");
    const mtime = new Date(now - ageMs);
    await utimes(path, mtime, mtime);
  };

  it("removes terminal records older than the retention window or beyond the newest N", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sovereign-install-jobs-"));
    const now = Date.parse("2026-08-22T12:00:00Z");
    try {
      await writeRecord(dir, "job_old-failed", "failed", 30 * HOUR_MS, now);
      await writeRecord(dir, "job_old-running", "running", 30 * HOUR_MS, now);
      await writeRecord(dir, "job_old-current", "succeeded", 30 * HOUR_MS, now);
      await writeRecord(dir, "job_fresh-succeeded", "succeeded", 1 * HOUR_MS, now);
      await writeFile(join(dir, "job_corrupt.json"), "{not json", "utf8");
      const corruptTime = new Date(now - 30 * HOUR_MS);
      await utimes(join(dir, "job_corrupt.json"), corruptTime, corruptTime);
      await writeFile(join(dir, "notes.txt"), "keep me", "utf8");
      for (let index = 0; index < 5; index += 1) {
        await writeRecord(dir, `job_recent-${index}`, "succeeded", (index + 2) * HOUR_MS, now);
      }

      const removed = await pruneInstallJobRecords(dir, {
        now: () => now,
        keepNewest: 3,
        maxAgeMs: 24 * HOUR_MS,
        protectJobId: "job_old-current",
      });

      const remaining = (await readdir(dir)).sort();
      expect(removed.sort()).toEqual(
        ["job_corrupt", "job_old-failed", "job_recent-2", "job_recent-3", "job_recent-4"].sort(),
      );
      expect(remaining).toEqual(
        [
          "job_fresh-succeeded.json",
          "job_old-current.json",
          "job_old-running.json",
          "job_recent-0.json",
          "job_recent-1.json",
          "notes.txt",
        ].sort(),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty list when the directory does not exist", async () => {
    const dir = join(tmpdir(), `sovereign-install-jobs-missing-${Date.now()}`);
    await expect(pruneInstallJobRecords(dir, { now: () => Date.now() })).resolves.toEqual([]);
  });

  it("uses default retention settings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sovereign-install-jobs-"));
    try {
      const now = Date.now();
      await writeRecord(dir, "job_stale", "succeeded", 48 * HOUR_MS, now);
      await writeRecord(dir, "job_new", "succeeded", 0, now);
      await expect(pruneInstallJobRecords(dir)).resolves.toEqual(["job_stale"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
