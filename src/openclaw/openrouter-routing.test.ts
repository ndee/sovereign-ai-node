import { describe, expect, it } from "vitest";

import {
  buildOpenClawOpenRouterModelParams,
  buildOpenRouterProviderRouting,
  DEFAULT_OPENROUTER_PRIVACY,
  resolveOpenRouterPrivacy,
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
