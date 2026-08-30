import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  describeRelayNodeAuthFailure,
  extractRelayErrorCode,
  RELAY_NODE_SECRET_FILE_NAME,
  RELAY_NODE_SECRET_PATH,
  readRelayNodeSecretFile,
  relayNodeSecretAuthHeaders,
  stripRelayNodeSecret,
} from "./real-service-relay-node-secret.js";

describe("relay node secret helpers", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "relay-node-secret-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  describe("readRelayNodeSecretFile", () => {
    it("returns undefined when no candidate dir holds the file", async () => {
      await expect(
        readRelayNodeSecretFile([join(tempRoot, "missing"), join(tempRoot, "also-missing")]),
      ).resolves.toBeUndefined();
    });

    it("returns the trimmed secret from the first dir that has a non-empty file", async () => {
      const first = join(tempRoot, "first");
      const second = join(tempRoot, "second");
      await mkdir(first, { recursive: true });
      await mkdir(second, { recursive: true });
      await writeFile(join(first, RELAY_NODE_SECRET_FILE_NAME), "\n", "utf8");
      await writeFile(join(second, RELAY_NODE_SECRET_FILE_NAME), "  s3cr3t-value \n", "utf8");

      await expect(readRelayNodeSecretFile([first, second])).resolves.toBe("s3cr3t-value");
    });

    it("treats a missing path component as absent", async () => {
      await expect(
        readRelayNodeSecretFile([join(tempRoot, "not-a-dir", "nested")]),
      ).resolves.toBeUndefined();
    });

    it("rethrows unexpected read errors", async () => {
      const dir = join(tempRoot, "broken");
      await mkdir(join(dir, RELAY_NODE_SECRET_FILE_NAME), { recursive: true });

      await expect(readRelayNodeSecretFile([dir])).rejects.toMatchObject({ code: "EISDIR" });
    });

    it("rethrows non-errno failures", async () => {
      await expect(readRelayNodeSecretFile([{} as unknown as string])).rejects.toBeDefined();
    });
  });

  describe("relayNodeSecretAuthHeaders", () => {
    it("returns no header when the secret is absent or blank", () => {
      expect(relayNodeSecretAuthHeaders(undefined)).toEqual({});
      expect(relayNodeSecretAuthHeaders("   ")).toEqual({});
    });

    it("returns a bearer header for a present secret", () => {
      expect(relayNodeSecretAuthHeaders(" abc ")).toEqual({ Authorization: "Bearer abc" });
    });
  });

  describe("extractRelayErrorCode", () => {
    it("reads a top-level code", () => {
      expect(extractRelayErrorCode(JSON.stringify({ ok: false, code: "SLUG_TAKEN" }))).toBe(
        "SLUG_TAKEN",
      );
    });

    it("reads a nested error.code", () => {
      expect(
        extractRelayErrorCode(JSON.stringify({ error: { code: "NODE_SECRET_INVALID" } })),
      ).toBe("NODE_SECRET_INVALID");
    });

    it("returns undefined for non-JSON, non-object, and code-less bodies", () => {
      expect(extractRelayErrorCode("not json")).toBeUndefined();
      expect(extractRelayErrorCode("[1]")).toBeUndefined();
      expect(extractRelayErrorCode(JSON.stringify({ error: "plain" }))).toBeUndefined();
      expect(extractRelayErrorCode(JSON.stringify({ error: { code: 5 } }))).toBeUndefined();
      expect(extractRelayErrorCode(JSON.stringify({ code: "" }))).toBeUndefined();
    });
  });

  describe("describeRelayNodeAuthFailure", () => {
    const base = { controlUrl: "https://relay.example", requestedSlug: "pilot" };

    it("maps 401 to a re-key instruction naming the secret path", () => {
      const failure = describeRelayNodeAuthFailure({
        ...base,
        status: 401,
        responseText: JSON.stringify({ ok: false, error: "nope", code: "NODE_SECRET_REQUIRED" }),
      });
      expect(failure).not.toBeNull();
      expect(failure?.code).toBe("RELAY_NODE_SECRET_REJECTED");
      expect(failure?.retryable).toBe(false);
      expect(failure?.message).toContain("re-key");
      expect(failure?.message).toContain(RELAY_NODE_SECRET_PATH);
      expect(failure?.details).toMatchObject({
        controlUrl: "https://relay.example",
        requestedSlug: "pilot",
        status: 401,
        relayCode: "NODE_SECRET_REQUIRED",
        secretPath: RELAY_NODE_SECRET_PATH,
      });
    });

    it("maps 401 without a relay code and without a slug", () => {
      const failure = describeRelayNodeAuthFailure({
        controlUrl: "https://relay.example",
        status: 401,
        responseText: "",
      });
      expect(failure?.code).toBe("RELAY_NODE_SECRET_REJECTED");
      expect(failure?.details).not.toHaveProperty("relayCode");
      expect(failure?.details).not.toHaveProperty("requestedSlug");
    });

    it("maps 409 SLUG_TAKEN to a non-retryable slug conflict", () => {
      const failure = describeRelayNodeAuthFailure({
        ...base,
        status: 409,
        responseText: JSON.stringify({ ok: false, error: "taken", code: "SLUG_TAKEN" }),
      });
      expect(failure?.code).toBe("RELAY_SLUG_TAKEN");
      expect(failure?.retryable).toBe(false);
      expect(failure?.message).toContain("pilot");
      expect(failure?.message).toContain("another node");
    });

    it("maps 409 SLUG_TAKEN without a slug in the request", () => {
      const failure = describeRelayNodeAuthFailure({
        controlUrl: "https://relay.example",
        status: 409,
        responseText: JSON.stringify({ ok: false, error: "taken", code: "SLUG_TAKEN" }),
      });
      expect(failure?.code).toBe("RELAY_SLUG_TAKEN");
      expect(failure?.message).toContain("requested node name");
    });

    it("maps 409 without an explicit code when a node secret was presented", () => {
      const failure = describeRelayNodeAuthFailure({
        ...base,
        status: 409,
        responseText: "conflict",
        presentedNodeSecret: true,
      });
      expect(failure?.code).toBe("RELAY_SLUG_TAKEN");
    });

    it("leaves a generic 409 (no code, no secret presented) to the caller", () => {
      expect(
        describeRelayNodeAuthFailure({ ...base, status: 409, responseText: "slug exists" }),
      ).toBeNull();
    });

    it("maps 429 to a retryable throttle error", () => {
      const failure = describeRelayNodeAuthFailure({
        ...base,
        status: 429,
        responseText: JSON.stringify({ ok: false, error: "Too many attempts; retry later" }),
      });
      expect(failure?.code).toBe("RELAY_THROTTLED");
      expect(failure?.retryable).toBe(true);
      expect(failure?.message).toContain("retry");
    });

    it("returns null for other statuses", () => {
      expect(describeRelayNodeAuthFailure({ ...base, status: 500, responseText: "" })).toBeNull();
      expect(describeRelayNodeAuthFailure({ ...base, status: 400, responseText: "" })).toBeNull();
    });
  });

  describe("stripRelayNodeSecret", () => {
    it("returns a copy without the nodeSecret field and leaves the input untouched", () => {
      const input = { hostname: "a", nodeSecret: "s" };
      const stripped = stripRelayNodeSecret(input);
      expect(stripped).toEqual({ hostname: "a" });
      expect(stripped).not.toHaveProperty("nodeSecret");
      expect(input.nodeSecret).toBe("s");
    });

    it("passes through objects without a secret", () => {
      expect(
        stripRelayNodeSecret({ hostname: "a" } as { hostname: string; nodeSecret?: string }),
      ).toEqual({ hostname: "a" });
    });
  });
});
