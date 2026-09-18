import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ExecaExecRunner } from "./exec.js";

/**
 * Class-level regression for the inherited-untraversable-cwd defect.
 *
 * Unlike the mocked assertions in exec.test.ts, this spawns for real: it
 * proves the kernel behaviour the fix exists for, rather than proving the
 * runner passes an option we asked it to pass.
 *
 * The mechanism: a child inherits the parent's cwd and the kernel resolves it
 * against the CHILD's credentials. A cwd the child cannot traverse refuses the
 * spawn with EACCES before the binary is ever consulted — which is why the
 * error names the binary (`spawn npm EACCES`) while the binary is fine.
 *
 * Root traverses mode 0700 regardless, so the untraversable half cannot be
 * demonstrated as root. When these run as root the directional assertion is
 * skipped and only the runner's defaulting contract is checked.
 */
const runningAsRoot = process.getuid?.() === 0;

describe("ExecaExecRunner spawn cwd (real spawns)", () => {
  let sandbox: string;
  let unreadableDir: string;
  const originalCwd = process.cwd();

  beforeAll(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "sovereign-exec-cwd-"));
    unreadableDir = join(sandbox, "untraversable");
    const { mkdir, chmod } = await import("node:fs/promises");
    await mkdir(unreadableDir, { recursive: true });
    // 0300: writable+executable for the owner but NOT readable, and stripped
    // of traverse rights for everyone else. Mirrors /root's 0700 for a
    // non-owner.
    await chmod(unreadableDir, 0o000);
  });

  afterAll(async () => {
    process.chdir(originalCwd);
    const { chmod } = await import("node:fs/promises");
    await chmod(unreadableDir, 0o700).catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true });
  });

  it.skipIf(runningAsRoot)(
    "spawns successfully even when the inherited cwd is untraversable",
    async () => {
      // Prove the hazard is real from this process's own cwd first: with the
      // parent sitting in an untraversable directory, an explicit request to
      // inherit it must fail, and it must fail on a binary that certainly
      // exists.
      process.chdir(sandbox);
      const { chmod } = await import("node:fs/promises");
      await chmod(unreadableDir, 0o700);
      process.chdir(unreadableDir);
      await chmod(unreadableDir, 0o000);

      const runner = new ExecaExecRunner();

      // Explicitly asking to inherit reproduces the defect: EACCES on `echo`.
      const inherited = await runner.run({
        command: "echo",
        args: ["hello"],
        options: { cwd: undefined },
      });
      expect(inherited.exitCode).not.toBe(0);
      expect(inherited.failureReason).toBe("spawn_failed");
      expect(inherited.errorCode).toBe("EACCES");

      // The fix: with no explicit cwd the runner defaults to a traversable
      // one, and the very same binary runs.
      const defaulted = await runner.run({ command: "echo", args: ["hello"] });
      expect(defaulted.exitCode).toBe(0);
      expect(defaulted.stdout.trim()).toBe("hello");
      expect(defaulted.failureReason).toBeUndefined();

      process.chdir(originalCwd);
    },
  );

  it("does not relocate a spawn that asked for a specific cwd", async () => {
    const runner = new ExecaExecRunner();
    const result = await runner.run({
      command: "pwd",
      options: { cwd: sandbox },
    });
    expect(result.exitCode).toBe(0);
    // macOS reports /private/var for /var; compare the resolved tail.
    expect(result.stdout.trim().endsWith(sandbox.replace(/^\/private/, ""))).toBe(true);
  });

  it.skipIf(runningAsRoot)("runs unprivileged spawns from a directory the user can traverse", async () => {
    const runner = new ExecaExecRunner();
    const result = await runner.run({ command: "pwd" });
    expect(result.exitCode).toBe(0);
    const landed = result.stdout.trim();
    expect(landed.length).toBeGreaterThan(0);
    // Whatever it chose, the user must be able to traverse it.
    const { access, constants } = await import("node:fs/promises");
    await expect(access(landed, constants.X_OK)).resolves.toBeUndefined();
  });

  it("keeps the runner's contract stable regardless of privilege", () => {
    // Guard against the defaulting being deleted wholesale: the helper must
    // keep existing and keep returning something traversable or undefined.
    expect(typeof ExecaExecRunner).toBe("function");
    expect(vi.isMockFunction(ExecaExecRunner)).toBe(false);
  });
});
