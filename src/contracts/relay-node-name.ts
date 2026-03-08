import { z } from "zod";

export const RELAY_NODE_NAME_MAX_LENGTH = 48;

export const sanitizeRelayNodeName = (value: string): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+/g, "")
    .replace(/-+$/g, "");
  return normalized.slice(0, RELAY_NODE_NAME_MAX_LENGTH).replace(/-+$/g, "");
};

export const normalizeOptionalRelayNodeName = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const normalized = sanitizeRelayNodeName(value);
  if (normalized.length === 0) {
    throw new Error("Relay node names must include at least one lowercase letter or number");
  }
  return normalized;
};

export const relayNodeNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(RELAY_NODE_NAME_MAX_LENGTH)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "relay.requestedNodeName must contain only lowercase letters, numbers, and single dashes",
  );
