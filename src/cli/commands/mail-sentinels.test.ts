import { Command } from "commander";

import { describe, expect, it, vi } from "vitest";

import type { AppContainer } from "../../app/create-app.js";
import { registerMailSentinelsCommand } from "./mail-sentinels.js";

const createMockApp = () =>
  ({
    installerService: {
      listMailSentinelInstances: vi.fn(async () => ({
        instances: [
          {
            id: "mail-sentinel",
            packageId: "mail-sentinel",
            workspace: "/var/lib/sovereign-node/mail-sentinel/workspace",
            allowedUsers: ["@operator:matrix.example.org"],
          },
        ],
      })),
      createMailSentinelInstance: vi.fn(async (req) => ({
        instance: {
          id: req.id,
          packageId: "mail-sentinel",
          workspace: `/var/lib/sovereign-node/${req.id}/workspace`,
          allowedUsers: req.allowedUsers,
        },
        changed: true,
      })),
      updateMailSentinelInstance: vi.fn(async (req) => ({
        instance: {
          id: req.id,
          packageId: "mail-sentinel",
          workspace: `/var/lib/sovereign-node/${req.id}/workspace`,
          allowedUsers: req.allowedUsers ?? [],
        },
        changed: true,
      })),
      deleteMailSentinelInstance: vi.fn(async (req) => ({
        id: req.id,
        deleted: true,
      })),
    },
  }) as unknown as AppContainer;

