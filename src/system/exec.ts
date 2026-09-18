import { execa } from "execa";

const isRunningAsRoot = (): boolean => process.getuid?.() === 0;

/**
 * Resolve a working directory every spawned child can legally start in.
 *
 * A child process inherits the parent's cwd, and the kernel resolves that cwd
 * against the CHILD's credentials. When the parent was started in a directory
 * the child's user cannot traverse — `/root` is mode 0700, and a CLI invoked
 * as `runuser -u <service-user> -- sovereign-node ...` from a root shell
 * inherits exactly that — the spawn is refused with EACCES before the binary
 * is ever consulted. The failure names the command (`spawn npm EACCES`), which
 * reads like npm is unexecutable; it is not, and the same npm runs fine for
 * the same user from a traversable cwd.
 *
 * This only bites when the process is NOT root: root traverses 0700
 * regardless, which is why an identical step succeeds during a root install
 * and fails when it is re-entered unprivileged.
 *
 * Applied here, in the runner, rather than at each call site: the same defect
 * has now surfaced at three different call sites in three releases, each fixed
 * locally only for the next unprotected spawn to fail the same way. Defaulting
 * centrally makes every present and future call site correct by construction.
 *
 * `$HOME` is preferred so a tool's own relative lookups (npm reading `.npmrc`)
 * land somewhere the running user owns; `/` is the fallback because it is
 * world-traversable on every supported system.
 */
export const resolveTraversableSpawnCwd = (): string | undefined => {
  if (isRunningAsRoot()) {
    return undefined;
  }
  const envHome = process.env.HOME?.trim();
  return envHome !== undefined && envHome.length > 0 ? envHome : "/";
};

export type ExecInput = {
  command: string;
  args?: string[];
  options?: Record<string, unknown>;
};

export type ExecResult = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  /**
   * Why the process produced no exit status of its own, when that happened.
   *
   * `spawn_failed` — the process never started (ENOENT, EACCES, ...).
   * `timed_out` — it was killed because it outlived `options.timeout`.
   * `signal` — it was terminated by a signal rather than exiting.
   *
   * Absent on a normal exit. Callers that only branch on `exitCode` stay
   * correct: a process that never exited now reports a non-zero `exitCode`
   * instead of a fabricated 0.
   */
  failureReason?: ExecFailureReason;
  /** The signal that terminated the process, when one did. */
  signal?: string;
  /**
   * The OS error code when the process could not be started (EACCES, ENOENT).
   *
   * `failureReason: "spawn_failed"` says a spawn failed; this says WHY, and it
   * is the difference between "the binary is missing" and "this user may not
   * start it from here". Without it the cause survives only inside execa's
   * human-readable `shortMessage`, which nothing can branch on.
   */
  errorCode?: string;
};

export type ExecFailureReason = "spawn_failed" | "timed_out" | "signal";

/**
 * The exit status reported when a process never produced one of its own.
 *
 * execa leaves `exitCode` undefined when the process failed to spawn, was
 * killed by a timeout, or was terminated by a signal. Coercing that to 0
 * reports the failure as a success, which is how an OpenClaw install that
 * never ran came back as "installer completed" with empty output. 127 is
 * the shell's own "command not found"/unexecutable convention, so the many
 * existing `exitCode !== 0` call sites treat these as the failures they are.
 */
export const EXEC_NO_EXIT_STATUS_CODE = 127;

export interface ExecRunner {
  run(input: ExecInput): Promise<ExecResult>;
}

export class ExecaExecRunner implements ExecRunner {
  async run(input: ExecInput): Promise<ExecResult> {
    // Default stdin to "ignore" so subprocesses cannot inherit an empty
    // SSH/CI stdin and block forever on a read. Callers that genuinely
    // need to pipe input can still override via input.options.stdin.
    const options = input.options ?? {};
    // Default the cwd to somewhere the running user can traverse, so an
    // inherited untraversable cwd cannot refuse the spawn with EACCES (see
    // resolveTraversableSpawnCwd). An explicit `cwd` from the caller always
    // wins: sites that must run somewhere specific (docker compose project
    // directories in backup.ts / matrix.ts) are unaffected, because the
    // default is only consulted when no `cwd` was supplied at all.
    const defaultCwd = "cwd" in options ? undefined : resolveTraversableSpawnCwd();
    const subprocess = await execa(input.command, input.args ?? [], {
      reject: false,
      stdin: "ignore",
      ...(defaultCwd === undefined ? {} : { cwd: defaultCwd }),
      ...options,
    });
    const command = [input.command, ...(input.args ?? [])].join(" ");
    const stdout = subprocess.stdout ?? "";
    const stderr = subprocess.stderr ?? "";
    if (subprocess.exitCode !== undefined && subprocess.exitCode !== null) {
      return { command, exitCode: subprocess.exitCode, stdout, stderr };
    }
    // No exit status: the process never ran, or never got to exit on its own.
    const failureReason = classifyMissingExitStatus(subprocess);
    const signal =
      typeof subprocess.signal === "string" && subprocess.signal.length > 0
        ? subprocess.signal
        : undefined;
    const errorCode =
      typeof subprocess.code === "string" && subprocess.code.length > 0
        ? subprocess.code
        : undefined;
    return {
      command,
      exitCode: EXEC_NO_EXIT_STATUS_CODE,
      stdout,
      // Surface execa's own explanation: a spawn failure has no stderr of its
      // own, so without this the caller is left with empty output and no clue.
      stderr: mergeFailureMessage(stderr, subprocess.shortMessage),
      failureReason,
      ...(signal === undefined ? {} : { signal }),
      ...(errorCode === undefined ? {} : { errorCode }),
    };
  }
}

type MissingExitStatusSubprocess = {
  timedOut?: boolean | undefined;
  signal?: string | undefined;
  shortMessage?: string | undefined;
  code?: string | undefined;
};

const classifyMissingExitStatus = (subprocess: MissingExitStatusSubprocess): ExecFailureReason => {
  if (subprocess.timedOut === true) {
    return "timed_out";
  }
  // A signal implies the process existed; without one it never spawned.
  return typeof subprocess.signal === "string" && subprocess.signal.length > 0
    ? "signal"
    : "spawn_failed";
};

const mergeFailureMessage = (stderr: string, shortMessage?: string | undefined): string => {
  const message = shortMessage?.trim() ?? "";
  if (message.length === 0) {
    return stderr;
  }
  return stderr.trim().length === 0 ? message : `${stderr}\n${message}`;
};
