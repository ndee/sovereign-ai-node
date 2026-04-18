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
};

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
    return {
      command: [input.command, ...(input.args ?? [])].join(" "),
      exitCode: subprocess.exitCode ?? 0,
      stdout: subprocess.stdout,
      stderr: subprocess.stderr,
    };
  }
}
