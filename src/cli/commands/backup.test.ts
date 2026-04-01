import { Command } from "commander";

import { describe, expect, it, vi } from "vitest";

import type { AppContainer } from "../../app/create-app.js";
import type {
  BackupCreateResult,
  BackupListResult,
  BackupRestoreResult,
} from "../../contracts/index.js";
import { registerBackupCommand } from "./backup.js";

const createMockApp = (overrides?: {
  create?: () => Promise<BackupCreateResult>;
  restore?: (archivePath: string) => Promise<BackupRestoreResult>;
  list?: () => Promise<BackupListResult>;
}): AppContainer => {
  const defaultManifest = {
    version: "1" as const,
    createdAt: "2026-03-30T00:00:00.000Z",
    sovereignNodeVersion: "2.0.0",
    contractVersion: "2.0.0" as const,
    items: [],
  };

  return {
    backupService: {
      create:
        overrides?.create ??
        (async () => ({
          archivePath: "/tmp/backup.tar.gz",
          sizeBytes: 1024,
          createdAt: "2026-03-30T00:00:00.000Z",
          manifest: defaultManifest,
        })),
      restore:
        overrides?.restore ??
        (async (archivePath: string) => ({
          archivePath,
          restoredAt: "2026-03-30T00:00:00.000Z",
          manifest: defaultManifest,
          warnings: [],
        })),
      list:
        overrides?.list ??
        (async () => ({
          backupsDir: "/var/lib/sovereign-node/backups",
          backups: [],
        })),
    },
  } as unknown as AppContainer;
};

describe("registerBackupCommand", () => {
  it("registers backup command with create, restore, and list subcommands", () => {
    const program = new Command();
    const app = createMockApp();
    registerBackupCommand(program, app);

    const backupCmd = program.commands.find((c) => c.name() === "backup");
    expect(backupCmd).toBeDefined();

    const subcommands = backupCmd?.commands.map((c) => c.name()) ?? [];
    expect(subcommands).toContain("create");
    expect(subcommands).toContain("restore");
    expect(subcommands).toContain("list");
  });

  it("backup create calls the service with output option", async () => {
    const createFn = vi.fn(async () => ({
      archivePath: "/custom/path.tar.gz",
      sizeBytes: 2048,
      createdAt: "2026-03-30T00:00:00.000Z",
      manifest: {
        version: "1" as const,
        createdAt: "2026-03-30T00:00:00.000Z",
        sovereignNodeVersion: "2.0.0",
        contractVersion: "2.0.0" as const,
        items: [],
      },
    }));

    const program = new Command();
    program.exitOverride();
    const app = createMockApp({ create: createFn });
    registerBackupCommand(program, app);

    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await program.parseAsync([
        "node",
        "test",
        "backup",
        "create",
        "--output",
        "/custom/path.tar.gz",
      ]);
      expect(createFn).toHaveBeenCalledWith({ outputPath: "/custom/path.tar.gz" });
    } finally {
      stdoutWrite.mockRestore();
    }
  });

  it("backup restore requires --yes flag", async () => {
    const restoreFn = vi.fn(async (archivePath: string) => ({
      archivePath,
      restoredAt: "2026-03-30T00:00:00.000Z",
      manifest: {
        version: "1" as const,
        createdAt: "2026-03-30T00:00:00.000Z",
        sovereignNodeVersion: "2.0.0",
        contractVersion: "2.0.0" as const,
        items: [],
      },
      warnings: [],
    }));

    const program = new Command();
    program.exitOverride();
    const app = createMockApp({ restore: restoreFn });
    registerBackupCommand(program, app);

    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const originalExitCode = process.exitCode;

    try {
      await program.parseAsync(["node", "test", "backup", "restore", "/tmp/backup.tar.gz"]);
      expect(restoreFn).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
      stderrWrite.mockRestore();
    }
  });

  it("backup restore proceeds with --yes flag", async () => {
    const restoreFn = vi.fn(async (archivePath: string) => ({
      archivePath,
      restoredAt: "2026-03-30T00:00:00.000Z",
      manifest: {
        version: "1" as const,
        createdAt: "2026-03-30T00:00:00.000Z",
        sovereignNodeVersion: "2.0.0",
        contractVersion: "2.0.0" as const,
        items: [],
      },
      warnings: [],
    }));

    const program = new Command();
    program.exitOverride();
    const app = createMockApp({ restore: restoreFn });
    registerBackupCommand(program, app);

    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await program.parseAsync([
        "node",
        "test",
        "backup",
        "restore",
        "/tmp/backup.tar.gz",
        "--yes",
      ]);
      expect(restoreFn).toHaveBeenCalledWith("/tmp/backup.tar.gz");
    } finally {
      stdoutWrite.mockRestore();
    }
  });

  it("backup list calls the service", async () => {
    const listFn = vi.fn(async () => ({
      backupsDir: "/var/lib/sovereign-node/backups",
      backups: [
        {
          filename: "sovereign-node-backup-20260330T000000.tar.gz",
          path: "/var/lib/sovereign-node/backups/sovereign-node-backup-20260330T000000.tar.gz",
          sizeBytes: 4096,
          createdAt: "2026-03-30T00:00:00.000Z",
        },
      ],
    }));

    const program = new Command();
    program.exitOverride();
    const app = createMockApp({ list: listFn });
    registerBackupCommand(program, app);

    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await program.parseAsync(["node", "test", "backup", "list"]);
      expect(listFn).toHaveBeenCalled();
    } finally {
      stdoutWrite.mockRestore();
    }
  });
});
