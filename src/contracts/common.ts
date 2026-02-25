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

export const componentHealthSchema = z.enum([
  "healthy",
  "degraded",
  "unhealthy",
  "unknown",
]);

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

