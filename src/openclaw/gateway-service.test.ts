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
      options: {
        timeout: 120000,
        env: {
          CI: "1",
        },
      },
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

  it("retries gateway install via invoking sudo user when root user bus is unavailable", async () => {
    const calls: ExecInput[] = [];
    const priorSudoUser = process.env.SUDO_USER;
    const priorSudoUid = process.env.SUDO_UID;
    process.env.SUDO_USER = "user1";
    process.env.SUDO_UID = "1000";
    try {
      const execRunner: ExecRunner = {
        run: async (input): Promise<ExecResult> => {
          calls.push(input);
          if (input.command === "openclaw") {
            return {
              command: "openclaw gateway install",
              exitCode: 1,
              stdout: "",
              stderr:
                "Gateway service check failed: Error: systemctl --user unavailable: Failed to connect to bus: No medium found",
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

      const manager = new ShellOpenClawGatewayServiceManager(execRunner, createLogger());
      await manager.install();

      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({
        command: "openclaw",
        args: ["gateway", "install"],
      });
      expect(calls[1]).toMatchObject({
        command: "sudo",
        args: ["-u", "user1", "--", "openclaw", "gateway", "install"],
        options: {
          timeout: 120000,
          env: {
            CI: "1",
            XDG_RUNTIME_DIR: "/run/user/1000",
            DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
          },
        },
      });
    } finally {
      if (priorSudoUser === undefined) {
        delete process.env.SUDO_USER;
      } else {
        process.env.SUDO_USER = priorSudoUser;
      }
      if (priorSudoUid === undefined) {
        delete process.env.SUDO_UID;
      } else {
        process.env.SUDO_UID = priorSudoUid;
      }
    }
  });
});
