import type {
  GatewayReadinessSummary,
  InstallJobStatusResponse,
  InstallJobSummary,
} from "../contracts/index.js";
import { awaitInstallJob } from "./commands/install.js";

/** Exit code for "the change was applied, but the node is degraded". */
export const EXIT_APPLIED_DEGRADED = 2;

export type AppliedJobReport = {
  job: InstallJobSummary;
  gateway?: GatewayReadinessSummary;
  lines: string[];
  exitCode: 0 | 1 | typeof EXIT_APPLIED_DEGRADED;
};

const STEP_MARK: Record<string, string> = {
  succeeded: "ok",
  warned: "warn",
  failed: "FAILED",
  skipped: "skipped",
};

/**
 * Waits for the install job that applies a settings change and turns its
 * terminal state into operator-facing lines and an exit code.
 */
export const waitForAppliedJob = async (
  subject: string,
  jobId: string,
  poll: (jobId: string) => Promise<InstallJobStatusResponse>,
  options: { sleepFn?: (ms: number) => Promise<void> } = {},
): Promise<AppliedJobReport> => {
  const response = await awaitInstallJob(jobId, poll, options);
  return describeAppliedJob(subject, response);
};

export const describeAppliedJob = (
  subject: string,
  response: InstallJobStatusResponse,
): AppliedJobReport => {
  const { job, gateway } = response;
  const lines = job.steps
    .filter((step) => step.state !== "pending")
    .map((step) => {
      const mark = STEP_MARK[step.state] ?? step.state;
      const error = step.error === undefined ? "" : ` (${step.error.message})`;
      return `  [${mark}] ${step.label}${error}`;
    });
  const base = { job, ...(gateway === undefined ? {} : { gateway }) };

  if (job.state === "failed" || job.state === "canceled") {
    const failedStep = job.steps.find((step) => step.state === "failed");
    const reason = response.error?.message ?? failedStep?.error?.message ?? job.state;
    lines.push(`${subject} could not be applied: ${reason}`);
    return { ...base, lines, exitCode: 1 };
  }
  if (job.state !== "succeeded") {
    lines.push(
      `${subject} is still being applied (job ${job.jobId} is ${job.state}). Check with: sovereign-node status --json`,
    );
    return { ...base, lines, exitCode: 1 };
  }
  if (gateway !== undefined && !gateway.ready) {
    lines.push(
      `${subject} applied, but the OpenClaw gateway is not ready yet (not listening after ${Math.round(
        gateway.waitedMs / 1000,
      )} s). Bots will not reply and mail reviews will fail until it is. Check with: sovereign-node status --json`,
    );
    return { ...base, lines, exitCode: EXIT_APPLIED_DEGRADED };
  }
  lines.push(`${subject} applied.`);
  return { ...base, lines, exitCode: 0 };
};
