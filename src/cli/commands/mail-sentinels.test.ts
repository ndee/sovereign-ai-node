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
});
