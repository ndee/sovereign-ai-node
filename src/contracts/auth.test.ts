import { describe, expect, it } from "vitest";

import {
  authLoginRequestSchema,
  authStateSchema,
  setupUiBootstrapIssueResultSchema,
  setupUiBootstrapPublicStateSchema,
} from "./auth.js";

describe("auth contracts", () => {
  it("authStateSchema accepts both authenticated and unauthenticated shapes", () => {
    expect(authStateSchema.parse({ authenticated: false, stage: "needs-bootstrap" })).toEqual({
      authenticated: false,
      stage: "needs-bootstrap",
    });
    expect(
      authStateSchema.parse({
        authenticated: true,
        stage: "needs-password",
        username: "@admin:example",
        csrf: "csrf-token",
      }),
    ).toMatchObject({
      stage: "needs-password",
      username: "@admin:example",
      csrf: "csrf-token",
    });
  });

  it("authLoginRequestSchema requires at least token or password", () => {
    expect(() => authLoginRequestSchema.parse({})).toThrow();
    expect(authLoginRequestSchema.parse({ token: "ABCD-EFGH-JKLM" })).toEqual({
      token: "ABCD-EFGH-JKLM",
    });
    expect(authLoginRequestSchema.parse({ password: "p" })).toEqual({ password: "p" });
  });

  it("authLoginRequestSchema is strict and rejects unknown keys", () => {
    expect(() => authLoginRequestSchema.parse({ token: "x", extra: 1 })).toThrow();
  });

  it("setupUiBootstrapIssueResultSchema validates token+expiresAt+ttlMinutes", () => {
    expect(() =>
      setupUiBootstrapIssueResultSchema.parse({
        token: "ABCD-EFGH-JKLM",
        expiresAt: "2026-01-01T00:00:00.000Z",
        ttlMinutes: 30,
      }),
    ).not.toThrow();
    expect(() =>
      setupUiBootstrapIssueResultSchema.parse({
        token: "x",
        expiresAt: "y",
        ttlMinutes: -5,
      }),
    ).toThrow();
  });

  it("setupUiBootstrapPublicStateSchema accepts the public projection (no secrets)", () => {
    expect(() =>
      setupUiBootstrapPublicStateSchema.parse({
        issuedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-02T00:00:00.000Z",
        failedAttempts: 0,
        maxAttempts: 5,
      }),
    ).not.toThrow();
  });
});
