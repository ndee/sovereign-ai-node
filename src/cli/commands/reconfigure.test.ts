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

  it("waits for the install job and exits 7 when the gateway is not ready", async () => {
    const app = createApp(savedResult(), terminal(false));

    const out = await run(app, []);

    expect(app.installerService.getInstallJob).toHaveBeenCalledWith("job_1");
    expect(out).toContain("[warn] Wait for OpenClaw gateway");
    expect(out).toContain(
      "Mail settings applied, but the OpenClaw gateway is not ready yet (not listening after 300 s).",
    );
    expect(process.exitCode).toBe(7);
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
    expect(process.exitCode).toBe(7);
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

describe("reconfigure openrouter", () => {
  let priorExitCode: typeof process.exitCode;

  beforeEach(() => {
    priorExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = priorExitCode;
  });

  const openrouterResult: ReconfigureResult = {
    target: "openrouter",
    changed: ["openrouter.privacy"],
    restartRequiredServices: [],
    validation: [],
  };

  const runOpenrouter = async (args: string[]) => {
    const reconfigureOpenrouter = vi.fn(async () => openrouterResult);
    const app = { installerService: { reconfigureOpenrouter } } as unknown as AppContainer;
    const program = new Command();
    program.exitOverride();
    registerReconfigureCommand(program, app);
    let out = "";
    const capture = (chunk: unknown) => {
      out += String(chunk);
      return true;
    };
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(capture);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(capture);
    try {
      await program.parseAsync(["node", "test", "reconfigure", "openrouter", ...args, "--json"]);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
    return {
      reconfigureOpenrouter,
      envelope: JSON.parse(out) as { ok: boolean; error?: { message: string } },
    };
  };

  it("sets the provider allow-list without touching the model or key", async () => {
    const { reconfigureOpenrouter, envelope } = await runOpenrouter([
      "--provider-only",
      " together, deepinfra ,,",
    ]);

    expect(reconfigureOpenrouter).toHaveBeenCalledWith({
      openrouter: { privacy: { only: ["together", "deepinfra"] } },
    });
    expect(envelope.ok).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it("clears the allow-list with an empty value", async () => {
    const { reconfigureOpenrouter } = await runOpenrouter(["--provider-only", ""]);

    expect(reconfigureOpenrouter).toHaveBeenCalledWith({
      openrouter: { privacy: { only: [] } },
    });
  });

  it("passes model, key and secret ref through unchanged", async () => {
    const { reconfigureOpenrouter } = await runOpenrouter([
      "--model",
      "openai/gpt-5",
      "--api-key",
      "sk-or-new",
    ]);
    expect(reconfigureOpenrouter).toHaveBeenCalledWith({
      openrouter: { model: "openai/gpt-5", apiKey: "sk-or-new" },
    });

    const second = await runOpenrouter(["--secret-ref", "file:/tmp/key"]);
    expect(second.reconfigureOpenrouter).toHaveBeenCalledWith({
      openrouter: { secretRef: "file:/tmp/key" },
    });
  });

  it("requires at least one setting", async () => {
    const { reconfigureOpenrouter, envelope } = await runOpenrouter([]);

    expect(reconfigureOpenrouter).not.toHaveBeenCalled();
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.message).toBe(
      "Provide at least one of --model, --api-key, --secret-ref, or --provider-only",
    );
    expect(process.exitCode).toBe(1);
  });

  it("rejects --api-key together with --secret-ref", async () => {
    const { reconfigureOpenrouter, envelope } = await runOpenrouter([
      "--api-key",
      "sk-or-new",
      "--secret-ref",
      "file:/tmp/key",
    ]);

    expect(reconfigureOpenrouter).not.toHaveBeenCalled();
    expect(envelope.error?.message).toBe("Use either --api-key or --secret-ref, not both");
    expect(process.exitCode).toBe(1);
  });
});
