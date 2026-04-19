import { z } from "zod";

import { contractVersionSchema, isoTimestampSchema } from "./common.js";

export const backupManifestItemSchema = z.object({
  key: z.string().min(1),
  relativePath: z.string().min(1),
  description: z.string().min(1),
  optional: z.boolean().optional(),
});

export const backupManifestSchema = z.object({
  version: z.literal("1"),
  createdAt: isoTimestampSchema,
  sovereignNodeVersion: z.string().min(1),
  contractVersion: contractVersionSchema,
  homeserverDomain: z.string().min(1).optional(),
  items: z.array(backupManifestItemSchema),
});

export const backupCreateResultSchema = z.object({
  archivePath: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  createdAt: isoTimestampSchema,
  manifest: backupManifestSchema,
});

export const backupListEntrySchema = z.object({
  filename: z.string().min(1),
  path: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  createdAt: isoTimestampSchema,
});

export const backupListResultSchema = z.object({
  backupsDir: z.string().min(1),
  backups: z.array(backupListEntrySchema),
});

export const backupRestoreResultSchema = z.object({
  archivePath: z.string().min(1),
  restoredAt: isoTimestampSchema,
  manifest: backupManifestSchema,
  warnings: z.array(z.string()),
});

export type BackupManifestItem = z.infer<typeof backupManifestItemSchema>;
export type BackupManifest = z.infer<typeof backupManifestSchema>;
export type BackupCreateResult = z.infer<typeof backupCreateResultSchema>;
export type BackupListEntry = z.infer<typeof backupListEntrySchema>;
export type BackupListResult = z.infer<typeof backupListResultSchema>;
export type BackupRestoreResult = z.infer<typeof backupRestoreResultSchema>;
