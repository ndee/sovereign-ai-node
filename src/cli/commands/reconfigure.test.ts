import { Command } from "commander";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppContainer } from "../../app/create-app.js";
import type { InstallJobStatusResponse, ReconfigureResult } from "../../contracts/index.js";
import { registerReconfigureCommand } from "./reconfigure.js";

const pendingJob = {
  jobId: "job_1",
  state: "pending" as const,
  createdAt: "2026-10-12T10:00:00.000Z",
  steps: [],
};

const savedResult = (overrides: Partial<ReconfigureResult> = {}): ReconfigureResult => ({
  target: "imap",
  changed: ["imap.host"],
  restartRequiredServices: [],
  validation: [{ id: "mail-config", name: "Mail configuration", status: "pass", message: "saved" }],
  job: pendingJob,
  ...overrides,
});

const terminal = (gatewayReady: boolean): InstallJobStatusResponse => ({
  job: {
    ...pendingJob,
    state: "succeeded",
    steps: [
      {
        id: "gateway_ready",
        label: "Wait for OpenClaw gateway",
        state: gatewayReady ? "succeeded" : "warned",
      },
    ],
  },
  gateway: { ready: gatewayReady, waitedMs: gatewayReady ? 4_000 : 300_000, deadlineMs: 300_000 },
});

const createApp = (result: ReconfigureResult, job: InstallJobStatusResponse) =>
  ({
    installerService: {
      getSettings: vi.fn(async () => ({
        mail: {
          configured: true,
          protocol: "imap",
          host: "imap.example.org",
          port: 993,
          tls: true,
          username: "user@example.org",
          mailbox: "INBOX",
          passwordSet: true,
          editable: true,
        },
      })),
      reconfigureImap: vi.fn(async () => result),
      getInstallJob: vi.fn(async () => job),
    },
  }) as unknown as AppContainer;

const run = async (app: AppContainer, extra: string[]): Promise<string> => {
  const program = new Command();
  program.exitOverride();
  registerReconfigureCommand(program, app);
  let out = "";
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  try {
    await program.parseAsync([
      "node",
      "test",
      "reconfigure",
      "imap",
      "--secret-ref",
      "file:/tmp/mail-secret",
      ...extra,
    ]);
  } finally {
    write.mockRestore();
  }
  return out;
};

describe("reconfigure imap", () => {
  let priorExitCode: typeof process.exitCode;

  beforeEach(() => {
    priorExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = priorExitCode;
  });

  it("waits for the install job and exits 2 when the gateway is not ready", async () => {
    const app = createApp(savedResult(), terminal(false));

    const out = await run(app, []);

    expect(app.installerService.getInstallJob).toHaveBeenCalledWith("job_1");
    expect(out).toContain("[warn] Wait for OpenClaw gateway");
    expect(out).toContain(
      "Mail settings applied, but the OpenClaw gateway is not ready yet (not listening after 300 s).",
    );
    expect(process.exitCode).toBe(2);
  });

  it("carries the job and gateway readiness in --json output", async () => {
    const app = createApp(savedResult(), terminal(false));

    const envelope = JSON.parse(await run(app, ["--json"])) as {
      ok: boolean;
      result: ReconfigureResult;
    };

    expect(envelope.ok).toBe(true);
    expect(envelope.result.job?.state).toBe("succeeded");
    expect(envelope.result.gateway).toEqual({
      ready: false,
      waitedMs: 300_000,
      deadlineMs: 300_000,
    });
    expect(process.exitCode).toBe(2);
  });

  it("exits 0 once the job applied the change and the gateway listens", async () => {
    const app = createApp(savedResult(), terminal(true));

    expect(await run(app, [])).toContain("Mail settings applied.");
    expect(process.exitCode).toBe(0);
  });

  it("keeps the fire-and-forget behaviour with --no-wait", async () => {
    const app = createApp(savedResult(), terminal(false));

    const envelope = JSON.parse(await run(app, ["--no-wait", "--json"])) as {
      result: ReconfigureResult;
    };

    expect(app.installerService.getInstallJob).not.toHaveBeenCalled();
    expect(envelope.result.job?.state).toBe("pending");
    expect(process.exitCode).toBeUndefined();
  });

  it("does not wait when the new connection failed its test", async () => {
    const app = createApp(
      savedResult({
        job: undefined,
        validation: [{ id: "mail-connection", name: "Mail", status: "fail", message: "refused" }],
      }),
      terminal(true),
    );

    await run(app, ["--json"]);

    expect(app.installerService.getInstallJob).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("does not wait when no job was started", async () => {
    const app = createApp(savedResult({ job: undefined }), terminal(true));

    await run(app, []);

    expect(app.installerService.getInstallJob).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("omits the gateway field when the job reported none", async () => {
    const app = createApp(savedResult(), { job: { ...pendingJob, state: "succeeded" } });

    const envelope = JSON.parse(await run(app, ["--json"])) as { result: ReconfigureResult };

    expect(envelope.result).not.toHaveProperty("gateway");
    expect(process.exitCode).toBe(0);
  });
});
