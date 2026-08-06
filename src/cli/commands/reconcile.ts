import type { Command } from "commander";
import { z } from "zod";

import type { AppContainer } from "../../app/create-app.js";
import { writeCliError, writeCliSuccess } from "../output.js";

const templateTransitionSchema = z
  .object({
    botId: z.string(),
    templateRef: z.string(),
    kind: z.enum(["tool", "agent"]),
    previousManifestSha256: z.string(),
    newManifestSha256: z.string(),
    previousKeyId: z.string(),
    newKeyId: z.string(),
    classifications: z.array(z.string()),
    capabilitiesAdded: z.array(z.string()),
    capabilitiesRemoved: z.array(z.string()),
    commandsAdded: z.array(z.string()),
    commandsRemoved: z.array(z.string()),
    resourcesAdded: z.array(z.string()),
    resourcesRemoved: z.array(z.string()),
    resourcesChanged: z.array(z.string()),
    committed: z.boolean(),
  })
  .strict();

const reconcileResultSchema = z
  .object({
    reconciled: z.array(z.string()),
    templateTransitions: z.array(templateTransitionSchema),
    releaseAuthorization: z
      .object({
        releaseId: z.string(),
        artifactSha256: z.string(),
        runId: z.string(),
      })
      .strict()
      .nullable(),
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
 * `--release-authorization <path>` points at a ROOT-owned attestation written
 * by the verified updater after manifest-signature and artifact-digest
 * verification. It is the only way a changed tool-template pin may be
 * transitioned; without it (or with an attestation that does not bind the
 * exact installed catalog bytes) a changed template remains a hard
 * TEMPLATE_PIN_MISMATCH refusal. There is deliberately no flag that trusts
 * the local checkout, and none may be added.
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
    .option(
      "--release-authorization <path>",
      "Root-owned verified-release attestation authorizing template pin transitions",
    )
    .action(async (opts: { json?: boolean; releaseAuthorization?: string }) => {
      const command = "reconcile";
      try {
        const result = await app.installerService.reconcileAgentWorkspaces(
          opts.releaseAuthorization === undefined
            ? undefined
            : { releaseAuthorizationPath: opts.releaseAuthorization },
        );
        writeCliSuccess(command, result, reconcileResultSchema, Boolean(opts.json));
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });
};
