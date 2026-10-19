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
  uidValidity: z.string().min(1).optional(),
  /**
   * Non-fatal diagnostic about the mailbox view itself (e.g. a POP3 server
   * whose visible window excludes recent mail). Consumers that predate the
   * field ignore it.
   */
  note: z.string().min(1).optional(),
});

export const imapReadMailResultSchema = z.object({
  instanceId: z.string().min(1),
  mailbox: z.string().min(1),
  selectedBy: z.enum(["uid", "message-id"]),
  message: imapMessageSummarySchema.extend({
    headers: z.record(z.string(), z.string()).default({}),
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

const uidRangeSchema = z.tuple([z.number().int().positive(), z.number().int().positive()]);

const mailInventoryBaseSchema = z.object({
  instanceId: z.string().min(1),
  mailbox: z.string().min(1),
  inventoriedAt: z.string().min(1),
  /** Message count the server reports (IMAP `STATUS MESSAGES`, POP3 `STAT`). */
  messageCount: z.number().int().nonnegative(),
  /** Identifiers listed by this inventory. */
  count: z.number().int().nonnegative(),
});

export const imapMailInventoryResultSchema = mailInventoryBaseSchema.extend({
  protocol: z.literal("imap"),
  uidValidity: z.string().min(1).optional(),
  /** True when the caller's `--uid-validity` no longer matches the server's. */
  uidValidityChanged: z.boolean(),
  /** Effective lower bound: only UIDs above it are listed; 0 is a full census. */
  afterUid: z.number().int().nonnegative(),
  uidNext: z.number().int().positive().optional(),
  highestUid: z.number().int().positive().optional(),
  /** Listed UIDs as ascending, inclusive `[first, last]` runs. */
  uidRanges: z.array(uidRangeSchema),
  /** UIDs inside the census range that the server no longer lists. */
  uidGaps: z.number().int().nonnegative(),
});

export const pop3MailInventoryResultSchema = mailInventoryBaseSchema.extend({
  protocol: z.literal("pop3"),
  /** The search's `uidValidity`; absent while the POP3 index is absent or corrupt. */
  uidValidity: z.string().min(1).optional(),
  index: z.enum(["present", "absent", "corrupt"]),
  /** In server order. The UIDL itself is never emitted, only a short hash of it. */
  messages: z.array(
    z.object({
      uidlHash: z.string().regex(/^[0-9a-f]{12}$/),
      uid: z.number().int().positive().optional(),
      baseline: z.literal(true).optional(),
    }),
  ),
  unindexedCount: z.number().int().nonnegative(),
});

export const mailInventoryResultSchema = z.discriminatedUnion("protocol", [
  imapMailInventoryResultSchema,
  pop3MailInventoryResultSchema,
]);

export type ImapMailInventoryResult = z.infer<typeof imapMailInventoryResultSchema>;
export type Pop3MailInventoryResult = z.infer<typeof pop3MailInventoryResultSchema>;
export type MailInventoryResult = z.infer<typeof mailInventoryResultSchema>;
