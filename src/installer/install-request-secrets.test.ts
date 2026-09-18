import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { InstallRequest } from "../contracts/index.js";
import { installRequestSchema } from "../contracts/index.js";
import {
  INSTALL_REQUEST_SECRET_FIELDS,
  pruneInstallJobRecords,
  redactInstallRequestSecrets,
} from "./install-request-secrets.js";
import { tryUsePreEnrolledRelay } from "./real-service-relay-enrollment.js";

/** Narrows `request.relay` for the relay round-trip tests, failing loudly if absent. */
const relayOf = (request: InstallRequest): NonNullable<InstallRequest["relay"]> => {
  const relay = request.relay;
  if (relay === undefined) {
    throw new Error("expected the test request to carry a relay block");
  }
  return relay;
};

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

  it("strips every relay credential and keeps the non-secret relay shape", () => {
    const request = {
      ...buildRequest(),
      connectivity: { mode: "relay" },
      relay: {
        controlUrl: "https://relay.example.org",
        enrollmentToken: "enroll-token-test-value",
        requestedSlug: "node-slug",
        hostname: "node-slug.relay.example.org",
        publicBaseUrl: "https://node-slug.relay.example.org",
        tunnel: {
          serverAddr: "relay.example.org",
          serverPort: 7000,
          token: "frp-tunnel-token-test-value",
          proxyName: "node-slug",
          type: "https",
        },
        dns01: {
          provider: "desec",
          apiBase: "https://desec.example.org/api/v1",
          zone: "relay.example.org",
          subname: "node-slug",
          acmeEmail: "operator@example.org",
          token: "desec-dns01-token-test-value",
        },
      },
    } as unknown as InstallRequest;

    const redacted = redactInstallRequestSecrets(request, { secretsDir: "/secrets" });
    const serialized = JSON.stringify(redacted);

    // No relay credential value may survive into the persisted request.
    expect(serialized).not.toContain("enroll-token-test-value");
    expect(serialized).not.toContain("frp-tunnel-token-test-value");
    expect(serialized).not.toContain("desec-dns01-token-test-value");

    // Relay tokens have no secretRef sibling in the request contract, so they
    // are dropped outright rather than replaced with a `file:` ref that no
    // consumer would resolve.
    expect(redacted.relay).toEqual({
      controlUrl: "https://relay.example.org",
      requestedSlug: "node-slug",
      hostname: "node-slug.relay.example.org",
      publicBaseUrl: "https://node-slug.relay.example.org",
      tunnel: {
        serverAddr: "relay.example.org",
        serverPort: 7000,
        proxyName: "node-slug",
        type: "https",
      },
      dns01: {
        provider: "desec",
        apiBase: "https://desec.example.org/api/v1",
        zone: "relay.example.org",
        subname: "node-slug",
        acmeEmail: "operator@example.org",
      },
    });

    // The caller's request object is left untouched, so the in-flight install
    // still has the live tokens it needs.
    expect(request.relay?.enrollmentToken).toBe("enroll-token-test-value");
    expect(request.relay?.tunnel?.token).toBe("frp-tunnel-token-test-value");
    expect(request.relay?.dns01?.token).toBe("desec-dns01-token-test-value");
  });

  it("leaves a relay request without optional tunnel/dns01 blocks intact", () => {
    const request = {
      ...buildRequest(),
      relay: { controlUrl: "https://relay.example.org", enrollmentToken: "enroll-token-value" },
    } as unknown as InstallRequest;

    const redacted = redactInstallRequestSecrets(request, { secretsDir: "/secrets" });

    expect(redacted.relay).toEqual({ controlUrl: "https://relay.example.org" });
    expect(JSON.stringify(redacted)).not.toContain("enroll-token-value");
  });

  /**
   * Regression guard for the read-back half of redaction.
   *
   * Redaction is only half a contract: a redacted request is written to disk
   * (install job records, the saved install request) and later read back and
   * re-validated with `installRequestSchema`. If redaction removes a field the
   * schema still demands, every such read-back fails — the install job status
   * endpoint 400s and the saved-request consumers reject the file as invalid,
   * even though nothing is actually wrong with the install.
   *
   * Asserting the redacted *shape* (as the tests above do) does not catch that;
   * only feeding the redacted value back through the real schema does. This
   * round-trip is that check, and it runs over the maximal relay request so
   * every dropped credential field is exercised at once.
   */
  it("produces a request that still validates against the real schema (persist/read-back round-trip)", () => {
    const request = {
      ...buildRequest(),
      connectivity: { mode: "relay" },
      relay: {
        controlUrl: "https://relay.example.org",
        enrollmentToken: "enroll-token-test-value",
        requestedSlug: "node-slug",
        hostname: "node-slug.relay.example.org",
        publicBaseUrl: "https://node-slug.relay.example.org",
        tunnel: {
          serverAddr: "relay.example.org",
          serverPort: 7000,
          token: "frp-tunnel-token-test-value",
          proxyName: "node-slug",
          type: "https",
        },
        dns01: {
          provider: "desec",
          apiBase: "https://desec.example.org/api/v1",
          zone: "relay.example.org",
          subname: "node-slug",
          acmeEmail: "operator@example.org",
          token: "desec-dns01-token-test-value",
        },
      },
    } as unknown as InstallRequest;

    const redacted = redactInstallRequestSecrets(request, { secretsDir: "/secrets" });

    // Round-trip through JSON exactly as persistence does, so a field that was
    // dropped is genuinely absent rather than an `undefined` property.
    const persisted: unknown = JSON.parse(JSON.stringify(redacted));
    const reread = installRequestSchema.safeParse(persisted);

    expect(reread.error?.issues ?? []).toEqual([]);
    expect(reread.success).toBe(true);

    // The re-read request is still recognizably the same install, minus the
    // credentials: redaction must not have damaged the non-secret shape.
    expect(reread.data?.relay?.tunnel).toEqual({
      serverAddr: "relay.example.org",
      serverPort: 7000,
      proxyName: "node-slug",
      type: "https",
    });
    expect(reread.data?.relay?.tunnel?.token).toBeUndefined();
    expect(reread.data?.relay?.dns01?.token).toBeUndefined();
    expect(reread.data?.relay?.enrollmentToken).toBeUndefined();
    expect(JSON.stringify(reread.data)).not.toContain("test-value");
  });

  /**
   * The other half of the same contract: a tunnel whose token redaction removed
   * must read as "not pre-enrolled", never as a usable enrollment. Making
   * `tunnel.token` optional would be a security regression if any consumer
   * treated an absent token as acceptable and went on to build a tunnel config
   * from it; `tryUsePreEnrolledRelay` must keep falling through instead.
   */
  it("leaves a redacted relay request unusable as a pre-enrollment", () => {
    const request = {
      ...buildRequest(),
      connectivity: { mode: "relay" },
      relay: {
        controlUrl: "https://relay.example.org",
        hostname: "node-slug.relay.example.org",
        publicBaseUrl: "https://node-slug.relay.example.org",
        tunnel: {
          serverAddr: "relay.example.org",
          serverPort: 7000,
          token: "frp-tunnel-token-test-value",
          proxyName: "node-slug",
          type: "https",
        },
      },
    } as unknown as InstallRequest;

    // Before redaction the request IS a usable pre-enrollment.
    expect(
      tryUsePreEnrolledRelay({
        relay: relayOf(request),
        localEdgePort: 8080,
        localTlsPort: 8443,
      }),
    ).not.toBeNull();

    const redacted = redactInstallRequestSecrets(request, { secretsDir: "/secrets" });
    const reread = installRequestSchema.parse(JSON.parse(JSON.stringify(redacted)));

    // After redaction it validates, but must NOT be mistaken for one: the
    // caller falls through to the enrollment-reuse path, which resolves the
    // real token from the runtime config's tokenSecretRef.
    expect(
      tryUsePreEnrolledRelay({
        relay: relayOf(reread),
        localEdgePort: 8080,
        localTlsPort: 8443,
      }),
    ).toBeNull();
  });
});

