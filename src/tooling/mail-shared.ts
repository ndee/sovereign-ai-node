import { readFile } from "node:fs/promises";

/**
 * Helpers shared by the IMAP and POP3 read-only tool services: the tool error
 * type, secret-ref resolution, tool-instance value parsing and the
 * body/header normalisation applied to fetched messages.
 */

export class SovereignToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly details?: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SovereignToolError";
  }
}

export const resolveSecretRefValue = async (secretRef: string): Promise<string> => {
  if (secretRef.startsWith("file:")) {
    const filePath = secretRef.slice("file:".length);
    try {
      const raw = await readFile(filePath, "utf8");
      const value = stripSingleTrailingNewline(raw);
      if (value.length > 0) {
        return value;
      }
      throw new SovereignToolError("SECRET_READ_FAILED", "Secret file is empty", false, {
        secretRef,
      });
    } catch (error) {
      if (error instanceof SovereignToolError) {
        throw error;
      }
      throw new SovereignToolError(
        "SECRET_READ_FAILED",
        `Failed to read secret file for ${secretRef}`,
        false,
        {
          secretRef,
          error: error instanceof Error ? error.message : String(error),
        },
        { cause: error instanceof Error ? error : undefined },
      );
    }
  }

  if (secretRef.startsWith("env:")) {
    const key = secretRef.slice("env:".length);
    const value = process.env[key];
    if (value !== undefined && value.length > 0) {
      return value;
    }
    throw new SovereignToolError(
      "SECRET_READ_FAILED",
      `Environment variable ${key} referenced by ${secretRef} is not set`,
      false,
      {
        secretRef,
      },
    );
  }

  throw new SovereignToolError(
    "SECRET_REF_UNSUPPORTED",
    `Unsupported secretRef format for ${secretRef}`,
    false,
    {
      secretRef,
    },
  );
};

const stripSingleTrailingNewline = (value: string): string => value.replace(/\r?\n$/, "");

export const parseBooleanString = (value: string, key: string, instanceId: string): boolean => {
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  throw new SovereignToolError(
    "TOOL_INSTANCE_INVALID",
    `Tool instance '${instanceId}' has an invalid boolean value for '${key}'`,
    false,
    {
      instanceId,
      key,
      value,
    },
  );
};

export const parsePort = (value: string, instanceId: string): number => {
  const parsed = Number.parseInt(value, 10);
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535) {
    return parsed;
  }
  throw new SovereignToolError(
    "TOOL_INSTANCE_INVALID",
    `Tool instance '${instanceId}' has an invalid IMAP port`,
    false,
    {
      instanceId,
      value,
    },
  );
};

export const truncateText = (
  value: string,
  maxChars: number,
): { text: string; truncated: boolean } => {
  const normalized = value.trim();
  if (normalized.length <= maxChars) {
    return {
      text: normalized,
      truncated: false,
    };
  }
  return {
    text: `${normalized.slice(0, maxChars).trimEnd()}\n\n[truncated]`,
    truncated: true,
  };
};

export const stripHtmlTags = (value: string): string =>
  value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const normalizeParsedHeaders = (value: unknown): Record<string, string> => {
  if (value instanceof Map) {
    return Object.fromEntries(
      Array.from(value.entries()).flatMap(([key, entryValue]) => {
        if (typeof key !== "string") {
          return [];
        }
        if (Array.isArray(entryValue)) {
          return [[key.toLowerCase(), entryValue.map((part) => String(part)).join(", ")]];
        }
        if (entryValue === undefined || entryValue === null) {
          return [];
        }
        return [[key.toLowerCase(), String(entryValue)]];
      }),
    );
  }
  if (Array.isArray(value)) {
    return Object.fromEntries(
      value.flatMap((entry) => {
        if (entry && typeof entry === "object") {
          const record = entry as Record<string, unknown>;
          const key = typeof record.key === "string" ? record.key : record.name;
          if (typeof key === "string" && typeof record.value === "string") {
            return [[key.toLowerCase(), record.value]];
          }
        }
        return [];
      }),
    );
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, entryValue]) => {
        if (Array.isArray(entryValue)) {
          return [[key.toLowerCase(), entryValue.map((part) => String(part)).join(", ")]];
        }
        if (typeof entryValue === "string") {
          return [[key.toLowerCase(), entryValue]];
        }
        return [];
      }),
    );
  }
  return {};
};
