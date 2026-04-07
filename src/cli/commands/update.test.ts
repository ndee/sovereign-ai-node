import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppContainer } from "../../app/create-app.js";
import { registerUpdateCommand } from "./update.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const createMockApp = (pending = false) =>
  ({
    installerService: {
      getPendingMigrations: vi.fn(async () => ({
        requestFile: "/etc/sovereign-node/install-request.json",
        pending: pending
          ? [
              {
                id: "mail-sentinel-instances",
                description: "migrate legacy mail-sentinel",
                interactive: true,
              },
            ]
          : [],
      })),
      startInstall: vi.fn(async () => ({
        job: {
          jobId: "job_123",
          state: "pending",
          createdAt: "2026-04-05T00:00:00.000Z",
          steps: [],
        },
      })),
    },
  }) as unknown as AppContainer;

describe("registerUpdateCommand", () => {
  it("blocks update when pending migrations exist", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-update-command-test-"));
    tempRoots.push(tempRoot);
    const requestPath = join(tempRoot, "install-request.json");
    await writeFile(
      requestPath,
      JSON.stringify({
        mode: "bundled_matrix",
        openrouter: { secretRef: "env:OPENROUTER_API_KEY" },
        matrix: {
          homeserverDomain: "matrix.example.org",
          publicBaseUrl: "https://matrix.example.org",
        },
        operator: { username: "operator" },
      }),
      "utf8",
    );

    const program = new Command();
    program.exitOverride();
    const app = createMockApp(true);
    registerUpdateCommand(program, app);

    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const originalExitCode = process.exitCode;
    try {
      await program.parseAsync(["node", "test", "update", "--request-file", requestPath]);
      expect(app.installerService.startInstall).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
      stderrWrite.mockRestore();
    }
  });
});