describe("registerMailSentinelsCommand", () => {
  it("lists configured Mail Sentinel instances", async () => {
    const program = new Command();
    program.exitOverride();
    const app = createMockApp();
    registerMailSentinelsCommand(program, app);

    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await program.parseAsync(["node", "test", "mail-sentinels", "list", "--json"]);
      expect(app.installerService.listMailSentinelInstances).toHaveBeenCalled();
    } finally {
      stdoutWrite.mockRestore();
    }
  });

  it("creates a Mail Sentinel instance with the provided flags", async () => {
    const program = new Command();
    program.exitOverride();
    const app = createMockApp();
    registerMailSentinelsCommand(program, app);

    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await program.parseAsync([
        "node",
        "test",
        "mail-sentinels",
        "create",
        "mail-sentinel-ndee",
        "--imap-host",
        "imap.ndee.example.org",
        "--imap-port",
        "993",
        "--imap-tls",
        "true",
        "--imap-username",
        "ndee@example.org",
        "--imap-secret-ref",
        "file:/tmp/ndee-secret",
        "--allowed-user",
        "@ndee:matrix.example.org",
        "--json",
      ]);
      expect(app.installerService.createMailSentinelInstance).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "mail-sentinel-ndee",
          imapHost: "imap.ndee.example.org",
          imapPort: 993,
          imapTls: true,
          imapUsername: "ndee@example.org",
          imapSecretRef: "file:/tmp/ndee-secret",
          allowedUsers: ["@ndee:matrix.example.org"],
        }),
      );
    } finally {
      stdoutWrite.mockRestore();
    }
  });

  it("deletes a Mail Sentinel instance", async () => {
    const program = new Command();
    program.exitOverride();
    const app = createMockApp();
    registerMailSentinelsCommand(program, app);

    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await program.parseAsync(["node", "test", "mail-sentinels", "delete", "mail-sentinel"]);
      expect(app.installerService.deleteMailSentinelInstance).toHaveBeenCalledWith({
        id: "mail-sentinel",
      });
    } finally {
      stdoutWrite.mockRestore();
    }
  });

  it("shows a single Mail Sentinel instance by id", async () => {
    const program = new Command();
    program.exitOverride();
    const app = createMockApp();
    registerMailSentinelsCommand(program, app);

    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await program.parseAsync([
        "node",
        "test",
        "mail-sentinels",
        "show",
        "mail-sentinel",
        "--json",
      ]);
      expect(app.installerService.listMailSentinelInstances).toHaveBeenCalled();
    } finally {
      stdoutWrite.mockRestore();
    }
  });

  it("fails show when the instance id is unknown", async () => {
    const program = new Command();
    program.exitOverride();
    const app = createMockApp();
    registerMailSentinelsCommand(program, app);

    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const originalExitCode = process.exitCode;

    try {
      await program.parseAsync(["node", "test", "mail-sentinels", "show", "missing"]);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
      stderrWrite.mockRestore();
    }
  });

  it("rejects create when --imap-host is missing", async () => {
    const program = new Command();
    program.exitOverride();
    const app = createMockApp();
    registerMailSentinelsCommand(program, app);

    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const originalExitCode = process.exitCode;

    try {
      await program.parseAsync([
        "node",
        "test",
        "mail-sentinels",
        "create",
        "mail-sentinel-new",
        "--imap-port",
        "993",
        "--imap-username",
        "user@example.org",
        "--imap-secret-ref",
        "file:/tmp/secret",
      ]);
      expect(app.installerService.createMailSentinelInstance).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
      stderrWrite.mockRestore();
    }
  });

  it("rejects create when --imap-port is not a positive integer", async () => {
    const program = new Command();
    program.exitOverride();
    const app = createMockApp();
    registerMailSentinelsCommand(program, app);

    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const originalExitCode = process.exitCode;

    try {
      await program.parseAsync([
        "node",
        "test",
        "mail-sentinels",
        "create",
        "mail-sentinel-new",
        "--imap-host",
        "imap.example.org",
        "--imap-port",
        "not-a-number",
        "--imap-username",
        "user@example.org",
        "--imap-secret-ref",
        "file:/tmp/secret",
        "--allowed-user",
        "@user:matrix.example.org",
      ]);
      expect(app.installerService.createMailSentinelInstance).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
      stderrWrite.mockRestore();
    }
  });

  it("rejects --imap-tls values other than true/false", async () => {
    const program = new Command();
    program.exitOverride();
    const app = createMockApp();
    registerMailSentinelsCommand(program, app);

    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const originalExitCode = process.exitCode;

    try {
      await program.parseAsync([
        "node",
        "test",
        "mail-sentinels",
        "create",
        "mail-sentinel-new",
        "--imap-host",
        "imap.example.org",
        "--imap-port",
        "993",
        "--imap-tls",
        "maybe",
        "--imap-username",
        "user@example.org",
        "--imap-secret-ref",
        "file:/tmp/secret",
        "--allowed-user",
        "@user:matrix.example.org",
      ]);
      expect(app.installerService.createMailSentinelInstance).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
      stderrWrite.mockRestore();
    }
  });

  it("updates a Mail Sentinel instance with selected flags", async () => {
    const program = new Command();
    program.exitOverride();
    const app = createMockApp();
    registerMailSentinelsCommand(program, app);

    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await program.parseAsync([
        "node",
        "test",
        "mail-sentinels",
        "update",
        "mail-sentinel",
        "--poll-interval",
        "15m",
        "--lookback-window",
        "2h",
        "--default-reminder-delay",
        "3h",
        "--digest-interval",
        "8h",
        "--imap-tls",
        "false",
        "--create-alert-room-name",
        "Custom Alerts",
        "--matrix-localpart",
        "mail-sentinel-alt",
        "--mailbox",
        "Archive",
        "--allowed-user",
        "@ops:matrix.example.org",
        "--json",
      ]);
      expect(app.installerService.updateMailSentinelInstance).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "mail-sentinel",
          imapTls: false,
          pollInterval: "15m",
          lookbackWindow: "2h",
          defaultReminderDelay: "3h",
          digestInterval: "8h",
          createAlertRoomName: "Custom Alerts",
          matrixLocalpart: "mail-sentinel-alt",
          mailbox: "Archive",
          allowedUsers: ["@ops:matrix.example.org"],
        }),
      );
    } finally {
      stdoutWrite.mockRestore();
    }
  });

  describe("waiting for the applying install job", () => {
    const pendingJob = {
      jobId: "job_1",
      state: "pending",
      createdAt: "2026-10-12T10:00:00.000Z",
      steps: [],
    };
    const createWaitingApp = (gatewayReady: boolean) => {
      const app = createMockApp();
      const service = app.installerService as unknown as Record<string, unknown>;
      const instance = {
        id: "mail-sentinel-ops",
        packageId: "mail-sentinel",
        workspace: "/var/lib/sovereign-node/mail-sentinel-ops/workspace",
        allowedUsers: [],
      };
      service.createMailSentinelInstance = vi.fn(async () => ({
        instance,
        changed: true,
        job: pendingJob,
      }));
      service.updateMailSentinelInstance = vi.fn(async () => ({
        instance,
        changed: true,
        job: pendingJob,
      }));
      service.deleteMailSentinelInstance = vi.fn(async () => ({
        id: "mail-sentinel-ops",
        deleted: true,
        job: pendingJob,
      }));
      service.getInstallJob = vi.fn(async () => ({
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
        gateway: { ready: gatewayReady, waitedMs: 300_000, deadlineMs: 300_000 },
      }));
      return app;
    };

    const runCli = async (app: AppContainer, args: string[]): Promise<string> => {
      const program = new Command();
      program.exitOverride();
      registerMailSentinelsCommand(program, app);
      let out = "";
      const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        out += String(chunk);
        return true;
      });
      try {
        await program.parseAsync(["node", "test", "mail-sentinels", ...args]);
      } finally {
        write.mockRestore();
      }
      return out;
    };

    const createArgs = [
      "create",
      "mail-sentinel-ops",
      "--imap-host",
      "imap.example.org",
      "--imap-port",
      "993",
      "--imap-username",
      "ops@example.org",
      "--imap-secret-ref",
      "file:/tmp/ops-secret",
    ];

    it("exits 7 when create applied but the gateway is not listening", async () => {
      const originalExitCode = process.exitCode;
      const app = createWaitingApp(false);
      try {
        const out = await runCli(app, createArgs);
        expect(out).toContain(
          "Mail Sentinel mail-sentinel-ops applied, but the OpenClaw gateway is not ready yet",
        );
        expect(process.exitCode).toBe(7);
      } finally {
        process.exitCode = originalExitCode;
      }
    });

    it("carries gateway readiness in --json output for update", async () => {
      const originalExitCode = process.exitCode;
      const app = createWaitingApp(true);
      try {
        const envelope = JSON.parse(
          await runCli(app, ["update", "mail-sentinel-ops", "--poll-interval", "15m", "--json"]),
        ) as { result: { job: { state: string }; gateway: { ready: boolean } } };
        expect(envelope.result.job.state).toBe("succeeded");
        expect(envelope.result.gateway.ready).toBe(true);
        expect(process.exitCode).toBe(0);
      } finally {
        process.exitCode = originalExitCode;
      }
    });

    it("waits for a delete, unless --no-wait is given", async () => {
      const originalExitCode = process.exitCode;
      const app = createWaitingApp(true);
      try {
        expect(await runCli(app, ["delete", "mail-sentinel-ops"])).toContain(
          "Mail Sentinel mail-sentinel-ops removal applied.",
        );
        expect(app.installerService.getInstallJob).toHaveBeenCalledTimes(1);

        await runCli(app, ["delete", "mail-sentinel-ops", "--no-wait", "--json"]);
        expect(app.installerService.getInstallJob).toHaveBeenCalledTimes(1);
      } finally {
        process.exitCode = originalExitCode;
      }
    });
  });
});
