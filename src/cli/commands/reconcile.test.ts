import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppContainer } from "../../app/create-app.js";
import { registerReconcileCommand } from "./reconcile.js";

const baseResult = {
  reconciled: ["mail-sentinel"],
  systemdUnits: { applied: [] },
  templateTransitions: [],
  releaseAuthorization: null,
};

const runReconcile = async (args: string[], reconcile: ReturnType<typeof vi.fn>) => {
  const program = new Command();
  program.exitOverride();
  registerReconcileCommand(program, {
    installerService: { reconcileAgentWorkspaces: reconcile },
  } as unknown as AppContainer);
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
  await program.parseAsync(["node", "sovereign-node", "reconcile", ...args]);
  vi.mocked(process.stdout.write).mockRestore();
  vi.mocked(process.stderr.write).mockRestore();
  return { stdout: stdout.join(""), stderr: stderr.join("") };
};

describe("reconcile command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("reconciles without options and emits the unchanged result", async () => {
    const reconcile = vi.fn(async () => baseResult);

    const { stdout } = await runReconcile(["--json"], reconcile);

    expect(reconcile).toHaveBeenCalledWith(undefined);
    expect(JSON.parse(stdout).result).toEqual(baseResult);
  });

  it("passes the release authorization through", async () => {
    const reconcile = vi.fn(async () => baseResult);

    await runReconcile(["--json", "--release-authorization", "/run/auth.json"], reconcile);

    expect(reconcile).toHaveBeenCalledWith({ releaseAuthorizationPath: "/run/auth.json" });
  });

  it("asks for a runtime refresh and emits its outcome", async () => {
    const runtimeRefresh = {
      rendered: true,
      restarted: true,
      ready: true,
      waitedMs: 4_321,
      invocationId: "4b6f1e0c2a9d4f1b8e3c7a5d6f0e1b2c",
    };
    const reconcile = vi.fn(async () => ({ ...baseResult, runtimeRefresh }));

    const { stdout } = await runReconcile(
      ["--json", "--refresh-runtime", "--release-authorization", "/run/auth.json"],
      reconcile,
    );

    expect(reconcile).toHaveBeenCalledWith({
      releaseAuthorizationPath: "/run/auth.json",
      refreshRuntime: true,
    });
    expect(JSON.parse(stdout).result.runtimeRefresh).toEqual(runtimeRefresh);
  });

  it("emits a null runtime refresh when there was nothing to refresh", async () => {
    const reconcile = vi.fn(async () => ({ ...baseResult, runtimeRefresh: null }));

    const { stdout } = await runReconcile(["--json", "--refresh-runtime"], reconcile);

    expect(reconcile).toHaveBeenCalledWith({ refreshRuntime: true });
    expect(JSON.parse(stdout).result.runtimeRefresh).toBeNull();
  });

  it("reports GATEWAY_REFRESH_FAILED as a failed reconcile", async () => {
    const reconcile = vi.fn(async () => {
      throw {
        code: "GATEWAY_REFRESH_FAILED",
        message: "OpenClaw gateway did not become ready",
        retryable: true,
      };
    });

    const { stderr } = await runReconcile(["--json", "--refresh-runtime"], reconcile);

    expect(process.exitCode).toBe(1);
    expect(JSON.parse(stderr).error.code).toBe("GATEWAY_REFRESH_FAILED");
  });
});
