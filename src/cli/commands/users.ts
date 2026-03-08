import type { Command } from "commander";
import { z } from "zod";

import type { AppContainer } from "../../app/create-app.js";
import { writeCliError, writeCliSuccess } from "../output.js";

const inviteHumanUserResultSchema = z.object({
  localpart: z.string().min(1),
  userId: z.string().min(1),
  code: z.string().min(1),
  expiresAt: z.string().min(1),
  onboardingUrl: z.string().min(1),
  invitedToAlertRoom: z.boolean(),
});

const deleteHumanUserResultSchema = z.object({
  localpart: z.string().min(1),
  userId: z.string().min(1),
  deleted: z.boolean(),
  deactivated: z.boolean(),
  onboardingCleared: z.boolean(),
});

type InviteUserOptions = {
  ttlMinutes?: string;
  json?: boolean;
};

type RemoveUserOptions = {
  json?: boolean;
};

export const registerUsersCommand = (program: Command, app: AppContainer): void => {
  const users = program
    .command("users")
    .description("Manage human Matrix users on this node");

  users
    .command("invite")
    .description("Create or reset a human Matrix user and issue a one-time onboarding code")
    .argument("<username>", "Matrix localpart or full user ID")
    .option("--ttl-minutes <minutes>", "Override code lifetime in minutes", "10")
    .option("--json", "Emit JSON output")
    .action(async (username: string, opts: InviteUserOptions) => {
      const command = "users invite";
      try {
        const ttlMinutes = Number.parseInt(opts.ttlMinutes ?? "10", 10);
        if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
          throw new Error("Provide a positive integer for --ttl-minutes");
        }
        const result = await app.installerService.inviteHumanMatrixUser({
          username,
          ttlMinutes,
        });
        if (opts.json) {
          writeCliSuccess(command, result, inviteHumanUserResultSchema, true);
          return;
        }
        process.stdout.write(
          [
            "Matrix user invited.",
            `User ID: ${result.userId}`,
            `Localpart: ${result.localpart}`,
            `Code: ${result.code}`,
            `Expires: ${result.expiresAt}`,
            `Onboarding URL: ${result.onboardingUrl}`,
            `Invited to alert room: ${result.invitedToAlertRoom ? "yes" : "no"}`,
            "",
          ].join("\n"),
        );
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });

  users
    .command("remove")
    .alias("delete")
    .description("Deactivate a human Matrix user")
    .argument("<username>", "Matrix localpart or full user ID")
    .option("--json", "Emit JSON output")
    .action(async (username: string, opts: RemoveUserOptions) => {
      const command = "users remove";
      try {
        const result = await app.installerService.deleteHumanMatrixUser({ username });
        if (opts.json) {
          writeCliSuccess(command, result, deleteHumanUserResultSchema, true);
          return;
        }
        process.stdout.write(
          [
            result.deleted ? "Matrix user removed." : "Matrix user was not found.",
            `User ID: ${result.userId}`,
            `Localpart: ${result.localpart}`,
            `Deactivated in Synapse: ${result.deactivated ? "yes" : "no"}`,
            `Onboarding state cleared: ${result.onboardingCleared ? "yes" : "no"}`,
            "",
          ].join("\n"),
        );
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });
};
