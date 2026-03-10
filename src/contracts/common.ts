import { z } from "zod";

export const CONTRACT_VERSION = "1.0.0" as const;

export const contractVersionSchema = z.literal(CONTRACT_VERSION);
export const isoTimestampSchema = z.string().min(1);
export const idSchema = z.string().min(1);

export const errorDetailSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const checkStatusSchema = z.enum(["pass", "warn", "fail", "skip"]);

export const checkResultSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: checkStatusSchema,
  message: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const componentHealthSchema = z.enum(["healthy", "degraded", "unhealthy", "unknown"]);

export const baseSuccessEnvelopeSchema = <T extends z.ZodTypeAny>(resultSchema: T) =>
  z.object({
    contractVersion: contractVersionSchema,
    ok: z.literal(true),
    timestamp: isoTimestampSchema,
    requestId: z.string().min(1),
    result: resultSchema,
  });

export const baseErrorEnvelopeSchema = z.object({
  contractVersion: contractVersionSchema,
  ok: z.literal(false),
  timestamp: isoTimestampSchema,
  requestId: z.string().min(1),
  error: errorDetailSchema,
});

export type ErrorDetail = z.infer<typeof errorDetailSchema>;
export type CheckResult = z.infer<typeof checkResultSchema>;
export type ComponentHealth = z.infer<typeof componentHealthSchema>;

export const normalizeErrorDetail = (error: unknown, fallbackCode: string): ErrorDetail => {
  if (error instanceof Error) {
    return {
      code: fallbackCode,
      message: error.message,
      retryable: false,
    };
  }

  if (isRecord(error)) {
    return {
      code: typeof error.code === "string" && error.code.length > 0 ? error.code : fallbackCode,
      message:
        typeof error.message === "string" && error.message.length > 0
          ? error.message
          : summarizeUnknownError(error),
      retryable: error.retryable === true,
      ...(isRecord(error.details) ? { details: error.details } : {}),
    };
  }

  return {
    code: fallbackCode,
    message: summarizeUnknownError(error),
    retryable: false,
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const summarizeUnknownError = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};
