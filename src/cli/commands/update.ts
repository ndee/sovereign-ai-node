import { readFile } from "node:fs/promises";

import type { Command } from "commander";

import type { AppContainer } from "../../app/create-app.js";
import {
  type InstallRequest,
  installRequestSchema,
  startInstallResultSchema,
} from "../../contracts/index.js";
import { DEFAULT_INSTALL_REQUEST_FILE } from "../../installer/real-service-shared.js";
import { writeCliError, writeCliSuccess } from "../output.js";

type UpdateOptions = {
  json?: boolean;
  requestFile?: string;
};

export const registerUpdateCommand = (program: Command, app: AppContainer): void => {
  program
    .command("update")
    .description("Re-run the install flow using the existing saved request file")
    .option("--json", "Emit JSON output")
    .option(
      "--request-file <path>",
      `Path to an InstallRequest JSON file (default: ${DEFAULT_INSTALL_REQUEST_FILE})`,
    )
    .action(async (opts: UpdateOptions) => {
      const command = "update";
      try {
        const requestPath = opts.requestFile ?? DEFAULT_INSTALL_REQUEST_FILE;
        const raw = await readFile(requestPath, "utf8");
        const req: InstallRequest = installRequestSchema.parse(JSON.parse(raw) as unknown);
        const result = await app.installerService.startInstall(req);
        writeCliSuccess(command, result, startInstallResultSchema, Boolean(opts.json));
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });
};
