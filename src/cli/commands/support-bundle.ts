import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Command } from "commander";
import { z } from "zod";

import type { AppContainer } from "../../app/create-app.js";
import { DEFAULT_PATHS } from "../../config/paths.js";
import { CONTRACT_VERSION } from "../../contracts/common.js";
import {
  cleanupOldBundles,
  ensureBundleDirectory,
  generateBundleId,
  generateSupportBundle,
  validateOutputPath,
} from "../../support/bundle.js";
import { listSanErrorIds, lookupSanError } from "../../support/codes.js";
import {
  buildInstallDiagnostics,
  type DiagnosticsSource,
  defaultNodeDiagnosticsSources,
  defaultNodeKnownSecretSources,
  diagnosticsFileName,
  type InstallDiagnosticsResult,
} from "../../support/install-diagnostics.js";
import { type KnownSecretSources, loadKnownSecrets } from "../../support/known-secrets.js";
import { buildVersionInventory, summarizeInventory } from "../../support/version-inventory.js";
import { writeCliError } from "../output.js";

/**
 * `sovereign-node support-bundle` and `sovereign-node explain <code>`.
 *
 * # Why these do not use `writeCliSuccess`'s human path
 *
 * `writeCliSuccess` prints the literal string "<command>: scaffold response
 * generated" for every non-JSON invocation (`src/cli/output.ts:17-20`). That is
 * acceptable for machine-oriented commands, but these two exist specifically to
 * be read by a person under stress during a support call. They render their own
 * human output and use the shared envelope only for `--json`.
 *
 * # Exit codes
 *
 * Deterministic and meaningful, unlike `doctor`, which exits 0 even when it
 * reports `overall: "fail"`:
 *   0 — bundle generated and complete
 *   1 — generation failed; no usable bundle exists
 *   2 — bundle generated but INCOMPLETE (some evidence could not be collected)
 *
 * A distinct code for "partial" lets the readiness check fail closed without
 * conflating "we could not gather everything" with "the command crashed".
 */

/** Exit code for a bundle that was produced but is missing sections. */
export const EXIT_PARTIAL = 2;

const bundleResultSchema = z.object({
  path: z.string(),
  sha256: z.string(),
  bytes: z.number(),
  complete: z.boolean(),
  removedOldBundles: z.array(z.string()),
});

const explainResultSchema = z.object({
  id: z.string(),
  known: z.boolean(),
  definition: z.unknown().optional(),
});

/**
 * Read Mail Sentinel state for the counter summary.
 *
 * Returns `undefined` on any failure: a missing or unreadable state file is a
 * normal condition (mail may not be configured) and must degrade the bundle to
 * "that section is unavailable", never fail the command.
 */
const tryReadMailState = async (statePath: string): Promise<unknown> => {
  try {
    const { readFile } = await import("node:fs/promises");
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    return undefined;
  }
};

export interface InstallDiagnosticsInputs {
  readonly sources?: readonly DiagnosticsSource[];
  readonly secretSources?: KnownSecretSources;
  readonly now?: Date;
}

export interface InstallDiagnosticsFile {
  readonly path: string;
  readonly result: InstallDiagnosticsResult;
}

/**
 * Build the install-failure diagnostics `.zip` and write it into `directory`.
 *
 * Unlike the support bundle, this targets a node whose install did NOT finish:
 * it carries install job records (with the failing step's error details), npm
 * debug logs and journal tails, keeps the tail of every log, and sheds low
 * priority files instead of aborting when it grows too large.
 */
export const writeInstallDiagnostics = async (
  directory: string,
  options: InstallDiagnosticsInputs = {},
): Promise<InstallDiagnosticsFile> => {
  const now = options.now ?? new Date();
  const knownSecrets = await loadKnownSecrets(
    options.secretSources ?? defaultNodeKnownSecretSources(),
  );
  const inventory = buildVersionInventory({ provenance: null, contractVersion: CONTRACT_VERSION });
  const result = await buildInstallDiagnostics({
    sources: options.sources ?? defaultNodeDiagnosticsSources(),
    knownSecrets,
    generatedBy: "sovereign-node support-bundle --install-diagnostics",
    product: { components: inventory.components, contractVersion: inventory.contractVersion },
    now: () => now,
  });
  const path = await validateOutputPath(
    join(directory, diagnosticsFileName(now, generateBundleId())),
  );
  // `wx`: never follow or replace something planted at the generated name.
  await writeFile(path, result.archive, { mode: 0o600, flag: "wx" });
  return { path, result };
};

