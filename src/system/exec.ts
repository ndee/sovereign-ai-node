import { execa } from "execa";

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
    const subprocess = await execa(input.command, input.args ?? [], {
      reject: false,
      stdin: "ignore",
      ...(input.options ?? {}),
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
    return {
      command,
      exitCode: EXEC_NO_EXIT_STATUS_CODE,
      stdout,
      // Surface execa's own explanation: a spawn failure has no stderr of its
      // own, so without this the caller is left with empty output and no clue.
      stderr: mergeFailureMessage(stderr, subprocess.shortMessage),
      failureReason,
      ...(signal === undefined ? {} : { signal }),
    };
  }
}

type MissingExitStatusSubprocess = {
  timedOut?: boolean | undefined;
  signal?: string | undefined;
  shortMessage?: string | undefined;
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
