import { describe, expect, it } from "vitest";

import type { ExecResult } from "../system/exec.js";
import {
  buildMatrixPluginInstallArgs,
  installOpenClawMatrixPlugin,
  isTransientOpenClawFailure,
  OPENCLAW_CLI_CHECK_TIMEOUT_MS,
  OPENCLAW_DOCTOR_TIMEOUT_MS,
  OPENCLAW_PLUGIN_INSTALL_ATTEMPTS,
  OPENCLAW_PLUGIN_INSTALL_RETRY_DELAYS_MS,
  OPENCLAW_PLUGIN_INSTALL_TIMEOUT_MS,
  type OpenClawCliRun,
  openClawAskedForInput,
  prepareOpenClawGatewayFirstStart,
  runOpenClawDoctorFix,
  validateOpenClawConfig,
} from "./openclaw-first-start.js";

const HELP_WITH_CONSENT =
  "Usage: openclaw plugins install [options] <spec>\n  --force\n  --accept-capabilities  Accept the plugin's declared capabilities\n";
const HELP_WITHOUT_CONSENT = "Usage: openclaw plugins install [options] <spec>\n  --force\n";

const result = (overrides: Partial<ExecResult> = {}): ExecResult => ({
  command: "openclaw",
  exitCode: 0,
  stdout: "",
  stderr: "",
  ...overrides,
});

type Reply = ExecResult | { error: string };

/** A CLI whose replies are scripted per subcommand, recording every call. */
const scriptedCli = (replies: Record<string, Reply[]>) => {
  const calls: Array<{ args: string[]; timeoutMs: number }> = [];
  const sleeps: number[] = [];
  const run: OpenClawCliRun = async (args, options) => {
    calls.push({ args, timeoutMs: options.timeoutMs });
    const key = args.includes("--help") ? "help" : args.slice(0, 2).join(" ");
    const queue = replies[key] ?? [];
    const reply = (queue.length > 1 ? queue.shift() : queue[0]) ?? result();
    return "error" in reply ? { ok: false, error: reply.error } : { ok: true, result: reply };
  };
  return {
    calls,
    sleeps,
    deps: {
      run,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    },
  };
};

describe("the Matrix plugin install", () => {
  it("installs the plugin at the host version from npm, with capability consent when the CLI takes it", async () => {
    const cli = scriptedCli({ help: [result({ stdout: HELP_WITH_CONSENT })] });

    const args = await installOpenClawMatrixPlugin(cli.deps, "2026.8.35");

    expect(args).toEqual([
      "plugins",
      "install",
      "npm:@openclaw/matrix@2026.8.35",
      "--force",
      "--accept-capabilities",
    ]);
    expect(cli.calls).toEqual([
      { args: ["plugins", "install", "--help"], timeoutMs: OPENCLAW_CLI_CHECK_TIMEOUT_MS },
      { args, timeoutMs: OPENCLAW_PLUGIN_INSTALL_TIMEOUT_MS },
    ]);
  });

  it("leaves the consent flag out when the CLI does not list it or its help cannot be read", async () => {
    for (const help of [result({ stdout: HELP_WITHOUT_CONSENT }), { error: "spawn EACCES" }]) {
      const cli = scriptedCli({ help: [help] });
      expect(await installOpenClawMatrixPlugin(cli.deps, "2026.8.35")).toEqual(
        buildMatrixPluginInstallArgs("2026.8.35", false),
      );
    }
  });

  it("retries a transient failure with a backoff and succeeds", async () => {
    const cli = scriptedCli({
      help: [result({ stdout: HELP_WITH_CONSENT })],
      "plugins install": [
        result({ exitCode: 1, stderr: "npm error code EAI_AGAIN" }),
        result({ exitCode: 1, failureReason: "timed_out" }),
        result(),
      ],
    });

    await installOpenClawMatrixPlugin(cli.deps, "2026.8.35");

    expect(cli.calls.filter((call) => !call.args.includes("--help"))).toHaveLength(3);
    expect(cli.sleeps).toEqual([...OPENCLAW_PLUGIN_INSTALL_RETRY_DELAYS_MS]);
  });

  it("gives up after the last attempt and reports the failure as retryable", async () => {
    const cli = scriptedCli({
      help: [result({ stdout: HELP_WITH_CONSENT })],
      "plugins install": [result({ exitCode: 1, stderr: "fetch failed (ENOTFOUND)" })],
    });

    await expect(installOpenClawMatrixPlugin(cli.deps, "2026.8.35")).rejects.toMatchObject({
      code: "OPENCLAW_MATRIX_PLUGIN_INSTALL_FAILED",
      retryable: true,
      details: { exitCode: 1, stderr: "fetch failed (ENOTFOUND)" },
    });
    expect(cli.calls.filter((call) => !call.args.includes("--help"))).toHaveLength(
      OPENCLAW_PLUGIN_INSTALL_ATTEMPTS,
    );
    expect(cli.sleeps).toHaveLength(OPENCLAW_PLUGIN_INSTALL_ATTEMPTS - 1);
  });

  it("does not retry a failure a second attempt cannot fix", async () => {
    const incompatible = result({
      exitCode: 1,
      stderr: "requires plugin API >=2026.10.9, but this OpenClaw runtime exposes 2026.8.35",
    });
    const cli = scriptedCli({ help: [result()], "plugins install": [incompatible] });

    await expect(installOpenClawMatrixPlugin(cli.deps, "2026.8.35")).rejects.toMatchObject({
      code: "OPENCLAW_MATRIX_PLUGIN_INSTALL_FAILED",
      details: { stderr: incompatible.stderr },
    });
    expect(cli.sleeps).toEqual([]);
  });

  it("reports a CLI that could not be started", async () => {
    const cli = scriptedCli({ help: [result()], "plugins install": [{ error: "spawn ENOENT" }] });

    await expect(installOpenClawMatrixPlugin(cli.deps, "2026.8.35")).rejects.toMatchObject({
      details: { error: "spawn ENOENT" },
    });
    expect(cli.sleeps).toEqual([]);
  });

  it("keeps only the end of a long output", async () => {
    const cli = scriptedCli({
      help: [result()],
      "plugins install": [result({ exitCode: 1, stdout: `${"x".repeat(5000)}END` })],
    });

    const failure = (await installOpenClawMatrixPlugin(cli.deps, "2026.8.35").then(
      () => null,
      (error: unknown) => error,
    )) as { details: { stdout: string } };

    expect(failure.details.stdout).toHaveLength(1200);
    expect(failure.details.stdout.endsWith("END")).toBe(true);
  });
});

