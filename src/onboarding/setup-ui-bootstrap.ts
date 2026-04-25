import { randomBytes, timingSafeEqual } from "node:crypto";

import {
  generateMatrixOnboardingCode,
  hashMatrixOnboardingCode,
  normalizeMatrixOnboardingCode,
} from "./bootstrap-code.js";

export const DEFAULT_SETUP_UI_BOOTSTRAP_TTL_MINUTES = 24 * 60;
export const MAX_SETUP_UI_BOOTSTRAP_FAILED_ATTEMPTS = 5;

export type SetupUiBootstrapState = {
  version: 1;
  issuedAt: string;
  expiresAt: string;
  consumedAt?: string;
  failedAttempts: number;
  maxAttempts: number;
  codeSalt: string;
  codeHash: string;
};

export type SetupUiBootstrapPublicState = {
  issuedAt: string;
  expiresAt: string;
  consumedAt?: string;
  failedAttempts: number;
  maxAttempts: number;
};

export type SetupUiBootstrapRedeemResult =
  | { ok: true; state: SetupUiBootstrapState }
  | {
      ok: false;
      reason: "invalid" | "expired" | "consumed" | "locked";
      state: SetupUiBootstrapState;
    };

export const issueSetupUiBootstrapState = (input?: {
  ttlMinutes?: number;
  now?: Date;
}): { state: SetupUiBootstrapState; token: string } => {
  const issuedAt = input?.now ?? new Date();
  const ttlMinutes = Math.max(
    1,
    Math.trunc(input?.ttlMinutes ?? DEFAULT_SETUP_UI_BOOTSTRAP_TTL_MINUTES),
  );
  const expiresAt = new Date(issuedAt.getTime() + ttlMinutes * 60_000);
  const token = generateMatrixOnboardingCode();
  const salt = randomBytes(16).toString("hex");
  return {
    token,
    state: {
      version: 1,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      failedAttempts: 0,
      maxAttempts: MAX_SETUP_UI_BOOTSTRAP_FAILED_ATTEMPTS,
      codeSalt: salt,
      codeHash: hashMatrixOnboardingCode(token, salt),
    },
  };
};

export const parseSetupUiBootstrapState = (value: unknown): SetupUiBootstrapState | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    typeof candidate.issuedAt !== "string" ||
    typeof candidate.expiresAt !== "string" ||
    typeof candidate.failedAttempts !== "number" ||
    typeof candidate.maxAttempts !== "number" ||
    typeof candidate.codeSalt !== "string" ||
    typeof candidate.codeHash !== "string"
  ) {
    return null;
  }
  return {
    version: 1,
    issuedAt: candidate.issuedAt,
    expiresAt: candidate.expiresAt,
    ...(typeof candidate.consumedAt === "string" ? { consumedAt: candidate.consumedAt } : {}),
    failedAttempts: Math.max(0, Math.trunc(candidate.failedAttempts)),
    maxAttempts: Math.max(1, Math.trunc(candidate.maxAttempts)),
    codeSalt: candidate.codeSalt,
    codeHash: candidate.codeHash,
  };
};

export const redeemSetupUiBootstrapToken = (input: {
  state: SetupUiBootstrapState;
  token: string;
  now?: Date;
}): SetupUiBootstrapRedeemResult => {
  const current = input.state;
  const at = input.now ?? new Date();

  if (current.consumedAt !== undefined) {
    return { ok: false, reason: "consumed", state: current };
  }
  if (current.failedAttempts >= current.maxAttempts) {
    return { ok: false, reason: "locked", state: current };
  }
  if (Date.parse(current.expiresAt) <= at.getTime()) {
    return { ok: false, reason: "expired", state: current };
  }

  const candidate = normalizeMatrixOnboardingCode(input.token);
  const actualHash = Buffer.from(hashMatrixOnboardingCode(candidate, current.codeSalt), "hex");
  const expectedHash = Buffer.from(current.codeHash, "hex");
  const matches =
    actualHash.length === expectedHash.length && timingSafeEqual(actualHash, expectedHash);

  if (!matches) {
    return {
      ok: false,
      reason: "invalid",
      state: { ...current, failedAttempts: current.failedAttempts + 1 },
    };
  }

  return {
    ok: true,
    state: { ...current, consumedAt: at.toISOString() },
  };
};

export const projectSetupUiBootstrapPublicState = (
  state: SetupUiBootstrapState,
): SetupUiBootstrapPublicState => ({
  issuedAt: state.issuedAt,
  expiresAt: state.expiresAt,
  ...(state.consumedAt !== undefined ? { consumedAt: state.consumedAt } : {}),
  failedAttempts: state.failedAttempts,
  maxAttempts: state.maxAttempts,
});
