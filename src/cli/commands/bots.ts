import type { Command } from "commander";
import { z } from "zod";

import type { AppContainer } from "../../app/create-app.js";
import { DEFAULT_BOT_REPO_URL } from "../../bots/catalog.js";
import {
  applyBotCatalogSourceOptions,
  type BotCatalogSourceOptions,
} from "../bot-catalog-source.js";
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

  addBotCatalogSourceOptions(
    bots
      .command("list")
      .description("List bot packages from the configured bot repository")
      .option("--json", "Emit JSON output"),
  ).action(async (opts: BotCatalogSourceOptions & { json?: boolean }) => {
    const command = "bots list";
    try {
      applyBotCatalogSourceOptions(opts);
      const result = await app.installerService.listSovereignBots();
      writeCliSuccess(command, result, listBotsResultSchema, Boolean(opts.json));
    } catch (error) {
      writeCliError(command, error, Boolean(opts.json));
      process.exitCode = 1;
    }
  });

  addBotCatalogSourceOptions(
    bots
      .command("install")
      .alias("instantiate")
      .description("Install a managed bot from the configured bot repository")
      .argument("<id>", "Bot package ID")
      .option("--workspace <dir>", "Workspace directory override")
      .option("--json", "Emit JSON output"),
  ).action(
    async (id: string, opts: BotCatalogSourceOptions & { workspace?: string; json?: boolean }) => {
      const command = "bots install";
      try {
        applyBotCatalogSourceOptions(opts);
        const result = await app.installerService.instantiateSovereignBot({
          id,
          ...(opts.workspace === undefined ? {} : { workspace: opts.workspace }),
        });
        writeCliSuccess(command, result, instantiateBotResultSchema, Boolean(opts.json));
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    },
  );
};

const addBotCatalogSourceOptions = <T extends Command>(command: T): T =>
  command
    .option("--bots-source-dir <path>", "Use a local sovereign-ai-bots checkout")
    .option(
      "--bots-repo-url <url>",
      `Clone bot packages from a Git repository URL (default: ${DEFAULT_BOT_REPO_URL})`,
    )
    .option("--bots-repo-ref <ref>", "Git branch, tag, or commit for --bots-repo-url");
