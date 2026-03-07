import { describe, expect, it } from "vitest";

import { createLogger } from "../logging/logger.js";
import type { ExecInput, ExecResult, ExecRunner } from "../system/exec.js";
import { ShellOpenClawManagedAgentRegistrar } from "./managed-agent.js";

describe("ShellOpenClawManagedAgentRegistrar", () => {
  it("registers agent and cron when commands succeed", async () => {
    const calls: ExecInput[] = [];
    const execRunner: ExecRunner = {
      run: async (input): Promise<ExecResult> => {
        calls.push(input);
        const serialized = [input.command, ...(input.args ?? [])].join(" ");
        return {
          command: serialized,
          exitCode: 0,
          stdout: serialized === "openclaw cron list --json" ? "{\"jobs\":[]}" : "",
          stderr: "",
        };
      },
    };

    const registrar = new ShellOpenClawManagedAgentRegistrar(execRunner, createLogger());
    const result = await registrar.register({
      agentId: "mail-sentinel",
      workspaceDir: "/var/lib/sovereign-node/mail-sentinel/workspace",
      cron: {
        id: "mail-sentinel-poll",
        every: "5m",
        message: "Summarize new inbox mail",
        announceRoomId: "!alerts:matrix.example.org",
        session: "isolated",
      },
    });

    expect(result.agentId).toBe("mail-sentinel");
    expect(result.cronJobId).toBe("mail-sentinel-poll");
    expect(calls[0]).toMatchObject({
      command: "openclaw",
      args: [
        "agents",
        "add",
        "mail-sentinel",
        "--workspace",
        "/var/lib/sovereign-node/mail-sentinel/workspace",
      ],
      options: {
        timeout: 90000,
        env: {
          CI: "1",
        },
      },
    });
    expect(calls[1]).toMatchObject({
      command: "openclaw",
      args: ["cron", "list", "--json"],
    });
    expect(calls[2]?.command).toBe("openclaw");
    expect(calls[2]?.args?.slice(0, 5)).toEqual([
      "cron",
      "add",
      "--name",
      "mail-sentinel-poll",
      "--agent",
    ]);
  });

  it("falls back when first cron command variant fails", async () => {
    const calls: string[] = [];
    const execRunner: ExecRunner = {
      run: async (input): Promise<ExecResult> => {
        const serialized = [input.command, ...(input.args ?? [])].join(" ");
        calls.push(serialized);
        if (serialized === "openclaw cron list --json") {
          return {
            command: serialized,
            exitCode: 0,
            stdout: "{\"jobs\":[]}",
            stderr: "",
          };
        }
        if (serialized.includes("cron add") && serialized.includes("--replace")) {
          return {
            command: serialized,
            exitCode: 2,
            stdout: "",
            stderr: "unknown flag: --replace",
          };
        }
        return {
          command: serialized,
          exitCode: 0,
          stdout: "",
          stderr: "",
        };
      },
    };

    const registrar = new ShellOpenClawManagedAgentRegistrar(execRunner, createLogger());
    const result = await registrar.register({
      agentId: "mail-sentinel",
      workspaceDir: "/tmp/ws",
      cron: {
        id: "mail-sentinel-poll",
        every: "5m",
        message: "Summarize new inbox mail",
      },
    });

    expect(result.cronCommand?.includes("--replace")).toBe(false);
    expect(calls.some((entry) => entry.includes("--replace"))).toBe(true);
  });

  it("falls back to legacy agent flags when positional syntax is unavailable", async () => {
    const calls: string[] = [];
    const execRunner: ExecRunner = {
      run: async (input): Promise<ExecResult> => {
        const serialized = [input.command, ...(input.args ?? [])].join(" ");
        calls.push(serialized);
        if (serialized === "openclaw cron list --json") {
          return {
            command: serialized,
            exitCode: 0,
            stdout: "{\"jobs\":[]}",
            stderr: "",
          };
        }
        if (serialized === "openclaw agents add mail-sentinel --workspace /tmp/ws") {
          return {
            command: serialized,
            exitCode: 1,
            stdout: "",
            stderr: "unknown command add",
          };
        }
        if (serialized === "openclaw agents create mail-sentinel --workspace /tmp/ws") {
          return {
            command: serialized,
            exitCode: 1,
            stdout: "",
            stderr: "unknown command create",
          };
        }
        if (serialized === "openclaw agents upsert mail-sentinel --workspace /tmp/ws") {
          return {
            command: serialized,
            exitCode: 1,
            stdout: "",
            stderr: "unknown command upsert",
          };
        }
        return {
          command: serialized,
          exitCode: 0,
          stdout: "",
          stderr: "",
        };
      },
    };

    const registrar = new ShellOpenClawManagedAgentRegistrar(execRunner, createLogger());
    const result = await registrar.register({
      agentId: "mail-sentinel",
      workspaceDir: "/tmp/ws",
      cron: {
        id: "mail-sentinel-poll",
        every: "5m",
        message: "Summarize new inbox mail",
      },
    });

    expect(result.agentCommand).toContain(
      "openclaw agents upsert --id mail-sentinel --workspace /tmp/ws",
    );
    expect(calls).toContain(
      "openclaw agents upsert --id mail-sentinel --workspace /tmp/ws",
    );
  });

  it("removes existing cron jobs with the same name before re-registering", async () => {
    const calls: string[] = [];
    const execRunner: ExecRunner = {
      run: async (input): Promise<ExecResult> => {
        const serialized = [input.command, ...(input.args ?? [])].join(" ");
        calls.push(serialized);
        if (serialized === "openclaw cron list --json") {
          return {
            command: serialized,
            exitCode: 0,
            stdout: JSON.stringify({
              jobs: [
                {
                  id: "11111111-1111-1111-1111-111111111111",
                  name: "mail-sentinel-poll",
                  agentId: "mail-sentinel",
                },
                {
                  id: "22222222-2222-2222-2222-222222222222",
                  name: "mail-sentinel-poll",
                  agentId: "mail-sentinel",
                },
              ],
            }),
            stderr: "",
          };
        }
        return {
          command: serialized,
          exitCode: 0,
          stdout: "",
          stderr: "",
        };
      },
    };

    const registrar = new ShellOpenClawManagedAgentRegistrar(execRunner, createLogger());
    await registrar.register({
      agentId: "mail-sentinel",
      workspaceDir: "/tmp/ws",
      cron: {
        id: "mail-sentinel-poll",
        every: "5m",
        message: "Summarize new inbox mail",
      },
    });

    expect(calls).toContain("openclaw cron rm 11111111-1111-1111-1111-111111111111");
    expect(calls).toContain("openclaw cron rm 22222222-2222-2222-2222-222222222222");
    expect(calls.at(-1)).toContain("openclaw cron add --name mail-sentinel-poll");
  });

  it("retries cron listing when OpenClaw gateway is temporarily unavailable", async () => {
    const calls: string[] = [];
    let jsonListAttempts = 0;
    const execRunner: ExecRunner = {
      run: async (input): Promise<ExecResult> => {
        const serialized = [input.command, ...(input.args ?? [])].join(" ");
        calls.push(serialized);
        if (serialized === "openclaw cron list --json") {
          jsonListAttempts += 1;
          if (jsonListAttempts === 1) {
            return {
              command: serialized,
              exitCode: 1,
              stdout: "",
              stderr: "Error: gateway closed (1006 abnormal closure (no close frame))",
            };
          }
          return {
            command: serialized,
            exitCode: 0,
            stdout: "{\"jobs\":[]}",
            stderr: "",
          };
        }
        return {
          command: serialized,
          exitCode: 0,
          stdout: "",
          stderr: "",
        };
      },
    };

    const registrar = new ShellOpenClawManagedAgentRegistrar(execRunner, createLogger());
    const result = await registrar.register({
      agentId: "mail-sentinel",
      workspaceDir: "/tmp/ws",
      cron: {
        id: "mail-sentinel-poll",
        every: "5m",
        message: "Summarize new inbox mail",
      },
    });

    expect(result.cronJobId).toBe("mail-sentinel-poll");
    expect(jsonListAttempts).toBe(2);
    expect(calls).toContain("openclaw cron list --json");
  });
});
