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
});