describe("the doctor repair", () => {
  it("runs doctor --fix --non-interactive with the long timeout", async () => {
    const cli = scriptedCli({});

    await runOpenClawDoctorFix(cli.deps);

    expect(cli.calls).toEqual([
      { args: ["doctor", "--fix", "--non-interactive"], timeoutMs: OPENCLAW_DOCTOR_TIMEOUT_MS },
    ]);
  });

  it.each([
    ["a timeout", result({ exitCode: 143, failureReason: "timed_out" }), /did not finish within/],
    ["timeout(1)'s exit status", result({ exitCode: 124 }), /did not finish within/],
    ["a SIGKILL", result({ exitCode: 137 }), /did not finish within/],
    ["a y/n question", result({ stdout: "Apply this repair? (y/N)" }), /asked an interactive/],
    ["a prompt error", result({ exitCode: 1, stderr: "ExitPromptError: closed" }), /asked an/],
    ["a select prompt", result({ stdout: "◆  Which agent should own ambient work?\n" }), /asked/],
  ])("treats %s as an interactive prompt", async (_label, reply, message) => {
    const cli = scriptedCli({ "doctor --fix": [reply] });

    await expect(runOpenClawDoctorFix(cli.deps)).rejects.toMatchObject({
      code: "OPENCLAW_DOCTOR_PROMPTED",
      retryable: false,
      message: expect.stringMatching(message),
    });
  });

  it("fails on a non-zero exit and on a CLI that could not be started", async () => {
    await expect(
      runOpenClawDoctorFix(
        scriptedCli({ "doctor --fix": [result({ exitCode: 2, stderr: "boom" })] }).deps,
      ),
    ).rejects.toMatchObject({
      code: "OPENCLAW_DOCTOR_FAILED",
      message: "openclaw doctor exited 2",
    });
    await expect(
      runOpenClawDoctorFix(scriptedCli({ "doctor --fix": [{ error: "spawn EACCES" }] }).deps),
    ).rejects.toMatchObject({ code: "OPENCLAW_DOCTOR_FAILED", details: { error: "spawn EACCES" } });
  });

  it("accepts doctor's ordinary output", async () => {
    const output =
      "┌  OpenClaw doctor\n│\n◇  Config\n[warning] gateway.bind - Gateway is only bound to loopback.\n└  Doctor complete.\n";
    await expect(
      runOpenClawDoctorFix(scriptedCli({ "doctor --fix": [result({ stdout: output })] }).deps),
    ).resolves.toBeUndefined();
  });
});

describe("the config validation", () => {
  it("runs config validate and passes on exit 0", async () => {
    const cli = scriptedCli({});
    await validateOpenClawConfig(cli.deps);
    expect(cli.calls).toEqual([
      { args: ["config", "validate"], timeoutMs: OPENCLAW_CLI_CHECK_TIMEOUT_MS },
    ]);
  });

  it("is a hard gate", async () => {
    await expect(
      validateOpenClawConfig(
        scriptedCli({ "config validate": [result({ exitCode: 1, stderr: "agents.list" })] }).deps,
      ),
    ).rejects.toMatchObject({
      code: "OPENCLAW_CONFIG_INVALID",
      retryable: false,
      details: { stderr: "agents.list" },
    });
    await expect(
      validateOpenClawConfig(scriptedCli({ "config validate": [{ error: "spawn ENOENT" }] }).deps),
    ).rejects.toMatchObject({
      code: "OPENCLAW_CONFIG_INVALID",
      details: { error: "spawn ENOENT" },
    });
  });
});

describe("the first-start preparation", () => {
  it("installs the plugin, then repairs, then validates", async () => {
    const cli = scriptedCli({ help: [result({ stdout: HELP_WITH_CONSENT })] });

    await prepareOpenClawGatewayFirstStart(cli.deps, "2026.8.35");

    expect(cli.calls.map((call) => call.args.slice(0, 2).join(" "))).toEqual([
      "plugins install",
      "plugins install",
      "doctor --fix",
      "config validate",
    ]);
  });

  it("does not repair or validate when the plugin install fails", async () => {
    const cli = scriptedCli({ help: [result()], "plugins install": [result({ exitCode: 1 })] });

    await expect(prepareOpenClawGatewayFirstStart(cli.deps, "2026.8.35")).rejects.toMatchObject({
      code: "OPENCLAW_MATRIX_PLUGIN_INSTALL_FAILED",
    });
    expect(cli.calls.some((call) => call.args[0] === "doctor")).toBe(false);
  });
});

describe("output classification", () => {
  it("never retries a spawn failure", () => {
    expect(
      isTransientOpenClawFailure(result({ exitCode: 127, failureReason: "spawn_failed" })),
    ).toBe(false);
  });

  it("does not take a clean run for a prompt", () => {
    expect(openClawAskedForInput(result({ stdout: "Config valid" }))).toBe(false);
  });
});
