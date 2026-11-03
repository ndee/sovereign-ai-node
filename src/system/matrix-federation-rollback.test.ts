import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SovereignPaths } from "../config/paths.js";
import type { InstallRequest } from "../contracts/index.js";
import { createLogger } from "../logging/logger.js";
import type { ExecInput, ExecResult, ExecRunner } from "./exec.js";
import { DockerComposeBundledMatrixProvisioner } from "./matrix.js";

// One-shot write failure, armed per test: the first write whose path matches
// fails, later writes (the rollback restoring that same file) go through.
const injected = vi.hoisted(() => ({ failWriteOnce: null as ((path: string) => boolean) | null }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const writeFile: typeof actual.writeFile = async (file, data, options) => {
    const predicate = injected.failWriteOnce;
    if (predicate?.(String(file))) {
      injected.failWriteOnce = null;
      throw Object.assign(new Error(`EIO: injected write failure, write '${String(file)}'`), {
        code: "EIO",
      });
    }
    return actual.writeFile(file, data, options);
  };
  return { ...actual, writeFile };
});

const buildRequest = (federationEnabled: boolean): InstallRequest => ({
  mode: "bundled_matrix",
  openclaw: {
    manageInstallation: true,
    installMethod: "install_sh",
    version: "pinned-by-sovereign",
    skipIfCompatibleInstalled: true,
    forceReinstall: false,
    runOnboard: false,
  },
  openrouter: { model: "qwen/qwen-2.5-7b-instruct", apiKey: "sk-or-test" },
  imap: {
    host: "imap.example.org",
    port: 993,
    tls: true,
    username: "operator@example.org",
    secretRef: "file:/tmp/imap-secret",
    mailbox: "INBOX",
  },
  matrix: {
    homeserverDomain: "node-abc.relay.example.com",
    publicBaseUrl: "https://node-abc.relay.example.com",
    federationEnabled,
    tlsMode: "auto",
    alertRoomName: "Sovereign Alerts",
  },
  operator: { username: "operator" },
  advanced: { nonInteractive: true },
  connectivity: { mode: "relay" },
  relay: { controlUrl: "https://relay.example.com", enrollmentToken: "relay-token" },
});

const buildPaths = (tempRoot: string): SovereignPaths => ({
  configPath: join(tempRoot, "etc", "sovereign-node.json5"),
  secretsDir: join(tempRoot, "etc", "secrets"),
  stateDir: join(tempRoot, "state"),
  logsDir: join(tempRoot, "logs"),
  installJobsDir: join(tempRoot, "install-jobs"),
  openclawServiceHome: join(tempRoot, "openclaw-home"),
  provenancePath: join(tempRoot, "install-provenance.json"),
  backupsDir: join(tempRoot, "backups"),
});

type ExitCodeFor = (args: string) => number;

const recordingExecRunner = (calls: string[], exitCodeFor: ExitCodeFor): ExecRunner => ({
  run: async (input: ExecInput): Promise<ExecResult> => {
    const command = [input.command, ...(input.args ?? [])].join(" ");
    if (input.command !== "docker") {
      return { command, exitCode: 127, stdout: "", stderr: "command not found" };
    }
    const composeArgs = (input.args ?? []).slice(5).join(" ");
    calls.push(composeArgs);
    return { command, exitCode: exitCodeFor(composeArgs), stdout: "", stderr: "compose said no" };
  },
});

const snapshotTree = async (dir: string): Promise<Record<string, string>> => {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      files[relative(dir, path)] = await readFile(path, "utf8");
    }
  }
  return files;
};

const RESTART = "restart synapse";
const RECREATE = "up -d --no-deps --force-recreate reverse-proxy";

