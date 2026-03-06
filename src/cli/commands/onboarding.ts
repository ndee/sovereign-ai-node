import type { Command } from "commander";

import type { AppContainer } from "../../app/create-app.js";
import { matrixOnboardingIssueResultSchema } from "../../contracts/index.js";
import { writeCliError, writeCliSuccess } from "../output.js";

type OnboardingIssueOptions = {
  ttlMinutes?: string;
  json?: boolean;
};

export const registerOnboardingCommand = (
  program: Command,
  app: AppContainer,
): void => {
  const onboarding = program
    .command("onboarding")
    .description("Manage Matrix onboarding access");

  onboarding
    .command("issue")
    .description("Issue a one-time Matrix onboarding code")
    .option("--ttl-minutes <minutes>", "Override code lifetime in minutes", "10")
    .option("--json", "Emit JSON output")
    .action(async (opts: OnboardingIssueOptions) => {
      const command = "onboarding issue";
      try {
        const ttlMinutes = Number.parseInt(opts.ttlMinutes ?? "10", 10);
        if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
          throw new Error("Provide a positive integer for --ttl-minutes");
        }
        const result = await app.installerService.issueMatrixOnboardingCode({ ttlMinutes });
        if (opts.json) {
          writeCliSuccess(command, result, matrixOnboardingIssueResultSchema, true);
          return;
        }
        process.stdout.write(
          [
            "Matrix onboarding code issued.",
            `Code: ${result.code}`,
            `Expires: ${result.expiresAt}`,
            `Onboarding URL: ${result.onboardingUrl}`,
            `Username: ${result.username}`,
            "Regenerate: sudo sovereign-node onboarding issue",
            "",
          ].join("\n"),
        );
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });
};
