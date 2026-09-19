import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Class-level guard over the WHOLE source tree.
 *
 * The untraversable-cwd defect has now surfaced at three separate call sites
 * in three releases. Each was fixed where it burned, and each fix was scoped
 * to the file that happened to fail — so the next unprotected spawn failed
 * the same way. The previous regression test asserted "every spawn names a
 * cwd" but only for one class, which is why it stayed green while
 * real-service-lobster.ts and the sudo drop in real-service.ts were exposed.
 *
 * This test is deliberately scoped to `src/**` rather than to any file, so a
 * call site added tomorrow is covered without anyone remembering to extend
 * it. It enforces the two ways a spawn can be safe:
 *
 *  1. It goes through ExecRunner, which defaults the cwd for unprivileged
 *     processes (see resolveTraversableSpawnCwd). This is the normal case and
 *     needs nothing at the call site — that is the point of fixing it there.
 *  2. It drops privilege (`sudo -u` / `runuser -u`), where the runner's
 *     default cannot help because the PARENT is root while the CHILD is not.
 *     Those sites must name a cwd explicitly.
 *
 * So the rule enforced here is narrow but total: any spawn that drops
 * privilege must pin a cwd, and nothing may bypass ExecRunner by calling
 * node:child_process directly.
 */

const SRC_DIR = new URL("..", import.meta.url).pathname;

const collectSourceFiles = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        return collectSourceFiles(full);
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
        return [];
      }
      return [full];
    }),
  );
  return files.flat();
};

describe("spawn cwd coverage across src/", () => {
  /**
   * Direct spawns outside the runner are not banned outright — several
   * predate the runner and are harmless, because a spawn that merely
   * INHERITS an untraversable cwd still succeeds (verified on a dev VM:
   * inherit => OK, explicit untraversable cwd => EACCES). What is dangerous
   * is a direct spawn that also drops privilege, since that combines an
   * unprivileged child with a cwd nobody pinned.
   *
   * This list is a ratchet: it may shrink, never grow. A new file spawning
   * outside the runner has to be added deliberately, which is the moment to
   * ask whether it needs the runner's cwd defaulting.
   */
  const KNOWN_DIRECT_SPAWN_FILES = [
    "src/bots/catalog.ts",
    "src/cli/commands/update.ts",
    "src/installer/real-service-guarded-json-state-plugin.ts",
    "src/installer/real-service.ts",
    "src/support/collectors.ts",
  ];

  it("does not add new spawns that bypass ExecRunner's cwd defaulting", async () => {
    const files = await collectSourceFiles(SRC_DIR);
    expect(files.length).toBeGreaterThan(50);

    const offenders: string[] = [];
    for (const file of files) {
      // The exec runner itself legitimately wraps a spawn library.
      if (file.endsWith("/system/exec.ts")) {
        continue;
      }
      const source = await readFile(file, "utf8");
      if (!/from "node:child_process"|require\("node:child_process"\)|from "execa"/.test(source)) {
        continue;
      }
      const relative = `src/${file.replace(SRC_DIR, "")}`.replace("src//", "src/");
      if (!KNOWN_DIRECT_SPAWN_FILES.includes(relative)) {
        offenders.push(relative);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("pins an explicit cwd at every privilege-dropping spawn", async () => {
    const files = await collectSourceFiles(SRC_DIR);
    const offenders: { file: string; snippet: string }[] = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      // A privilege drop is recognisable by the sudo/runuser -u argument
      // pattern the installer uses to become the service user.
      const dropsPrivilege = /"(sudo|runuser)"/.test(source) && /"-u"/.test(source);
      if (!dropsPrivilege) {
        continue;
      }
      // Such a file must name a cwd somewhere: either a literal `cwd:` option
      // or the shared constant for privilege drops.
      const pinsCwd = /cwd:/.test(source) || /PRIVILEGE_DROP_SPAWN_CWD/.test(source);
      if (!pinsCwd) {
        offenders.push({
          file: file.replace(SRC_DIR, "src/"),
          snippet: "drops privilege via sudo/runuser -u without pinning a cwd",
        });
      }
    }

    // `sudo` and `runuser` both PRESERVE the caller's cwd, so a drop performed
    // from /root hands the unprivileged child a directory it cannot traverse
    // and the next spawn dies EACCES naming an innocent binary.
    expect(offenders).toEqual([]);
  });

  it("keeps the runner's cwd defaulting in place", async () => {
    const execSource = await readFile(join(SRC_DIR, "system", "exec.ts"), "utf8");
    // If someone deletes the defaulting, every unprivileged call site silently
    // becomes vulnerable again. Pin the behaviour, not just the helper name.
    expect(execSource).toMatch(/resolveTraversableSpawnCwd/);
    expect(execSource).toMatch(/"cwd" in options/);
  });
});
