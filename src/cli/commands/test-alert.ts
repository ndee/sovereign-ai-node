import type { Command } from "commander";

import type { AppContainer } from "../../app/create-app.js";
import { testAlertResultSchema } from "../../contracts/index.js";
import { writeCliError, writeCliSuccess } from "../output.js";

type TestAlertOptions = {
  json?: boolean;
  roomId?: string;
  text?: string;
};

export const registerTestAlertCommand = (program: Command, app: AppContainer): void => {
  program
    .command("test-alert")
    .description("Send a synthetic alert to the configured Matrix room (scaffold)")
    .option("--json", "Emit JSON output")
    .option("--room-id <roomId>", "Override target room id")
    .option("--text <text>", "Override test alert text")
    .action(async (opts: TestAlertOptions) => {
      const command = "test-alert";
      try {
        const result = await app.installerService.testAlert({
          channel: "matrix",
          roomId: opts.roomId,
          text: opts.text,
        });
        writeCliSuccess(command, result, testAlertResultSchema, Boolean(opts.json));
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });
};

