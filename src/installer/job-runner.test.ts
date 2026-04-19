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
