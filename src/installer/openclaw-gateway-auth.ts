import { randomBytes } from "node:crypto";

/**
 * The `gateway.auth` block node renders into the OpenClaw runtime config.
 *
 * Every local caller of the gateway (the bots' `/tools/invoke` calls, the
 * service user's OpenClaw CLI) authenticates with the token it reads from
 * `gateway.auth.token` in that config, so the config must carry one. OpenClaw
 * 2026.3 wrote a generated token there on its first gateway start; 2026.8 only
 * keeps a generated token in memory for that one process, and only
 * `openclaw gateway install` writes one, which node cannot run on a host
 * without a systemd user bus. Node therefore generates the token itself
 * whenever the existing config carries no credential.
 *
 * An existing block is kept exactly as it is whenever it already authenticates
 * callers: a token or password (literal or secret reference), or a mode other
 * than token chosen deliberately. A token is only ever added, never replaced,
 * so re-renders and updates keep the token callers already hold.
 */

/** 32 random bytes, hex-encoded: 256 bits from the platform CSPRNG. */
export const MANAGED_GATEWAY_TOKEN_BYTES = 32;

export const generateGatewayToken = (): string =>
  randomBytes(MANAGED_GATEWAY_TOKEN_BYTES).toString("hex");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isCredential = (value: unknown): boolean =>
  (typeof value === "string" && value.trim().length > 0) || isRecord(value);

const authenticatesCallers = (auth: Record<string, unknown>): boolean => {
  if (auth.mode !== undefined && auth.mode !== "token") {
    return true;
  }
  return isCredential(auth.token) || (auth.mode === undefined && isCredential(auth.password));
};

export const resolveManagedGatewayAuth = (
  existing: unknown,
  generateToken: () => string = generateGatewayToken,
): Record<string, unknown> => {
  if (isRecord(existing) && authenticatesCallers(existing)) {
    return existing;
  }
  return {
    ...(isRecord(existing) ? existing : {}),
    mode: "token",
    token: generateToken(),
  };
};