describe("bundled Matrix federation toggle rollback", () => {
  let tempRoot: string;
  let projectDir: string;
  let calls: string[];
  let exitCodeFor: ExitCodeFor;
  let provisioner: DockerComposeBundledMatrixProvisioner;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-matrix-federation-"));
    calls = [];
    exitCodeFor = () => 0;
    provisioner = new DockerComposeBundledMatrixProvisioner(
      recordingExecRunner(calls, (args) => exitCodeFor(args)),
      createLogger(),
      buildPaths(tempRoot),
      undefined,
      () => ["10.20.30.40"],
      () => "direct",
    );
    projectDir = (await provisioner.provision(buildRequest(false))).projectDir;
    calls.length = 0;
  });

  afterEach(async () => {
    injected.failWriteOnce = null;
    await rm(tempRoot, { recursive: true, force: true });
  });

  const enableFederation = () =>
    provisioner.updateFederationConfig({
      federationEnabled: true,
      projectDir,
      composeFilePath: join(projectDir, "compose.yaml"),
      accessMode: "relay",
      homeserverDomain: "node-abc.relay.example.com",
      publicBaseUrl: "https://node-abc.relay.example.com",
    });

  it("rewrites homeserver.yaml, .env and the Caddyfile and restarts both services", async () => {
    const before = await snapshotTree(projectDir);

    await enableFederation();

    const after = await snapshotTree(projectDir);
    const changed = Object.keys(before).filter((path) => before[path] !== after[path]);
    expect(changed.sort()).toEqual([".env", "reverse-proxy/Caddyfile", "synapse/homeserver.yaml"]);
    expect(calls).toEqual([RESTART, RECREATE]);
  });

  it.each([
    ["homeserver.yaml", "synapse/homeserver.yaml"],
    [".env", ".env"],
    ["the Caddyfile", "reverse-proxy/Caddyfile"],
  ])("restores every file without restarting anything when writing %s fails", async (_label, file) => {
    const before = await snapshotTree(projectDir);
    injected.failWriteOnce = (path) => path === join(projectDir, file);

    const error = await enableFederation().then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect(error).toMatchObject({
      code: "MATRIX_FEDERATION_UPDATE_FAILED",
      retryable: false,
      details: {
        error: expect.stringContaining("injected write failure"),
        rollback: { complete: true, failures: [] },
        synapseRestarted: false,
      },
    });
    expect(await snapshotTree(projectDir)).toEqual(before);
    expect(calls).toEqual([]);
  });

  it("restores a stale well-known server file whose rewrite fails", async () => {
    const wellKnownPath = join(projectDir, "well-known", ".well-known", "matrix", "server");
    await writeFile(wellKnownPath, '{\n  "m.server": "stale.example.org"\n}\n', "utf8");
    const before = await snapshotTree(projectDir);
    injected.failWriteOnce = (path) => path === wellKnownPath;

    await expect(enableFederation()).rejects.toMatchObject({
      code: "MATRIX_FEDERATION_UPDATE_FAILED",
      details: { rollback: { complete: true } },
    });
    expect(await snapshotTree(projectDir)).toEqual(before);
    expect(calls).toEqual([]);
  });

  it("restores the files and restarts Synapse on the old config when its restart fails", async () => {
    const before = await snapshotTree(projectDir);
    let restarts = 0;
    exitCodeFor = (args) => (args === RESTART && ++restarts === 1 ? 1 : 0);

    await expect(enableFederation()).rejects.toMatchObject({
      code: "MATRIX_SYNAPSE_RESTART_FAILED",
      retryable: true,
      details: {
        exitCode: 1,
        stderr: "compose said no",
        rollback: { complete: true },
        synapseRestarted: true,
      },
    });
    expect(await snapshotTree(projectDir)).toEqual(before);
    expect(calls).toEqual([RESTART, RESTART]);
  });

  it("restores the files and recreates both services on the old config when the recreate fails", async () => {
    const before = await snapshotTree(projectDir);
    let recreates = 0;
    exitCodeFor = (args) => (args === RECREATE && ++recreates === 1 ? 1 : 0);

    await expect(enableFederation()).rejects.toMatchObject({
      code: "MATRIX_EDGE_RELOAD_FAILED",
      retryable: true,
      details: { exitCode: 1, rollback: { complete: true, failures: [] } },
    });
    expect(await snapshotTree(projectDir)).toEqual(before);
    expect(calls).toEqual([RESTART, RECREATE, RESTART, RECREATE]);
  });

  it("is not retryable when the rollback cannot recreate the reverse proxy either", async () => {
    const before = await snapshotTree(projectDir);
    exitCodeFor = (args) => (args === RECREATE ? 1 : 0);

    await expect(enableFederation()).rejects.toMatchObject({
      code: "MATRIX_EDGE_RELOAD_FAILED",
      retryable: false,
      details: {
        rollback: {
          complete: false,
          failures: [{ step: "recreate reverse-proxy", error: expect.stringContaining("exit 1") }],
        },
      },
    });
    // The files are still restored, so the next recreate starts the old edge.
    expect(await snapshotTree(projectDir)).toEqual(before);
  });

  it("reports a rollback that cannot restore a file", async () => {
    exitCodeFor = (args) => (args === RESTART ? 1 : 0);
    let yamlWrites = 0;
    injected.failWriteOnce = (path) =>
      path === join(projectDir, "synapse", "homeserver.yaml") && ++yamlWrites === 2;

    await expect(enableFederation()).rejects.toMatchObject({
      code: "MATRIX_SYNAPSE_RESTART_FAILED",
      retryable: false,
      details: {
        rollback: {
          complete: false,
          failures: [
            {
              step: `restore ${join(projectDir, "synapse", "homeserver.yaml")}`,
              error: expect.stringContaining("injected write failure"),
            },
            { step: "restart synapse", error: expect.stringContaining("exit 1") },
          ],
        },
      },
    });
  });

  it("keeps a non-retryable compose error non-retryable after a complete rollback", async () => {
    const helperProvisioner = new DockerComposeBundledMatrixProvisioner(
      {
        run: async () => {
          throw new Error("sudo: command not found");
        },
      },
      createLogger(),
      buildPaths(tempRoot),
      undefined,
      undefined,
      () => "helper",
    );
    const before = await snapshotTree(projectDir);

    await expect(
      helperProvisioner.updateFederationConfig({
        federationEnabled: true,
        projectDir,
        composeFilePath: join(projectDir, "compose.yaml"),
        accessMode: "relay",
        homeserverDomain: "node-abc.relay.example.com",
        publicBaseUrl: "https://node-abc.relay.example.com",
      }),
    ).rejects.toMatchObject({
      code: "MATRIX_COMPOSE_UNAVAILABLE",
      retryable: false,
      details: { rollback: { complete: false } },
    });
    expect(await snapshotTree(projectDir)).toEqual(before);
  });

  it("returns a rollback that undoes an applied change", async () => {
    const before = await snapshotTree(projectDir);
    const change = await enableFederation();
    calls.length = 0;

    await change.rollback();

    expect(await snapshotTree(projectDir)).toEqual(before);
    expect(calls).toEqual([RESTART, RECREATE]);
  });

  it("fails a rollback of an applied change that does not complete", async () => {
    const change = await enableFederation();
    exitCodeFor = (args) => (args === RESTART ? 1 : 0);

    await expect(change.rollback()).rejects.toMatchObject({
      code: "MATRIX_FEDERATION_ROLLBACK_FAILED",
      retryable: false,
      message: expect.stringContaining("restart synapse"),
      details: { rollback: { complete: false } },
    });
  });

  it("restarts only Synapse when the edge policy did not change", async () => {
    const change = await provisioner.updateFederationConfig({
      federationEnabled: false,
      projectDir,
      composeFilePath: join(projectDir, "compose.yaml"),
      accessMode: "relay",
      homeserverDomain: "node-abc.relay.example.com",
      publicBaseUrl: "https://node-abc.relay.example.com",
    });
    await change.rollback();
    expect(calls).toEqual([RESTART, RESTART]);
  });
});
