import type { Command } from "commander";
import { z } from "zod";

import type { AppContainer } from "../../app/create-app.js";
import {
  type MatrixOnboardingReadiness,
  matrixOnboardingIssueResultSchema,
  matrixOnboardingReadinessSchema,
} from "../../contracts/index.js";
import { writeCliError, writeCliSuccess } from "../output.js";

const matrixOnboardingReadyOutcomeSchema = matrixOnboardingReadinessSchema.extend({
  timedOut: z.boolean(),
});

type OnboardingIssueOptions = {
  ttlMinutes?: string;
  json?: boolean;
};

type OnboardingReadyOptions = {
  wait?: boolean;
  timeoutSeconds?: string;
  json?: boolean;
};

const ONBOARDING_READY_POLL_INTERVAL_MS = 2_000;
// Per-mode wait ceilings. relay-passthrough must cover the DNS-01 issuance
// window (Caddy waits propagation_delay 150s + up to propagation_timeout 600s),
// so allow generous headroom; every other mode is reachable within seconds.
const ONBOARDING_READY_PASSTHROUGH_DEADLINE_MS = 12 * 60_000;
const ONBOARDING_READY_DEFAULT_DEADLINE_MS = 60_000;

export type OnboardingReadyOutcome = MatrixOnboardingReadiness & { timedOut: boolean };

const onboardingReadyDeadlineFor = (mode: MatrixOnboardingReadiness["mode"]): number =>
  mode === "relay-passthrough"
    ? ONBOARDING_READY_PASSTHROUGH_DEADLINE_MS
    : ONBOARDING_READY_DEFAULT_DEADLINE_MS;

/**
 * Polls the onboarding-readiness probe until the page is reachable or a per-mode
 * deadline elapses. Returns the last reading with `timedOut` set — it never
 * rejects on not-ready, so the installer can reveal-with-warning instead of
 * aborting. When `deadlineMs` is not given, the ceiling is derived from the mode
 * and can only grow as real readings arrive: the first ticks of a fresh install
 * report mode "direct"/reason "config-not-found" (config still writing), and we
 * must not lock the short default and give up before a relay-passthrough cert
 * finishes issuing.
 */
export const awaitOnboardingReady = async (
  poll: () => Promise<MatrixOnboardingReadiness>,
  opts: {
    intervalMs?: number;
    deadlineMs?: number;
    sleepFn?: (ms: number) => Promise<void>;
  } = {},
): Promise<OnboardingReadyOutcome> => {
  const intervalMs = opts.intervalMs ?? ONBOARDING_READY_POLL_INTERVAL_MS;
  const sleep = opts.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const startedAt = Date.now();
  let deadlineMs = opts.deadlineMs ?? ONBOARDING_READY_DEFAULT_DEADLINE_MS;
  const sizeDeadline = (reading: MatrixOnboardingReadiness): void => {
    if (opts.deadlineMs !== undefined) return;
    if (reading.reason === "config-not-found") return;
    deadlineMs = Math.max(deadlineMs, onboardingReadyDeadlineFor(reading.mode));
  };

  let last = await poll();
  if (last.ready) {
    return { ...last, timedOut: false };
  }
  sizeDeadline(last);
  while (Date.now() - startedAt < deadlineMs) {
    await sleep(intervalMs);
    last = await poll();
    if (last.ready) {
      return { ...last, timedOut: false };
    }
    sizeDeadline(last);
  }
  return { ...last, timedOut: true };
};

export const registerOnboardingCommand = (program: Command, app: AppContainer): void => {
  const onboarding = program.command("onboarding").description("Manage Matrix onboarding access");

  onboarding
    .command("issue")
    .description("Issue a one-time Matrix onboarding code")
    .option("--ttl-minutes <minutes>", "Override code lifetime in minutes", "21")
    .option("--json", "Emit JSON output")
    .action(async (opts: OnboardingIssueOptions) => {
      const command = "onboarding issue";
      try {
        const ttlMinutes = Number.parseInt(opts.ttlMinutes ?? "21", 10);
        if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
          throw new Error("Provide a positive integer for --ttl-minutes");
        }
        const result = await app.installerService.issueMatrixOnboardingCode({ ttlMinutes });
        if (opts.json) {
          writeCliSuccess(command, result, matrixOnboardingIssueResultSchema, true);
          return;
        }
        process.stdout.write(
          [
            "Matrix onboarding code issued.",
            `Code: ${result.code}`,
            `Expires: ${result.expiresAt}`,
            `Onboarding URL: ${result.onboardingUrl}`,
            `Shareable link: ${result.onboardingLink}`,
            `Username: ${result.username}`,
            "Regenerate: sudo sovereign-node onboarding issue",
            "",
          ].join("\n"),
        );
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });

  onboarding
    .command("ready")
    .description("Check (or wait for) the public onboarding page to become reachable")
    .option("--wait", "Poll until the onboarding page is reachable or the timeout elapses")
    .option(
      "--timeout-seconds <seconds>",
      "Override the wait ceiling (defaults: 720s for relay-passthrough, 60s otherwise)",
    )
    .option("--json", "Emit JSON output")
    .action(async (opts: OnboardingReadyOptions) => {
      const command = "onboarding ready";
      try {
        const poll = () => app.installerService.getMatrixOnboardingReadiness();
        let outcome: OnboardingReadyOutcome;
        if (opts.wait) {
          const deadlineMs = parseTimeoutSeconds(opts.timeoutSeconds);
          outcome = await awaitOnboardingReady(poll, {
            ...(deadlineMs === undefined ? {} : { deadlineMs }),
          });
        } else {
          // Single-shot check: we did not wait, so timedOut is always false —
          // `ready` alone carries whether the page is reachable right now.
          const reading = await poll();
          outcome = { ...reading, timedOut: false };
        }

        if (opts.json) {
          writeCliSuccess(command, outcome, matrixOnboardingReadyOutcomeSchema, true);
        } else if (outcome.ready) {
          process.stdout.write(`Onboarding page is reachable: ${outcome.url}\n`);
        } else {
          // Never block the caller: a not-ready/timed-out result is reported on
          // stderr but still exits 0 so `set -e` install scripts continue and
          // reveal the URL/QR with a warning.
          process.stderr.write(
            `Onboarding page not reachable yet (mode=${outcome.mode}${
              outcome.reason === undefined ? "" : `, reason=${outcome.reason}`
            }); it may take a few minutes to come online.\n`,
          );
        }
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });
};

const parseTimeoutSeconds = (raw?: string): number | undefined => {
  if (raw === undefined) {
    return undefined;
  }
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("Provide a positive integer for --timeout-seconds");
  }
  return seconds * 1_000;
};
