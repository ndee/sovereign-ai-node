import type { ExecResult } from "../system/exec.js";

/**
 * Preparing an OpenClaw 2026.8 runtime for its first gateway start.
 *
 * 2026.8 no longer bundles the Matrix channel, migrates its state on the first
 * repair, and refuses to start on a config it considers invalid. Each of these
 * has to happen before the gateway is started, with the gateway stopped, or the
 * start turns into a restart loop:
 * 1. install the external `@openclaw/matrix` plugin at the host's own version;
 * 2. `openclaw doctor --fix --non-interactive`;
 * 3. `openclaw config validate` as the hard gate.
 */

export const OPENCLAW_MATRIX_PLUGIN_PACKAGE = "@openclaw/matrix";
export const OPENCLAW_PLUGIN_INSTALL_TIMEOUT_MS = 600_000;
export const OPENCLAW_PLUGIN_INSTALL_ATTEMPTS = 3;
export const OPENCLAW_PLUGIN_INSTALL_RETRY_DELAYS_MS = [10_000, 30_000] as const;
export const OPENCLAW_DOCTOR_TIMEOUT_MS = 600_000;
export const OPENCLAW_CLI_CHECK_TIMEOUT_MS = 120_000;

export const OPENCLAW_DOCTOR_ARGS = ["doctor", "--fix", "--non-interactive"] as const;
export const OPENCLAW_CONFIG_VALIDATE_ARGS = ["config", "validate"] as const;

/**
 * What a CLI prints when it wanted to ask something. Doctor does not prompt
 * without a TTY today; this catches it if that ever changes, because the
 * unattended path must not depend on a default answer.
 */
export const OPENCLAW_PROMPT_PATTERN =
  /(\(y\/n\)|\[y\/n\]|\by\/N\b|\bY\/n\b|ExitPromptError|force closed the prompt|prompt was cancel|cancelled by user|not a tty|stdin is not a|use arrow keys|press (enter|space|return) to|^\s*[◆◇]\s.*\?\s*$|\?\s*›)/im;

/** Exit statuses of `timeout(1)` and of a SIGKILL: a run that never ended on its own. */
const KILLED_EXIT_CODES = new Set([124, 137]);

const TRANSIENT_FAILURE_PATTERN =
  /\b(ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|socket hang up|fetch failed|network|429|502|503|504)\b/i;

export type OpenClawCliRun = (
  args: string[],
  options: { timeoutMs: number },
) => Promise<{ ok: true; result: ExecResult } | { ok: false; error: string }>;

export type OpenClawFirstStartDeps = {
  run: OpenClawCliRun;
  sleep: (ms: number) => Promise<void>;
};

type InstallerFailure = {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
};

const OUTPUT_TAIL_CHARS = 1200;

const tail = (value: string): string =>
  value.length <= OUTPUT_TAIL_CHARS ? value : value.slice(value.length - OUTPUT_TAIL_CHARS);

const describeResult = (result: ExecResult): Record<string, unknown> => ({
  command: result.command,
  exitCode: result.exitCode,
  ...(result.failureReason === undefined ? {} : { failureReason: result.failureReason }),
  stdout: tail(result.stdout),
  stderr: tail(result.stderr),
});

const outputOf = (result: ExecResult): string => `${result.stdout}\n${result.stderr}`;

/** The run never ended on its own: most likely it waited for an answer on stdin. */
const didNotFinish = (result: ExecResult): boolean =>
  result.failureReason === "timed_out" || KILLED_EXIT_CODES.has(result.exitCode);

export const openClawAskedForInput = (result: ExecResult): boolean =>
  didNotFinish(result) || OPENCLAW_PROMPT_PATTERN.test(outputOf(result));

export const isTransientOpenClawFailure = (result: ExecResult): boolean =>
  result.failureReason !== "spawn_failed" &&
  (didNotFinish(result) || TRANSIENT_FAILURE_PATTERN.test(outputOf(result)));

/**
 * The Matrix plugin is the first-party channel at the host's own version: the
 * newest published one needs a newer plugin API than the host exposes.
 */
export const buildMatrixPluginInstallArgs = (version: string, acceptCapabilities: boolean) => [
  "plugins",
  "install",
  `npm:${OPENCLAW_MATRIX_PLUGIN_PACKAGE}@${version}`,
  "--force",
  ...(acceptCapabilities ? ["--accept-capabilities"] : []),
];

