import { describe, expect, it } from "vitest";

import { onboardingIssueRequestSchema } from "./api.js";

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
