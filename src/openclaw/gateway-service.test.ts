import { describe, expect, it } from "vitest";

import { createLogger } from "../logging/logger.js";
import type { ExecInput, ExecResult, ExecRunner } from "../system/exec.js";
import { ShellOpenClawGatewayServiceManager } from "./gateway-service.js";

describe("ShellOpenClawGatewayServiceManager", () => {
  it("runs openclaw gateway install with optional --force", async () => {
    const calls: ExecInput[] = [];
    const execRunner: ExecRunner = {
      run: async (input): Promise<ExecResult> => {
        calls.push(input);
        return {
          command: [input.command, ...(input.args ?? [])].join(" "),
          exitCode: 0,
          stdout: "",
          stderr: "",
        };
      },
    };

    const manager = new ShellOpenClawGatewayServiceManager(execRunner, createLogger());
    await manager.install({ force: true });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "openclaw",
      args: ["gateway", "install", "--force"],
    });
  });

  it("throws structured install error on non-zero exit code", async () => {
    const execRunner: ExecRunner = {
      run: async (): Promise<ExecResult> => ({
        command: "openclaw gateway install",
        exitCode: 1,
        stdout: "stdout",
        stderr: "stderr",
      }),
    };

    const manager = new ShellOpenClawGatewayServiceManager(execRunner, createLogger());
    await expect(manager.install()).rejects.toMatchObject({
      code: "OPENCLAW_GATEWAY_INSTALL_FAILED",
      retryable: true,
    });
  });
});