export const registerSupportBundleCommand = (
  program: Command,
  app: AppContainer,
  // Test seam: production always uses the node's default sources.
  diagnosticsInputs: InstallDiagnosticsInputs = {},
): void => {
  program
    .command("support-bundle")
    .description("Generate a redacted local diagnostic bundle to share with support")
    .option("--json", "Emit JSON output")
    .option("--output-dir <dir>", "Directory to write the bundle into")
    .option(
      "--install-diagnostics",
      "Write an install-failure diagnostics .zip (job records, npm logs, journals) instead",
    )
    .action(async (opts: { json?: boolean; outputDir?: string; installDiagnostics?: boolean }) => {
      const command = "support-bundle";
      const json = Boolean(opts.json);
      try {
        const directory = await ensureBundleDirectory(
          opts.outputDir ?? `${DEFAULT_PATHS.stateDir}/support-bundles`,
        );

        if (opts.installDiagnostics === true) {
          const { path, result } = await writeInstallDiagnostics(directory, diagnosticsInputs);
          if (json) {
            process.stdout.write(
              `${JSON.stringify(
                {
                  contractVersion: CONTRACT_VERSION,
                  ok: true,
                  command,
                  timestamp: result.manifest.generatedAt,
                  result: {
                    path,
                    sha256: result.sha256,
                    bytes: result.bytes,
                    complete: result.complete,
                    files: result.manifest.files,
                  },
                },
                null,
                2,
              )}\n`,
            );
          } else {
            const missing = result.manifest.files.filter((file) => file.status !== "collected");
            process.stdout.write(
              `${[
                "Install diagnostics file created.",
                "",
                `  File:     ${path}`,
                `  Size:     ${Math.ceil(result.bytes / 1024)} KiB`,
                `  SHA-256:  ${result.sha256}`,
                "",
                "Passwords, keys and tokens are removed. Open it to review before sharing.",
                ...(missing.length === 0
                  ? []
                  : [
                      "",
                      "Not included:",
                      ...missing.map((file) => `  - ${file.file}: ${file.reason ?? file.status}`),
                    ]),
              ].join("\n")}\n`,
            );
          }
          if (!result.complete) {
            process.exitCode = EXIT_PARTIAL;
          }
          return;
        }

        // Best-effort inputs. Each is independently optional so that a broken
        // component produces a bundle documenting the breakage, rather than no
        // bundle at all — which is exactly when a bundle is most needed.
        const [doctorReport, status] = await Promise.all([
          app.installerService.getDoctorReport().catch(() => undefined),
          app.installerService.getStatus().catch(() => undefined),
        ]);

        const provenance =
          status !== undefined && typeof status === "object" && status !== null
            ? ((status as { version?: { provenance?: unknown } }).version?.provenance ?? null)
            : null;

        const inventory = buildVersionInventory({
          provenance: provenance as never,
          openclawVersion:
            status !== undefined && typeof status === "object" && status !== null
              ? (status as { openclaw?: { version?: string } }).openclaw?.version
              : undefined,
          contractVersion: CONTRACT_VERSION,
        });

        const mailState = await tryReadMailState(
          `${DEFAULT_PATHS.stateDir}/mail-sentinel-state.json`,
        );

        const now = new Date();
        const removedOldBundles = await cleanupOldBundles(directory, now);

        const result = await generateSupportBundle(directory, {
          inventory,
          doctorReport,
          status,
          mailState,
          now: () => now,
        });

        if (json) {
          process.stdout.write(
            `${JSON.stringify(
              {
                contractVersion: CONTRACT_VERSION,
                ok: true,
                command,
                timestamp: now.toISOString(),
                result: bundleResultSchema.parse({
                  path: result.path,
                  sha256: result.sha256,
                  bytes: result.bytes,
                  complete: result.complete,
                  removedOldBundles,
                }),
              },
              null,
              2,
            )}\n`,
          );
        } else {
          const lines = [
            "Support bundle created.",
            "",
            `  File:     ${result.path}`,
            `  Size:     ${Math.ceil(result.bytes / 1024)} KiB`,
            `  SHA-256:  ${result.sha256}`,
            `  Node:     ${summarizeInventory(inventory)}`,
            "",
          ];
          if (result.complete) {
            lines.push(
              "This bundle contains no passwords, API keys, access tokens, or email content.",
              "You can open it to review the contents before sharing it.",
            );
          } else {
            const missing = result.manifest.files.filter((file) => file.status !== "collected");
            lines.push(
              "WARNING: this bundle is INCOMPLETE. These sections could not be collected:",
              ...missing.map((file) => `  - ${file.file}: ${file.reason ?? file.status}`),
              "",
              "Share it anyway, and mention that it is partial.",
            );
          }
          process.stdout.write(`${lines.join("\n")}\n`);
        }

        if (!result.complete) {
          process.exitCode = EXIT_PARTIAL;
        }
      } catch (error) {
        writeCliError(command, error, json);
        process.exitCode = 1;
      }
    });

  program
    .command("explain")
    .argument("[code]", "Error code to explain, e.g. SAN-LLM-001")
    .description("Explain a SAN-* error code in plain language")
    .option("--json", "Emit JSON output")
    .action((code: string | undefined, opts: { json?: boolean }) => {
      const command = "explain";
      const json = Boolean(opts.json);

      if (code === undefined) {
        const ids = listSanErrorIds();
        if (json) {
          process.stdout.write(
            `${JSON.stringify({ ok: true, command, result: { ids } }, null, 2)}\n`,
          );
        } else {
          process.stdout.write(`Known error codes:\n${ids.map((id) => `  ${id}`).join("\n")}\n`);
        }
        return;
      }

      const definition = lookupSanError(code);
      if (json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              ok: true,
              command,
              result: explainResultSchema.parse({
                id: code.trim().toUpperCase(),
                known: definition !== undefined,
                ...(definition === undefined ? {} : { definition }),
              }),
            },
            null,
            2,
          )}\n`,
        );
        return;
      }

      if (definition === undefined) {
        // An unknown code is a normal outcome — an operator may mistype, or read
        // a code from a newer node. Say so plainly and point somewhere useful.
        process.stdout.write(
          `Unknown error code: ${code}\n\n` +
            `Known codes:\n${listSanErrorIds()
              .map((id) => `  ${id}`)
              .join("\n")}\n`,
        );
        process.exitCode = 1;
        return;
      }

      process.stdout.write(
        [
          `${definition.id} — ${definition.title}`,
          "",
          definition.explanation,
          "",
          `Likely cause:  ${definition.likelyCause}`,
          `What you can do: ${definition.userAction}`,
          `Severity:      ${definition.severity}`,
          `Retryable:     ${definition.retryable ? "yes" : "no"}`,
          `Playbook:      docs/supportability/playbooks/${definition.docAnchor}`,
          "",
        ].join("\n"),
      );
    });
};
