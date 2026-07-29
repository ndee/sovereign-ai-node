import type { Command } from "commander";

import type { AppContainer } from "../../app/create-app.js";
import { DEFAULT_PATHS } from "../../config/paths.js";
import { CONTRACT_VERSION } from "../../contracts/common.js";
import {
  buildDiagnosticsPresentation,
  type DiagnosticsPresentation,
  diagnosticsPresentationSchema,
} from "../../support/presentation.js";
import { writeCliError } from "../output.js";

/**
 * `sovereign-node diagnostics` — the product-safe health view.
 *
 * Unlike `status` and `doctor`, whose JSON carries paths, command lines and
 * check internals, this command emits only the fixed presentation model from
 * `src/support/presentation.ts`. It exists so that consumers that face a
 * design partner — the Node Operator Matrix bot and shell scripts on a
 * maintained node — have a single output they may relay verbatim.
 *
 * Renders its own human output for the same reason `support-bundle` does:
 * `writeCliSuccess` prints a scaffold string for non-JSON invocations.
 */

const STATUS_WORDS: Record<string, string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  failed: "Failed",
  unknown: "Unknown",
};

const OVERALL_WORDS: Record<DiagnosticsPresentation["overall"], string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  action_required: "Action required",
  unavailable: "Unavailable",
};

export const renderDiagnosticsText = (presentation: DiagnosticsPresentation): string => {
  const lines = [`Node status: ${OVERALL_WORDS[presentation.overall]}`, ""];
  for (const component of presentation.components) {
    lines.push(`${component.label}: ${STATUS_WORDS[component.status] ?? component.status}`);
  }
  if (presentation.components.length > 0) {
    lines.push("");
  }
  lines.push(presentation.headline);
  const codes = presentation.components
    .filter((component) => component.code !== undefined)
    .map((component) => component.code as string);
  if (codes.length > 0) {
    lines.push("", `Code: ${[...new Set(codes)].join(", ")}`);
  }
  return `${lines.join("\n")}\n`;
};

const tryReadMailState = async (statePath: string): Promise<unknown> => {
  try {
    const { readFile } = await import("node:fs/promises");
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    return undefined;
  }
};

export const registerDiagnosticsCommand = (program: Command, app: AppContainer): void => {
  program
    .command("diagnostics")
    .description("Show a product-safe component health summary")
    .option("--json", "Emit JSON output")
    .action(async (opts: { json?: boolean }) => {
      const command = "diagnostics";
      const json = Boolean(opts.json);
      try {
        // Best-effort inputs, same stance as support-bundle: a broken
        // component must yield a presentation that says so, not a crash.
        const [doctorReport, status] = await Promise.all([
          app.installerService.getDoctorReport().catch(() => undefined),
          app.installerService.getStatus().catch(() => undefined),
        ]);
        const mailSentinelState = await tryReadMailState(
          `${DEFAULT_PATHS.stateDir}/mail-sentinel-state.json`,
        );

        const presentation = buildDiagnosticsPresentation({
          now: new Date(),
          status,
          doctorReport,
          mailSentinelState,
        });

        if (json) {
          process.stdout.write(
            `${JSON.stringify(
              {
                contractVersion: CONTRACT_VERSION,
                ok: true,
                command,
                timestamp: presentation.checkedAt,
                result: diagnosticsPresentationSchema.parse(presentation),
              },
              null,
              2,
            )}\n`,
          );
          return;
        }

        process.stdout.write(renderDiagnosticsText(presentation));
      } catch (error) {
        writeCliError(command, error, json);
        process.exitCode = 1;
      }
    });
};
