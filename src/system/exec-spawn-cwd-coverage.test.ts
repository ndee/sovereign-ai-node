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
        // Sibling worktrees carry their own full copy of src/. Collecting them
        // makes this guard grade a stale snapshot of the tree and report green
        // for code that is not the code under test.
        if (entry.name === ".worktrees" || entry.name === "node_modules") {
          return [];
        }
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

  it("pins an explicit cwd at every privilege-dropping spawn site", async () => {
    const files = await collectSourceFiles(SRC_DIR);
    const offenders: { site: string; snippet: string }[] = [];
    let siteCount = 0;

    /**
     * A privilege drop is recognisable by the sudo/runuser argument pattern.
     *
     * Matching only the bare literal `"sudo"` is not enough: the installer
     * COMPUTES the command (`shouldRunAsServiceUser ? "sudo" : command`), so
     * the literal appears in a ternary rather than at a spawn's `command:`.
     * That site matched the old file-level check only incidentally — the file
     * happened to contain the word. Recognise the computed form explicitly.
     */
    const DROP_PATTERNS = [
      /command:\s*"(?:sudo|runuser)"/g,
      /\?\s*"(?:sudo|runuser)"\s*:/g,
      /=\s*"(?:sudo|runuser)"\s*;/g,
    ];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (!/"-u"/.test(source)) {
        continue;
      }
      const lines = source.split("\n");
      for (const pattern of DROP_PATTERNS) {
        pattern.lastIndex = 0;
        let match = pattern.exec(source);
        while (match !== null) {
          const line = source.slice(0, match.index).split("\n").length;
          // Judge the site, not the file: look only at the enclosing member,
          // so one correct drop cannot vouch for a second, broken one.
          const start = Math.max(0, line - 40);
          const scope = lines.slice(start, Math.min(lines.length, line + 60)).join("\n");
          // Only a DROP is in scope here. `sudo -n chown` / `sudo -n tee` are
          // privilege ESCALATIONS: the child runs as root, which can traverse
          // anything, so the untraversable-cwd class cannot apply. The `-u`
          // must therefore belong to THIS site, not merely to the file.
          if (!/"-u"/.test(scope)) {
            match = pattern.exec(source);
            continue;
          }
          siteCount += 1;
          const pinsCwd = /cwd:/.test(scope) || /PRIVILEGE_DROP_SPAWN_CWD/.test(scope);
          if (!pinsCwd) {
            offenders.push({
              site: `${file.replace(SRC_DIR, "src/")}:${line}`,
              snippet: "drops privilege via sudo/runuser -u without pinning a cwd",
            });
          }
          match = pattern.exec(source);
        }
      }
    }

    // If the detector stops finding drops, it has gone blind rather than the
    // tree having become safe.
    expect(siteCount).toBeGreaterThanOrEqual(2);

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
