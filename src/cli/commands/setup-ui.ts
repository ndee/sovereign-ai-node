import type { Command } from "commander";

import type { AppContainer } from "../../app/create-app.js";
import { setupUiBootstrapIssueResultSchema } from "../../contracts/index.js";
import { writeCliError, writeCliSuccess } from "../output.js";

const DEFAULT_TTL_MINUTES = 24 * 60;

type SetupUiIssueOptions = {
  ttlMinutes: string;
  json?: boolean;
};

export const registerSetupUiCommand = (program: Command, app: AppContainer): void => {
  const setupUi = program.command("setup-ui").description("Manage the Sovereign Node setup web UI");

  setupUi
    .command("issue-bootstrap-token")
    .description("Issue a one-time bootstrap token for the setup UI")
    .option("--ttl-minutes <minutes>", "Token lifetime in minutes", String(DEFAULT_TTL_MINUTES))
    .option("--json", "Emit JSON output")
    .action(async (opts: SetupUiIssueOptions) => {
      const command = "setup-ui issue-bootstrap-token";
      try {
        const ttlMinutes = Number.parseInt(opts.ttlMinutes, 10);
        if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
          throw new Error("Provide a positive integer for --ttl-minutes");
        }
        const result = await app.installerService.issueSetupUiBootstrapToken({ ttlMinutes });
        if (opts.json) {
          writeCliSuccess(command, result, setupUiBootstrapIssueResultSchema, true);
          return;
        }
        process.stdout.write(
          [
            "Setup UI bootstrap token issued.",
            `Token: ${result.token}`,
            `Expires: ${result.expiresAt}`,
            `Lifetime: ${result.ttlMinutes} minutes`,
            "Sign in once with this token, then use your Matrix password going forward.",
            "Regenerate: sudo sovereign-node setup-ui issue-bootstrap-token",
            "",
          ].join("\n"),
        );
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });
};
