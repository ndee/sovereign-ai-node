import type { Command } from "commander";
import { z } from "zod";

import type { AppContainer } from "../../app/create-app.js";
import { writeCliError, writeCliSuccess } from "../output.js";
import { promptChoice, promptText } from "../prompt.js";

const pendingMigrationSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  interactive: z.boolean(),
});

const migrationStatusSchema = z.object({
  requestFile: z.string().min(1),
  pending: z.array(pendingMigrationSchema),
});

const mailSentinelMigrationSchema = z.object({
  changed: z.boolean(),
  requestFile: z.string().min(1),
  instance: z.object({
    id: z.string().min(1),
    packageId: z.string().min(1),
    workspace: z.string().min(1),
    matrixLocalpart: z.string().min(1).optional(),
    matrixUserId: z.string().min(1).optional(),
    alertRoomId: z.string().min(1).optional(),
    alertRoomName: z.string().min(1).optional(),
    allowedUsers: z.array(z.string().min(1)),
    imapHost: z.string().min(1).optional(),
    imapUsername: z.string().min(1).optional(),
    mailbox: z.string().min(1).optional(),
    pollInterval: z.string().min(1).optional(),
  }),
});

type MigrateOptions = {
  json?: boolean;
  status?: boolean;
  nonInteractive?: boolean;
  matrixLocalpart?: string;
  alertRoomId?: string;
  alertRoomName?: string;
  createAlertRoomName?: string;
  allowedUser?: string[];
};

export const registerMigrateCommand = (program: Command, app: AppContainer): void => {
  program
    .command("migrate")
    .description("Run one-off config migrations before future updates")
    .option("--json", "Emit JSON output")
    .option("--status", "Only show pending migrations")
    .option("--non-interactive", "Do not prompt for missing migration input")
    .option("--matrix-localpart <localpart>", "Matrix localpart for the migrated mail-sentinel")
    .option(
      "--alert-room-id <roomId>",
      "Reuse an existing Matrix room ID for the migrated mail-sentinel",
    )
    .option("--alert-room-name <name>", "Human-readable name for --alert-room-id")
    .option("--create-alert-room-name <name>", "Create a fresh Matrix alert room with this name")
    .option(
      "--allowed-user <user>",
      "Allowed Matrix user/localpart for the migrated mail-sentinel (repeatable)",
      (value: string, prev: string[] = []) => [...prev, value],
    )
    .action(async (opts: MigrateOptions) => {
      const command = "migrate";
      try {
        const status = await app.installerService.getPendingMigrations();
        if (opts.status || status.pending.length === 0) {
          writeCliSuccess(command, status, migrationStatusSchema, Boolean(opts.json));
          return;
        }

        let matrixLocalpart = opts.matrixLocalpart;
        let alertRoomId = opts.alertRoomId;
        let alertRoomName = opts.alertRoomName;
        let createAlertRoomName = opts.createAlertRoomName;
        let allowedUsers = opts.allowedUser;

        if (!opts.json && !opts.nonInteractive) {
          const existing = await app.installerService.listMailSentinelInstances();
          const legacy = existing.instances[0];
          matrixLocalpart =
            matrixLocalpart ??
            (await promptText(
              "Matrix localpart for mail-sentinel",
              legacy?.matrixLocalpart ?? "mail-sentinel",
            ));
          if (alertRoomId === undefined && createAlertRoomName === undefined) {
            const roomMode = await promptChoice(
              "Alert room action (keep/create/id)",
              ["keep", "create", "id"],
              "keep",
            );
            if (roomMode === "create") {
              createAlertRoomName = await promptText(
                "New alert room name",
                legacy?.alertRoomName ?? "Mail Sentinel Alerts",
              );
            } else if (roomMode === "id") {
              alertRoomId = await promptText("Existing alert room id", legacy?.alertRoomId ?? "");
              alertRoomName = await promptText(
                "Existing alert room name",
                legacy?.alertRoomName ?? "Mail Sentinel Alerts",
              );
            } else {
              alertRoomId = legacy?.alertRoomId;
              alertRoomName = legacy?.alertRoomName;
            }
          }
          if (allowedUsers === undefined || allowedUsers.length === 0) {
            const defaultUsers = legacy?.allowedUsers.join(",") ?? "";
            const answer = await promptText("Allowed Matrix users (comma separated)", defaultUsers);
            allowedUsers = answer
              .split(",")
              .map((entry) => entry.trim())
              .filter((entry) => entry.length > 0);
          }
        }

        const result = await app.installerService.migrateLegacyMailSentinel({
          ...(opts.nonInteractive === undefined ? {} : { nonInteractive: opts.nonInteractive }),
          ...(matrixLocalpart === undefined ? {} : { matrixLocalpart }),
          ...(alertRoomId === undefined ? {} : { alertRoomId }),
          ...(alertRoomName === undefined ? {} : { alertRoomName }),
          ...(createAlertRoomName === undefined ? {} : { createAlertRoomName }),
          ...(allowedUsers === undefined ? {} : { allowedUsers }),
        });
        writeCliSuccess(command, result, mailSentinelMigrationSchema, Boolean(opts.json));
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });
};
