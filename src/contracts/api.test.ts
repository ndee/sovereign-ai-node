import { describe, expect, it } from "vitest";

import { onboardingIssueRequestSchema, reconfigureOpenrouterRequestSchema } from "./api.js";

describe("onboardingIssueRequestSchema", () => {
  it("accepts an empty object", () => {
    expect(() => onboardingIssueRequestSchema.parse({})).not.toThrow();
  });

  it("accepts a positive integer ttlMinutes", () => {
    const parsed = onboardingIssueRequestSchema.parse({ ttlMinutes: 30 });
    expect(parsed).toEqual({ ttlMinutes: 30 });
  });

  it("rejects a non-numeric ttlMinutes", () => {
    expect(() => onboardingIssueRequestSchema.parse({ ttlMinutes: "soon" })).toThrow();
  });

  it("rejects unknown keys (strict)", () => {
    expect(() => onboardingIssueRequestSchema.parse({ unexpected: 1 })).toThrow();
  });
});

describe("reconfigureOpenrouterRequestSchema privacy", () => {
  const parse = (privacy: unknown, extra: Record<string, unknown> = {}) =>
    reconfigureOpenrouterRequestSchema.safeParse({ openrouter: { ...extra, privacy } });
  const messages = (result: { success: boolean; error?: { issues: { message: string }[] } }) =>
    result.error?.issues.map((issue) => issue.message) ?? [];

  it("accepts a request that only sets the provider allow-list", () => {
    const result = parse({ only: ["together", "deepinfra"] });
    expect(result.success).toBe(true);
    expect(result.data?.openrouter.privacy).toEqual({ only: ["together", "deepinfra"] });
  });

  it("trims provider slugs", () => {
    expect(parse({ only: [" together ", "deepinfra"] }).data?.openrouter.privacy).toEqual({
      only: ["together", "deepinfra"],
    });
  });

  it("accepts an empty allow-list, which clears it", () => {
    expect(parse({ only: [] }).data?.openrouter.privacy).toEqual({ only: [] });
  });

  it("accepts re-asserting the strict values together with a model change", () => {
    const result = parse(
      { zdr: true, dataCollection: "deny", allowFallbacks: false },
      { model: "openai/gpt-5" },
    );
    expect(result.success).toBe(true);
  });

  it.each([
    [{ zdr: false }, "openrouter.privacy.zdr cannot be turned off through reconfigure"],
    [
      { dataCollection: "allow" },
      'openrouter.privacy.dataCollection cannot be set to "allow" through reconfigure',
    ],
    [
      { allowFallbacks: true },
      "openrouter.privacy.allowFallbacks cannot be turned on through reconfigure",
    ],
  ])("rejects weakening the strict defaults: %j", (privacy, message) => {
    const result = parse({ ...privacy, only: ["together"] });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain(message);
  });

  it.each([
    ["an empty provider slug", { only: [""] }],
    ["a blank provider slug", { only: ["   "] }],
    ["a non-array allow-list", { only: "together" }],
    ["a non-string provider slug", { only: [42] }],
    ["an unknown key", { data_collection: "deny" }],
    ["a non-boolean zdr", { zdr: "yes" }],
    ["an unknown dataCollection value", { dataCollection: "maybe" }],
    ["a non-object block", ["together"]],
  ])("rejects %s", (_label, privacy) => {
    expect(parse(privacy).success).toBe(false);
  });

  it("still rejects apiKey together with secretRef", () => {
    const result = parse({ only: ["together"] }, { apiKey: "sk-or-new", secretRef: "file:/k" });
    expect(messages(result)).toEqual([
      "Provide openrouter.apiKey or openrouter.secretRef, not both",
    ]);
  });

  it("still requires at least one field", () => {
    const result = reconfigureOpenrouterRequestSchema.safeParse({ openrouter: {} });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain(
      "Provide at least one of openrouter.model, openrouter.apiKey, openrouter.secretRef, or openrouter.privacy",
    );
  });
});
