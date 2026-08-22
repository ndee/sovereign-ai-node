import { describe, expect, it } from "vitest";

import { HttpOpenrouterKeyValidator, OPENROUTER_KEY_ENDPOINT } from "./openrouter.js";

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("HttpOpenrouterKeyValidator", () => {
  it("accepts a key OpenRouter recognises and returns only its label", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const validator = new HttpOpenrouterKeyValidator({
      fetch: async (url, init) => {
        seen.push({ url, init });
        return jsonResponse(200, { data: { label: "sovereign-node", usage: 0.1 } });
      },
    });
    const result = await validator.validate("sk-or-v1-abc");
    expect(result).toEqual({ ok: true, label: "sovereign-node" });
    expect(seen[0]?.url).toBe(OPENROUTER_KEY_ENDPOINT);
    expect(seen[0]?.init.method).toBe("GET");
    expect((seen[0]?.init.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk-or-v1-abc",
    );
    expect(JSON.stringify(result)).not.toContain("sk-or-v1-abc");
  });

  it("reports an invalid key on 401 without echoing it", async () => {
    const validator = new HttpOpenrouterKeyValidator({
      fetch: async () => jsonResponse(401, { error: { message: "User not found." } }),
    });
    const result = await validator.validate("sk-or-bad");
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("OPENROUTER_KEY_INVALID");
    expect(JSON.stringify(result)).not.toContain("sk-or-bad");
  });

  it("treats upstream 5xx as retryable and network errors as reachability failures", async () => {
    const upstream = new HttpOpenrouterKeyValidator({
      fetch: async () => jsonResponse(503, {}),
    });
    expect(await upstream.validate("sk-or-x")).toMatchObject({
      ok: false,
      error: { code: "OPENROUTER_KEY_CHECK_FAILED", retryable: true },
    });

    const offline = new HttpOpenrouterKeyValidator({
      fetch: async () => {
        throw new Error("getaddrinfo ENOTFOUND openrouter.ai");
      },
    });
    expect(await offline.validate("sk-or-x")).toMatchObject({
      ok: false,
      error: { code: "OPENROUTER_KEY_CHECK_FAILED", retryable: true },
    });
  });

  it("times out", async () => {
    const validator = new HttpOpenrouterKeyValidator({
      timeoutMs: 10,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    });
    expect(await validator.validate("sk-or-x")).toMatchObject({
      ok: false,
      error: { code: "OPENROUTER_KEY_CHECK_TIMEOUT" },
    });
  });

  it("tolerates a non-JSON success body", async () => {
    const validator = new HttpOpenrouterKeyValidator({
      fetch: async () => new Response("ok", { status: 200 }),
    });
    expect(await validator.validate("sk-or-x")).toEqual({ ok: true });
  });
});
