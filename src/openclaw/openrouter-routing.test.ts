import { describe, expect, it } from "vitest";

import {
  buildOpenClawOpenRouterModelParams,
  buildOpenClawOpenRouterModelsParams,
  buildOpenRouterProviderRouting,
  DEFAULT_OPENROUTER_PRIVACY,
  mergeOpenRouterPrivacy,
  resolveOpenRouterPrivacy,
  sameOpenRouterPrivacy,
} from "./openrouter-routing.js";

describe("resolveOpenRouterPrivacy", () => {
  it("defaults to the strict profile when nothing is configured", () => {
    expect(resolveOpenRouterPrivacy(undefined)).toEqual({
      zdr: true,
      dataCollection: "deny",
      allowFallbacks: false,
    });
    expect(resolveOpenRouterPrivacy(null)).toEqual(DEFAULT_OPENROUTER_PRIVACY);
    expect(resolveOpenRouterPrivacy("nope")).toEqual(DEFAULT_OPENROUTER_PRIVACY);
    expect(resolveOpenRouterPrivacy([])).toEqual(DEFAULT_OPENROUTER_PRIVACY);
  });

  it("honours explicit opt-outs", () => {
    expect(
      resolveOpenRouterPrivacy({
        zdr: false,
        dataCollection: "allow",
        allowFallbacks: true,
        only: ["together", " deepinfra ", "together", "", 42],
      }),
    ).toEqual({
      zdr: false,
      dataCollection: "allow",
      allowFallbacks: true,
      only: ["together", "deepinfra"],
    });
  });

  it("falls back to strict defaults for malformed values", () => {
    expect(
      resolveOpenRouterPrivacy({
        zdr: "false",
        dataCollection: "maybe",
        allowFallbacks: 1,
        only: "together",
      }),
    ).toEqual(DEFAULT_OPENROUTER_PRIVACY);
    expect(resolveOpenRouterPrivacy({ only: [] })).toEqual(DEFAULT_OPENROUTER_PRIVACY);
    expect(resolveOpenRouterPrivacy({ only: ["  "] })).toEqual(DEFAULT_OPENROUTER_PRIVACY);
  });
});

describe("mergeOpenRouterPrivacy", () => {
  const current = {
    zdr: true,
    dataCollection: "deny" as const,
    allowFallbacks: false,
    only: ["together"],
  };

  it("keeps every field the update omits", () => {
    expect(mergeOpenRouterPrivacy(current, {})).toEqual(current);
    expect(mergeOpenRouterPrivacy(current, { zdr: true, only: undefined })).toEqual(current);
  });

  it("replaces the allow-list, trimmed and de-duplicated", () => {
    expect(
      mergeOpenRouterPrivacy(current, { only: [" deepinfra ", "fireworks", "deepinfra"] }),
    ).toEqual({ ...current, only: ["deepinfra", "fireworks"] });
  });

  it("clears the allow-list on an empty list", () => {
    expect(mergeOpenRouterPrivacy(current, { only: [] })).toEqual(DEFAULT_OPENROUTER_PRIVACY);
  });

  it("keeps an install-time opt-out the update does not touch", () => {
    const optedOut = { zdr: false, dataCollection: "allow" as const, allowFallbacks: true };
    expect(mergeOpenRouterPrivacy(optedOut, { only: ["together"] })).toEqual({
      ...optedOut,
      only: ["together"],
    });
    expect(mergeOpenRouterPrivacy(optedOut, { zdr: true })).toEqual({ ...optedOut, zdr: true });
  });
});

describe("sameOpenRouterPrivacy", () => {
  it("compares the rendered routing blocks", () => {
    expect(
      sameOpenRouterPrivacy(DEFAULT_OPENROUTER_PRIVACY, { ...DEFAULT_OPENROUTER_PRIVACY }),
    ).toBe(true);
    expect(
      sameOpenRouterPrivacy(
        { ...DEFAULT_OPENROUTER_PRIVACY, only: ["together"] },
        { ...DEFAULT_OPENROUTER_PRIVACY, only: ["together"] },
      ),
    ).toBe(true);
    expect(
      sameOpenRouterPrivacy(DEFAULT_OPENROUTER_PRIVACY, {
        ...DEFAULT_OPENROUTER_PRIVACY,
        only: ["together"],
      }),
    ).toBe(false);
    expect(
      sameOpenRouterPrivacy(DEFAULT_OPENROUTER_PRIVACY, {
        ...DEFAULT_OPENROUTER_PRIVACY,
        zdr: false,
      }),
    ).toBe(false);
  });
});

describe("buildOpenRouterProviderRouting", () => {
  it("renders the OpenRouter request-body provider block", () => {
    expect(buildOpenRouterProviderRouting(DEFAULT_OPENROUTER_PRIVACY)).toEqual({
      data_collection: "deny",
      zdr: true,
      allow_fallbacks: false,
    });
    const only = ["together"];
    const routing = buildOpenRouterProviderRouting({
      zdr: false,
      dataCollection: "allow",
      allowFallbacks: true,
      only,
    });
    expect(routing).toEqual({
      data_collection: "allow",
      zdr: false,
      allow_fallbacks: true,
      only: ["together"],
    });
    expect(routing.only).not.toBe(only);
  });
});

