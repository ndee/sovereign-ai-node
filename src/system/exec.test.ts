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

  it("normalises a missing exitCode to 0 in the returned ExecResult", async () => {
    execaMock.mockResolvedValueOnce({ exitCode: undefined, stdout: "", stderr: "boom" });
    const runner = new ExecaExecRunner();

    const result = await runner.run({ command: "true" });

    expect(result).toEqual({
      command: "true",
      exitCode: 0,
      stdout: "",
      stderr: "boom",
    });
  });
});
