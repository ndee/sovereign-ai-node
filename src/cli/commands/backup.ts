import type { Command } from "commander";

import type { AppContainer } from "../../app/create-app.js";
import {
  backupCreateResultSchema,
  backupListResultSchema,
  backupRestoreResultSchema,
} from "../../contracts/index.js";
import { writeCliError, writeCliSuccess } from "../output.js";

export const registerBackupCommand = (program: Command, app: AppContainer): void => {
  const backup = program.command("backup").description("Back up and restore Sovereign Node state");

  backup
    .command("create")
    .description("Create a backup archive of all node state")
    .option("--output <path>", "Path for the output archive (default: backups directory)")
    .option("--json", "Emit JSON output")
    .action(async (opts: { output?: string; json?: boolean }) => {
      const command = "backup create";
      try {
        const result = await app.backupService.create({
          ...(opts.output !== undefined ? { outputPath: opts.output } : {}),
        });
        if (!opts.json) {
          process.stdout.write(
            `Backup created: ${result.archivePath} (${result.sizeBytes} bytes)\n`,
          );
          return;
        }
        writeCliSuccess(command, result, backupCreateResultSchema, true);
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });

  backup
    .command("restore")
    .description("Restore node state from a backup archive")
    .argument("<archive>", "Path to the backup archive (.tar.gz)")
    .option("--yes", "Confirm destructive restore operation")
    .option("--json", "Emit JSON output")
    .action(async (archive: string, opts: { yes?: boolean; json?: boolean }) => {
      const command = "backup restore";
      try {
        if (!opts.yes) {
          const error = {
            code: "BACKUP_RESTORE_REQUIRES_CONFIRMATION",
            message:
              "Restore is a destructive operation that replaces all node state. " +
              "Pass --yes to confirm.",
            retryable: false,
          };
          writeCliError(command, error, Boolean(opts.json));
          process.exitCode = 1;
          return;
        }
        const result = await app.backupService.restore(archive);
        if (!opts.json) {
          process.stdout.write(`Restore completed from: ${result.archivePath}\n`);
          for (const warning of result.warnings) {
            process.stderr.write(`Warning: ${warning}\n`);
          }
          return;
        }
        writeCliSuccess(command, result, backupRestoreResultSchema, true);
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });

  backup
    .command("list")
    .description("List available backups")
    .option("--json", "Emit JSON output")
    .action(async (opts: { json?: boolean }) => {
      const command = "backup list";
      try {
        const result = await app.backupService.list();
        if (!opts.json) {
          if (result.backups.length === 0) {
            process.stdout.write(`No backups found in ${result.backupsDir}\n`);
            return;
          }
          for (const entry of result.backups) {
            process.stdout.write(
              `${entry.filename}  ${entry.sizeBytes} bytes  ${entry.createdAt}\n`,
            );
          }
          return;
        }
        writeCliSuccess(command, result, backupListResultSchema, true);
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });
};
