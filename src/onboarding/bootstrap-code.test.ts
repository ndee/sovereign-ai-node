import { describe, expect, it } from "vitest";

import {
  issueMatrixOnboardingState,
  parseMatrixOnboardingState,
  redeemMatrixOnboardingCode,
} from "./bootstrap-code.js";

describe("Matrix onboarding bootstrap code", () => {
  it("issues a state file without storing the plaintext code", () => {
    const issued = issueMatrixOnboardingState({
      passwordSecretRef: "file:/etc/sovereign-node/secrets/matrix-operator.password",
      username: "@operator:matrix.example.org",
      homeserverUrl: "https://matrix.example.org",
      now: new Date("2026-03-06T10:00:00.000Z"),
    });

    expect(issued.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(issued.state.codeHash).toHaveLength(64);
    expect(issued.state.codeSalt).toHaveLength(32);
    expect(JSON.stringify(issued.state)).not.toContain(issued.code);
  });

  it("redeems a valid code once and then marks it consumed", () => {
    const issued = issueMatrixOnboardingState({
      passwordSecretRef: "file:/etc/sovereign-node/secrets/matrix-operator.password",
      username: "@operator:matrix.example.org",
      homeserverUrl: "https://matrix.example.org",
      now: new Date("2026-03-06T10:00:00.000Z"),
    });

    const first = redeemMatrixOnboardingCode({
      state: issued.state,
      code: issued.code,
      now: new Date("2026-03-06T10:05:00.000Z"),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      throw new Error("expected first redeem to succeed");
    }
    expect(first.state.consumedAt).toBeTruthy();

    const second = redeemMatrixOnboardingCode({
      state: first.state,
      code: issued.code,
      now: new Date("2026-03-06T10:05:05.000Z"),
    });
    expect(second).toMatchObject({
      ok: false,
      reason: "consumed",
    });
  });

  it("rejects expired codes", () => {
    const issued = issueMatrixOnboardingState({
      passwordSecretRef: "file:/etc/sovereign-node/secrets/matrix-operator.password",
      username: "@operator:matrix.example.org",
      homeserverUrl: "https://matrix.example.org",
      now: new Date("2026-03-06T10:00:00.000Z"),
      ttlMinutes: 10,
    });

    const expired = redeemMatrixOnboardingCode({
      state: issued.state,
      code: issued.code,
      now: new Date("2026-03-06T10:11:00.000Z"),
    });
    expect(expired).toMatchObject({
      ok: false,
      reason: "expired",
    });
  });

  it("increments failed attempts and locks after too many invalid codes", () => {
    const issued = issueMatrixOnboardingState({
      passwordSecretRef: "file:/etc/sovereign-node/secrets/matrix-operator.password",
      username: "@operator:matrix.example.org",
      homeserverUrl: "https://matrix.example.org",
      now: new Date("2026-03-06T10:00:00.000Z"),
    });

    let state = issued.state;
    for (let index = 0; index < state.maxAttempts; index += 1) {
      const next = redeemMatrixOnboardingCode({
        state,
        code: "WRNG-WRNG-WRNG",
        now: new Date("2026-03-06T10:05:00.000Z"),
      });
      expect(next.ok).toBe(false);
      if (next.ok) {
        throw new Error("expected invalid code to fail");
      }
      state = next.state;
    }

    const locked = redeemMatrixOnboardingCode({
      state,
      code: issued.code,
      now: new Date("2026-03-06T10:05:10.000Z"),
    });
    expect(locked).toMatchObject({
      ok: false,
      reason: "locked",
    });
  });

  it("parses valid serialized state and rejects invalid shapes", () => {
    const issued = issueMatrixOnboardingState({
      passwordSecretRef: "file:/etc/sovereign-node/secrets/matrix-operator.password",
      username: "@operator:matrix.example.org",
      homeserverUrl: "https://matrix.example.org",
    });

    expect(parseMatrixOnboardingState(JSON.parse(JSON.stringify(issued.state)))).toEqual(
      issued.state,
    );
    expect(parseMatrixOnboardingState({
      ...issued.state,
      operatorPasswordSecretRef: issued.state.passwordSecretRef,
      passwordSecretRef: undefined,
    })).toEqual(issued.state);
    expect(parseMatrixOnboardingState({ foo: "bar" })).toBeNull();
  });
});
