import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppContainer } from "../../app/create-app.js";
import { SOVEREIGN_PINNED_OPENCLAW_VERSION } from "../../openclaw/bootstrap.js";
import * as stagedMigration from "../../openclaw/staged-migration.js";
import { registerOpenClawMigrationCommand } from "./openclaw-migration.js";

const app = {
  openclawBootstrapper: { detectInstalled: vi.fn(), ensureInstalled: vi.fn() },
  execRunner: { run: vi.fn() },
  logger: { info: vi.fn(), warn: vi.fn() },
} as unknown as AppContainer;

const run = async (args: string[]) => {
  const program = new Command();
  program.exitOverride();
  registerOpenClawMigrationCommand(program, app);
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  await program.parseAsync(["node", "sovereign-node", "openclaw-migration", ...args]);
  vi.mocked(process.stdout.write).mockRestore();
  vi.mocked(process.stderr.write).mockRestore();
  return { stdout: stdout.join(""), stderr: stderr.join("") };
};

describe("openclaw-migration install-runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("installs through the staged migration and emits the result envelope", async () => {
    const result = {
      version: SOVEREIGN_PINNED_OPENCLAW_VERSION,
      binaryPath: "/srv/.npm-global/bin/openclaw",
      installMethod: "locked_project" as const,
      reinstalled: true,
    };
    const install = vi
      .spyOn(stagedMigration, "installForStagedMigration")
      .mockResolvedValue(result);

    const { stdout } = await run([
      "install-runtime",
      "--target",
      SOVEREIGN_PINNED_OPENCLAW_VERSION,
      "--json",
    ]);

    expect(install).toHaveBeenCalledWith({
      bootstrapper: app.openclawBootstrapper,
      execRunner: app.execRunner,
      logger: app.logger,
      target: SOVEREIGN_PINNED_OPENCLAW_VERSION,
    });
    const envelope = JSON.parse(stdout);
    expect(envelope).toMatchObject({
      ok: true,
      command: "openclaw-migration install-runtime",
      result,
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("emits the error envelope and exits non-zero when the migration is not staged", async () => {
    vi.spyOn(stagedMigration, "installForStagedMigration").mockRejectedValue({
      code: "OPENCLAW_MIGRATION_NOT_STAGED",
      message: "No staged OpenClaw migration holds the lock",
      retryable: false,
      details: {},
    });

    const { stdout, stderr } = await run(["install-runtime", "--target", "2026.8.35", "--json"]);

    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toMatchObject({
      ok: false,
      command: "openclaw-migration install-runtime",
      error: { code: "OPENCLAW_MIGRATION_NOT_STAGED", retryable: false },
    });
    expect(process.exitCode).toBe(1);
  });

  it("requires --target", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const program = new Command();
    program.exitOverride();
    registerOpenClawMigrationCommand(program, app);
    await expect(
      program.parseAsync(["node", "sovereign-node", "openclaw-migration", "install-runtime"]),
    ).rejects.toMatchObject({ code: "commander.missingMandatoryOptionValue" });
  });
});
