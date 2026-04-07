import type { Command } from "commander";
import { z } from "zod";

import type { AppContainer } from "../../app/create-app.js";
import { writeCliError, writeCliSuccess } from "../output.js";

const mailSentinelSchema = z.object({
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
});

const listMailSentinelsSchema = z.object({
  instances: z.array(mailSentinelSchema),
});

const applyMailSentinelSchema = z.object({
  instance: mailSentinelSchema,
  changed: z.boolean(),
  job: z
    .object({
      jobId: z.string().min(1),
      state: z.enum(["pending", "running", "succeeded", "failed", "canceled"]),
      createdAt: z.string().min(1),
      startedAt: z.string().min(1).optional(),
      endedAt: z.string().min(1).optional(),
      steps: z.array(
        z.object({
          id: z.string().min(1),
          label: z.string().min(1),
          state: z.string().min(1),
        }),
      ),
      currentStepId: z.string().min(1).optional(),
    })
    .optional(),
});

const deleteMailSentinelSchema = z.object({
  id: z.string().min(1),
  deleted: z.boolean(),
  job: applyMailSentinelSchema.shape.job,
});

type CreateOrUpdateOptions = {
  json?: boolean;
  imapHost?: string;
  imapPort?: string;
  imapTls?: string;
  imapUsername?: string;
  imapPassword?: string;
  imapSecretRef?: string;
  mailbox?: string;
  matrixLocalpart?: string;
  alertRoomId?: string;
  alertRoomName?: string;
  createAlertRoomName?: string;
  allowedUser?: string[];
  pollInterval?: string;
  lookbackWindow?: string;
  defaultReminderDelay?: string;
  digestInterval?: string;
};

