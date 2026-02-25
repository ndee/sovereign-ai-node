import { Command } from "commander";

import type { AppContainer } from "../../app/create-app.js";
import { reconfigureResultSchema } from "../../contracts/index.js";
import { writeCliError, writeCliSuccess } from "../output.js";

export const registerReconfigureCommand = (
  program: Command,
  app: AppContainer,
): void => {
  const reconfigure = program
    .command("reconfigure")
    .description("Reconfigure installer-managed settings (scaffold)");

  reconfigure
    .command("imap")
    .description("Reconfigure IMAP settings (scaffold)")
    .option("--json", "Emit JSON output")
    .action(async (opts: { json?: boolean }) => {
      const command = "reconfigure imap";
      try {
        const result = await app.installerService.reconfigureImap({
          imap: {
            host: "imap.example.org",
            port: 993,
            tls: true,
            username: "operator@example.org",
            secretRef: "file:/etc/sovereign-node/secrets/imap-password",
            mailbox: "INBOX",
          },
        });
        writeCliSuccess(command, result, reconfigureResultSchema, Boolean(opts.json));
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });

  reconfigure
    .command("matrix")
    .description("Reconfigure Matrix settings (scaffold)")
    .option("--json", "Emit JSON output")
    .action(async (opts: { json?: boolean }) => {
      const command = "reconfigure matrix";
      try {
        const result = await app.installerService.reconfigureMatrix({
          matrix: {
            publicBaseUrl: "https://matrix.example.org",
          },
          mailSentinel: {
            e2eeAlertRoom: false,
          },
        });
        writeCliSuccess(command, result, reconfigureResultSchema, Boolean(opts.json));
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });
};

