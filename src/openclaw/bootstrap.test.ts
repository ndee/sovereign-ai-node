import { describe, expect, it } from "vitest";

import { createLogger } from "../logging/logger.js";
import type { ExecInput, ExecResult, ExecRunner } from "../system/exec.js";
import {
  ShellOpenClawBootstrapper,
  SOVEREIGN_PINNED_OPENCLAW_VERSION,
  SOVEREIGN_PINNED_OPENCLAW_VERSION_ALIAS,
} from "./bootstrap.js";

describe("ShellOpenClawBootstrapper", () => {
  it("resolves pinned-by-sovereign to the concrete pinned version during install", async () => {
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
        stdout: SOVEREIGN_PINNED_OPENCLAW_VERSION,
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
      version: SOVEREIGN_PINNED_OPENCLAW_VERSION_ALIAS,
      noOnboard: true,
      noPrompt: true,
      skipIfCompatibleInstalled: true,
    });

    expect(result.version).toBe(SOVEREIGN_PINNED_OPENCLAW_VERSION);
    expect(calls[1]?.command).toBe("bash");
    expect(calls[1]?.args?.[1]).toContain("install.sh");
    expect(calls[1]?.args?.[1]).toContain(`'${SOVEREIGN_PINNED_OPENCLAW_VERSION}'`);
  });

  it("skips reinstall when installed OpenClaw already matches the concrete Sovereign pin", async () => {
    const calls: ExecInput[] = [];
    const execRunner: ExecRunner = {
      run: async (input): Promise<ExecResult> => {
        calls.push(input);
        return {
          command: [input.command, ...(input.args ?? [])].join(" "),
          exitCode: 0,
          stdout: SOVEREIGN_PINNED_OPENCLAW_VERSION,
          stderr: "",
        };
      },
    };

    const bootstrapper = new ShellOpenClawBootstrapper(execRunner, createLogger());
    const result = await bootstrapper.ensureInstalled({
      version: SOVEREIGN_PINNED_OPENCLAW_VERSION_ALIAS,
      noOnboard: true,
      noPrompt: true,
      skipIfCompatibleInstalled: true,
    });

    expect(result.version).toBe(SOVEREIGN_PINNED_OPENCLAW_VERSION);
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

  it("reinstalls when the detected OpenClaw version does not match the concrete Sovereign pin", async () => {
    const calls: ExecInput[] = [];
    const results: ExecResult[] = [
      {
        command: "openclaw --version",
        exitCode: 0,
        stdout: "2026.3.2",
        stderr: "",
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
        stdout: SOVEREIGN_PINNED_OPENCLAW_VERSION,
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
      version: SOVEREIGN_PINNED_OPENCLAW_VERSION_ALIAS,
      noOnboard: true,
      noPrompt: true,
      skipIfCompatibleInstalled: true,
    });

    expect(result.version).toBe(SOVEREIGN_PINNED_OPENCLAW_VERSION);
    expect(calls).toHaveLength(3);
    expect(calls[1]?.args?.[1]).toContain(`'${SOVEREIGN_PINNED_OPENCLAW_VERSION}'`);
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
        version: SOVEREIGN_PINNED_OPENCLAW_VERSION_ALIAS,
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
        version: SOVEREIGN_PINNED_OPENCLAW_VERSION_ALIAS,
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
