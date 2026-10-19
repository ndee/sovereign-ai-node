import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppContainer } from "../../app/create-app.js";

const WORKSPACE_STATE =
  "/var/lib/sovereign-node/mail-sentinel/workspace/data/mail-sentinel-state.json";

const reads = vi.hoisted(() => ({ paths: [] as string[], maxBytes: [] as number[] }));

vi.mock("../../support/tail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../support/tail.js")>();
  return {
    ...actual,
    readSmallFile: async (path: string, maxBytes: number, ...rest: unknown[]) => {
      if (path.endsWith("mail-sentinel-state.json")) {
        reads.paths.push(path);
        reads.maxBytes.push(maxBytes);
        return JSON.stringify({ integrity: { version: 1, days: {} } });
      }
      return await (actual.readSmallFile as (...args: unknown[]) => Promise<string>)(
        path,
        maxBytes,
        ...rest,
      );
    },
  };
});

const generated = vi.hoisted(() => ({ deps: [] as unknown[] }));

vi.mock("../../support/bundle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../support/bundle.js")>();
  return {
    ...actual,
    // The real generator shells out to systemctl/journalctl; only the inputs
    // handed to it matter here.
    generateSupportBundle: async (_directory: string, deps: unknown) => {
      generated.deps.push(deps);
      return {
        path: "/tmp/bundle.tar.gz",
        sha256: "0".repeat(64),
        bytes: 1,
        complete: true,
        manifest: { files: [] },
      };
    },
  };
});

const { registerSupportBundleCommand } = await import("./support-bundle.js");

let outputDir: string;

beforeEach(async () => {
  outputDir = await mkdtemp(join(tmpdir(), "sb-mail-state-"));
  reads.paths = [];
  reads.maxBytes = [];
  generated.deps = [];
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(outputDir, { recursive: true, force: true });
});

describe("support-bundle — Mail Sentinel state", () => {
  it("reads the state from the Mail Sentinel agent workspace", async () => {
    const program = new Command();
    program.exitOverride();
    registerSupportBundleCommand(program, {
      installerService: {
        getDoctorReport: async () => ({ overall: "pass" }),
        getStatus: async () => ({}),
      },
    } as unknown as AppContainer);

    await program.parseAsync(["node", "test", "support-bundle", "--output-dir", outputDir]);

    // Read through the bounded, symlink-refusing reader.
    expect(reads.paths).toEqual([WORKSPACE_STATE]);
    expect(reads.maxBytes).toEqual([32 * 1024 * 1024]);
    expect(generated.deps).toEqual([
      expect.objectContaining({ mailState: { integrity: { version: 1, days: {} } } }),
    ]);
  });
});
