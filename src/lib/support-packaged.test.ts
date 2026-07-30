import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Verify the PUBLISHED artifact, not the source tree: `sovereign-ai-node-pro`
 * imports `sovereign-ai-node/support` from the built package (`dist/lib/…`),
 * and a source-tree import proves nothing about what tsup actually bundled or
 * what package.json actually exports.
 *
 * The dist bundle is produced by `npm run build` (CI's build job, and the git
 * dependency's `prepare` script). When it is absent — a source-only test run —
 * this suite fails loudly rather than skipping silently, because a silent
 * skip is exactly how a broken export would reach a release.
 * Set SOVEREIGN_SKIP_PACKAGED_EXPORT_TEST=1 for deliberate source-only runs.
 */

const REQUIRED_EXPORTS = [
  // Support-bundle library
  "generateSupportBundle",
  "ensureBundleDirectory",
  "cleanupOldBundles",
  // SAN registry
  "lookupSanError",
  "listSanErrorIds",
  "SAN_ERRORS",
  // Presentation model
  "buildDiagnosticsPresentation",
  "diagnosticsPresentationSchema",
  "DIAGNOSTICS_COMPONENT_IDS",
  // Redaction + inventory + build identity
  "redactText",
  "redactValue",
  "buildVersionInventory",
  "getNodeBuildInfo",
] as const;

const distEntry = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "dist",
  "lib",
  "support.js",
);

const skipRequested = process.env.SOVEREIGN_SKIP_PACKAGED_EXPORT_TEST === "1";

describe.skipIf(skipRequested)("packaged sovereign-ai-node/support export", () => {
  it("exposes every required symbol from the built dist bundle", async () => {
    await access(distEntry).catch(() => {
      throw new Error(
        `built support bundle missing at ${distEntry} — run \`npm run build\` first; ` +
          "the packaged-export check verifies the artifact consumers actually import",
      );
    });
    const packaged: Record<string, unknown> = await import(pathToFileURL(distEntry).href);
    for (const name of REQUIRED_EXPORTS) {
      expect(packaged[name], `missing packaged export: ${name}`).toBeDefined();
    }
    // The packaged presentation model must carry the new contract marker.
    const build = (
      packaged.buildDiagnosticsPresentation as (inputs: { now: Date }) => {
        contractVersion: string;
        overall: string;
      }
    )({ now: new Date("2026-07-30T00:00:00.000Z") });
    expect(build.contractVersion.length).toBeGreaterThan(0);
    expect(build.overall).toBe("unavailable");
  });

  it("is what package.json actually exports as ./support", async () => {
    const { readFile } = await import("node:fs/promises");
    const packageJson = JSON.parse(
      await readFile(join(dirname(distEntry), "..", "..", "package.json"), "utf8"),
    ) as { exports?: Record<string, { import?: string }> };
    expect(packageJson.exports?.["./support"]?.import).toBe("./dist/lib/support.js");
  });
});
