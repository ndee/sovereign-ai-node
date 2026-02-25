import type { Command } from "commander";

import type { AppContainer } from "../../app/create-app.js";
import { sovereignStatusSchema } from "../../contracts/index.js";
import { writeCliError, writeCliSuccess } from "../output.js";

export const registerStatusCommand = (program: Command, app: AppContainer): void => {
  program
    .command("status")
    .description("Show Sovereign Node status (scaffold)")
    .option("--json", "Emit JSON output")
    .action(async (opts: { json?: boolean }) => {
      const command = "status";
      try {
        const result = await app.installerService.getStatus();
        writeCliSuccess(command, result, sovereignStatusSchema, Boolean(opts.json));
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });
};