/**
 * Fail-closed guard. `redactInstallRequestSecrets` is an allowlist: it handles
 * exactly the fields named in `INSTALL_REQUEST_SECRET_FIELDS`. This suite walks
 * the real `installRequestSchema` and fails when the contract grows a
 * secret-bearing field that the allowlist does not name — which is how the
 * relay tokens came to be persisted in cleartext in the first place.
 *
 * If this test fails because you added a field:
 *  - if it carries a credential, handle it in `redactInstallRequestSecrets`
 *    and add it to `INSTALL_REQUEST_SECRET_FIELDS`;
 *  - if it does not, add it to `NON_SECRET_MATCHES` below with a reason.
 */
describe("INSTALL_REQUEST_SECRET_FIELDS covers the install contract", () => {
  /** Leaf paths whose name looks secret-ish but which carry no secret value. */
  const NON_SECRET_MATCHES = new Set([
    // Pointers to a secret, not the secret itself — persisting these is the
    // whole point of redaction.
    "imap.secretRef",
    "openrouter.secretRef",
    "bots.instances.[].secretRefs",
  ]);

  /** Matches field names that plausibly carry a credential value. */
  const SECRET_NAME_PATTERN = /password|token|apikey|secret|credential|passphrase/i;

  type ZodLike = { _zod?: { def?: Record<string, unknown> } };

  const unwrap = (schema: unknown): unknown => {
    let current = schema;
    // Peel optional/nullable/default/pipe wrappers to reach the inner type.
    for (let depth = 0; depth < 20; depth += 1) {
      const def = (current as ZodLike)?._zod?.def;
      const type = def?.type;
      if (type === "optional" || type === "nullable" || type === "default") {
        current = def?.innerType;
        continue;
      }
      if (type === "pipe") {
        current = def?.in;
        continue;
      }
      break;
    }
    return current;
  };

  const collectLeafPaths = (schema: unknown, path: string[], out: string[]): void => {
    const node = unwrap(schema);
    const def = (node as ZodLike)?._zod?.def;
    if (def?.type === "object") {
      for (const [key, value] of Object.entries(def.shape as Record<string, unknown>)) {
        collectLeafPaths(value, [...path, key], out);
      }
      return;
    }
    if (def?.type === "array") {
      collectLeafPaths(def.element, [...path, "[]"], out);
      return;
    }
    out.push(path.join("."));
  };

  it("names every secret-bearing field in the InstallRequest schema", () => {
    const leaves: string[] = [];
    collectLeafPaths(installRequestSchema, [], leaves);

    // Guard the guard: if the walker stops seeing the contract, it would pass
    // vacuously and this whole suite would stop protecting anything.
    expect(leaves).toContain("openrouter.apiKey");
    expect(leaves).toContain("relay.dns01.token");
    expect(leaves.length).toBeGreaterThan(30);

    const secretish = leaves.filter(
      (leaf) =>
        SECRET_NAME_PATTERN.test(leaf.split(".").pop() ?? "") && !NON_SECRET_MATCHES.has(leaf),
    );
    const allowlisted = Object.keys(INSTALL_REQUEST_SECRET_FIELDS);

    expect(secretish.sort()).toEqual([...allowlisted].sort());
  });

  it("redacts every allowlisted field out of a fully populated request", () => {
    // One canary value per allowlisted field, so a field that is listed but
    // not actually handled by the redactor fails here instead of leaking.
    const canaries: Record<string, string> = {
      "imap.password": "canary-imap-password",
      "openrouter.apiKey": "canary-openrouter-key",
      "operator.password": "canary-operator-password",
      "relay.enrollmentToken": "canary-enrollment-token",
      "relay.tunnel.token": "canary-tunnel-token",
      "relay.dns01.token": "canary-dns01-token",
    };
    expect(Object.keys(canaries).sort()).toEqual(Object.keys(INSTALL_REQUEST_SECRET_FIELDS).sort());

    const request = {
      mode: "bundled_matrix",
      openrouter: { model: "m", apiKey: canaries["openrouter.apiKey"] },
      imap: {
        host: "imap.example.org",
        port: 993,
        tls: true,
        username: "operator@example.org",
        password: canaries["imap.password"],
      },
      matrix: {
        homeserverDomain: "matrix.example.org",
        publicBaseUrl: "https://matrix.example.org",
      },
      operator: { username: "operator", password: canaries["operator.password"] },
      relay: {
        controlUrl: "https://relay.example.org",
        enrollmentToken: canaries["relay.enrollmentToken"],
        tunnel: {
          serverAddr: "relay.example.org",
          token: canaries["relay.tunnel.token"],
          proxyName: "node",
        },
        dns01: {
          provider: "desec",
          apiBase: "https://desec.example.org/api/v1",
          zone: "relay.example.org",
          subname: "node",
          token: canaries["relay.dns01.token"],
        },
      },
    } as unknown as InstallRequest;

    const serialized = JSON.stringify(
      redactInstallRequestSecrets(request, { secretsDir: "/secrets" }),
    );
    const leaked = Object.entries(canaries)
      .filter(([, value]) => serialized.includes(value))
      .map(([field]) => field);

    expect(leaked).toEqual([]);
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
