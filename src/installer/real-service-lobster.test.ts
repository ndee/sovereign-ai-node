import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ExecResult, ExecRunner } from "../system/exec.js";
import { detectInstalledLobsterCli, ensureLobsterCliInstalled } from "./real-service-lobster.js";

const buildExecRunner = (
  responses: ExecResult[],
): { runner: ExecRunner; calls: Parameters<ExecRunner["run"]>[0][] } => {
  const calls: Parameters<ExecRunner["run"]>[0][] = [];
  let index = 0;
  const runner: ExecRunner = {
    async run(input) {
      calls.push(input);
      const response = responses[index];
      index += 1;
      if (!response) {
        throw new Error(`unexpected exec call #${index}: ${input.command}`);
      }
      return response;
    },
  };
  return { runner, calls };
};

const noopLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
} as never;

// Run `action` with process.getuid() forced to return 0 (root), restoring the
// original afterwards. process.getuid is typed as possibly-undefined, so we
// swap the function directly rather than spying.
const withRootUid = async <T>(action: () => Promise<T>): Promise<T> => {
  const proc = process as { getuid?: () => number };
  const original = proc.getuid;
  proc.getuid = () => 0;
  try {
    return await action();
  } finally {
    if (original === undefined) {
      delete proc.getuid;
    } else {
      proc.getuid = original;
    }
  }
};

const successResult = (overrides: Partial<ExecResult> = {}): ExecResult => ({
  command: "noop",
  exitCode: 0,
  stdout: "",
  stderr: "",
  ...overrides,
});

