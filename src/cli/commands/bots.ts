import type { Command } from "commander";
import { z } from "zod";

import type { AppContainer } from "../../app/create-app.js";
import { writeCliError, writeCliSuccess } from "../output.js";

const botSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().min(1),
  defaultInstall: z.boolean(),
  templateRef: z.string().min(1),
  installed: z.boolean(),
  instantiated: z.boolean(),
  agentId: z.string().min(1).optional(),
  cronJobIds: z.array(z.string().min(1)).optional(),
});

const listBotsResultSchema = z.object({
  bots: z.array(botSchema),
});

const instantiateBotResultSchema = z.object({
  bot: botSchema,
  agent: z.object({
    id: z.string().min(1),
    workspace: z.string().min(1),
    matrixUserId: z.string().min(1).optional(),
    templateRef: z.string().min(1).optional(),
    toolInstanceIds: z.array(z.string().min(1)).optional(),
  }),
  changed: z.boolean(),
  restartRequiredServices: z.array(z.string().min(1)),
});

export const registerBotsCommand = (program: Command, app: AppContainer): void => {
  const bots = program
    .command("bots")
    .description("List and instantiate installable Sovereign bot packages");

  bots
    .command("list")
    .description("List bot packages from the configured bot repository")
    .option("--json", "Emit JSON output")
    .action(async (opts: { json?: boolean }) => {
      const command = "bots list";
      try {
        const result = await app.installerService.listSovereignBots();
        writeCliSuccess(command, result, listBotsResultSchema, Boolean(opts.json));
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });

  bots
    .command("instantiate")
    .description("Instantiate a managed bot from the configured bot repository")
    .argument("<id>", "Bot package ID")
    .option("--workspace <dir>", "Workspace directory override")
    .option("--json", "Emit JSON output")
    .action(async (id: string, opts: { workspace?: string; json?: boolean }) => {
      const command = "bots instantiate";
      try {
        const result = await app.installerService.instantiateSovereignBot({
          id,
          ...(opts.workspace === undefined ? {} : { workspace: opts.workspace }),
        });
        writeCliSuccess(command, result, instantiateBotResultSchema, Boolean(opts.json));
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });
};
