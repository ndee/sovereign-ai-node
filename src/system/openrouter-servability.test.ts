import { describe, expect, it, vi } from "vitest";

import {
  HttpOpenrouterServabilityChecker,
  OPENROUTER_API_BASE_URL,
  openrouterLookupModelId,
} from "./openrouter-servability.js";

const strict = { zdr: true, dataCollection: "deny" as const, allowFallbacks: false };
const nebiusOnly = { ...strict, only: ["nebius"] };

const endpoint = (modelId: string, tag: string) => ({
  model_id: modelId,
  provider_name: tag.split("/")[0],
  tag,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Routes fake OpenRouter metadata by URL; unknown URLs answer 404. */
const fakeOpenRouter = (input: {
  endpoints?: Record<string, Array<ReturnType<typeof endpoint>>>;
  zdr?: Array<ReturnType<typeof endpoint>>;
  override?: (url: string) => Response | Promise<Response> | undefined;
}) => {
  const calls: string[] = [];
  const fetch = vi.fn(async (url: string, _init: RequestInit) => {
    calls.push(url);
    const overridden = await input.override?.(url);
    if (overridden !== undefined) {
      return overridden;
    }
    if (url === `${OPENROUTER_API_BASE_URL}/endpoints/zdr`) {
      return json({ data: input.zdr ?? [] });
    }
    const match = /\/models\/(.+)\/endpoints$/.exec(url);
    const endpoints = match?.[1] === undefined ? undefined : input.endpoints?.[match[1]];
    if (endpoints === undefined) {
      return json({ error: { message: "Not Found", code: 404 } }, 404);
    }
    return json({ data: { id: match?.[1], endpoints } });
  });
  return { fetch, calls };
};

const QWEN_30B = "qwen/qwen3-30b-a3b-instruct-2507";
const QWEN_27B = "qwen/qwen3.5-27b";
const metadata = {
  endpoints: {
    [QWEN_30B]: [
      endpoint(QWEN_30B, "dekallm"),
      endpoint(QWEN_30B, "siliconflow/fp8"),
      endpoint(QWEN_30B, "nebius/fp8"),
    ],
    [QWEN_27B]: [
      endpoint(QWEN_27B, "alibaba"),
      endpoint(QWEN_27B, "siliconflow/fp8"),
      endpoint(QWEN_27B, "deepinfra/fp8"),
    ],
  },
  zdr: [
    endpoint(QWEN_30B, "nebius/fp8"),
    endpoint(QWEN_30B, "siliconflow/fp8"),
    endpoint(QWEN_27B, "siliconflow/fp8"),
    endpoint(QWEN_27B, "deepinfra/fp8"),
  ],
};

describe("openrouterLookupModelId", () => {
  it("drops the OpenClaw provider prefix of an OpenRouter model ref", () => {
    expect(openrouterLookupModelId("openrouter/qwen/qwen3.5-27b")).toBe("qwen/qwen3.5-27b");
    expect(openrouterLookupModelId("OpenRouter/qwen/qwen3.5-27b")).toBe("qwen/qwen3.5-27b");
    expect(openrouterLookupModelId(" qwen/qwen3.5-27b ")).toBe("qwen/qwen3.5-27b");
  });

  it("keeps OpenRouter's own router models whole", () => {
    expect(openrouterLookupModelId("openrouter/auto")).toBe("openrouter/auto");
  });
});

describe("HttpOpenrouterServabilityChecker", () => {
  it("finds a model servable when an allowed provider has a ZDR endpoint", async () => {
    const { fetch } = fakeOpenRouter(metadata);
    const checker = new HttpOpenrouterServabilityChecker({ fetch });

    await expect(checker.check([QWEN_30B], nebiusOnly)).resolves.toEqual([
      { model: QWEN_30B, status: "servable", endpoints: ["nebius/fp8"] },
    ]);
  });

  it("reports a model no allowed provider serves, with the providers that do", async () => {
    const { fetch } = fakeOpenRouter(metadata);
    const checker = new HttpOpenrouterServabilityChecker({ fetch });

    await expect(checker.check([`openrouter/${QWEN_27B}`], nebiusOnly)).resolves.toEqual([
      {
        model: `openrouter/${QWEN_27B}`,
        status: "unservable",
        reason: "no-allowed-endpoint",
        endpoints: ["alibaba", "siliconflow/fp8", "deepinfra/fp8"],
      },
    ]);
  });

  it("requires the endpoint to be on the ZDR list when zero data retention is on", async () => {
    const { fetch } = fakeOpenRouter(metadata);
    const checker = new HttpOpenrouterServabilityChecker({ fetch });

    // dekallm serves the model but is not a ZDR endpoint.
    const [result] = await checker.check([QWEN_30B], { ...strict, only: ["dekallm"] });
    expect(result).toMatchObject({ status: "unservable", reason: "no-allowed-endpoint" });

    const [optedOut] = await checker.check([QWEN_30B], {
      zdr: false,
      dataCollection: "allow",
      allowFallbacks: true,
      only: ["dekallm"],
    });
    expect(optedOut).toEqual({ model: QWEN_30B, status: "servable", endpoints: ["dekallm"] });
  });

  it("accepts every ZDR endpoint when there is no provider allow-list", async () => {
    const { fetch } = fakeOpenRouter(metadata);
    const checker = new HttpOpenrouterServabilityChecker({ fetch });

    const [result] = await checker.check([QWEN_30B], strict);
    expect(result).toEqual({
      model: QWEN_30B,
      status: "servable",
      endpoints: ["siliconflow/fp8", "nebius/fp8"],
    });
  });

  it("matches allow-list entries by provider slug or by exact endpoint tag, case-insensitively", async () => {
    const { fetch } = fakeOpenRouter(metadata);
    const checker = new HttpOpenrouterServabilityChecker({ fetch });

    const [byTag] = await checker.check([QWEN_30B], { ...strict, only: ["Nebius/FP8"] });
    expect(byTag).toMatchObject({ status: "servable", endpoints: ["nebius/fp8"] });
    const [wrongQuantization] = await checker.check([QWEN_30B], {
      ...strict,
      only: ["nebius/fp4"],
    });
    expect(wrongQuantization).toMatchObject({ status: "unservable" });
    // A slug prefix is not a slug: "neb" must not match "nebius".
    const [prefix] = await checker.check([QWEN_30B], { ...strict, only: ["neb"] });
    expect(prefix).toMatchObject({ status: "unservable" });
  });

  it("reports a model OpenRouter does not know as unservable", async () => {
    const { fetch } = fakeOpenRouter(metadata);
    const checker = new HttpOpenrouterServabilityChecker({ fetch });

    await expect(checker.check(["vendor/no-such-model"], strict)).resolves.toEqual([
      {
        model: "vendor/no-such-model",
        status: "unservable",
        reason: "unknown-model",
        endpoints: [],
      },
    ]);
  });

  it("reports a model with no endpoints at all as unservable", async () => {
    const { fetch } = fakeOpenRouter({ ...metadata, endpoints: { "vendor/empty": [] } });
    const checker = new HttpOpenrouterServabilityChecker({ fetch });

    const [result] = await checker.check(["vendor/empty"], strict);
    expect(result).toEqual({
      model: "vendor/empty",
      status: "unservable",
      reason: "no-allowed-endpoint",
      endpoints: [],
    });
  });

  it("fetches the ZDR list once per check and each model once", async () => {
    const { fetch, calls } = fakeOpenRouter(metadata);
    const checker = new HttpOpenrouterServabilityChecker({ fetch });

    const results = await checker.check([QWEN_30B, QWEN_27B, `openrouter/${QWEN_30B}`], nebiusOnly);

    expect(results.map((entry) => entry.status)).toEqual(["servable", "unservable", "servable"]);
    expect(calls.filter((url) => url.endsWith("/endpoints/zdr"))).toHaveLength(1);
    expect(calls.filter((url) => url.includes(QWEN_30B))).toHaveLength(1);
    for (const [, init] of fetch.mock.calls) {
      expect(init.method).toBe("GET");
      // Public metadata: the API key is never sent.
      expect(JSON.stringify(init.headers ?? {})).not.toMatch(/authorization/i);
    }
  });

  it("skips the ZDR list when zero data retention is off", async () => {
    const { fetch, calls } = fakeOpenRouter(metadata);
    const checker = new HttpOpenrouterServabilityChecker({ fetch });

    await checker.check([QWEN_30B], { ...strict, zdr: false, only: ["nebius"] });

    expect(calls.some((url) => url.endsWith("/endpoints/zdr"))).toBe(false);
  });

  it("returns nothing and asks nothing for an empty model list", async () => {
    const { fetch } = fakeOpenRouter(metadata);
    const checker = new HttpOpenrouterServabilityChecker({ fetch });

    await expect(checker.check([], strict)).resolves.toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  describe("an inconclusive lookup is unknown, never unservable", () => {
    it("on a server error for the model", async () => {
      const { fetch } = fakeOpenRouter({
        ...metadata,
        override: (url) => (url.includes(QWEN_30B) ? json({}, 503) : undefined),
      });
      const checker = new HttpOpenrouterServabilityChecker({ fetch });

      await expect(checker.check([QWEN_30B], nebiusOnly)).resolves.toEqual([
        {
          model: QWEN_30B,
          status: "unknown",
          message: "OpenRouter responded with HTTP 503 to the model endpoint lookup",
        },
      ]);
    });

    it("on a failed ZDR list, for every model", async () => {
      const { fetch } = fakeOpenRouter({
        ...metadata,
        override: (url) => (url.endsWith("/endpoints/zdr") ? json({}, 502) : undefined),
      });
      const checker = new HttpOpenrouterServabilityChecker({ fetch });

      const results = await checker.check([QWEN_30B, QWEN_27B], nebiusOnly);
      expect(results).toEqual([
        {
          model: QWEN_30B,
          status: "unknown",
          message: "OpenRouter responded with HTTP 502 to the zero-data-retention endpoint lookup",
        },
        {
          model: QWEN_27B,
          status: "unknown",
          message: "OpenRouter responded with HTTP 502 to the zero-data-retention endpoint lookup",
        },
      ]);
    });

    it("on a network error", async () => {
      const checker = new HttpOpenrouterServabilityChecker({
        fetch: async () => {
          throw new TypeError("fetch failed");
        },
      });

      const [result] = await checker.check([QWEN_30B], { ...strict, zdr: false });
      expect(result).toEqual({
        model: QWEN_30B,
        status: "unknown",
        message: "Could not reach OpenRouter for the model endpoint lookup: fetch failed",
      });
    });

    it("on a non-Error rejection", async () => {
      const checker = new HttpOpenrouterServabilityChecker({
        fetch: async () => {
          throw "offline";
        },
      });

      const [result] = await checker.check([QWEN_30B], { ...strict, zdr: false });
      expect(result).toMatchObject({
        status: "unknown",
        message: "Could not reach OpenRouter for the model endpoint lookup: offline",
      });
    });

    it("on a timeout", async () => {
      const checker = new HttpOpenrouterServabilityChecker({
        timeoutMs: 5,
        fetch: (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            });
          }),
      });

      const [result] = await checker.check([QWEN_30B], { ...strict, zdr: false });
      expect(result).toEqual({
        model: QWEN_30B,
        status: "unknown",
        message: "Timed out contacting OpenRouter for the model endpoint lookup",
      });
    });

    it.each([
      ["not JSON", new Response("<html>", { status: 200 })],
      ["no data", json({ nope: true })],
      ["not an object", json([])],
      ["no endpoint list", json({ data: { id: QWEN_30B } })],
    ])("on a malformed model answer (%s)", async (_label, response) => {
      const { fetch } = fakeOpenRouter({
        ...metadata,
        override: (url) => (url.includes(QWEN_30B) ? response : undefined),
      });
      const checker = new HttpOpenrouterServabilityChecker({ fetch });

      const [result] = await checker.check([QWEN_30B], { ...strict, zdr: false });
      expect(result).toEqual({
        model: QWEN_30B,
        status: "unknown",
        message: "OpenRouter returned an unexpected answer to the model endpoint lookup",
      });
    });

    it.each([
      ["no list", { data: "x" }],
      ["not an object", []],
    ])("on a malformed ZDR list (%s)", async (_label, body) => {
      const { fetch } = fakeOpenRouter({
        ...metadata,
        override: (url) => (url.endsWith("/endpoints/zdr") ? json(body) : undefined),
      });
      const checker = new HttpOpenrouterServabilityChecker({ fetch });

      const [result] = await checker.check([QWEN_30B], nebiusOnly);
      expect(result).toMatchObject({
        status: "unknown",
        message:
          "OpenRouter returned an unexpected answer to the zero-data-retention endpoint lookup",
      });
    });

    it("for a model id that cannot be looked up safely", async () => {
      const { fetch } = fakeOpenRouter(metadata);
      const checker = new HttpOpenrouterServabilityChecker({ fetch });

      const [result] = await checker.check(["vendor/model?x=1"], { ...strict, zdr: false });
      expect(result).toEqual({
        model: "vendor/model?x=1",
        status: "unknown",
        message: "Model id vendor/model?x=1 cannot be looked up on OpenRouter",
      });
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  it("ignores endpoint entries without a usable tag", async () => {
    const { fetch } = fakeOpenRouter({
      ...metadata,
      endpoints: {
        [QWEN_30B]: [
          { model_id: QWEN_30B, provider_name: "x", tag: "" },
          { model_id: QWEN_30B } as never,
          "junk" as never,
          endpoint(QWEN_30B, "nebius/fp8"),
        ],
      },
      zdr: [...metadata.zdr, "junk" as never, { tag: "nebius/fp8" } as never],
    });
    const checker = new HttpOpenrouterServabilityChecker({ fetch });

    const [result] = await checker.check([QWEN_30B], nebiusOnly);
    expect(result).toEqual({ model: QWEN_30B, status: "servable", endpoints: ["nebius/fp8"] });
  });

  it("uses the global fetch and the public API by default", async () => {
    const { fetch, calls } = fakeOpenRouter(metadata);
    vi.stubGlobal("fetch", fetch);
    try {
      const checker = new HttpOpenrouterServabilityChecker();
      await checker.check([QWEN_30B], nebiusOnly);
      expect(calls).toContain(`https://openrouter.ai/api/v1/models/${QWEN_30B}/endpoints`);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