describe("real-service-lobster", () => {
  it("anchors npm/lobster invocations to the API service HOME via env", async () => {
    const { runner, calls } = buildExecRunner([
      successResult({ stdout: '["clawd.invoke"]' }),
      successResult({
        stdout: JSON.stringify({
          dependencies: { "@clawdbot/lobster": { version: "2026.1.24" } },
        }),
      }),
    ]);

    const result = await detectInstalledLobsterCli({
      execRunner: runner,
      packageName: "@clawdbot/lobster",
      probeTimeoutMs: 5_000,
    });

    expect(result).not.toBeNull();
    expect(result?.version).toBe("2026.1.24");
    expect(result?.commands).toContain("clawd.invoke");

    // Both calls must carry HOME and npm_config_prefix so npm uses the
    // service user's npm-global prefix even after OpenClaw mutates
    // process.env.HOME during install.
    const expectedPrefix = join(process.env.HOME ?? "", ".npm-global");
    for (const call of calls) {
      const env = call.options?.env as Record<string, string> | undefined;
      expect(env?.CI).toBe("1");
      expect(env?.HOME).toBe(process.env.HOME);
      expect(env?.npm_config_prefix).toBe(expectedPrefix);
    }
  });

  it("targets the service user's HOME and npm prefix when serviceHome is supplied", async () => {
    const { runner, calls } = buildExecRunner([
      successResult({ stdout: '["clawd.invoke"]' }),
      successResult({
        stdout: JSON.stringify({
          dependencies: { "@clawdbot/lobster": { version: "2026.1.24" } },
        }),
      }),
    ]);

    const serviceHome = "/var/lib/sovereign-node";
    const result = await detectInstalledLobsterCli({
      execRunner: runner,
      packageName: "@clawdbot/lobster",
      probeTimeoutMs: 5_000,
      serviceHome,
    });

    expect(result).not.toBeNull();
    for (const call of calls) {
      const env = call.options?.env as Record<string, string> | undefined;
      expect(env?.HOME).toBe(serviceHome);
      expect(env?.npm_config_prefix).toBe(join(serviceHome, ".npm-global"));
    }
  });

  it("delegates to the service user via sudo when running as root", async () => {
    await withRootUid(async () => {
      const { runner, calls } = buildExecRunner([
        successResult({ stdout: '["clawd.invoke"]' }),
        successResult({
          stdout: JSON.stringify({
            dependencies: { "@clawdbot/lobster": { version: "2026.1.24" } },
          }),
        }),
      ]);

      await detectInstalledLobsterCli({
        execRunner: runner,
        packageName: "@clawdbot/lobster",
        probeTimeoutMs: 5_000,
        serviceHome: "/var/lib/sovereign-node",
        runAsUser: "sovereign-node",
      });

      const lobsterCall = calls[0];
      if (!lobsterCall) throw new Error("expected lobster probe call");
      expect(lobsterCall.command).toBe("sudo");
      expect(lobsterCall.args?.slice(0, 4)).toEqual([
        "-u",
        "sovereign-node",
        "--preserve-env=HOME,npm_config_prefix,CI,PATH",
        "--",
      ]);
      expect(lobsterCall.args).toContain("lobster");

      const npmListCall = calls[1];
      if (!npmListCall) throw new Error("expected npm list call");
      expect(npmListCall.command).toBe("sudo");
      expect(npmListCall.args).toContain("npm");
    });
  });

  it("does not delegate when the service user is root", async () => {
    await withRootUid(async () => {
      const { runner, calls } = buildExecRunner([
        successResult({ stdout: '["clawd.invoke"]' }),
        successResult({
          stdout: JSON.stringify({
            dependencies: { "@clawdbot/lobster": { version: "2026.1.24" } },
          }),
        }),
      ]);

      await detectInstalledLobsterCli({
        execRunner: runner,
        packageName: "@clawdbot/lobster",
        probeTimeoutMs: 5_000,
        runAsUser: "root",
      });

      expect(calls[0]?.command).toBe("lobster");
      expect(calls[1]?.command).toBe("npm");
    });
  });

  it("delegates the install command to the service user when running as root", async () => {
    await withRootUid(async () => {
      const { runner, calls } = buildExecRunner([
        successResult({ exitCode: 1 }), // detect probe fails -> null
        successResult({ stdout: "" }), // npm install
        successResult({ stdout: '["clawd.invoke"]' }), // re-probe lobster
        successResult({
          stdout: JSON.stringify({
            dependencies: { "@clawdbot/lobster": { version: "2026.1.24" } },
          }),
        }),
      ]);

      await ensureLobsterCliInstalled({
        execRunner: runner,
        logger: noopLogger,
        packageName: "@clawdbot/lobster",
        version: "2026.1.24",
        installTimeoutMs: 60_000,
        probeTimeoutMs: 5_000,
        requiredCommands: ["clawd.invoke"],
        serviceHome: "/var/lib/sovereign-node",
        runAsUser: "sovereign-node",
      });

      const installCall = calls[1];
      if (!installCall) throw new Error("expected install call");
      expect(installCall.command).toBe("sudo");
      expect(installCall.args).toEqual([
        "-u",
        "sovereign-node",
        "--preserve-env=HOME,npm_config_prefix,CI,PATH",
        "--",
        "npm",
        "install",
        "-g",
        "@clawdbot/lobster@2026.1.24",
      ]);
      const env = installCall.options?.env as Record<string, string>;
      expect(env.HOME).toBe("/var/lib/sovereign-node");
      expect(env.npm_config_prefix).toBe(join("/var/lib/sovereign-node", ".npm-global"));
    });
  });

  it("returns null when lobster probe exits non-zero", async () => {
    const { runner } = buildExecRunner([
      successResult({ exitCode: 1, stderr: "lobster: not found" }),
    ]);

    const result = await detectInstalledLobsterCli({
      execRunner: runner,
      packageName: "@clawdbot/lobster",
      probeTimeoutMs: 5_000,
    });

    expect(result).toBeNull();
  });

  it("returns null exec runner short-circuits the probe", async () => {
    const result = await detectInstalledLobsterCli({
      execRunner: null,
      packageName: "@clawdbot/lobster",
      probeTimeoutMs: 5_000,
    });
    expect(result).toBeNull();
  });

  it("skips reinstall when an existing Lobster CLI matches version", async () => {
    const { runner, calls } = buildExecRunner([
      successResult({ stdout: '["clawd.invoke"]' }),
      successResult({
        stdout: JSON.stringify({
          dependencies: { "@clawdbot/lobster": { version: "2026.1.24" } },
        }),
      }),
    ]);

    await expect(
      ensureLobsterCliInstalled({
        execRunner: runner,
        logger: noopLogger,
        packageName: "@clawdbot/lobster",
        version: "2026.1.24",
        installTimeoutMs: 60_000,
        probeTimeoutMs: 5_000,
        requiredCommands: ["clawd.invoke"],
      }),
    ).resolves.toBeUndefined();

    // Probe (lobster + npm list). No install attempted.
    expect(calls).toHaveLength(2);
  });

  it("reinstalls when the existing CLI version does not match and required commands are missing", async () => {
    const { runner, calls } = buildExecRunner([
      successResult({ stdout: '["other.command"]' }),
      successResult({
        stdout: JSON.stringify({
          dependencies: { "@clawdbot/lobster": { version: "2026.1.10" } },
        }),
      }),
      successResult({ stdout: "" }), // npm install
      successResult({ stdout: '["clawd.invoke"]' }), // re-probe lobster
      successResult({
        stdout: JSON.stringify({
          dependencies: { "@clawdbot/lobster": { version: "2026.1.24" } },
        }),
      }),
    ]);

    await expect(
      ensureLobsterCliInstalled({
        execRunner: runner,
        logger: noopLogger,
        packageName: "@clawdbot/lobster",
        version: "2026.1.24",
        installTimeoutMs: 60_000,
        probeTimeoutMs: 5_000,
        requiredCommands: ["clawd.invoke"],
      }),
    ).resolves.toBeUndefined();

    const installCall = calls[2];
    if (!installCall) throw new Error("expected install call");
    expect(installCall.command).toBe("npm");
    expect(installCall.args).toEqual(["install", "-g", "@clawdbot/lobster@2026.1.24"]);
    const env = installCall.options?.env as Record<string, string>;
    expect(env.HOME).toBe(process.env.HOME);
    expect(env.npm_config_prefix).toBe(join(process.env.HOME ?? "", ".npm-global"));
  });

  it("throws LOBSTER_INSTALL_FAILED with stderr details when npm install fails", async () => {
    const { runner } = buildExecRunner([
      successResult({ exitCode: 1 }), // probe lobster fails -> detected null
      successResult({
        exitCode: 1,
        stderr: "EACCES: permission denied, mkdir '/usr/lib/node_modules/@clawdbot'",
      }),
    ]);

    await expect(
      ensureLobsterCliInstalled({
        execRunner: runner,
        logger: noopLogger,
        packageName: "@clawdbot/lobster",
        version: "2026.1.24",
        installTimeoutMs: 60_000,
        probeTimeoutMs: 5_000,
        requiredCommands: ["clawd.invoke"],
      }),
    ).rejects.toMatchObject({
      code: "LOBSTER_INSTALL_FAILED",
      message: "npm install for Lobster CLI exited with non-zero status",
      details: { exitCode: 1, stderr: expect.stringContaining("EACCES") },
    });
  });

  it("throws when a null exec runner is passed to ensureLobsterCliInstalled", async () => {
    await expect(
      ensureLobsterCliInstalled({
        execRunner: null,
        logger: noopLogger,
        packageName: "@clawdbot/lobster",
        version: "2026.1.24",
        installTimeoutMs: 60_000,
        probeTimeoutMs: 5_000,
        requiredCommands: ["clawd.invoke"],
      }),
    ).rejects.toMatchObject({
      code: "LOBSTER_INSTALL_FAILED",
      message: "Exec runner unavailable; cannot install or probe Lobster CLI",
    });
  });

  it("throws verification failure when reinstall succeeds but required commands still missing", async () => {
    const { runner } = buildExecRunner([
      successResult({ exitCode: 1 }), // detected null
      successResult({ stdout: "" }), // npm install ok
      successResult({ stdout: '["other.command"]' }), // re-probe finds CLI but wrong commands
      successResult({
        stdout: JSON.stringify({
          dependencies: { "@clawdbot/lobster": { version: "2026.1.10" } },
        }),
      }),
    ]);

    await expect(
      ensureLobsterCliInstalled({
        execRunner: runner,
        logger: noopLogger,
        packageName: "@clawdbot/lobster",
        version: "2026.1.24",
        installTimeoutMs: 60_000,
        probeTimeoutMs: 5_000,
        requiredCommands: ["clawd.invoke"],
      }),
    ).rejects.toMatchObject({
      code: "LOBSTER_INSTALL_FAILED",
      message: "Lobster CLI installed but required workflow commands are unavailable",
    });
  });
});
