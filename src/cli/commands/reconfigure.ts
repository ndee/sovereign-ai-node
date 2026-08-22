import type { Command } from "commander";

import type { AppContainer } from "../../app/create-app.js";
import { reconfigureResultSchema } from "../../contracts/index.js";
import { writeCliError, writeCliSuccess } from "../output.js";

type ReconfigureImapOptions = {
  protocol?: string;
  host?: string;
  port?: string;
  tls?: boolean;
  username?: string;
  password?: string;
  secretRef?: string;
  mailbox?: string;
  json?: boolean;
};

const parseProtocol = (value: string): "imap" | "pop3" => {
  const normalized = value.trim().toLowerCase();
  if (normalized === "imap" || normalized === "pop3") {
    return normalized;
  }
  throw new Error("--protocol must be imap or pop3");
};

const parsePort = (value: string): number => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error("--port must be a number between 1 and 65535");
  }
  return parsed;
};

type ReconfigureOpenrouterOptions = {
  model?: string;
  apiKey?: string;
  secretRef?: string;
  json?: boolean;
};

export const registerReconfigureCommand = (program: Command, app: AppContainer): void => {
  const reconfigure = program
    .command("reconfigure")
    .description("Reconfigure installer-managed settings after install");

  reconfigure
    .command("imap")
    .description(
      "Replace the Mail Sentinel mail connection (IMAP or POP3). The new connection is tested before anything is changed.",
    )
    .option("--protocol <protocol>", "Mail protocol: imap (default) or pop3")
    .option("--host <host>", "Mail server host")
    .option("--port <port>", "Mail server port (IMAP 993, POP3 995)")
    .option("--tls", "Use TLS (default)")
    .option("--no-tls", "Disable TLS (loopback hosts only for POP3)")
    .option("--username <value>", "Email address / username (usually your full email address)")
    .option(
      "--password <password>",
      "Mail password or app password (stored as a managed secret; prefer --secret-ref on shared hosts)",
    )
    .option("--secret-ref <ref>", "Existing secret ref (file:/path or env:NAME) for the password")
    .option("--mailbox <mailbox>", "IMAP folder to watch (default INBOX; ignored for POP3)")
    .option("--json", "Emit JSON output")
    .action(async (opts: ReconfigureImapOptions) => {
      const command = "reconfigure imap";
      try {
        const current = await app.installerService.getSettings();
        const protocol = parseProtocol(opts.protocol ?? current.mail.protocol);
        if (opts.password !== undefined && opts.secretRef !== undefined) {
          throw new Error("Use either --password or --secret-ref, not both");
        }
        if (opts.password === undefined && opts.secretRef === undefined) {
          throw new Error("Provide --password or --secret-ref so the new connection can be tested");
        }
        const host = (opts.host ?? current.mail.host).trim();
        const username = (opts.username ?? current.mail.username).trim();
        if (host.length === 0 || username.length === 0) {
          throw new Error("Provide --host and --username (no previous mail connection to reuse)");
        }
        const port =
          opts.port === undefined
            ? opts.protocol !== undefined && protocol !== current.mail.protocol
              ? protocol === "pop3"
                ? 995
                : 993
              : current.mail.port
            : parsePort(opts.port);
        const result = await app.installerService.reconfigureImap({
          imap: {
            protocol,
            host,
            port,
            tls: opts.tls ?? current.mail.tls,
            username,
            ...(opts.password === undefined ? {} : { password: opts.password }),
            ...(opts.secretRef === undefined ? {} : { secretRef: opts.secretRef }),
            mailbox: opts.mailbox ?? current.mail.mailbox,
          },
        });
        writeCliSuccess(command, result, reconfigureResultSchema, Boolean(opts.json));
        if (result.validation.some((entry) => entry.status === "fail")) {
          process.exitCode = 1;
        }
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });

  reconfigure
    .command("matrix")
    .description("Reconfigure Matrix settings")
    .option("--federation", "Enable Matrix federation (allows users from other homeservers)")
    .option("--no-federation", "Disable Matrix federation")
    .option("--json", "Emit JSON output")
    .action(async (opts: { federation?: boolean; json?: boolean }) => {
      const command = "reconfigure matrix";
      try {
        if (opts.federation === undefined) {
          throw new Error("Provide --federation or --no-federation");
        }
        const result = await app.installerService.reconfigureMatrix({
          matrix: {
            federationEnabled: opts.federation,
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
    .option(
      "--api-key <key>",
      "OpenRouter API key (writes /etc/sovereign-node/secrets/openrouter-api-key)",
    )
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
