import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const DEFAULT_MATRIX_ONBOARDING_TTL_MINUTES = 10;
export const MAX_MATRIX_ONBOARDING_FAILED_ATTEMPTS = 5;
const MATRIX_ONBOARDING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type MatrixOnboardingState = {
  version: 1;
  issuedAt: string;
  expiresAt: string;
  consumedAt?: string;
  failedAttempts: number;
  maxAttempts: number;
  codeSalt: string;
  codeHash: string;
  passwordSecretRef: string;
  username: string;
  homeserverUrl: string;
};

export type MatrixOnboardingIssueResult = {
  code: string;
  expiresAt: string;
  onboardingUrl: string;
  username: string;
};

export type MatrixOnboardingRedeemResult =
  | {
      ok: true;
      state: MatrixOnboardingState;
    }
  | {
      ok: false;
      reason: "invalid" | "expired" | "consumed" | "locked";
      state: MatrixOnboardingState;
    };

const nowIso = (): string => new Date().toISOString();

export const buildMatrixOnboardingUrl = (homeserverUrl: string): string =>
  `${homeserverUrl.replace(/\/+$/, "")}/onboard`;

export const normalizeMatrixOnboardingCode = (value: string): string =>
  value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

export const generateMatrixOnboardingCode = (): string => {
  const bytes = randomBytes(12);
  let raw = "";
  for (let index = 0; index < 12; index += 1) {
    const next = bytes[index];
    if (next === undefined) {
      throw new Error("Failed to generate onboarding code");
    }
    raw += MATRIX_ONBOARDING_CODE_ALPHABET[next % MATRIX_ONBOARDING_CODE_ALPHABET.length];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
};

export const hashMatrixOnboardingCode = (code: string, salt: string): string =>
  createHash("sha256")
    .update(`${salt}:${normalizeMatrixOnboardingCode(code)}`, "utf8")
    .digest("hex");

export const issueMatrixOnboardingState = (input: {
  passwordSecretRef: string;
  username: string;
  homeserverUrl: string;
  ttlMinutes?: number;
  now?: Date;
}): { state: MatrixOnboardingState; code: string } => {
  const issuedAt = input.now ?? new Date();
  const ttlMinutes = Math.max(1, Math.trunc(input.ttlMinutes ?? DEFAULT_MATRIX_ONBOARDING_TTL_MINUTES));
  const expiresAt = new Date(issuedAt.getTime() + ttlMinutes * 60_000);
  const code = generateMatrixOnboardingCode();
  const salt = randomBytes(16).toString("hex");
  return {
    code,
    state: {
      version: 1,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      failedAttempts: 0,
      maxAttempts: MAX_MATRIX_ONBOARDING_FAILED_ATTEMPTS,
      codeSalt: salt,
      codeHash: hashMatrixOnboardingCode(code, salt),
      passwordSecretRef: input.passwordSecretRef,
      username: input.username,
      homeserverUrl: input.homeserverUrl,
    },
  };
};

export const parseMatrixOnboardingState = (value: unknown): MatrixOnboardingState | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1
    || typeof candidate.issuedAt !== "string"
    || typeof candidate.expiresAt !== "string"
    || typeof candidate.failedAttempts !== "number"
    || typeof candidate.maxAttempts !== "number"
    || typeof candidate.codeSalt !== "string"
    || typeof candidate.codeHash !== "string"
    || typeof candidate.username !== "string"
    || typeof candidate.homeserverUrl !== "string"
  ) {
    return null;
  }
  const passwordSecretRef =
    typeof candidate.passwordSecretRef === "string"
      ? candidate.passwordSecretRef
      : typeof candidate.operatorPasswordSecretRef === "string"
        ? candidate.operatorPasswordSecretRef
        : null;
  if (passwordSecretRef === null) {
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
    passwordSecretRef,
    username: candidate.username,
    homeserverUrl: candidate.homeserverUrl,
  };
};

export const redeemMatrixOnboardingCode = (input: {
  state: MatrixOnboardingState;
  code: string;
  now?: Date;
}): MatrixOnboardingRedeemResult => {
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

  const actualHash = Buffer.from(hashMatrixOnboardingCode(input.code, current.codeSalt), "hex");
  const expectedHash = Buffer.from(current.codeHash, "hex");
  const hashMatches = actualHash.length === expectedHash.length
    && timingSafeEqual(actualHash, expectedHash);

  if (!hashMatches) {
    return {
      ok: false,
      reason: "invalid",
      state: {
        ...current,
        failedAttempts: current.failedAttempts + 1,
      },
    };
  }

  return {
    ok: true,
    state: {
      ...current,
      consumedAt: nowIso(),
    },
  };
};
