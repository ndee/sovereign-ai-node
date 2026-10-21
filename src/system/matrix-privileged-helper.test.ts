import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SovereignPaths } from "../config/paths.js";
import type { InstallRequest } from "../contracts/index.js";
import { createLogger } from "../logging/logger.js";
import type { ExecInput, ExecResult, ExecRunner } from "./exec.js";
import {
  type BundledMatrixProvisionResult,
  DockerComposeBundledMatrixProvisioner,
} from "./matrix.js";
import {
  BUNDLED_MATRIX_DOCKER_HELPER_PATH,
  RECLAIM_OWNERSHIP_HELPER_PATH,
} from "./privileged-helpers.js";

const isRoot = process.getuid?.() === 0;

// `process.getuid` is optional in the Node typings, which leaves the spy
// typed as `never`.
const mockGetuid = (uid: number): void => {
  (
    vi.spyOn(process, "getuid" as never) as unknown as { mockReturnValue: (v: number) => void }
  ).mockReturnValue(uid);
};

const buildPaths = (root: string): SovereignPaths => ({
  configPath: join(root, "etc", "sovereign-node.json5"),
  secretsDir: join(root, "etc", "secrets"),
  stateDir: join(root, "state"),
  logsDir: join(root, "logs"),
  installJobsDir: join(root, "install-jobs"),
  openclawServiceHome: join(root, "openclaw-home"),
  provenancePath: join(root, "install-provenance.json"),
  backupsDir: join(root, "backups"),
});

const buildInstallRequest = (): InstallRequest => ({
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
  matrix: {
    homeserverDomain: "matrix.local.test",
    publicBaseUrl: "http://matrix.local.test:8008",
    federationEnabled: false,
    tlsMode: "local-dev",
    alertRoomName: "Sovereign Alerts",
  },
  operator: { username: "operator" },
  advanced: { nonInteractive: true },
});

type PrivateProvisioner = {
  runComposeCommand: (
    projectDir: string,
    composeFilePath: string,
    args: string[],
  ) => Promise<ExecResult>;
  collectContainerErrors: (
    projectDir: string,
    states: Array<{ service: string; state: string; name?: string; error?: string }>,
  ) => Promise<string[]>;
  findHostPortOwner: (
    projectDir: string,
    port: number,
  ) => Promise<{ name: string; project: string } | undefined>;
  resetBundledPostgresState: (provision: BundledMatrixProvisionResult) => Promise<void>;
};

const harness = async (
  respond: (input: ExecInput) => Partial<ExecResult> | Promise<Partial<ExecResult>>,
) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-matrix-helper-test-"));
  const calls: string[][] = [];
  const execRunner: ExecRunner = {
    run: async (input) => {
      const argv = [input.command, ...(input.args ?? [])];
      calls.push(argv);
      return {
        command: argv.join(" "),
        exitCode: 0,
        stdout: "",
        stderr: "",
        ...(await respond(input)),
      };
    },
  };
  const provisioner = new DockerComposeBundledMatrixProvisioner(
    execRunner,
    createLogger(),
    buildPaths(tempRoot),
    undefined,
    undefined,
    () => "helper",
  );
  return {
    tempRoot,
    calls,
    provisioner,
    priv: provisioner as unknown as PrivateProvisioner,
    cleanup: () => rm(tempRoot, { recursive: true, force: true }),
  };
};