describe("buildOpenClawOpenRouterModelParams", () => {
  it("keys the params block by openrouter/<model>", () => {
    expect(
      buildOpenClawOpenRouterModelParams("qwen/qwen-2.5-7b-instruct", DEFAULT_OPENROUTER_PRIVACY),
    ).toEqual({
      "openrouter/qwen/qwen-2.5-7b-instruct": {
        params: {
          provider: { data_collection: "deny", zdr: true, allow_fallbacks: false },
        },
      },
    });
  });

  it("does not double the provider prefix", () => {
    expect(
      Object.keys(
        buildOpenClawOpenRouterModelParams("OpenRouter/openai/gpt-5", DEFAULT_OPENROUTER_PRIVACY),
      ),
    ).toEqual(["openrouter/openai/gpt-5"]);
  });
});

describe("buildOpenClawOpenRouterModelsParams", () => {
  const strict = { provider: { data_collection: "deny", zdr: true, allow_fallbacks: false } };

  it("routes every OpenRouter model in use, not just the default", () => {
    const models = buildOpenClawOpenRouterModelsParams(
      [
        "openrouter/qwen/qwen-2.5-7b-instruct",
        "openrouter/qwen/qwen3.5-27b",
        "openrouter/qwen/qwen3.5-27b",
        "OpenRouter/openai/gpt-5",
      ],
      DEFAULT_OPENROUTER_PRIVACY,
    );
    expect(models).toEqual({
      "openrouter/qwen/qwen-2.5-7b-instruct": { params: strict },
      "openrouter/qwen/qwen3.5-27b": { params: strict },
      "openrouter/openai/gpt-5": { params: strict },
    });
  });

  it("leaves non-OpenRouter models without a routing block", () => {
    expect(
      buildOpenClawOpenRouterModelsParams(
        ["openrouter/qwen/qwen3.5-27b", "ollama/llama3.2:3b/q4"],
        DEFAULT_OPENROUTER_PRIVACY,
      ),
    ).toEqual({ "openrouter/qwen/qwen3.5-27b": { params: strict } });
  });

  it("applies an explicit privacy opt-out to every model", () => {
    const privacy = resolveOpenRouterPrivacy({
      zdr: false,
      dataCollection: "allow",
      allowFallbacks: true,
      only: ["together"],
    });
    const models = buildOpenClawOpenRouterModelsParams(
      ["openrouter/a/one", "openrouter/b/two"],
      privacy,
    );
    for (const entry of Object.values(models)) {
      expect(entry).toEqual({
        params: {
          provider: {
            data_collection: "allow",
            zdr: false,
            allow_fallbacks: true,
            only: ["together"],
          },
        },
      });
    }
  });

  it("keeps existing per-model params and replaces only the provider block", () => {
    const existing = {
      "openrouter/qwen/qwen3.5-27b": {
        alias: "qwen",
        params: {
          temperature: 0.2,
          provider: { data_collection: "allow", zdr: false, allow_fallbacks: true, only: ["x"] },
        },
      },
      "openrouter/a/no-params": { alias: "plain", params: "broken" },
      "ollama/llama3.2:3b/q4": { params: { temperature: 0.5 } },
      "openrouter/stale/model": { params: { temperature: 0.9 } },
    };
    const models = buildOpenClawOpenRouterModelsParams(
      ["openrouter/qwen/qwen3.5-27b", "openrouter/a/no-params", "ollama/llama3.2:3b/q4"],
      DEFAULT_OPENROUTER_PRIVACY,
      existing,
    );
    expect(models).toEqual({
      "openrouter/qwen/qwen3.5-27b": { alias: "qwen", params: { temperature: 0.2, ...strict } },
      "openrouter/a/no-params": { alias: "plain", params: strict },
      "ollama/llama3.2:3b/q4": { params: { temperature: 0.5 } },
    });
    // Re-rendering from its own output is a no-op.
    expect(
      buildOpenClawOpenRouterModelsParams(
        ["openrouter/qwen/qwen3.5-27b", "openrouter/a/no-params", "ollama/llama3.2:3b/q4"],
        DEFAULT_OPENROUTER_PRIVACY,
        models,
      ),
    ).toEqual(models);
    expect(existing["openrouter/qwen/qwen3.5-27b"].params.provider.zdr).toBe(false);
  });

  it("ignores a malformed existing map", () => {
    expect(
      buildOpenClawOpenRouterModelsParams(["openrouter/a/one"], DEFAULT_OPENROUTER_PRIVACY, [1]),
    ).toEqual({ "openrouter/a/one": { params: strict } });
  });
});
