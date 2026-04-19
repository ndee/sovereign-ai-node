import { z } from "zod";

import {
  baseErrorEnvelopeSchema,
  baseSuccessEnvelopeSchema,
  contractVersionSchema,
  isoTimestampSchema,
} from "./common.js";

export const cliSuccessEnvelopeSchema = <T extends z.ZodTypeAny>(
  command: string,
  resultSchema: T,
) =>
  baseSuccessEnvelopeSchema(resultSchema).extend({
    command: z.literal(command),
  });

export const cliAnySuccessEnvelopeSchema = <T extends z.ZodTypeAny>(resultSchema: T) =>
  baseSuccessEnvelopeSchema(resultSchema).extend({
    command: z.string().min(1),
  });

export const cliErrorEnvelopeSchema = baseErrorEnvelopeSchema.extend({
  command: z.string().min(1),
});

export const cliLogEventSchema = z.object({
  contractVersion: contractVersionSchema,
  type: z.enum(["log", "status", "end"]),
  source: z.string().min(1),
  timestamp: isoTimestampSchema,
  level: z.enum(["trace", "debug", "info", "warn", "error"]).optional(),
  message: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
});

export type CliLogEvent = z.infer<typeof cliLogEventSchema>;
