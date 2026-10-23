import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>,
) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-matrix-helper-test-"));
  const calls: string[][] = [];
  const inputs: ExecInput[] = [];
  const execRunner: ExecRunner = {
    run: async (input) => {
      const argv = [input.command, ...(input.args ?? [])];
      calls.push(argv);
      inputs.push(input);
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
    fetchImpl,
    undefined,
    () => "helper",
  );
  return {
    tempRoot,
    calls,
    inputs,
    provisioner,
    priv: provisioner as unknown as PrivateProvisioner,
    cleanup: () => rm(tempRoot, { recursive: true, force: true }),
  };
};

const jsonResponse = (payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const fakeHomeserver = async (url: string, init?: RequestInit): Promise<Response> => {
  if (url.endsWith("/_matrix/key/v2/server")) {
    return jsonResponse({ server_name: "matrix.local.test", valid_until_ts: 0, verify_keys: {} });
  }
  if (url.endsWith("/_matrix/client/v3/login")) {
    const body = JSON.parse(String(init?.body)) as { identifier: { user: string } };
    const localpart = body.identifier.user;
    return jsonResponse({
      access_token: `token-${localpart}`,
      user_id: `@${localpart}:matrix.local.test`,
    });
  }
  return jsonResponse({ versions: ["v1.1"] });
};

const composePsRunning = [
  { Service: "postgres", State: "running", Status: "Up (healthy)" },
  { Service: "synapse", State: "running", Status: "Up (healthy)" },
  { Service: "reverse-proxy", State: "running", Status: "Up (healthy)" },
]
  .map((entry) => JSON.stringify(entry))
  .join("\n");

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

  it("keeps account passwords and the registration secret out of every sudo argv", async () => {
    const h = await harness(
      (input) => (input.args?.includes("--format") ? { stdout: composePsRunning } : {}),
      fakeHomeserver,
    );
    try {
      const req = buildInstallRequest();
      const provision = await h.provisioner.provision(req);
      const accounts = await h.provisioner.bootstrapAccounts(req, provision);

      const readSecretRef = async (ref: string) =>
        (await readFile(ref.slice("file:".length), "utf8")).trim();
      const homeserverYaml = await readFile(
        join(provision.projectDir, "synapse", "homeserver.yaml"),
        "utf8",
      );
      const sharedSecret = /registration_shared_secret: "([^"]+)"/.exec(homeserverYaml)?.[1];
      const secrets = [
        await readSecretRef(accounts.operator.passwordSecretRef),
        await readSecretRef(accounts.bot.passwordSecretRef),
        sharedSecret ?? "",
      ];
      for (const secret of secrets) {
        expect(secret.length).toBeGreaterThan(8);
      }

      const sudoCalls = h.inputs.filter((input) => input.command === "sudo");
      expect(sudoCalls.length).toBeGreaterThan(0);
      for (const call of sudoCalls) {
        const argv = (call.args ?? []).join(" ");
        for (const secret of secrets) {
          expect(argv).not.toContain(secret);
        }
      }

      const registerCalls = sudoCalls.filter((call) =>
        call.args?.includes("register_new_matrix_user"),
      );
      expect(registerCalls.map((call) => call.options)).toEqual([
        expect.objectContaining({ input: secrets[0], stdin: "pipe" }),
        expect.objectContaining({ input: secrets[1], stdin: "pipe" }),
      ]);
      for (const call of registerCalls) {
        expect(call.args).toEqual([
          "-n",
          BUNDLED_MATRIX_DOCKER_HELPER_PATH,
          provision.projectDir,
          "compose",
          "exec",
          "-T",
          "synapse",
          "register_new_matrix_user",
          "-u",
          expect.any(String),
          "--password-file",
          "/dev/stdin",
          expect.stringMatching(/^(-a|--no-admin)$/),
          "-c",
          "/data/homeserver.yaml",
          provision.adminBaseUrl,
        ]);
      }
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
