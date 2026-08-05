import { mkdtemp, chmod, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  findAuthorizedReleaseBot,
  loadReleaseAuthorization,
  type ReleaseAuthorization,
} from "./release-authorization.js";

const currentUid = process.getuid?.() ?? 0;

const validDocument = (): Record<string, unknown> => ({
  schemaVersion: 1,
  kind: "sovereign-release-authorization",
  runId: "c9eada2f-9d60-4146-a63a-249d7c2683d0",
  createdAt: "2026-08-05T12:00:00Z",
  releaseId: "v2.7.7-linux-any-test",
  channel: "test",
  version: "2.7.7",
  artifactSha256: "a".repeat(64),
  signingKeyId: "release-2026-01",
  bots: [
    {
      id: "mail-sentinel",
      version: "2.0.7",
      manifestFileSha256: "b".repeat(64),
    },
  ],
});

describe("loadReleaseAuthorization", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "release-authz-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const writeAuthorization = async (document: unknown, mode = 0o640): Promise<string> => {
    const path = join(dir, "release-authorization.json");
    await writeFile(path, typeof document === "string" ? document : JSON.stringify(document));
    await chmod(path, mode);
    return path;
  };

  it("loads a valid attestation owned by an allowed uid", async () => {
    const path = await writeAuthorization(validDocument());
    const loaded = loadReleaseAuthorization(path, { allowedOwnerUids: [currentUid] });
    expect(loaded.releaseId).toBe("v2.7.7-linux-any-test");
    expect(loaded.bots[0]?.id).toBe("mail-sentinel");
  });

  it("rejects a file owned by an untrusted uid (production default: root only)", async () => {
    const path = await writeAuthorization(validDocument());
    // The test process is not root, so the default [0] owner policy must refuse.
    expect(() => loadReleaseAuthorization(path)).toThrowError(
      expect.objectContaining({
        code: "RELEASE_AUTHORIZATION_INVALID",
        details: expect.objectContaining({ reason: "untrusted-owner" }),
      }),
    );
  });

  it("rejects a symlinked authorization path", async () => {
    const target = await writeAuthorization(validDocument());
    const link = join(dir, "link.json");
    await symlink(target, link);
    expect(() => loadReleaseAuthorization(link, { allowedOwnerUids: [currentUid] })).toThrowError(
      expect.objectContaining({
        code: "RELEASE_AUTHORIZATION_INVALID",
        details: expect.objectContaining({ reason: "symlink" }),
      }),
    );
  });

  it("rejects a group- or world-writable file", async () => {
    for (const mode of [0o660, 0o642]) {
      const path = await writeAuthorization(validDocument(), mode);
      expect(() =>
        loadReleaseAuthorization(path, { allowedOwnerUids: [currentUid] }),
      ).toThrowError(
        expect.objectContaining({
          code: "RELEASE_AUTHORIZATION_INVALID",
          details: expect.objectContaining({ reason: "unsafe-mode" }),
        }),
      );
    }
  });

  it("rejects a missing file", async () => {
    expect(() =>
      loadReleaseAuthorization(join(dir, "missing.json"), { allowedOwnerUids: [currentUid] }),
    ).toThrowError(
      expect.objectContaining({
        code: "RELEASE_AUTHORIZATION_INVALID",
        details: expect.objectContaining({ reason: "unreadable" }),
      }),
    );
  });

  it("rejects invalid JSON", async () => {
    const path = await writeAuthorization("{not json");
    expect(() => loadReleaseAuthorization(path, { allowedOwnerUids: [currentUid] })).toThrowError(
      expect.objectContaining({
        code: "RELEASE_AUTHORIZATION_INVALID",
        details: expect.objectContaining({ reason: "parse-error" }),
      }),
    );
  });

  it("rejects schema violations, including unknown keys and bad digests", async () => {
    const withUnknownKey = { ...validDocument(), extra: true };
    const withBadDigest = {
      ...validDocument(),
      artifactSha256: "ZZ".repeat(32),
    };
    const withoutKind = (() => {
      const document = validDocument();
      delete document.kind;
      return document;
    })();
    for (const document of [withUnknownKey, withBadDigest, withoutKind]) {
      const path = await writeAuthorization(document);
      expect(() =>
        loadReleaseAuthorization(path, { allowedOwnerUids: [currentUid] }),
      ).toThrowError(
        expect.objectContaining({
          code: "RELEASE_AUTHORIZATION_INVALID",
          details: expect.objectContaining({ reason: "schema-invalid" }),
        }),
      );
    }
  });
});

describe("findAuthorizedReleaseBot", () => {
  const authorization = {
    ...validDocument(),
    bots: [{ id: "mail-sentinel", version: "2.0.7", manifestFileSha256: "b".repeat(64) }],
  } as ReleaseAuthorization;

  it("returns the entry only on an exact id + version + digest match", () => {
    expect(
      findAuthorizedReleaseBot(authorization, {
        botId: "mail-sentinel",
        botVersion: "2.0.7",
        manifestFileSha256: "b".repeat(64),
      }),
    ).not.toBeNull();
  });

  it("refuses a different bot, version, or digest", () => {
    expect(
      findAuthorizedReleaseBot(authorization, {
        botId: "node-operator",
        botVersion: "2.0.7",
        manifestFileSha256: "b".repeat(64),
      }),
    ).toBeNull();
    expect(
      findAuthorizedReleaseBot(authorization, {
        botId: "mail-sentinel",
        botVersion: "2.0.5",
        manifestFileSha256: "b".repeat(64),
      }),
    ).toBeNull();
    expect(
      findAuthorizedReleaseBot(authorization, {
        botId: "mail-sentinel",
        botVersion: "2.0.7",
        manifestFileSha256: "c".repeat(64),
      }),
    ).toBeNull();
  });
});
