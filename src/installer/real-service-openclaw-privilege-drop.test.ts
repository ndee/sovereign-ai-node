import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLogger } from "../logging/logger.js";
import type { ExecInput, ExecResult } from "../system/exec.js";
import { RealInstallerService } from "./real-service.js";

type Internals = {
  serviceProgramSearchPath: string;
  safeExec(command: string, args: string[]): Promise<{ ok: boolean }>;
  resolveManagedOpenClawEnv(): Promise<Record<string, string> | null>;
  resolveManagedOpenClawServiceUser(): Promise<string | null>;
};

describe("OpenClaw CLI run as the service user", () => {
  let tempRoot: string;
  let systemBin: string;
  let openclawBin: string;
  const priorPath = process.env.PATH;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "sovereign-privilege-drop-"));
    await chmod(tempRoot, 0o755);
    systemBin = join(tempRoot, "system-bin");
    openclawBin = join(tempRoot, "npm-global", "bin");
    await mkdir(systemBin, { recursive: true });
    await mkdir(openclawBin, { recursive: true });
    await writeFile(join(openclawBin, "openclaw"), "#!/usr/bin/env node\n", { mode: 0o755 });
    process.env.PATH = openclawBin;
    vi.spyOn(process as { getuid: () => number }, "getuid").mockReturnValue(0);
  });

  afterEach(async () => {
    process.env.PATH = priorPath;
    vi.restoreAllMocks();
    await rm(tempRoot, { recursive: true, force: true });
  });

  const runOpenClaw = async (): Promise<ExecInput[]> => {
    const calls: ExecInput[] = [];
    const service = new RealInstallerService(
      createLogger(),
      {} as ConstructorParameters<typeof RealInstallerService>[1],
      {
        execRunner: {
          run: async (input: ExecInput): Promise<ExecResult> => {
            calls.push(input);
            return { command: input.command, exitCode: 0, stdout: "", stderr: "" };
          },
        },
      } as unknown as ConstructorParameters<typeof RealInstallerService>[2],
    );
    const internals = service as unknown as Internals;
    internals.serviceProgramSearchPath = systemBin;
    vi.spyOn(internals, "resolveManagedOpenClawEnv").mockResolvedValue({});
    vi.spyOn(internals, "resolveManagedOpenClawServiceUser").mockResolvedValue("sovereign-node");
    expect((await internals.safeExec("openclaw", ["config", "get"])).ok).toBe(true);
    return calls;
  };

  it("starts the CLI with the system node instead of the node on the caller's PATH", async () => {
    await writeFile(join(systemBin, "node"), "#!/bin/sh\n", { mode: 0o755 });

    const [call] = await runOpenClaw();

    expect(call?.command).toBe("sudo");
    expect(call?.args?.slice(4)).toEqual([
      join(systemBin, "node"),
      join(openclawBin, "openclaw"),
      "config",
      "get",
    ]);
  });

  it("leaves the CLI to its own interpreter line when no system node is usable", async () => {
    const [call] = await runOpenClaw();

    expect(call?.args?.slice(4)).toEqual([join(openclawBin, "openclaw"), "config", "get"]);
  });
});
