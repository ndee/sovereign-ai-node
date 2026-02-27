import type { Command } from "commander";

import type { AppContainer } from "../../app/create-app.js";
import { doctorReportSchema } from "../../contracts/index.js";
import { writeCliError, writeCliSuccess } from "../output.js";

export const registerDoctorCommand = (program: Command, app: AppContainer): void => {
  program
    .command("doctor")
    .description("Run diagnostics")
    .option("--json", "Emit JSON output")
    .action(async (opts: { json?: boolean }) => {
      const command = "doctor";
      try {
        const result = await app.installerService.getDoctorReport();
        writeCliSuccess(command, result, doctorReportSchema, Boolean(opts.json));
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });
};
