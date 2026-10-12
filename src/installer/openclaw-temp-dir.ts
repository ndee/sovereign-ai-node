import type { Stats } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * The caches OpenClaw keeps under its TMPDIR. A cold start re-transpiles every
 * bundled TypeScript plugin, which takes minutes on a small ARM board, so these
 * must survive gateway restarts.
 *
 * They cannot be moved elsewhere by configuration: jiti coerces a
 * `JITI_FS_CACHE` value to a boolean and always derives the directory from
 * `os.tmpdir()`, so a path there would be silently ignored.
 */
export const OPENCLAW_TMPDIR_CACHE_ENTRIES = ["jiti", "node-compile-cache"] as const;

export type TempDirFs = {
  readdir(path: string): Promise<string[]>;
  lstat(path: string): Promise<Pick<Stats, "uid" | "isDirectory">>;
  rm(path: string, options: { recursive: true; force: true }): Promise<void>;
};

const nodeTempDirFs: TempDirFs = { readdir, lstat, rm };

/**
 * The uid every entry under the managed TMPDIR should belong to, or undefined
 * when that cannot be known. A root installer that failed to resolve the
 * service account must not guess "root": that would keep exactly the
 * root-owned leftovers that make the service fail with EACCES.
 */
export const resolveTempDirOwnerUid = (
  serviceOwnership: { uid: number } | null,
  processUid: number | undefined,
): number | undefined => {
  if (serviceOwnership !== null) {
    return serviceOwnership.uid;
  }
  return processUid === undefined || processUid === 0 ? undefined : processUid;
};

/**
 * Removes entries the service user may be unable to overwrite: anything owned
 * by another uid, at any depth. Entries the service user owns are kept, which
 * is what keeps OpenClaw's caches warm across restarts. With an unknown owner
 * every entry is removed, since nothing can be proven safe to keep.
 *
 * Returns the removed paths. A missing directory is not an error.
 */
export const removeForeignOwnedTempEntries = async (
  dir: string,
  ownerUid: number | undefined,
  fs: TempDirFs = nodeTempDirFs,
): Promise<string[]> => {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const removed: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry);
    try {
      const stats = ownerUid === undefined ? null : await fs.lstat(path);
      if (stats !== null && stats.uid === ownerUid) {
        if (stats.isDirectory()) {
          removed.push(...(await removeForeignOwnedTempEntries(path, ownerUid, fs)));
        }
        continue;
      }
      await fs.rm(path, { recursive: true, force: true });
      removed.push(path);
    } catch {
      // Best effort: one unreadable entry must not stop the gateway restart.
    }
  }
  return removed;
};

/** Drops OpenClaw's caches so a new OpenClaw release starts from a clean slate. */
export const clearOpenClawTempDirCaches = async (
  tempDir: string,
  fs: Pick<TempDirFs, "rm"> = nodeTempDirFs,
): Promise<void> => {
  for (const entry of OPENCLAW_TMPDIR_CACHE_ENTRIES) {
    await fs.rm(join(tempDir, entry), { recursive: true, force: true });
  }
};