/**
 * Whether `plugins install` takes `--accept-capabilities`. 2026.8 refuses an
 * unattended install of a plugin that declares capabilities without it, and a
 * release that does not know the flag rejects it.
 */
const pluginInstallTakesCapabilityConsent = async (run: OpenClawCliRun): Promise<boolean> => {
  const help = await run(["plugins", "install", "--help"], {
    timeoutMs: OPENCLAW_CLI_CHECK_TIMEOUT_MS,
  });
  return help.ok && outputOf(help.result).includes("--accept-capabilities");
};

export const installOpenClawMatrixPlugin = async (
  deps: OpenClawFirstStartDeps,
  version: string,
): Promise<string[]> => {
  const args = buildMatrixPluginInstallArgs(
    version,
    await pluginInstallTakesCapabilityConsent(deps.run),
  );
  let last: { ok: true; result: ExecResult } | { ok: false; error: string } | undefined;
  for (let attempt = 1; attempt <= OPENCLAW_PLUGIN_INSTALL_ATTEMPTS; attempt += 1) {
    last = await deps.run(args, { timeoutMs: OPENCLAW_PLUGIN_INSTALL_TIMEOUT_MS });
    if (last.ok && last.result.exitCode === 0) {
      return args;
    }
    const retry =
      last.ok &&
      isTransientOpenClawFailure(last.result) &&
      attempt < OPENCLAW_PLUGIN_INSTALL_ATTEMPTS;
    if (!retry) {
      break;
    }
    await deps.sleep(OPENCLAW_PLUGIN_INSTALL_RETRY_DELAYS_MS[attempt - 1] ?? 0);
  }
  const failure: InstallerFailure = {
    code: "OPENCLAW_MATRIX_PLUGIN_INSTALL_FAILED",
    message: `OpenClaw could not install the Matrix channel plugin ${OPENCLAW_MATRIX_PLUGIN_PACKAGE}@${version}`,
    // The same install succeeds on a rerun once the registry answers again.
    retryable: true,
    details:
      last === undefined || !last.ok
        ? { args, error: last?.error ?? "not run" }
        : { args, ...describeResult(last.result) },
  };
  throw failure;
};

export const runOpenClawDoctorFix = async (deps: OpenClawFirstStartDeps): Promise<void> => {
  const outcome = await deps.run([...OPENCLAW_DOCTOR_ARGS], {
    timeoutMs: OPENCLAW_DOCTOR_TIMEOUT_MS,
  });
  if (!outcome.ok) {
    throw {
      code: "OPENCLAW_DOCTOR_FAILED",
      message: "openclaw doctor could not be run",
      retryable: true,
      details: { error: outcome.error },
    } satisfies InstallerFailure;
  }
  if (openClawAskedForInput(outcome.result)) {
    throw {
      code: "OPENCLAW_DOCTOR_PROMPTED",
      message: didNotFinish(outcome.result)
        ? `openclaw doctor did not finish within ${OPENCLAW_DOCTOR_TIMEOUT_MS / 1000}s with stdin closed (waiting for input)`
        : "openclaw doctor asked an interactive question",
      retryable: false,
      details: describeResult(outcome.result),
    } satisfies InstallerFailure;
  }
  if (outcome.result.exitCode !== 0) {
    throw {
      code: "OPENCLAW_DOCTOR_FAILED",
      message: `openclaw doctor exited ${outcome.result.exitCode}`,
      retryable: true,
      details: describeResult(outcome.result),
    } satisfies InstallerFailure;
  }
};

export const validateOpenClawConfig = async (deps: OpenClawFirstStartDeps): Promise<void> => {
  const outcome = await deps.run([...OPENCLAW_CONFIG_VALIDATE_ARGS], {
    timeoutMs: OPENCLAW_CLI_CHECK_TIMEOUT_MS,
  });
  if (outcome.ok && outcome.result.exitCode === 0) {
    return;
  }
  throw {
    code: "OPENCLAW_CONFIG_INVALID",
    message: "openclaw config validate rejected the rendered OpenClaw config",
    retryable: false,
    details: outcome.ok ? describeResult(outcome.result) : { error: outcome.error },
  } satisfies InstallerFailure;
};

/** Runs the three steps in order; the first failure stops the gateway start. */
export const prepareOpenClawGatewayFirstStart = async (
  deps: OpenClawFirstStartDeps,
  version: string,
): Promise<void> => {
  await installOpenClawMatrixPlugin(deps, version);
  await runOpenClawDoctorFix(deps);
  await validateOpenClawConfig(deps);
};
