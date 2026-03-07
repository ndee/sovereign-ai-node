import { Command } from "commander";

import type { AppContainer } from "../../app/create-app.js";
import { reconfigureResultSchema } from "../../contracts/index.js";
import { writeCliError, writeCliSuccess } from "../output.js";

type ReconfigureOpenrouterOptions = {
  model?: string;
  apiKey?: string;
  secretRef?: string;
  json?: boolean;
};

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
          bots: {
            config: {
              "mail-sentinel": {
                e2eeAlertRoom: false,
              },
            },
          },
        });
        writeCliSuccess(command, result, reconfigureResultSchema, Boolean(opts.json));
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });

  reconfigure
    .command("openrouter")
    .description("Set the OpenRouter model and/or API key for the installed runtime")
    .option("--model <model>", "OpenRouter model id")
    .option("--api-key <key>", "OpenRouter API key (writes /etc/sovereign-node/secrets/openrouter-api-key)")
    .option("--secret-ref <ref>", "Existing secret ref to use instead of writing a new key")
    .option("--json", "Emit JSON output")
    .action(async (opts: ReconfigureOpenrouterOptions) => {
      const command = "reconfigure openrouter";
      try {
        if (opts.model === undefined && opts.apiKey === undefined && opts.secretRef === undefined) {
          throw new Error("Provide at least one of --model, --api-key, or --secret-ref");
        }
        if (opts.apiKey !== undefined && opts.secretRef !== undefined) {
          throw new Error("Use either --api-key or --secret-ref, not both");
        }
        const result = await app.installerService.reconfigureOpenrouter({
          openrouter: {
            ...(opts.model === undefined ? {} : { model: opts.model }),
            ...(opts.apiKey === undefined ? {} : { apiKey: opts.apiKey }),
            ...(opts.secretRef === undefined ? {} : { secretRef: opts.secretRef }),
          },
        });
        writeCliSuccess(command, result, reconfigureResultSchema, Boolean(opts.json));
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });
};