export const registerMailSentinelsCommand = (program: Command, app: AppContainer): void => {
  const mailSentinels = program
    .command("mail-sentinels")
    .description("Manage Mail Sentinel bot instances");

  mailSentinels
    .command("list")
    .description("List configured Mail Sentinel instances")
    .option("--json", "Emit JSON output")
    .action(async (opts: { json?: boolean }) => {
      const command = "mail-sentinels list";
      try {
        const result = await app.installerService.listMailSentinelInstances();
        writeCliSuccess(command, result, listMailSentinelsSchema, Boolean(opts.json));
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });

  mailSentinels
    .command("show")
    .description("Show one Mail Sentinel instance")
    .argument("<id>", "Mail Sentinel instance ID")
    .option("--json", "Emit JSON output")
    .action(async (id: string, opts: { json?: boolean }) => {
      const command = "mail-sentinels show";
      try {
        const result = await app.installerService.listMailSentinelInstances();
        const instance = result.instances.find((entry) => entry.id === id);
        if (instance === undefined) {
          throw {
            code: "MAIL_SENTINEL_NOT_FOUND",
            message: `Mail Sentinel instance '${id}' was not found`,
            retryable: false,
          };
        }
        writeCliSuccess(
          command,
          { instances: [instance] },
          listMailSentinelsSchema,
          Boolean(opts.json),
        );
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });

  mailSentinels
    .command("create")
    .description("Create a Mail Sentinel instance and apply it via the installer")
    .argument("<id>", "Mail Sentinel instance ID")
    .option("--imap-host <host>", "IMAP host")
    .option("--imap-port <port>", "IMAP port")
    .option("--imap-tls <enabled>", "IMAP TLS true|false (default true)")
    .option("--imap-username <user>", "IMAP username")
    .option("--imap-password <password>", "IMAP password (stored as a managed secret)")
    .option("--imap-secret-ref <ref>", "Secret reference for the IMAP password")
    .option("--mailbox <mailbox>", "IMAP mailbox (default INBOX)")
    .option("--matrix-localpart <localpart>", "Dedicated Matrix localpart for this Mail Sentinel")
    .option("--alert-room-id <roomId>", "Use an existing Matrix alert room")
    .option("--alert-room-name <name>", "Human-readable name for --alert-room-id")
    .option("--create-alert-room-name <name>", "Create a fresh Matrix alert room")
    .option(
      "--allowed-user <user>",
      "Allowed Matrix user/localpart for this Mail Sentinel (repeatable)",
      (value: string, prev: string[] = []) => [...prev, value],
    )
    .option("--poll-interval <duration>", "Polling interval, e.g. 30m")
    .option("--lookback-window <duration>", "Lookback window, e.g. 1h")
    .option("--default-reminder-delay <duration>", "Reminder delay, e.g. 4h")
    .option("--digest-interval <duration>", "Digest interval, e.g. 12h")
    .option("--json", "Emit JSON output")
    .action(async (id: string, opts: CreateOrUpdateOptions) => {
      const command = "mail-sentinels create";
      try {
        const result = await app.installerService.createMailSentinelInstance({
          id,
          imapHost: requireOption(command, "--imap-host", opts.imapHost),
          imapPort: parsePort(command, opts.imapPort),
          imapTls: parseBooleanOption(command, "--imap-tls", opts.imapTls, true),
          imapUsername: requireOption(command, "--imap-username", opts.imapUsername),
          ...(opts.imapPassword === undefined ? {} : { imapPassword: opts.imapPassword }),
          ...(opts.imapSecretRef === undefined ? {} : { imapSecretRef: opts.imapSecretRef }),
          ...(opts.mailbox === undefined ? {} : { mailbox: opts.mailbox }),
          ...(opts.matrixLocalpart === undefined ? {} : { matrixLocalpart: opts.matrixLocalpart }),
          ...(opts.alertRoomId === undefined ? {} : { alertRoomId: opts.alertRoomId }),
          ...(opts.alertRoomName === undefined ? {} : { alertRoomName: opts.alertRoomName }),
          ...(opts.createAlertRoomName === undefined
            ? {}
            : { createAlertRoomName: opts.createAlertRoomName }),
          allowedUsers: opts.allowedUser ?? [],
          ...(opts.pollInterval === undefined ? {} : { pollInterval: opts.pollInterval }),
          ...(opts.lookbackWindow === undefined ? {} : { lookbackWindow: opts.lookbackWindow }),
          ...(opts.defaultReminderDelay === undefined
            ? {}
            : { defaultReminderDelay: opts.defaultReminderDelay }),
          ...(opts.digestInterval === undefined ? {} : { digestInterval: opts.digestInterval }),
        });
        writeCliSuccess(command, result, applyMailSentinelSchema, Boolean(opts.json));
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });

  mailSentinels
    .command("update")
    .description("Update a Mail Sentinel instance and apply it via the installer")
    .argument("<id>", "Mail Sentinel instance ID")
    .option("--imap-host <host>", "IMAP host")
    .option("--imap-port <port>", "IMAP port")
    .option("--imap-tls <enabled>", "IMAP TLS true|false")
    .option("--imap-username <user>", "IMAP username")
    .option("--imap-password <password>", "IMAP password (stored as a managed secret)")
    .option("--imap-secret-ref <ref>", "Secret reference for the IMAP password")
    .option("--mailbox <mailbox>", "IMAP mailbox")
    .option("--matrix-localpart <localpart>", "Dedicated Matrix localpart for this Mail Sentinel")
    .option("--alert-room-id <roomId>", "Use an existing Matrix alert room")
    .option("--alert-room-name <name>", "Human-readable name for --alert-room-id")
    .option("--create-alert-room-name <name>", "Create a fresh Matrix alert room")
    .option(
      "--allowed-user <user>",
      "Replace allowed Matrix users for this Mail Sentinel (repeatable)",
      (value: string, prev: string[] = []) => [...prev, value],
    )
    .option("--poll-interval <duration>", "Polling interval, e.g. 30m")
    .option("--lookback-window <duration>", "Lookback window, e.g. 1h")
    .option("--default-reminder-delay <duration>", "Reminder delay, e.g. 4h")
    .option("--digest-interval <duration>", "Digest interval, e.g. 12h")
    .option("--json", "Emit JSON output")
    .action(async (id: string, opts: CreateOrUpdateOptions) => {
      const command = "mail-sentinels update";
      try {
        const result = await app.installerService.updateMailSentinelInstance({
          id,
          ...(opts.imapHost === undefined ? {} : { imapHost: opts.imapHost }),
          ...(opts.imapPort === undefined ? {} : { imapPort: parsePort(command, opts.imapPort) }),
          ...(opts.imapTls === undefined
            ? {}
            : { imapTls: parseBooleanOption(command, "--imap-tls", opts.imapTls) }),
          ...(opts.imapUsername === undefined ? {} : { imapUsername: opts.imapUsername }),
          ...(opts.imapPassword === undefined ? {} : { imapPassword: opts.imapPassword }),
          ...(opts.imapSecretRef === undefined ? {} : { imapSecretRef: opts.imapSecretRef }),
          ...(opts.mailbox === undefined ? {} : { mailbox: opts.mailbox }),
          ...(opts.matrixLocalpart === undefined ? {} : { matrixLocalpart: opts.matrixLocalpart }),
          ...(opts.alertRoomId === undefined ? {} : { alertRoomId: opts.alertRoomId }),
          ...(opts.alertRoomName === undefined ? {} : { alertRoomName: opts.alertRoomName }),
          ...(opts.createAlertRoomName === undefined
            ? {}
            : { createAlertRoomName: opts.createAlertRoomName }),
          ...(opts.allowedUser === undefined ? {} : { allowedUsers: opts.allowedUser }),
          ...(opts.pollInterval === undefined ? {} : { pollInterval: opts.pollInterval }),
          ...(opts.lookbackWindow === undefined ? {} : { lookbackWindow: opts.lookbackWindow }),
          ...(opts.defaultReminderDelay === undefined
            ? {}
            : { defaultReminderDelay: opts.defaultReminderDelay }),
          ...(opts.digestInterval === undefined ? {} : { digestInterval: opts.digestInterval }),
        });
        writeCliSuccess(command, result, applyMailSentinelSchema, Boolean(opts.json));
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });

  mailSentinels
    .command("delete")
    .description("Delete a Mail Sentinel instance and apply the removal via the installer")
    .argument("<id>", "Mail Sentinel instance ID")
    .option("--json", "Emit JSON output")
    .action(async (id: string, opts: { json?: boolean }) => {
      const command = "mail-sentinels delete";
      try {
        const result = await app.installerService.deleteMailSentinelInstance({ id });
        writeCliSuccess(command, result, deleteMailSentinelSchema, Boolean(opts.json));
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });
};

const parsePort = (command: string, value: string | undefined): number => {
  const candidate = requireOption(command, "--imap-port", value);
  const parsed = Number.parseInt(candidate, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw {
      code: "CLI_OPTION_INVALID",
      message: `${command} failed: --imap-port must be a positive integer`,
      retryable: false,
    };
  }
  return parsed;
};

const parseBooleanOption = (
  command: string,
  flag: string,
  value: string | undefined,
  fallback?: boolean,
): boolean => {
  if (value === undefined) {
    if (fallback !== undefined) {
      return fallback;
    }
    throw {
      code: "CLI_OPTION_REQUIRED",
      message: `${command} failed: ${flag} is required`,
      retryable: false,
    };
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  throw {
    code: "CLI_OPTION_INVALID",
    message: `${command} failed: ${flag} must be true or false`,
    retryable: false,
  };
};

const requireOption = (command: string, flag: string, value: string | undefined): string => {
  const candidate = value?.trim();
  if (candidate !== undefined && candidate.length > 0) {
    return candidate;
  }
  throw {
    code: "CLI_OPTION_REQUIRED",
    message: `${command} failed: ${flag} is required`,
    retryable: false,
  };
};
