import { describe, expect, it } from "vitest";

import { createLogger } from "../logging/logger.js";
import type { ExecInput, ExecResult, ExecRunner } from "../system/exec.js";
import { ShellOpenClawMailSentinelRegistrar } from "./mail-sentinel.js";

describe("ShellOpenClawMailSentinelRegistrar", () => {
  it("registers agent and cron when commands succeed", async () => {
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

    const registrar = new ShellOpenClawMailSentinelRegistrar(execRunner, createLogger());
    const result = await registrar.register({
      agentId: "mail-sentinel",
      workspaceDir: "/var/lib/sovereign-node/mail-sentinel/workspace",
      cronJobName: "mail-sentinel-poll",
      pollInterval: "5m",
      lookbackWindow: "15m",
      roomId: "!alerts:matrix.example.org",
    });

    expect(result.agentId).toBe("mail-sentinel");
    expect(result.cronJobId).toBe("mail-sentinel-poll");
    expect(calls[0]).toMatchObject({
      command: "openclaw",
      args: [
        "agents",
        "upsert",
        "--id",
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
    expect(calls[1]?.command).toBe("openclaw");
    expect(calls[1]?.args?.slice(0, 5)).toEqual([
      "cron",
      "add",
      "--name",
      "mail-sentinel-poll",
      "--every",
    ]);
  });

  it("falls back when first cron command variant fails", async () => {
    const calls: string[] = [];
    const execRunner: ExecRunner = {
      run: async (input): Promise<ExecResult> => {
        const serialized = [input.command, ...(input.args ?? [])].join(" ");
        calls.push(serialized);
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

    const registrar = new ShellOpenClawMailSentinelRegistrar(execRunner, createLogger());
    const result = await registrar.register({
      agentId: "mail-sentinel",
      workspaceDir: "/tmp/ws",
      cronJobName: "mail-sentinel-poll",
      pollInterval: "5m",
      lookbackWindow: "15m",
      roomId: "!alerts:matrix.example.org",
    });

    expect(result.cronCommand.includes("--replace")).toBe(false);
    expect(calls.some((entry) => entry.includes("--replace"))).toBe(true);
  });
});
