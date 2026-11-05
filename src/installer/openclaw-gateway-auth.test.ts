import { describe, expect, it } from "vitest";

import {
  generateGatewayToken,
  MANAGED_GATEWAY_TOKEN_BYTES,
  resolveManagedGatewayAuth,
} from "./openclaw-gateway-auth.js";

const fixedToken = () => "generated-token";

describe("generateGatewayToken", () => {
  it("returns 32 random bytes as hex", () => {
    const first = generateGatewayToken();
    expect(MANAGED_GATEWAY_TOKEN_BYTES).toBeGreaterThanOrEqual(32);
    expect(first).toMatch(new RegExp(`^[0-9a-f]{${MANAGED_GATEWAY_TOKEN_BYTES * 2}}$`));
    expect(generateGatewayToken()).not.toBe(first);
  });
});

describe("resolveManagedGatewayAuth", () => {
  it("generates a token when there is no auth block", () => {
    expect(resolveManagedGatewayAuth(undefined, fixedToken)).toEqual({
      mode: "token",
      token: "generated-token",
    });
    expect(resolveManagedGatewayAuth("not-a-block", fixedToken)).toEqual({
      mode: "token",
      token: "generated-token",
    });
  });

  it("uses the platform generator by default", () => {
    const auth = resolveManagedGatewayAuth(undefined);
    expect(auth.mode).toBe("token");
    expect(auth.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ["no token", { mode: "token" }],
    ["an empty token", { mode: "token", token: "" }],
    ["a blank token", { token: "   " }],
    ["a non-string token", { mode: "token", token: 42 }],
  ])("adds a token to a block with %s and keeps its other settings", (_label, existing) => {
    const auth = resolveManagedGatewayAuth(
      { ...existing, rateLimit: { maxAttempts: 5 } },
      fixedToken,
    );
    expect(auth).toEqual({
      mode: "token",
      token: "generated-token",
      rateLimit: { maxAttempts: 5 },
    });
  });

  it.each([
    ["the token 2026.3 persisted on its first start", { mode: "token", token: "a".repeat(48) }],
    ["a token without a mode", { token: "operator-token" }],
    ["a token secret reference", { mode: "token", token: { source: "env", id: "GW_TOKEN" } }],
    ["a password", { mode: "password", password: "hunter2-hunter2" }],
    ["a password without a mode", { password: { source: "file", id: "/run/pw" } }],
    ["open auth chosen on purpose", { mode: "none" }],
    ["trusted-proxy auth", { mode: "trusted-proxy", trustedProxy: { userHeader: "x-user" } }],
  ])("keeps %s unchanged", (_label, existing) => {
    const auth = resolveManagedGatewayAuth(existing, () => {
      throw new Error("must not generate");
    });
    expect(auth).toBe(existing);
  });

  it("does not count a password as the credential of an explicit token mode", () => {
    expect(
      resolveManagedGatewayAuth({ mode: "token", password: "stale-password" }, fixedToken),
    ).toEqual({ mode: "token", password: "stale-password", token: "generated-token" });
  });
});
