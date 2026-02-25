import type { Command } from "commander";

import { CONTRACT_VERSION } from "../../contracts/common.js";
import { writeCliError, writeCliLogEvent } from "../output.js";

export const registerLogsCommand = (program: Command): void => {
  program
    .command("logs")
    .description("Show logs (scaffold)")
    .option("--json", "Emit NDJSON log events")
    .action(async (opts: { json?: boolean }) => {
      const command = "logs";
      try {
        if (opts.json) {
          writeCliLogEvent({
            contractVersion: CONTRACT_VERSION,
            type: "status",
            source: "sovereign-node",
            timestamp: new Date().toISOString(),
            message: "Scaffold log stream start",
          });
          writeCliLogEvent({
            contractVersion: CONTRACT_VERSION,
            type: "log",
            source: "installer",
            timestamp: new Date().toISOString(),
            level: "info",
            message: "No persisted logs yet; scaffold only",
          });
          writeCliLogEvent({
            contractVersion: CONTRACT_VERSION,
            type: "end",
            source: "sovereign-node",
            timestamp: new Date().toISOString(),
            message: "Scaffold log stream end",
          });
          return;
        }

        process.stdout.write("logs: scaffold only (no log backend implemented yet)\n");
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });
};

