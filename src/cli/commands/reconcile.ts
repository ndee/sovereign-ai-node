import type { Command } from "commander";
import { z } from "zod";

import type { AppContainer } from "../../app/create-app.js";
import { writeCliError, writeCliSuccess } from "../output.js";

const reconcileResultSchema = z
  .object({
    reconciled: z.array(z.string()),
  })
  .strict();

/**
 * Re-apply managed agent workspace files from the installed bot catalog.
 *
 * A bot exists twice on a device: the catalog under `<botsDir>/bots/<id>/`, and
 * the agent workspace at `<workspace>/bin/<id>.js` that systemd executes. An
 * update replaces the catalog; this re-applies the workspace so the running code
 * matches what was installed.
 *
 * Exposed as a CLI command rather than an HTTP route on purpose: the updater
 * restarts the Pro API immediately after installing, so an in-flight HTTP call
 * would race that restart. It is also safe to run by hand on a device that has
 * drifted.
 */
export const registerReconcileCommand = (program: Command, app: AppContainer): void => {
  program
    .command("reconcile")
    .description("Re-apply bot workspace files from the installed catalog")
    .option("--json", "Emit JSON output")
    .action(async (opts: { json?: boolean }) => {
      const command = "reconcile";
      try {
        const result = await app.installerService.reconcileAgentWorkspaces();
        writeCliSuccess(command, result, reconcileResultSchema, Boolean(opts.json));
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });
};
