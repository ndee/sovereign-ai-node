import { z } from "zod";

export const imapMessageSummarySchema = z.object({
  uid: z.number().int().positive(),
  messageId: z.string().min(1).optional(),
  subject: z.string().min(1).optional(),
  from: z.array(z.string().min(1)),
  to: z.array(z.string().min(1)),
  cc: z.array(z.string().min(1)),
  date: z.string().min(1).optional(),
  flags: z.array(z.string().min(1)),
  size: z.number().int().nonnegative().optional(),
});

export const imapAttachmentSummarySchema = z.object({
  filename: z.string().min(1).nullable(),
  mimeType: z.string().min(1),
  disposition: z.enum(["attachment", "inline"]).nullable(),
  related: z.boolean(),
  sizeBytes: z.number().int().nonnegative(),
});

export const imapSearchMailResultSchema = z.object({
  instanceId: z.string().min(1),
  mailbox: z.string().min(1),
  query: z.string().min(1),
  totalMatches: z.number().int().nonnegative(),
  messages: z.array(imapMessageSummarySchema),
});

export const imapReadMailResultSchema = z.object({
  instanceId: z.string().min(1),
  mailbox: z.string().min(1),
  selectedBy: z.enum(["uid", "message-id"]),
  message: imapMessageSummarySchema.extend({
    text: z.string(),
    textTruncated: z.boolean(),
    htmlAvailable: z.boolean(),
    attachments: z.array(imapAttachmentSummarySchema),
    bodyParseWarning: z.string().min(1).optional(),
  }),
});

export type ImapSearchMailResult = z.infer<typeof imapSearchMailResultSchema>;
export type ImapReadMailResult = z.infer<typeof imapReadMailResultSchema>;

export const guardedJsonStateRecordSchema = z.record(z.string(), z.unknown());

export const guardedJsonStateShowResultSchema = z.object({
  instanceId: z.string().min(1),
  statePath: z.string().min(1),
  policyPath: z.string().min(1),
  state: guardedJsonStateRecordSchema,
});

export const guardedJsonStateListResultSchema = z.object({
  instanceId: z.string().min(1),
  entity: z.string().min(1),
  count: z.number().int().nonnegative(),
  items: z.array(
    z.object({
      id: z.string().min(1).optional(),
      ownerMatrixUserId: z.string().min(1).optional(),
      parentKey: z.string().min(1).optional(),
      record: guardedJsonStateRecordSchema,
    }),
  ),
});

export const guardedJsonStateMutationResultSchema = z.object({
  instanceId: z.string().min(1),
  entity: z.string().min(1),
  actor: z.string().min(1),
  action: z.enum(["upsert-self", "delete-self"]),
  id: z.string().min(1),
  changed: z.boolean(),
  created: z.boolean().optional(),
  deleted: z.boolean().optional(),
  record: guardedJsonStateRecordSchema.optional(),
});

export type GuardedJsonStateShowResult = z.infer<typeof guardedJsonStateShowResultSchema>;
export type GuardedJsonStateListResult = z.infer<typeof guardedJsonStateListResultSchema>;
export type GuardedJsonStateMutationResult = z.infer<typeof guardedJsonStateMutationResultSchema>;
