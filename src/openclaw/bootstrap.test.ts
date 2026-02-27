import { describe, expect, it } from "vitest";

import { createLogger } from "../logging/logger.js";
import type { ExecInput, ExecResult, ExecRunner } from "../system/exec.js";
import { ShellOpenClawBootstrapper } from "./bootstrap.js";

describe("ShellOpenClawBootstrapper", () => {
  it("omits --version when requested version is pinned-by-sovereign", async () => {
    const calls: ExecInput[] = [];
    const results: ExecResult[] = [
      {
        command: "openclaw --version",
        exitCode: 1,
        stdout: "",
        stderr: "not installed",
      },
      {
        command: "bash -lc <install>",
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      },
      {
        command: "openclaw --version",
        exitCode: 0,
        stdout: "1.2.3",
        stderr: "",
      },
    ];

    const execRunner: ExecRunner = {
      run: async (input): Promise<ExecResult> => {
        calls.push(input);
        const next = results.shift();
        if (next === undefined) {
          throw new Error("unexpected exec call");
        }
        return next;
      },
    };

    const bootstrapper = new ShellOpenClawBootstrapper(execRunner, createLogger());
    const result = await bootstrapper.ensureInstalled({
      version: "pinned-by-sovereign",
      noOnboard: true,
      noPrompt: true,
      skipIfCompatibleInstalled: true,
    });

    expect(result.version).toBe("1.2.3");
    expect(calls[1]?.command).toBe("bash");
    expect(calls[1]?.args?.[1]).toContain("install.sh");
    expect(calls[1]?.args?.[1]).not.toContain("--version");
  });

  it("skips reinstall for abstract sovereign pin when OpenClaw is already installed", async () => {
    const calls: ExecInput[] = [];
    const execRunner: ExecRunner = {
      run: async (input): Promise<ExecResult> => {
        calls.push(input);
        return {
          command: [input.command, ...(input.args ?? [])].join(" "),
          exitCode: 0,
          stdout: "1.2.3",
          stderr: "",
        };
      },
    };

    const bootstrapper = new ShellOpenClawBootstrapper(execRunner, createLogger());
    const result = await bootstrapper.ensureInstalled({
      version: "pinned-by-sovereign",
      noOnboard: true,
      noPrompt: true,
      skipIfCompatibleInstalled: true,
    });

    expect(result.version).toBe("1.2.3");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "openclaw",
      args: ["--version"],
      options: {
        timeout: 20000,
        env: {
          CI: "1",
        },
      },
    });
  });

  it("does not treat empty --version output as installed", async () => {
    const calls: ExecInput[] = [];
    const execRunner: ExecRunner = {
      run: async (input): Promise<ExecResult> => {
        calls.push(input);
        if (input.command === "openclaw") {
          return {
            command: "openclaw --version",
            exitCode: 0,
            stdout: "",
            stderr: "",
          };
        }
        return {
          command: [input.command, ...(input.args ?? [])].join(" "),
          exitCode: 0,
          stdout: "ok",
          stderr: "",
        };
      },
    };

    const bootstrapper = new ShellOpenClawBootstrapper(execRunner, createLogger());
    await expect(
      bootstrapper.ensureInstalled({
        version: "pinned-by-sovereign",
        noOnboard: true,
        noPrompt: true,
        skipIfCompatibleInstalled: true,
      }),
    ).rejects.toMatchObject({
      code: "OPENCLAW_INSTALL_FAILED",
    });
    expect(calls.some((call) => call.command === "bash")).toBe(true);
  });

  it("treats missing openclaw binary during detection as not installed", async () => {
    const calls: ExecInput[] = [];
    const execRunner: ExecRunner = {
      run: async (input): Promise<ExecResult> => {
        calls.push(input);
        if (input.command === "openclaw") {
          throw new Error("spawn openclaw ENOENT");
        }
        return {
          command: [input.command, ...(input.args ?? [])].join(" "),
          exitCode: 0,
          stdout: "ok",
          stderr: "",
        };
      },
    };

    const bootstrapper = new ShellOpenClawBootstrapper(execRunner, createLogger());
    await expect(
      bootstrapper.ensureInstalled({
        version: "pinned-by-sovereign",
        noOnboard: true,
        noPrompt: true,
        skipIfCompatibleInstalled: true,
      }),
    ).rejects.toMatchObject({
      code: "OPENCLAW_INSTALL_FAILED",
    });
    expect(calls.some((call) => call.command === "bash")).toBe(true);
  });
});
