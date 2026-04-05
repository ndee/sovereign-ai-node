import { Command } from "commander";

import { describe, expect, it, vi } from "vitest";

import type { AppContainer } from "../../app/create-app.js";
import { registerMigrateCommand } from "./migrate.js";

const createMockApp = () =>
  ({
    installerService: {
      getPendingMigrations: vi.fn(async () => ({
        requestFile: "/etc/sovereign-node/install-request.json",
        pending: [
          {
            id: "mail-sentinel-instances",
            description: "migrate legacy mail-sentinel",
            interactive: true,
          },
        ],
      })),
      listMailSentinelInstances: vi.fn(async () => ({
        instances: [
          {
            id: "mail-sentinel",
            packageId: "mail-sentinel",
            workspace: "/var/lib/sovereign-node/mail-sentinel/workspace",
            matrixLocalpart: "mail-sentinel",
            alertRoomId: "!alerts:matrix.example.org",
            alertRoomName: "Sovereign Alerts",
            allowedUsers: ["@operator:matrix.example.org"],
          },
        ],
      })),
      migrateLegacyMailSentinel: vi.fn(async () => ({
        changed: true,
        requestFile: "/etc/sovereign-node/install-request.json",
        instance: {
          id: "mail-sentinel",
          packageId: "mail-sentinel",
          workspace: "/var/lib/sovereign-node/mail-sentinel/workspace",
          matrixLocalpart: "mail-sentinel",
          alertRoomId: "!alerts:matrix.example.org",
          alertRoomName: "Sovereign Alerts",
          allowedUsers: ["@operator:matrix.example.org"],
        },
      })),
    },
  }) as unknown as AppContainer;

describe("registerMigrateCommand", () => {
  it("returns pending migrations with --status", async () => {
    const program = new Command();
    program.exitOverride();
    const app = createMockApp();
    registerMigrateCommand(program, app);

    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await program.parseAsync(["node", "test", "migrate", "--status", "--json"]);
      expect(app.installerService.getPendingMigrations).toHaveBeenCalled();
      expect(app.installerService.migrateLegacyMailSentinel).not.toHaveBeenCalled();
    } finally {
      stdoutWrite.mockRestore();
    }
  });

  it("runs the legacy mail-sentinel migration when options are supplied", async () => {
    const program = new Command();
    program.exitOverride();
    const app = createMockApp();
    registerMigrateCommand(program, app);

    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await program.parseAsync([
        "node",
        "test",
        "migrate",
        "--json",
        "--non-interactive",
        "--matrix-localpart",
        "mail-sentinel",
        "--alert-room-id",
        "!alerts:matrix.example.org",
        "--allowed-user",
        "@operator:matrix.example.org",
      ]);
      expect(app.installerService.migrateLegacyMailSentinel).toHaveBeenCalledWith({
        nonInteractive: true,
        matrixLocalpart: "mail-sentinel",
        alertRoomId: "!alerts:matrix.example.org",
        allowedUsers: ["@operator:matrix.example.org"],
      });
    } finally {
      stdoutWrite.mockRestore();
    }
  });
});
