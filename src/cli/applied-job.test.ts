import { describe, expect, it } from "vitest";

import type { InstallJobStatusResponse } from "../contracts/index.js";
import { describeAppliedJob, EXIT_APPLIED_DEGRADED, waitForAppliedJob } from "./applied-job.js";

const job = (
  state: InstallJobStatusResponse["job"]["state"],
  steps: InstallJobStatusResponse["job"]["steps"] = [],
): InstallJobStatusResponse["job"] => ({
  jobId: "job_1",
  state,
  createdAt: "2026-10-12T10:00:00.000Z",
  steps,
});

const appliedSteps: InstallJobStatusResponse["job"]["steps"] = [
  { id: "openclaw_configure", label: "Configure OpenClaw runtime", state: "succeeded" },
  {
    id: "gateway_ready",
    label: "Wait for OpenClaw gateway",
    state: "warned",
    error: { code: "OPENCLAW_GATEWAY_NOT_READY", message: "not listening", retryable: true },
  },
  { id: "test_alert", label: "Send hello alert", state: "pending" },
];

describe("describeAppliedJob", () => {
  it("exits 0 when the job succeeded and the gateway listens", () => {
    const report = describeAppliedJob("Mail settings", {
      job: job("succeeded", [appliedSteps[0] as never]),
      gateway: {
        ready: true,
        readyAt: "2026-10-12T10:01:00.000Z",
        waitedMs: 4_000,
        deadlineMs: 300_000,
      },
    });
    expect(report.exitCode).toBe(0);
    expect(report.lines).toEqual(["  [ok] Configure OpenClaw runtime", "Mail settings applied."]);
    expect(report.gateway?.ready).toBe(true);
  });

  it("exits 0 when the job did not restart the gateway", () => {
    const report = describeAppliedJob("Mail settings", { job: job("succeeded") });
    expect(report).toEqual({
      job: job("succeeded"),
      lines: ["Mail settings applied."],
      exitCode: 0,
    });
  });

  it("exits 7 with the not-ready message when the gateway is not listening", () => {
    const report = describeAppliedJob("Mail settings", {
      job: job("succeeded", appliedSteps),
      gateway: { ready: false, waitedMs: 300_400, deadlineMs: 300_000 },
    });
    expect(report.exitCode).toBe(EXIT_APPLIED_DEGRADED);
    expect(EXIT_APPLIED_DEGRADED).toBe(7);
    expect(report.lines).toEqual([
      "  [ok] Configure OpenClaw runtime",
      "  [warn] Wait for OpenClaw gateway (not listening)",
      "Mail settings applied, but the OpenClaw gateway is not ready yet (not listening after 300 s). Bots will not reply and mail reviews will fail until it is. Check with: sovereign-node status --json",
    ]);
  });

  it("exits 1 with the job error when the job failed", () => {
    const failed = describeAppliedJob("Mail settings", {
      job: job("failed", [
        {
          id: "openclaw_configure",
          label: "Configure OpenClaw runtime",
          state: "failed",
          error: { code: "X", message: "step broke", retryable: false },
        },
        { id: "bots_configure", label: "Register managed bots", state: "skipped" },
      ]),
      error: { code: "X", message: "job broke", retryable: false },
    });
    expect(failed.exitCode).toBe(1);
    expect(failed.lines).toEqual([
      "  [FAILED] Configure OpenClaw runtime (step broke)",
      "  [skipped] Register managed bots",
      "Mail settings could not be applied: job broke",
    ]);
  });

  it("falls back to the failed step, then the job state, for the reason", () => {
    expect(
      describeAppliedJob("X", {
        job: job("failed", [
          {
            id: "preflight",
            label: "Preflight",
            state: "failed",
            error: { code: "P", message: "preflight broke", retryable: false },
          },
        ]),
      }).lines.at(-1),
    ).toBe("X could not be applied: preflight broke");
    expect(describeAppliedJob("X", { job: job("canceled") }).lines).toEqual([
      "X could not be applied: canceled",
    ]);
  });

  it("exits 1 when the job is still running at the poll deadline", () => {
    const report = describeAppliedJob("X", {
      job: job("running", [{ id: "preflight", label: "Preflight", state: "running" }]),
    });
    expect(report.exitCode).toBe(1);
    expect(report.lines).toEqual([
      "  [running] Preflight",
      "X is still being applied (job job_1 is running). Check with: sovereign-node status --json",
    ]);
  });
});

describe("waitForAppliedJob", () => {
  it("polls until the job is terminal", async () => {
    const states: InstallJobStatusResponse["job"]["state"][] = ["running", "succeeded"];
    const sleeps: number[] = [];
    const report = await waitForAppliedJob(
      "Mail settings",
      "job_1",
      async () => ({ job: job(states.shift() ?? "succeeded") }),
      {
        sleepFn: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    expect(report.exitCode).toBe(0);
    expect(sleeps).toEqual([2_000]);
  });
});
