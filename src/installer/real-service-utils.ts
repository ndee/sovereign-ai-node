import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";

import type { BotConfigRecord, BotConfigValue } from "../bots/catalog.js";

import {
  ensureTrailingSlash,
  isRecord,
  type RuntimeBotInstance,
  type RuntimeConfig,
  sanitizeExpectedMatrixLocalpart,
} from "./real-service-shared.js";

export const dedupeStrings = (values: string[]): string[] =>
  Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));

export const resolveExpectedBundledBotLocalpart = (
  operatorLocalpart: string,
  preferredLocalpart?: string,
): string => {
  const desiredLocalpart = sanitizeExpectedMatrixLocalpart(
    preferredLocalpart ?? "service-bot",
    "service-bot",
  );
  return operatorLocalpart === desiredLocalpart ? `${desiredLocalpart}-bot` : desiredLocalpart;
};

export const toSystemdDuration = (value: string): string => {
  const match = value.match(/^(\d+)\s*(m|h|d|s)/i);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return "30min";
  }
  const systemdUnit = match[2].toLowerCase() === "m" ? "min" : match[2].toLowerCase();
  return `${match[1]}${systemdUnit}`;
};

export const isManagedAgentMatrixAccessTokenFileName = (fileName: string): boolean =>
  /^matrix-agent-.+-access-token$/.test(fileName);

export const shouldGateSystemGatewayOnLocalMatrix = (adminBaseUrl: string): boolean => {
  try {
    const parsed = new URL(adminBaseUrl);
    const hostname = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
    return (
      parsed.protocol === "http:" &&
      (hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost")
    );
  } catch {
    return false;
  }
};

export const renderSystemGatewayMatrixWaitCommand = (input: {
  adminBaseUrl: string;
  attempts: number;
  delaySeconds: number;
  timeoutSeconds: number;
}): string => {
  const versionsUrl = new URL(
    "/_matrix/client/versions",
    ensureTrailingSlash(input.adminBaseUrl),
  ).toString();
  return [
    "/usr/bin/env",
    "sh",
    "-lc",
    `'attempt=0; while [ "$attempt" -lt ${input.attempts} ]; do curl -fsS --max-time ${input.timeoutSeconds} "${versionsUrl}" >/dev/null 2>&1 && exit 0; attempt=$((attempt + 1)); sleep ${input.delaySeconds}; done; exit 1'`,
  ].join(" ");
};

export const isBotConfigRecordMap = (value: unknown): value is Record<string, BotConfigRecord> => {
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).every(
    (entry) =>
      isRecord(entry) &&
      Object.values(entry).every(
        (item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean",
      ),
  );
};

export const normalizeBotConfigRecord = (value: unknown): BotConfigRecord =>
  !isRecord(value)
    ? {}
    : Object.fromEntries(
        Object.entries(value)
          .filter(
            (entry): entry is [string, BotConfigValue] =>
              typeof entry[0] === "string" &&
              entry[0].length > 0 &&
              (typeof entry[1] === "string" ||
                typeof entry[1] === "number" ||
                typeof entry[1] === "boolean"),
          )
          .sort(([left], [right]) => left.localeCompare(right)),
      );

export const normalizeMatrixUserList = (values: string[]): string[] =>
  dedupeStrings(
    values
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .sort((left, right) => left.localeCompare(right)),
  );

export const rewriteAllowedUsersToHomeserverDomain = (
  values: readonly string[],
  homeserverDomain: string,
): string[] => {
  const rewritten = values
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const withoutAt = entry.startsWith("@") ? entry.slice(1) : entry;
      const separatorIndex = withoutAt.indexOf(":");
      const localpart = separatorIndex >= 0 ? withoutAt.slice(0, separatorIndex) : withoutAt;
      if (localpart.length === 0) {
        return "";
      }
      return `@${localpart}:${homeserverDomain}`;
    })
    .filter((entry) => entry.length > 0);
  return normalizeMatrixUserList(rewritten);
};

export const sortBotInstances = (entries: RuntimeBotInstance[]): RuntimeBotInstance[] =>
  [...entries].sort((left, right) => left.id.localeCompare(right.id));

export const sortInstalledTemplates = (
  entries: RuntimeConfig["templates"]["installed"],
): RuntimeConfig["templates"]["installed"] =>
  [...entries].sort((left, right) =>
    `${left.kind}:${left.id}:${left.version}`.localeCompare(
      `${right.kind}:${right.id}:${right.version}`,
    ),
  );

export const sortToolInstances = (
  entries: RuntimeConfig["sovereignTools"]["instances"],
): RuntimeConfig["sovereignTools"]["instances"] =>
  [...entries].sort((left, right) => left.id.localeCompare(right.id));

export const resolveExecutablePath = async (command: string): Promise<string | null> => {
  if (command.includes("/")) {
    return command;
  }

  const pathValue = process.env.PATH ?? "";
  for (const entry of pathValue.split(delimiter)) {
    if (entry.length === 0) {
      continue;
    }
    const candidate = join(entry, command);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {}
  }

  return null;
};
