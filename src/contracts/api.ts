import { z } from "zod";

import {
  baseErrorEnvelopeSchema,
  baseSuccessEnvelopeSchema,
  idSchema,
} from "./common.js";
import {
  doctorReportSchema,
  imapInstallInputSchema,
  installJobStatusResponseSchema,
  installRequestSchema,
  preflightResultSchema,
  reconfigureResultSchema,
  sovereignStatusSchema,
  startInstallResultSchema,
  testAlertResultSchema,
  testImapResultSchema,
  testMatrixResultSchema,
} from "./install.js";

export const preflightRequestSchema = installRequestSchema.partial();

export const testImapRequestSchema = z.object({
  imap: imapInstallInputSchema,
});

export const testMatrixRequestSchema = z.object({
  publicBaseUrl: z.string().min(1),
  federationEnabled: z.boolean().optional(),
});

export const testAlertRequestSchema = z.object({
  channel: z.literal("matrix").optional(),
  roomId: z.string().min(1).optional(),
  text: z.string().min(1).optional(),
});

export const reconfigureImapRequestSchema = z.object({
  imap: imapInstallInputSchema,
});

export const reconfigureMatrixRequestSchema = z.object({
  matrix: installRequestSchema.shape.matrix.partial().optional(),
  operator: installRequestSchema.shape.operator.partial().optional(),
  mailSentinel: z
    .object({
      e2eeAlertRoom: z.boolean().optional(),
    })
    .optional(),
});

export const installJobParamsSchema = z.object({
  jobId: idSchema,
});

export const preflightApiSuccessSchema = baseSuccessEnvelopeSchema(preflightResultSchema);
export const testImapApiSuccessSchema = baseSuccessEnvelopeSchema(testImapResultSchema);
export const testMatrixApiSuccessSchema = baseSuccessEnvelopeSchema(testMatrixResultSchema);
export const startInstallApiSuccessSchema = baseSuccessEnvelopeSchema(startInstallResultSchema);
export const installJobApiSuccessSchema = baseSuccessEnvelopeSchema(
  installJobStatusResponseSchema,
);
export const testAlertApiSuccessSchema = baseSuccessEnvelopeSchema(testAlertResultSchema);
export const statusApiSuccessSchema = baseSuccessEnvelopeSchema(sovereignStatusSchema);
export const doctorApiSuccessSchema = baseSuccessEnvelopeSchema(doctorReportSchema);
export const reconfigureApiSuccessSchema = baseSuccessEnvelopeSchema(reconfigureResultSchema);

export const apiErrorSchema = baseErrorEnvelopeSchema;

export type PreflightRequest = z.infer<typeof preflightRequestSchema>;
export type TestImapRequest = z.infer<typeof testImapRequestSchema>;
export type TestMatrixRequest = z.infer<typeof testMatrixRequestSchema>;
export type TestAlertRequest = z.infer<typeof testAlertRequestSchema>;
export type ReconfigureImapRequest = z.infer<typeof reconfigureImapRequestSchema>;
export type ReconfigureMatrixRequest = z.infer<typeof reconfigureMatrixRequestSchema>;

