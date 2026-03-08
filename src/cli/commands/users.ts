import type { Command } from "commander";
import { z } from "zod";

import type { AppContainer } from "../../app/create-app.js";
import { matrixOnboardingIssueResultSchema } from "../../contracts/index.js";
import { writeCliError, writeCliSuccess } from "../output.js";

const matrixUserRemoveResultSchema = z.object({
  localpart: z.string().min(1),
  userId: z.string().min(1),
  removed: z.boolean(),
});

type UserInviteOptions = {
  ttlMinutes?: string;
  json?: boolean;
};

export const registerUsersCommand = (
  program: Command,
  app: AppContainer,
): void => {
  const users = program
    .command("users")
    .description("Manage local human Matrix users for this node");

  users
    .command("invite")
    .description("Create or refresh a local Matrix user invite")
    .argument("<username>", "Localpart or same-server Matrix user ID")
    .option("--ttl-minutes <minutes>", "Override code lifetime in minutes", "1440")
    .option("--json", "Emit JSON output")
    .action(async (username: string, opts: UserInviteOptions) => {
      const command = "users invite";
      try {
        const ttlMinutes = Number.parseInt(opts.ttlMinutes ?? "1440", 10);
        if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
          throw new Error("Provide a positive integer for --ttl-minutes");
        }
        const result = await app.installerService.inviteMatrixUser({
          username,
          ttlMinutes,
        });
        if (opts.json) {
          writeCliSuccess(command, result, matrixOnboardingIssueResultSchema, true);
          return;
        }
        process.stdout.write(
          [
            "Matrix user invite issued.",
            `Username: ${result.username}`,
            `Code: ${result.code}`,
            `Expires: ${result.expiresAt}`,
            `Onboarding URL: ${result.onboardingUrl}`,
            `Shareable link: ${result.onboardingLink}`,
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
    .description("Deactivate a local human Matrix user")
    .argument("<username>", "Localpart or same-server Matrix user ID")
    .option("--json", "Emit JSON output")
    .action(async (username: string, opts: { json?: boolean }) => {
      const command = "users remove";
      try {
        const result = await app.installerService.removeMatrixUser({ username });
        writeCliSuccess(command, result, matrixUserRemoveResultSchema, Boolean(opts.json));
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });
};
