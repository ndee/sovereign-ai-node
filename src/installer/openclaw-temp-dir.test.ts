import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearOpenClawTempDirCaches,
  OPENCLAW_TMPDIR_CACHE_ENTRIES,
  removeForeignOwnedTempEntries,
  resolveTempDirOwnerUid,
  type TempDirFs,
} from "./openclaw-temp-dir.js";

const SERVICE_UID = 999;
const ROOT_UID = 0;

type FakeEntry = { uid: number; children?: Record<string, FakeEntry> };

/** In-memory tree: lets the tests own files as other uids without being root. */
const createFakeFs = (root: string, tree: Record<string, FakeEntry>) => {
  const removed: string[] = [];
  const lookup = (path: string): FakeEntry | Record<string, FakeEntry> | undefined => {
    if (path === root) {
      return tree;
    }
    const segments = path.slice(root.length + 1).split("/");
    let level: Record<string, FakeEntry> | undefined = tree;
    let entry: FakeEntry | undefined;
    for (const segment of segments) {
      entry = level?.[segment];
      level = entry?.children;
    }
    return entry;
  };
  const enoent = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  const fs: TempDirFs = {
    readdir: async (path) => {
      const found = lookup(path);
      if (found === undefined) {
        throw enoent(path);
      }
      const children =
        path === root ? (found as Record<string, FakeEntry>) : (found as FakeEntry).children;
      return Object.keys(children ?? {});
    },
    lstat: async (path) => {
      const found = lookup(path) as FakeEntry | undefined;
      if (found === undefined) {
        throw enoent(path);
      }
      return { uid: found.uid, isDirectory: () => found.children !== undefined };
    },
    rm: async (path) => {
      removed.push(path);
    },
  };
  return { fs, removed };
};

describe("resolveTempDirOwnerUid", () => {
  it("uses the resolved service account", () => {
    expect(resolveTempDirOwnerUid({ uid: SERVICE_UID }, ROOT_UID)).toBe(SERVICE_UID);
  });

  it("keeps root-owned entries when the service itself runs as root", () => {
    expect(resolveTempDirOwnerUid({ uid: ROOT_UID }, ROOT_UID)).toBe(ROOT_UID);
  });

  it("falls back to the unprivileged process uid, which is the service user", () => {
    expect(resolveTempDirOwnerUid(null, 1000)).toBe(1000);
  });

  it("refuses to guess when a root installer could not resolve the service account", () => {
    expect(resolveTempDirOwnerUid(null, ROOT_UID)).toBeUndefined();
  });

  it("refuses to guess on a platform without uids", () => {
    expect(resolveTempDirOwnerUid(null, undefined)).toBeUndefined();
  });
});

describe("removeForeignOwnedTempEntries", () => {
  const root = "/svc/tmp";

  it("keeps the service user's caches and removes entries left by another uid", async () => {
    const { fs, removed } = createFakeFs(root, {
      jiti: {
        uid: SERVICE_UID,
        children: {
          "plugin-a.cjs": { uid: SERVICE_UID },
          "plugin-b.cjs": { uid: ROOT_UID },
        },
      },
      "node-compile-cache": {
        uid: SERVICE_UID,
        children: { v22: { uid: SERVICE_UID, children: {} } },
      },
      "openclaw-root-run": { uid: ROOT_UID, children: { "x.lock": { uid: ROOT_UID } } },
      "stray.txt": { uid: 1234 },
    });

    const result = await removeForeignOwnedTempEntries(root, SERVICE_UID, fs);

    expect(result).toEqual([
      `${root}/jiti/plugin-b.cjs`,
      `${root}/openclaw-root-run`,
      `${root}/stray.txt`,
    ]);
    expect(removed).toEqual(result);
  });

  it("removes every entry when the owner is unknown", async () => {
    const { fs, removed } = createFakeFs(root, {
      jiti: { uid: SERVICE_UID, children: { "a.cjs": { uid: SERVICE_UID } } },
      "other.txt": { uid: ROOT_UID },
    });

    expect(await removeForeignOwnedTempEntries(root, undefined, fs)).toEqual([
      `${root}/jiti`,
      `${root}/other.txt`,
    ]);
    expect(removed).toHaveLength(2);
  });

  it("treats a missing directory as already clean", async () => {
    const { fs } = createFakeFs(root, {});
    expect(await removeForeignOwnedTempEntries("/does/not/exist", SERVICE_UID, fs)).toEqual([]);
  });

  it("propagates an unreadable top-level directory to the caller", async () => {
    const fs: TempDirFs = {
      readdir: async () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
      lstat: async () => ({ uid: SERVICE_UID, isDirectory: () => false }),
      rm: async () => {},
    };
    await expect(removeForeignOwnedTempEntries(root, SERVICE_UID, fs)).rejects.toThrow("EACCES");
  });

  it("skips an entry it cannot inspect and carries on with the rest", async () => {
    const { fs } = createFakeFs(root, {
      vanished: { uid: ROOT_UID },
      "stray.txt": { uid: ROOT_UID },
    });
    const flaky: TempDirFs = {
      ...fs,
      lstat: async (path) => {
        if (path.endsWith("vanished")) {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }
        return fs.lstat(path);
      },
    };

    expect(await removeForeignOwnedTempEntries(root, SERVICE_UID, flaky)).toEqual([
      `${root}/stray.txt`,
    ]);
  });

  describe("on a real directory", () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "openclaw-temp-dir-test-"));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("keeps everything the current user owns", async () => {
      await mkdir(join(dir, "jiti"), { recursive: true });
      await writeFile(join(dir, "jiti", "plugin.cjs"), "cached");
      const { uid } = await stat(dir);

      expect(await removeForeignOwnedTempEntries(dir, uid)).toEqual([]);
      expect(await readdir(join(dir, "jiti"))).toEqual(["plugin.cjs"]);
    });
  });
});

describe("clearOpenClawTempDirCaches", () => {
  it("removes exactly the OpenClaw cache directories", async () => {
    const removed: string[] = [];
    await clearOpenClawTempDirCaches("/svc/tmp", {
      rm: async (path) => {
        removed.push(path);
      },
    });
    expect(removed).toEqual(OPENCLAW_TMPDIR_CACHE_ENTRIES.map((entry) => `/svc/tmp/${entry}`));
  });

  it("deletes them from disk and leaves other entries alone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openclaw-temp-dir-test-"));
    try {
      await mkdir(join(dir, "jiti"));
      await writeFile(join(dir, "jiti", "a.cjs"), "cached");
      await writeFile(join(dir, "keep.txt"), "x");

      await clearOpenClawTempDirCaches(dir);

      expect(await readdir(dir)).toEqual(["keep.txt"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