describe("DockerComposeBundledMatrixProvisioner with the bundled-matrix-docker helper", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("validates the generated bundle through the helper instead of the docker CLI", async () => {
    const h = await harness(() => ({}));
    try {
      const result = await h.provisioner.provision(buildInstallRequest());
      expect(h.calls).toContainEqual([
        "sudo",
        "-n",
        BUNDLED_MATRIX_DOCKER_HELPER_PATH,
        result.projectDir,
        "compose",
        "config",
      ]);
      expect(h.calls.some((argv) => argv[0] === "docker" || argv[0] === "docker-compose")).toBe(
        false,
      );
    } finally {
      await h.cleanup();
    }
  });

  it("returns the helper's non-zero result without trying the legacy binary", async () => {
    const h = await harness(() => ({ exitCode: 2, stderr: "refused" }));
    try {
      const result = await h.priv.runComposeCommand("/p/proj", "/p/proj/compose.yaml", [
        "ps",
        "-a",
      ]);
      expect(result.exitCode).toBe(2);
      expect(h.calls).toEqual([
        ["sudo", "-n", BUNDLED_MATRIX_DOCKER_HELPER_PATH, "/p/proj", "compose", "ps", "-a"],
      ]);
    } finally {
      await h.cleanup();
    }
  });

  it("reports the stack as unavailable when the helper cannot be executed", async () => {
    const h = await harness(() => {
      throw new Error("sudo: command not found");
    });
    try {
      await expect(
        h.priv.runComposeCommand("/p/proj", "/p/proj/compose.yaml", ["ps", "-a"]),
      ).rejects.toMatchObject({
        code: "MATRIX_COMPOSE_UNAVAILABLE",
        details: { dockerComposeError: "sudo: command not found" },
      });
    } finally {
      await h.cleanup();
    }
  });

  it("runs the container-error and port-owner queries through the helper", async () => {
    const h = await harness((input) =>
      input.args?.includes("inspect")
        ? { stdout: "port is already allocated\n" }
        : { stdout: "other-caddy-1\tother\n" },
    );
    try {
      const errors = await h.priv.collectContainerErrors("/p/proj", [
        { service: "synapse", state: "created", name: "proj-synapse-1" },
      ]);
      expect(errors).toEqual(["port is already allocated"]);
      const owner = await h.priv.findHostPortOwner("/p/proj", 8008);
      expect(owner).toEqual({ name: "other-caddy-1", project: "other" });
      expect(h.calls).toEqual([
        [
          "sudo",
          "-n",
          BUNDLED_MATRIX_DOCKER_HELPER_PATH,
          "/p/proj",
          "inspect",
          "--format",
          "{{.State.Error}}",
          "proj-synapse-1",
        ],
        [
          "sudo",
          "-n",
          BUNDLED_MATRIX_DOCKER_HELPER_PATH,
          "/p/proj",
          "ps",
          "--filter",
          "publish=8008",
          "--format",
          '{{.Names}}\t{{.Label "com.docker.compose.project"}}',
        ],
      ]);
    } finally {
      await h.cleanup();
    }
  });

  it.skipIf(isRoot)(
    "hands a root-owned project dir back through the ownership helper, then retries",
    async () => {
      const h = await harness(async (input) => {
        if (input.args?.[1] === RECLAIM_OWNERSHIP_HELPER_PATH) {
          await chmod(input.args[2] as string, 0o750);
        }
        return {};
      });
      const projectDir = join(h.tempRoot, "state", "bundled-matrix", "matrix-local-test");
      await mkdir(projectDir, { recursive: true });
      await chmod(projectDir, 0o550);
      try {
        await h.provisioner.provision(buildInstallRequest());
        expect(h.calls).toContainEqual(["sudo", "-n", RECLAIM_OWNERSHIP_HELPER_PATH, projectDir]);
      } finally {
        await chmod(projectDir, 0o750);
        await h.cleanup();
      }
    },
  );

  it.skipIf(isRoot)("fails provisioning when the ownership helper refuses", async () => {
    const h = await harness(() => ({ exitCode: 2, stderr: "refused" }));
    const projectDir = join(h.tempRoot, "state", "bundled-matrix", "matrix-local-test");
    await mkdir(projectDir, { recursive: true });
    await chmod(projectDir, 0o550);
    try {
      await expect(h.provisioner.provision(buildInstallRequest())).rejects.toThrow(
        /ownership reclaim helper exited 2: refused/,
      );
    } finally {
      await chmod(projectDir, 0o750);
      await h.cleanup();
    }
  });

  it("reclaims postgres-data through the helper before a reset when unprivileged", async () => {
    const h = await harness((input) =>
      input.args?.[1] === RECLAIM_OWNERSHIP_HELPER_PATH ? { exitCode: 2 } : {},
    );
    mockGetuid(1000);
    const projectDir = join(h.tempRoot, "state", "bundled-matrix", "matrix-local-test");
    await mkdir(projectDir, { recursive: true });
    try {
      await h.priv.resetBundledPostgresState({
        projectDir,
        composeFilePath: join(projectDir, "compose.yaml"),
      } as BundledMatrixProvisionResult);
      const reclaims = h.calls.filter((argv) => argv[2] === RECLAIM_OWNERSHIP_HELPER_PATH);
      expect(reclaims).toEqual([
        ["sudo", "-n", RECLAIM_OWNERSHIP_HELPER_PATH, join(projectDir, "postgres-data")],
        ["sudo", "-n", RECLAIM_OWNERSHIP_HELPER_PATH, join(projectDir, "postgres-data")],
      ]);
    } finally {
      await h.cleanup();
    }
  });

  it("does not call the ownership helper as root", async () => {
    const h = await harness(() => ({}));
    mockGetuid(0);
    const projectDir = join(h.tempRoot, "state", "bundled-matrix", "matrix-local-test");
    await mkdir(projectDir, { recursive: true });
    try {
      await h.priv.resetBundledPostgresState({
        projectDir,
        composeFilePath: join(projectDir, "compose.yaml"),
      } as BundledMatrixProvisionResult);
      expect(h.calls.some((argv) => argv[2] === RECLAIM_OWNERSHIP_HELPER_PATH)).toBe(false);
    } finally {
      await h.cleanup();
    }
  });
});
