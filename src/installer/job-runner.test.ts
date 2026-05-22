import { describe, expect, it } from "vitest";

import type { InstallStep } from "./job-runner.js";
import { JobRunner } from "./job-runner.js";

const ctx = { jobId: "test-job", installationId: "test-install" };

describe("JobRunner", () => {
  it("marks softFail steps as warned and continues", async () => {
    const steps: InstallStep[] = [
      {
        id: "preflight",
        label: "Preflight",
        run: async () => {},
      },
      {
        id: "imap_validate",
        label: "Validate IMAP",
        softFail: true,
        run: async () => {
          throw { code: "IMAP_TEST_FAILED", message: "Connection refused", retryable: true };
        },
      },
      {
        id: "relay_enroll",
        label: "Enroll relay",
        run: async () => {},
      },
    ];

    const runner = new JobRunner();
    const result = await runner.run(ctx, steps);

    expect(result.job.state).toBe("succeeded");
    expect(result.error).toBeUndefined();

    const imapStep = result.job.steps.find((s) => s.id === "imap_validate");
    expect(imapStep?.state).toBe("warned");
    expect(imapStep?.error?.code).toBe("IMAP_TEST_FAILED");

    const relayStep = result.job.steps.find((s) => s.id === "relay_enroll");
    expect(relayStep?.state).toBe("succeeded");
  });

  it("forwards reportProgress writes to the current step and notifies observers", async () => {
    const snapshots: Array<{ stepId: string; note?: string }> = [];
    const steps: InstallStep[] = [
      {
        id: "prepare_docker_runtime",
        label: "Prepare Docker runtime",
        run: async (_ctx, reportProgress) => {
          await reportProgress("");
          await reportProgress("  ");
          await reportProgress("Installing Docker runtime");
          await reportProgress("Docker runtime installed");
        },
      },
    ];

    const runner = new JobRunner();
    const result = await runner.run(ctx, steps, (snapshot) => {
      const step = snapshot.job.steps[0];
      if (step?.state === "running") {
        snapshots.push({
          stepId: step.id,
          ...(step.progressNote === undefined ? {} : { note: step.progressNote }),
        });
      }
    });

    expect(result.job.state).toBe("succeeded");
    const finalStep = result.job.steps[0];
    expect(finalStep?.progressNote).toBe("Docker runtime installed");
    expect(finalStep?.progressUpdatedAt).toBeDefined();
    expect(snapshots.filter((s) => s.note !== undefined).map((s) => s.note)).toEqual([
      "Installing Docker runtime",
      "Docker runtime installed",
    ]);
  });

  it("still hard-fails steps without softFail", async () => {
    const steps: InstallStep[] = [
      {
        id: "preflight",
        label: "Preflight",
        run: async () => {
          throw { code: "PREFLIGHT_FAILED", message: "Check failed", retryable: false };
        },
      },
      {
        id: "imap_validate",
        label: "Validate IMAP",
        run: async () => {},
      },
    ];

    const runner = new JobRunner();
    const result = await runner.run(ctx, steps);

    expect(result.job.state).toBe("failed");
    expect(result.error?.code).toBe("PREFLIGHT_FAILED");
    expect(result.job.steps.find((s) => s.id === "imap_validate")?.state).toBe("pending");
  });
});
