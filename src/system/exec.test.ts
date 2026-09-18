import { describe, expect, it, vi } from "vitest";

const execaMock = vi.fn();

vi.mock("execa", () => ({
  execa: (...args: unknown[]) => execaMock(...args),
}));

const { ExecaExecRunner } = await import("./exec.js");

describe("ExecaExecRunner", () => {
  it("defaults stdin to 'ignore' so subprocesses cannot block on inherited SSH/CI stdin", async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: "ok", stderr: "" });
    const runner = new ExecaExecRunner();

    const result = await runner.run({ command: "echo", args: ["hello"] });

    expect(execaMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = execaMock.mock.calls[0] ?? [];
    expect(command).toBe("echo");
    expect(args).toEqual(["hello"]);
    expect(options).toMatchObject({ reject: false, stdin: "ignore" });
    expect(result).toEqual({
      command: "echo hello",
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    });
  });

  it("honours a caller-supplied stdin override", async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
    const runner = new ExecaExecRunner();

    await runner.run({
      command: "cat",
      args: [],
      options: { stdin: "pipe", timeout: 5_000 },
    });

    const [, , options] = execaMock.mock.calls.at(-1) ?? [];
    // Caller override wins; timeout and any other option pass through.
    expect(options).toMatchObject({ reject: false, stdin: "pipe", timeout: 5_000 });
  });

  // Regression: a missing exitCode used to be normalised to 0, reporting a
  // process that never ran as a success. Every `exitCode !== 0` call site
  // then took the happy path on a failed spawn.
  it("reports a spawn failure as a non-zero exit rather than a fabricated success", async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: undefined,
      stdout: "",
      stderr: "",
      failed: true,
      shortMessage: "Command failed with ENOENT: openclaw --version",
    });
    const runner = new ExecaExecRunner();

    const result = await runner.run({ command: "openclaw", args: ["--version"] });

    expect(result.exitCode).not.toBe(0);
    expect(result.exitCode).toBe(127);
    expect(result.failureReason).toBe("spawn_failed");
    // execa's own explanation must survive: a spawn failure has no stderr.
    expect(result.stderr).toBe("Command failed with ENOENT: openclaw --version");
  });

  it("reports a timeout kill as a non-zero exit and preserves partial stdout", async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: undefined,
      stdout: "partial output",
      stderr: "",
      failed: true,
      timedOut: true,
      signal: "SIGTERM",
      shortMessage: "Command timed out after 1000 milliseconds",
    });
    const runner = new ExecaExecRunner();

    const result = await runner.run({ command: "bash", args: ["-lc", "install"] });

    expect(result.exitCode).toBe(127);
    expect(result.failureReason).toBe("timed_out");
    expect(result.signal).toBe("SIGTERM");
    expect(result.stdout).toBe("partial output");
    expect(result.stderr).toContain("timed out");
  });

  it("reports a signal kill as a non-zero exit", async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: undefined,
      stdout: "",
      stderr: "existing stderr",
      failed: true,
      signal: "SIGKILL",
      shortMessage: "Command was killed with SIGKILL",
    });
    const runner = new ExecaExecRunner();

    const result = await runner.run({ command: "node" });

    expect(result.exitCode).toBe(127);
    expect(result.failureReason).toBe("signal");
    expect(result.signal).toBe("SIGKILL");
    // Real stderr is kept alongside execa's explanation.
    expect(result.stderr).toBe("existing stderr\nCommand was killed with SIGKILL");
  });

  it("keeps a genuine non-zero exit status untouched and flags no failure reason", async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 3, stdout: "out", stderr: "err", failed: true });
    const runner = new ExecaExecRunner();

    const result = await runner.run({ command: "sh", args: ["-c", "exit 3"] });

    expect(result).toEqual({
      command: "sh -c exit 3",
      exitCode: 3,
      stdout: "out",
      stderr: "err",
    });
    expect(result.failureReason).toBeUndefined();
  });

  it("falls back to empty strings when execa reports no output streams", async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: undefined, stderr: undefined });
    const runner = new ExecaExecRunner();

    const result = await runner.run({ command: "true" });

    expect(result).toEqual({ command: "true", exitCode: 0, stdout: "", stderr: "" });
  });

  it("omits the signal field when a spawn failure carries an empty signal", async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: undefined,
      stdout: "",
      stderr: "",
      signal: "",
      shortMessage: "",
    });
    const runner = new ExecaExecRunner();

    const result = await runner.run({ command: "missing" });

    expect(result.failureReason).toBe("spawn_failed");
    expect(result.signal).toBeUndefined();
    // No shortMessage to merge: stderr stays as-is rather than gaining noise.
    expect(result.stderr).toBe("");
  });

  it("keeps stderr unchanged when execa supplies no shortMessage at all", async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: undefined,
      stdout: "",
      stderr: "only stderr",
      signal: "SIGKILL",
    });
    const runner = new ExecaExecRunner();

    const result = await runner.run({ command: "node" });

    expect(result.exitCode).toBe(127);
    expect(result.failureReason).toBe("signal");
    expect(result.stderr).toBe("only stderr");
  });

  it("treats a null exitCode the same as a missing one", async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: null,
      stdout: "",
      stderr: "",
      shortMessage: "Command failed with ENOENT: nope",
    });
    const runner = new ExecaExecRunner();

    const result = await runner.run({ command: "nope" });

    expect(result.exitCode).toBe(127);
    expect(result.failureReason).toBe("spawn_failed");
  });
});
