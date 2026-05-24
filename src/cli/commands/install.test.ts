import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { InstallJobStatusResponse } from "../../contracts/index.js";

import { awaitInstallJob, resolveInstallRequest } from "./install.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("resolveInstallRequest", () => {
  it("uses the default saved install request when it exists", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-install-command-test-"));
    tempRoots.push(tempRoot);
    const requestPath = join(tempRoot, "install-request.json");
    await writeFile(
      requestPath,
      JSON.stringify({
        mode: "bundled_matrix",
        openrouter: {
          secretRef: "file:/tmp/openrouter-secret",
        },
        imap: {
          host: "127.0.0.1",
          port: 1143,
          tls: true,
          username: "bridge-user",
          secretRef: "file:/tmp/imap-secret",
          mailbox: "INBOX",
        },
        matrix: {
          homeserverDomain: "matrix.example.org",
          publicBaseUrl: "https://matrix.example.org",
        },
        operator: {
          username: "operator",
        },
      }),
      "utf8",
    );

    const req = await resolveInstallRequest({}, requestPath);

    expect(req.imap).toMatchObject({
      host: "127.0.0.1",
      port: 1143,
      tls: true,
      username: "bridge-user",
      secretRef: "file:/tmp/imap-secret",
      mailbox: "INBOX",
    });
    expect(req.openrouter.secretRef).toBe("file:/tmp/openrouter-secret");
  });

  it("falls back to scaffold defaults when the saved request file is missing", async () => {
    const req = await resolveInstallRequest({}, join(tmpdir(), "missing-install-request.json"));

    expect(req.mode).toBe("bundled_matrix");
    expect(req.imap).toBeUndefined();
    expect(req.connectivity?.mode).toBe("relay");
    expect(req.operator.username).toBe("operator");
    expect(req.bots).toBeUndefined();
  });

  it("prefers an explicit request file over the default path", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-install-command-test-"));
    tempRoots.push(tempRoot);
    const explicitPath = join(tempRoot, "explicit.json");
    await writeFile(
      explicitPath,
      JSON.stringify({
        mode: "bundled_matrix",
        openrouter: {
          secretRef: "file:/tmp/openrouter-explicit",
        },
        matrix: {
          homeserverDomain: "explicit.example.org",
          publicBaseUrl: "https://explicit.example.org",
        },
        operator: {
          username: "explicit-operator",
        },
      }),
      "utf8",
    );

    const req = await resolveInstallRequest(
      { requestFile: explicitPath },
      join(tempRoot, "default-does-not-matter.json"),
    );

    expect(req.matrix.homeserverDomain).toBe("explicit.example.org");
    expect(req.operator.username).toBe("explicit-operator");
  });

  it("uses repeatable --bot flags to build a multi-bot install request", async () => {
    const req = await resolveInstallRequest(
      {
        bot: ["mail-sentinel", "node-operator"],
      },
      join(tmpdir(), "missing-install-request.json"),
    );

    expect(req.bots?.selected).toEqual(["mail-sentinel", "node-operator"]);
    expect(req.bots?.config).toBeUndefined();
  });
});

const makeJobResponse = (
  state: "pending" | "running" | "succeeded" | "failed" | "canceled",
): InstallJobStatusResponse => ({
  job: {
    jobId: "job_test-1",
    state,
    createdAt: "2026-01-01T00:00:00.000Z",
    steps: [
      {
        id: "preflight",
        label: "Preflight",
        state: state === "succeeded" ? "succeeded" : "pending",
      },
    ],
  },
});

describe("awaitInstallJob", () => {
  const noopSleep = async () => {};

  it("returns immediately when the first poll yields a succeeded job", async () => {
    const poll = vi.fn().mockResolvedValue(makeJobResponse("succeeded"));

    const result = await awaitInstallJob("job_test-1", poll, { sleepFn: noopSleep });

    expect(result.job.state).toBe("succeeded");
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("returns immediately when the first poll yields a failed job", async () => {
    const poll = vi.fn().mockResolvedValue(makeJobResponse("failed"));

    const result = await awaitInstallJob("job_test-1", poll, { sleepFn: noopSleep });

    expect(result.job.state).toBe("failed");
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("returns immediately when the first poll yields a canceled job", async () => {
    const poll = vi.fn().mockResolvedValue(makeJobResponse("canceled"));

    const result = await awaitInstallJob("job_test-1", poll, { sleepFn: noopSleep });

    expect(result.job.state).toBe("canceled");
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("polls until the job transitions from pending to succeeded", async () => {
    const poll = vi
      .fn()
      .mockResolvedValueOnce(makeJobResponse("pending"))
      .mockResolvedValueOnce(makeJobResponse("running"))
      .mockResolvedValueOnce(makeJobResponse("succeeded"));

    const result = await awaitInstallJob("job_test-1", poll, { sleepFn: noopSleep });

    expect(result.job.state).toBe("succeeded");
    expect(poll).toHaveBeenCalledTimes(3);
  });

  it("polls until the job transitions from running to failed", async () => {
    const poll = vi
      .fn()
      .mockResolvedValueOnce(makeJobResponse("running"))
      .mockResolvedValueOnce(makeJobResponse("failed"));

    const result = await awaitInstallJob("job_test-1", poll, { sleepFn: noopSleep });

    expect(result.job.state).toBe("failed");
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("returns the last poll result when the deadline expires", async () => {
    const poll = vi.fn().mockResolvedValue(makeJobResponse("running"));

    const result = await awaitInstallJob("job_test-1", poll, {
      deadlineMs: 0,
      sleepFn: noopSleep,
    });

    expect(result.job.state).toBe("running");
  });

  it("passes the job id to each poll call", async () => {
    const poll = vi.fn().mockResolvedValue(makeJobResponse("succeeded"));

    await awaitInstallJob("job_abc-123", poll, { sleepFn: noopSleep });

    expect(poll).toHaveBeenCalledWith("job_abc-123");
  });
});
