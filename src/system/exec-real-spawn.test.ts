/**
 * Real-spawn conformance tier for the exec runner.
 *
 * # Why this file exists separately from exec.test.ts
 *
 * Every other test of `ExecaExecRunner` mocks `execa`. Those tests assert that
 * the runner maps a given subprocess shape onto a given `ExecResult` — which is
 * necessary, but circular as a safety net: the mock's shape is one WE wrote. If
 * our belief about when execa leaves `exitCode` undefined were wrong, or if a
 * future execa release changed it, every mocked test would stay green while the
 * runner silently reported failures as successes.
 *
 * That is not hypothetical. The runner previously coerced a missing exit status
 * with `exitCode ?? 0`, turning three distinct failure modes — a process that
 * never spawned, one killed for exceeding its timeout, and one terminated by a
 * signal — into exit 0. Because the whole suite was mocked, nothing ever
 * spawned a process, and the defect was additionally PINNED by a test that
 * asserted the coercion as intended behaviour. The fix returns
 * `EXEC_NO_EXIT_STATUS_CODE` (127) plus a `failureReason` discriminator.
 *
 * So this tier spawns real processes and asserts the real kernel/runtime
 * behaviour end to end. It is the check that fails if someone reintroduces
 * `?? 0`, regardless of what the mocks say.
 *
 * # Over-correction guard
 *
 * Mapping a missing exit status to 127 is only correct if a process that DID
 * exit keeps its own status. A fix that reported 127 for everything would be
 * just as wrong in the other direction and would equally satisfy a test that
 * only asserted "non-zero". The `exit 3` and clean-success cases below pin
 * that boundary: an ordinary exit must survive untouched, with no
 * `failureReason` attached.
 *
 * # Portability
 *
 * Only POSIX tools assumed present on any supported host are used (`sh`,
 * `sleep`, `kill`, plus a deliberately nonexistent binary). No network, no
 * sudo, no distro-specific paths. Timeouts are kept short so the whole file
 * runs in a few seconds.
 */

import { describe, expect, it } from "vitest";

import { EXEC_NO_EXIT_STATUS_CODE, ExecaExecRunner } from "./exec.js";

/**
 * A command name that cannot exist on PATH.
 *
 * Randomised per run so a stray fixture or a developer's ~/bin cannot
 * accidentally satisfy it and make the spawn-failure assertion vacuous.
 */
const missingCommand = `sovereign-nonexistent-${Math.random().toString(36).slice(2, 10)}`;

describe("ExecaExecRunner against real processes", () => {
  const runner = new ExecaExecRunner();

  /**
   * A command that does not exist never produces an exit status of its own.
   * Under `?? 0` this returned exit 0 and empty output — an install that never
   * ran reported as an install that succeeded.
   */
  it("reports a real ENOENT spawn failure as non-zero, not a fabricated success", async () => {
    const result = await runner.run({ command: missingCommand, args: ["--version"] });

    expect(result.exitCode).not.toBe(0);
    expect(result.exitCode).toBe(EXEC_NO_EXIT_STATUS_CODE);
    expect(result.failureReason).toBe("spawn_failed");
    // The cause must be machine-readable, not only prose in stderr: callers
    // branch on "missing binary" versus "not permitted to start it".
    expect(result.errorCode).toBe("ENOENT");
    // execa's own explanation must survive; a failed spawn has no stderr of
    // its own, so without it the caller sees an empty failure.
    expect(result.stderr).not.toBe("");
  });

  /**
   * A process killed for outliving its timeout also exits without a status.
   * The partial stdout it produced before the kill must still reach the caller,
   * since that output is often the only evidence of how far it got.
   *
   * The sleep is `exec`ed rather than run as a child of the shell. A timeout
   * kill signals the process execa spawned — the shell — but a grandchild
   * `sleep` survives it holding the inherited stdout pipe open, and execa waits
   * on that pipe, so the call hangs until the grandchild finishes on its own.
   * `exec` replaces the shell with the sleep, leaving exactly one process to
   * kill. This is a real property of the runner's contract, not a test
   * artifact: a caller's timeout only bounds the process tree it can signal.
   */
  it("reports a real timeout kill as non-zero and keeps output produced before the kill", async () => {
    const result = await runner.run({
      command: "sh",
      args: ["-c", "printf 'started\\n'; exec sleep 10"],
      options: { timeout: 500 },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.exitCode).toBe(EXEC_NO_EXIT_STATUS_CODE);
    expect(result.failureReason).toBe("timed_out");
    expect(result.stdout).toContain("started");
  });

  /**
   * A process terminated by a signal is the third missing-status path, and the
   * one most likely to be read as success: it ran, it produced output, and
   * under `?? 0` it reported exit 0. The child signals itself so the test does
   * not depend on timing or on killing a pid it does not own.
   */
  it("reports a real signal termination as non-zero and names the signal", async () => {
    const result = await runner.run({
      command: "sh",
      args: ["-c", "printf 'before-signal\\n'; kill -TERM $$; sleep 5"],
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.exitCode).toBe(EXEC_NO_EXIT_STATUS_CODE);
    expect(result.failureReason).toBe("signal");
    expect(result.signal).toBe("SIGTERM");
  });

  /**
   * Over-correction guard. A process that exited on its own terms keeps its own
   * status: 3 must stay 3, not become 127, and no `failureReason` may be
   * attached — a real exit code is not a missing one. A fix that reported the
   * no-status code unconditionally would satisfy every "non-zero" assertion
   * above and would be caught only here.
   */
  it("preserves a genuine non-zero exit code and attaches no failure reason", async () => {
    const result = await runner.run({ command: "sh", args: ["-c", "exit 3"] });

    expect(result.exitCode).toBe(3);
    expect(result.exitCode).not.toBe(EXEC_NO_EXIT_STATUS_CODE);
    expect(result.failureReason).toBeUndefined();
    expect(result.signal).toBeUndefined();
    expect(result.errorCode).toBeUndefined();
  });

  /**
   * The baseline the other cases are distinguished from: a clean success is
   * exit 0 with its stdout captured and no failure metadata. Without this, a
   * runner that failed everything would still pass the failure assertions.
   */
  it("reports a real clean success as exit 0 with stdout captured", async () => {
    const result = await runner.run({
      command: "sh",
      args: ["-c", "printf 'real-spawn-ok\\n'"],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("real-spawn-ok");
    expect(result.failureReason).toBeUndefined();
    expect(result.command).toBe("sh -c printf 'real-spawn-ok\\n'");
  });
});
