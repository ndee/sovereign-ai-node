import type { Command } from "commander";
import { z } from "zod";

import type { AppContainer } from "../../app/create-app.js";
import { installForStagedMigration } from "../../openclaw/staged-migration.js";
import { writeCliError, writeCliSuccess } from "../output.js";

const installRuntimeResultSchema = z
  .object({
    version: z.string(),
    binaryPath: z.string(),
    installMethod: z.enum(["locked_project", "install_sh", "npm_fallback"]),
    reinstalled: z.boolean(),
  })
  .strict();

/**
 * Internal: the upgrade step of scripts/openclaw-migrate.sh, which calls it
 * after it took the migration lock, stopped the gateway and backed up its
 * tree and state. Every other install path keeps an installed OpenClaw of
 * another version, so this is the only way a node moves to the locked one.
 */
export const registerOpenClawMigrationCommand = (program: Command, app: AppContainer): void => {
  const group = program
    .command("openclaw-migration")
    .description("Internal steps of the staged OpenClaw migration (scripts/openclaw-migrate.sh)");

  group
    .command("install-runtime")
    .description(
      "Install the locked OpenClaw runtime over another installed version (internal; run by scripts/openclaw-migrate.sh once the gateway is stopped and backed up)",
    )
    .requiredOption("--target <version>", "OpenClaw version the migration moves to")
    .option("--json", "Emit JSON output")
    .action(async (opts: { target: string; json?: boolean }) => {
      const command = "openclaw-migration install-runtime";
      try {
        const result = await installForStagedMigration({
          bootstrapper: app.openclawBootstrapper,
          execRunner: app.execRunner,
          logger: app.logger,
          target: opts.target,
        });
        writeCliSuccess(command, result, installRuntimeResultSchema, Boolean(opts.json));
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });
};
