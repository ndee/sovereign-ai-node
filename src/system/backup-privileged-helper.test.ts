import { describe, expect, it } from "vitest";

import type { SovereignPaths } from "../config/paths.js";
import { createLogger } from "../logging/logger.js";
import { RealBackupService } from "./backup.js";
import type { ExecInput, ExecResult, ExecRunner } from "./exec.js";
import { BUNDLED_MATRIX_DOCKER_HELPER_PATH } from "./privileged-helpers.js";

const paths = {
  stateDir: "/var/lib/sovereign-node",
} as SovereignPaths;

type PrivateBackup = {
  runComposeCommand: (
    projectDir: string,
    composeFilePath: string,
    args: string[],
    extraOptions?: Record<string, unknown>,
  ) => Promise<ExecResult>;
};

const build = (run: (input: ExecInput) => Promise<ExecResult>) => {
  const calls: ExecInput[] = [];
  const execRunner: ExecRunner = {
    run: async (input) => {
      calls.push(input);
      return run(input);
    },
  };
  const service = new RealBackupService(execRunner, createLogger(), paths, () => "helper");
  return { calls, priv: service as unknown as PrivateBackup };
};

const projectDir = "/var/lib/sovereign-node/bundled-matrix/matrix-local-test";

describe("RealBackupService with the bundled-matrix-docker helper", () => {
  it("passes compose commands and their stdin through the helper", async () => {
    const { calls, priv } = build(async () => ({
      command: "sudo",
      exitCode: 1,
      stdout: "",
      stderr: "psql: error",
    }));
    const result = await priv.runComposeCommand(
      projectDir,
      `${projectDir}/compose.yaml`,
      ["exec", "-T", "postgres", "psql", "-U", "synapse", "-d", "synapse"],
      { input: "SELECT 1;" },
    );
    expect(result.exitCode).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("sudo");
    expect(calls[0]?.args).toEqual([
      "-n",
      BUNDLED_MATRIX_DOCKER_HELPER_PATH,
      projectDir,
      "compose",
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "synapse",
      "-d",
      "synapse",
    ]);
    expect(calls[0]?.options).toMatchObject({ cwd: projectDir, input: "SELECT 1;" });
  });

  it("reports compose as unavailable when the helper cannot be executed", async () => {
    const { calls, priv } = build(async () => {
      throw new Error("sudo: command not found");
    });
    await expect(
      priv.runComposeCommand(projectDir, `${projectDir}/compose.yaml`, ["down"]),
    ).rejects.toMatchObject({
      code: "BACKUP_COMPOSE_UNAVAILABLE",
      details: { dockerComposeError: "sudo: command not found" },
    });
    expect(calls).toHaveLength(1);
  });
});
