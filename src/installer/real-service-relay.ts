import { randomUUID } from "node:crypto";

import type { InstallRequest } from "../contracts/index.js";

import type { RuntimeConfig } from "./real-service-shared.js";

const DEFAULT_MANAGED_RELAY_CONTROL_URL = "https://relay.sovereign-ai-node.com";

const RELAY_NAME_THEMES = [
  "satoshi",
  "freedom",
  "privacy",
  "liberty",
  "cipher",
  "anon",
  "hodl",
  "sovereign",
  "bitcoin",
];

const RELAY_NAME_MOODS = [
  "stealthy",
  "mighty",
  "brave",
  "silent",
  "wild",
  "sunny",
  "cosmic",
  "fuzzy",
  "nimble",
];

const RELAY_NAME_MASCOTS = [
  "badger",
  "fox",
  "otter",
  "owl",
  "falcon",
  "lynx",
  "yak",
  "raven",
  "wolf",
];

export const isRelayModeRequest = (req: InstallRequest): boolean => {
  if (req.connectivity?.mode === "relay") {
    return true;
  }
  if (req.connectivity?.mode === "direct") {
    return false;
  }
  return req.relay !== undefined;
};

export const getRelayRequest = (req: InstallRequest): NonNullable<InstallRequest["relay"]> => {
  if (req.relay !== undefined) {
    return req.relay;
  }
  throw {
    code: "RELAY_CONFIG_MISSING",
    message: "Relay mode requires relay.controlUrl",
    retryable: false,
  };
};

export const isDefaultManagedRelayControlUrl = (controlUrl: string): boolean =>
  controlUrl.trim().replace(/\/+$/, "") === DEFAULT_MANAGED_RELAY_CONTROL_URL;

export const generateManagedRelayRequestedSlug = (): string => {
  const entropy = randomUUID().replace(/-/g, "");
  const pick = (values: readonly string[], offset: number): string => {
    const nibble = entropy.slice(offset, offset + 2);
    const value = Number.parseInt(nibble, 16);
    const index = Number.isFinite(value) ? value % values.length : 0;
    return values[index] ?? values[0] ?? "node";
  };
  const suffix = entropy.slice(0, 4);
  const raw =
    `${pick(RELAY_NAME_MOODS, 0)}-${pick(RELAY_NAME_THEMES, 2)}-${pick(RELAY_NAME_MASCOTS, 4)}-${suffix}`.toLowerCase();
  const normalized = raw
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return normalized.length === 0
    ? `sovereign-node-${suffix}`
    : normalized.slice(0, 63).replace(/-+$/, "");
};

export const buildRelayProvisionRequest = (input: {
  req: InstallRequest;
  hostname: string;
  publicBaseUrl: string;
  previousRuntimeConfig?: RuntimeConfig | null | undefined;
}): InstallRequest => {
  const homeserverDomain =
    input.previousRuntimeConfig?.matrix.accessMode === "direct"
      ? input.previousRuntimeConfig.matrix.homeserverDomain
      : input.hostname;
  return {
    ...input.req,
    connectivity: {
      ...(input.req.connectivity ?? {}),
      mode: "relay",
    },
    matrix: {
      ...input.req.matrix,
      homeserverDomain,
      publicBaseUrl: input.publicBaseUrl,
      federationEnabled: input.req.matrix.federationEnabled ?? false,
    },
  };
};
