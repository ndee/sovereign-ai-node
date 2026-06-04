import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { describe, expect, it } from "vitest";

import { createLogger } from "../logging/logger.js";
import type { ExecInput, ExecResult, ExecRunner } from "../system/exec.js";
import {
  isSystemdBusUnavailableMessage,
  ShellOpenClawGatewayServiceManager,
} from "./gateway-service.js";

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
    const priorPath = process.env.PATH;
    const priorOpenClawHome = process.env.OPENCLAW_HOME;
    const priorOpenClawConfig = process.env.OPENCLAW_CONFIG;
    const priorOpenClawConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    const priorSovereignNodeConfig = process.env.SOVEREIGN_NODE_CONFIG;
    const commandDir = await mkdtemp(join(tmpdir(), "openclaw-bin-"));
    const resolvedOpenclaw = join(commandDir, "openclaw");
    await writeFile(resolvedOpenclaw, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(resolvedOpenclaw, 0o755);
    process.env.SUDO_USER = "user1";
    process.env.SUDO_UID = "1000";
    process.env.PATH = priorPath ? `${commandDir}${delimiter}${priorPath}` : commandDir;
    process.env.OPENCLAW_HOME = "/var/lib/sovereign-node/openclaw-home/.openclaw";
    process.env.OPENCLAW_CONFIG = "/var/lib/sovereign-node/openclaw-home/.openclaw/openclaw.json5";
    process.env.OPENCLAW_CONFIG_PATH =
      "/var/lib/sovereign-node/openclaw-home/.openclaw/openclaw.json5";
    process.env.SOVEREIGN_NODE_CONFIG = "/etc/sovereign-node/config.json5";
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
        args: [
          "-u",
          "user1",
          "--",
          "/usr/bin/env",
          "CI=1",
          "XDG_RUNTIME_DIR=/run/user/1000",
          "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus",
          "OPENCLAW_HOME=/var/lib/sovereign-node/openclaw-home/.openclaw",
          "OPENCLAW_CONFIG=/var/lib/sovereign-node/openclaw-home/.openclaw/openclaw.json5",
          "OPENCLAW_CONFIG_PATH=/var/lib/sovereign-node/openclaw-home/.openclaw/openclaw.json5",
          "SOVEREIGN_NODE_CONFIG=/etc/sovereign-node/config.json5",
          process.execPath,
          resolvedOpenclaw,
          "gateway",
          "install",
        ],
        options: {
          timeout: 120000,
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
      if (priorPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = priorPath;
      }
      if (priorOpenClawHome === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = priorOpenClawHome;
      }
      if (priorOpenClawConfig === undefined) {
        delete process.env.OPENCLAW_CONFIG;
      } else {
        process.env.OPENCLAW_CONFIG = priorOpenClawConfig;
      }
      if (priorOpenClawConfigPath === undefined) {
        delete process.env.OPENCLAW_CONFIG_PATH;
      } else {
        process.env.OPENCLAW_CONFIG_PATH = priorOpenClawConfigPath;
      }
      if (priorSovereignNodeConfig === undefined) {
        delete process.env.SOVEREIGN_NODE_CONFIG;
      } else {
        process.env.SOVEREIGN_NODE_CONFIG = priorSovereignNodeConfig;
      }
      await rm(commandDir, { recursive: true, force: true });
    }
  });

  it("retries gateway install via invoking sudo user on a system-scope bus permission denial", async () => {
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
              stdout: "No gateway token found. Auto-generated one and saving to config.",
              stderr:
                "Gateway install failed: Error: systemctl daemon-reload failed: " +
                "Failed to connect to system scope bus via machine transport: Permission denied\n" +
                "Reload daemon failed: Transport endpoint is not connected",
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
      expect(calls[0]).toMatchObject({ command: "openclaw", args: ["gateway", "install"] });
      expect(calls[1]).toMatchObject({ command: "sudo", args: expect.arrayContaining(["user1"]) });
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

describe("ShellOpenClawGatewayServiceManager start/restart", () => {
  it("runs openclaw gateway start", async () => {
    const calls: ExecInput[] = [];
    const execRunner: ExecRunner = {
      run: async (input): Promise<ExecResult> => {
        calls.push(input);
        return { command: "openclaw gateway start", exitCode: 0, stdout: "", stderr: "" };
      },
    };

    const manager = new ShellOpenClawGatewayServiceManager(execRunner, createLogger());
    await manager.start();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ command: "openclaw", args: ["gateway", "start"] });
  });

  it("runs openclaw gateway restart", async () => {
    const calls: ExecInput[] = [];
    const execRunner: ExecRunner = {
      run: async (input): Promise<ExecResult> => {
        calls.push(input);
        return { command: "openclaw gateway restart", exitCode: 0, stdout: "", stderr: "" };
      },
    };

    const manager = new ShellOpenClawGatewayServiceManager(execRunner, createLogger());
    await manager.restart();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ command: "openclaw", args: ["gateway", "restart"] });
  });

  it("throws a restart error when the sudo-user retry also fails", async () => {
    const priorSudoUser = process.env.SUDO_USER;
    const priorSudoUid = process.env.SUDO_UID;
    process.env.SUDO_USER = "user1";
    process.env.SUDO_UID = "1000";
    try {
      const execRunner: ExecRunner = {
        run: async (input): Promise<ExecResult> => ({
          command: [input.command, ...(input.args ?? [])].join(" "),
          exitCode: 1,
          stdout: "",
          // Long stderr exercises the truncation path in the structured error.
          stderr: `systemctl --user unavailable: ${"x".repeat(5000)}`,
        }),
      };

      const manager = new ShellOpenClawGatewayServiceManager(execRunner, createLogger());
      await expect(manager.restart()).rejects.toMatchObject({
        code: "OPENCLAW_GATEWAY_RESTART_FAILED",
        details: {
          stderr: expect.stringContaining("...(truncated)"),
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

  it("skips the sudo-user fallback when SUDO_UID is not numeric", async () => {
    const calls: ExecInput[] = [];
    const priorSudoUser = process.env.SUDO_USER;
    const priorSudoUid = process.env.SUDO_UID;
    process.env.SUDO_USER = "user1";
    process.env.SUDO_UID = "not-a-number";
    try {
      const execRunner: ExecRunner = {
        run: async (input): Promise<ExecResult> => {
          calls.push(input);
          return {
            command: "openclaw gateway install",
            exitCode: 1,
            stdout: "",
            stderr: "systemctl --user unavailable: Failed to connect to bus: No medium found",
          };
        },
      };

      const manager = new ShellOpenClawGatewayServiceManager(execRunner, createLogger());
      await expect(manager.install()).rejects.toMatchObject({
        code: "OPENCLAW_GATEWAY_INSTALL_FAILED",
      });
      // Invalid uid means no sudo fallback is attempted; only the primary runs.
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ command: "openclaw" });
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

describe("isSystemdBusUnavailableMessage", () => {
  it.each([
    "systemctl --user unavailable",
    "Gateway service check failed: Failed to connect to bus: No medium found",
    "Failed to connect to system scope bus via machine transport: Permission denied",
    "Reload daemon failed: Transport endpoint is not connected",
  ])("recognizes systemd/D-Bus unavailability: %s", (message) => {
    expect(isSystemdBusUnavailableMessage(message)).toBe(true);
  });

  it.each([
    "Gateway install failed: relay enrollment rejected the node token",
    "Error: connection refused",
    "",
  ])("does not match unrelated failures: %s", (message) => {
    expect(isSystemdBusUnavailableMessage(message)).toBe(false);
  });
});
