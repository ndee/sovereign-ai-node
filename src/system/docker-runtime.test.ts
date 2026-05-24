import { describe, expect, it } from "vitest";

import { createLogger } from "../logging/logger.js";
import { ShellDockerRuntimePreparer } from "./docker-runtime.js";
import type { ExecInput, ExecResult, ExecRunner } from "./exec.js";

const okResult = (stdout = "", stderr = ""): ExecResult => ({
  command: "stub",
  exitCode: 0,
  stdout,
  stderr,
});

const failResult = (exitCode: number, stderr = ""): ExecResult => ({
  command: "stub",
  exitCode,
  stdout: "",
  stderr,
});

class ScriptedExecRunner implements ExecRunner {
  public calls: ExecInput[] = [];

  constructor(private readonly responder: (input: ExecInput) => Promise<ExecResult>) {}

  async run(input: ExecInput): Promise<ExecResult> {
    this.calls.push(input);
    return this.responder(input);
  }
}

const installScriptPath = "/tmp/fake-install-docker.sh";

describe("ShellDockerRuntimePreparer", () => {
  it("returns early when docker and compose are already available", async () => {
    const runner = new ScriptedExecRunner(async (input) => {
      if (input.command === "docker" && input.args?.[0] === "--version")
        return okResult("Docker 27");
      if (input.command === "docker" && input.args?.[0] === "compose")
        return okResult("compose v2");
      throw new Error(`unexpected command: ${input.command} ${(input.args ?? []).join(" ")}`);
    });
    const preparer = new ShellDockerRuntimePreparer(runner, createLogger(), {
      installScriptPath,
    });

    const progressNotes: string[] = [];
    const result = await preparer.prepare((note) => {
      progressNotes.push(note);
    });

    expect(result).toEqual({
      alreadyPresent: true,
      ranInstaller: false,
      probe: { cli: true, compose: true },
    });
    expect(runner.calls.map((c) => `${c.command} ${(c.args ?? []).join(" ")}`)).toEqual([
      "docker --version",
      "docker compose version",
    ]);
    expect(progressNotes).toEqual(["Docker and Compose are already installed"]);
  });

  it("invokes the installer when docker or compose are missing and re-probes", async () => {
    let probeCount = 0;
    const runner = new ScriptedExecRunner(async (input) => {
      if (input.command === "docker") {
        probeCount += 1;
        // First probe: missing. After installer run: present.
        if (probeCount <= 2) return failResult(127, "command not found");
        return okResult("present");
      }
      if (input.command === "sudo") {
        expect(input.args).toEqual(["-n", installScriptPath]);
        return okResult("installed", "");
      }
      throw new Error(`unexpected command: ${input.command}`);
    });
    const preparer = new ShellDockerRuntimePreparer(runner, createLogger(), {
      installScriptPath,
    });

    const progressNotes: string[] = [];
    const result = await preparer.prepare(async (note) => {
      progressNotes.push(note);
    });

    expect(result.alreadyPresent).toBe(false);
    expect(result.ranInstaller).toBe(true);
    expect(result.probe).toEqual({ cli: true, compose: true });
    expect(progressNotes).toEqual([
      `Installing Docker runtime via ${installScriptPath} (this can take a few minutes)`,
      "Docker runtime installed",
    ]);
  });

  it("throws DOCKER_RUNTIME_INSTALL_FAILED when the installer cannot spawn", async () => {
    const runner = new ScriptedExecRunner(async (input) => {
      if (input.command === "docker") return failResult(127);
      if (input.command === "sudo") throw new Error("spawn sudo ENOENT");
      throw new Error(`unexpected command: ${input.command}`);
    });
    const preparer = new ShellDockerRuntimePreparer(runner, createLogger(), {
      installScriptPath,
    });

    await expect(preparer.prepare()).rejects.toMatchObject({
      code: "DOCKER_RUNTIME_INSTALL_FAILED",
      message: expect.stringContaining("Failed to invoke Docker installer"),
      details: expect.objectContaining({
        spawnError: "spawn sudo ENOENT",
      }),
    });
  });

  it("throws DOCKER_RUNTIME_INSTALL_FAILED when the installer exits non-zero", async () => {
    const runner = new ScriptedExecRunner(async (input) => {
      if (input.command === "docker") return failResult(127);
      if (input.command === "sudo") return failResult(1, "apt failed");
      throw new Error(`unexpected command: ${input.command}`);
    });
    const preparer = new ShellDockerRuntimePreparer(runner, createLogger(), {
      installScriptPath,
    });

    await expect(preparer.prepare()).rejects.toMatchObject({
      code: "DOCKER_RUNTIME_INSTALL_FAILED",
      details: expect.objectContaining({
        exitCode: 1,
        stderr: "apt failed",
      }),
    });
  });

  it("throws DOCKER_RUNTIME_INSTALL_FAILED when the installer claims success but docker is still missing", async () => {
    const runner = new ScriptedExecRunner(async (input) => {
      if (input.command === "docker") return failResult(127);
      if (input.command === "sudo") return okResult("installer ran but compose still missing");
      throw new Error(`unexpected command: ${input.command}`);
    });
    const preparer = new ShellDockerRuntimePreparer(runner, createLogger(), {
      installScriptPath,
    });

    await expect(preparer.prepare()).rejects.toMatchObject({
      code: "DOCKER_RUNTIME_INSTALL_FAILED",
      details: expect.objectContaining({
        probe: { cli: false, compose: false },
      }),
    });
  });

  it("does not throw when onProgress is omitted", async () => {
    const runner = new ScriptedExecRunner(async () => okResult("ok"));
    const preparer = new ShellDockerRuntimePreparer(runner, createLogger(), {
      installScriptPath,
    });

    await expect(preparer.prepare()).resolves.toMatchObject({ alreadyPresent: true });
  });
});
