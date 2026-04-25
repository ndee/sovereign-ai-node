import { describe, expect, it } from "vitest";

import {
  DEFAULT_SETUP_UI_BOOTSTRAP_TTL_MINUTES,
  issueSetupUiBootstrapState,
  parseSetupUiBootstrapState,
  projectSetupUiBootstrapPublicState,
  redeemSetupUiBootstrapToken,
} from "./setup-ui-bootstrap.js";

describe("setup-ui bootstrap-token primitives", () => {
  it("issues a token with a 24h default TTL and matching hash/salt", () => {
    const issued = issueSetupUiBootstrapState({ now: new Date("2025-01-01T00:00:00.000Z") });
    expect(issued.token).toMatch(/^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){2}$/);
    expect(issued.state.issuedAt).toBe("2025-01-01T00:00:00.000Z");
    expect(Date.parse(issued.state.expiresAt) - Date.parse(issued.state.issuedAt)).toBe(
      DEFAULT_SETUP_UI_BOOTSTRAP_TTL_MINUTES * 60_000,
    );
    expect(issued.state.maxAttempts).toBe(5);
    expect(issued.state.failedAttempts).toBe(0);
    expect(issued.state.codeHash).toHaveLength(64);
    expect(issued.state.codeSalt.length).toBeGreaterThan(0);
  });

  it("respects a custom ttlMinutes (clamped to >= 1)", () => {
    const issued = issueSetupUiBootstrapState({
      ttlMinutes: 5,
      now: new Date("2025-01-01T00:00:00.000Z"),
    });
    expect(issued.state.expiresAt).toBe("2025-01-01T00:05:00.000Z");
    const clamped = issueSetupUiBootstrapState({
      ttlMinutes: 0,
      now: new Date("2025-01-01T00:00:00.000Z"),
    });
    expect(clamped.state.expiresAt).toBe("2025-01-01T00:01:00.000Z");
  });

  it("redeems a valid token and marks state consumed", () => {
    const issued = issueSetupUiBootstrapState({ now: new Date("2025-01-01T00:00:00.000Z") });
    const result = redeemSetupUiBootstrapToken({
      state: issued.state,
      token: issued.token,
      now: new Date("2025-01-01T00:01:00.000Z"),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.consumedAt).toBe("2025-01-01T00:01:00.000Z");
    }
  });

  it("rejects an invalid token and increments failedAttempts", () => {
    const issued = issueSetupUiBootstrapState();
    const result = redeemSetupUiBootstrapToken({
      state: issued.state,
      token: "WRNG-TOKE-NXYZ",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid");
      expect(result.state.failedAttempts).toBe(1);
    }
  });

  it("rejects an already-consumed token", () => {
    const issued = issueSetupUiBootstrapState();
    const consumedState = { ...issued.state, consumedAt: "2025-01-01T00:00:00.000Z" };
    const result = redeemSetupUiBootstrapToken({ state: consumedState, token: issued.token });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("consumed");
  });

  it("rejects an expired token", () => {
    const issued = issueSetupUiBootstrapState({
      ttlMinutes: 1,
      now: new Date("2025-01-01T00:00:00.000Z"),
    });
    const result = redeemSetupUiBootstrapToken({
      state: issued.state,
      token: issued.token,
      now: new Date("2025-01-01T01:00:00.000Z"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
  });

  it("rejects a locked token (failedAttempts at max)", () => {
    const issued = issueSetupUiBootstrapState();
    const locked = { ...issued.state, failedAttempts: issued.state.maxAttempts };
    const result = redeemSetupUiBootstrapToken({ state: locked, token: issued.token });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("locked");
  });

  it("normalizes the candidate token (case + dashes)", () => {
    const issued = issueSetupUiBootstrapState();
    const lower = issued.token.toLowerCase().replace(/-/g, "");
    const result = redeemSetupUiBootstrapToken({ state: issued.state, token: lower });
    expect(result.ok).toBe(true);
  });

  it("parses well-formed state and rejects malformed", () => {
    const issued = issueSetupUiBootstrapState();
    const round = parseSetupUiBootstrapState(JSON.parse(JSON.stringify(issued.state)));
    expect(round).toEqual(issued.state);
    expect(parseSetupUiBootstrapState(null)).toBeNull();
    expect(parseSetupUiBootstrapState([])).toBeNull();
    expect(parseSetupUiBootstrapState({ version: 2 })).toBeNull();
    expect(parseSetupUiBootstrapState({ ...issued.state, codeHash: undefined })).toBeNull();
  });

  it("preserves consumedAt when parsing", () => {
    const issued = issueSetupUiBootstrapState();
    const consumed = { ...issued.state, consumedAt: "2025-01-01T00:00:00.000Z" };
    const parsed = parseSetupUiBootstrapState(JSON.parse(JSON.stringify(consumed)));
    expect(parsed?.consumedAt).toBe("2025-01-01T00:00:00.000Z");
  });

  it("clamps negative failedAttempts and zero maxAttempts when parsing", () => {
    const issued = issueSetupUiBootstrapState();
    const corrupt = { ...issued.state, failedAttempts: -5, maxAttempts: 0 };
    const parsed = parseSetupUiBootstrapState(JSON.parse(JSON.stringify(corrupt)));
    expect(parsed?.failedAttempts).toBe(0);
    expect(parsed?.maxAttempts).toBe(1);
  });

  it("projects public state without secrets", () => {
    const issued = issueSetupUiBootstrapState();
    const projectedConsumed = projectSetupUiBootstrapPublicState({
      ...issued.state,
      consumedAt: "2025-01-01T00:00:00.000Z",
    });
    expect(projectedConsumed.consumedAt).toBe("2025-01-01T00:00:00.000Z");

    const projectedUnconsumed = projectSetupUiBootstrapPublicState(issued.state);
    expect(projectedUnconsumed).not.toHaveProperty("consumedAt");

    expect(projectedConsumed).not.toHaveProperty("codeHash");
    expect(projectedConsumed).not.toHaveProperty("codeSalt");
  });
});
