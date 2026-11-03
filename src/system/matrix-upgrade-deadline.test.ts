import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SovereignPaths } from "../config/paths.js";
import type { InstallRequest } from "../contracts/index.js";
import { createLogger } from "../logging/logger.js";
import type { ExecInput, ExecResult, ExecRunner } from "./exec.js";

const READY_ENV = "SOVEREIGN_MATRIX_READY_TIMEOUT_MS";
const UPGRADE_ENV = "SOVEREIGN_MATRIX_UPGRADE_READY_TIMEOUT_MS";

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
  imap: {
    host: "imap.example.org",
    port: 993,
    tls: true,
    username: "operator@example.org",
    secretRef: "file:/tmp/imap-secret",
    mailbox: "INBOX",
  },
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

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const loadMatrixModule = async (env: Record<string, string | undefined>) => {
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  vi.resetModules();
  return import("./matrix.js");
};

describe("Synapse readiness deadline after a homeserver upgrade", () => {
  const prior = { [READY_ENV]: process.env[READY_ENV], [UPGRADE_ENV]: process.env[UPGRADE_ENV] };

  afterEach(() => {
    for (const [name, value] of Object.entries(prior)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    vi.resetModules();
  });

  it("gives an existing homeserver database at least 15 minutes by default", async () => {
    const { resolveSynapseReadyTimeoutMs } = await loadMatrixModule({
      [READY_ENV]: undefined,
      [UPGRADE_ENV]: undefined,
    });

    expect(resolveSynapseReadyTimeoutMs(true)).toBe(30 * 60_000);
    expect(resolveSynapseReadyTimeoutMs(true)).toBeGreaterThanOrEqual(15 * 60_000);
    expect(resolveSynapseReadyTimeoutMs(false)).toBe(10 * 60_000);
  });

  it("reads the upgrade deadline from the environment", async () => {
    const { resolveSynapseReadyTimeoutMs } = await loadMatrixModule({
      [READY_ENV]: undefined,
      [UPGRADE_ENV]: "3600000",
    });

    expect(resolveSynapseReadyTimeoutMs(true)).toBe(3_600_000);
    expect(resolveSynapseReadyTimeoutMs(false)).toBe(10 * 60_000);
  });

  it("never gives an upgrade less time than a fresh install", async () => {
    const { resolveSynapseReadyTimeoutMs } = await loadMatrixModule({
      [READY_ENV]: "7200000",
      [UPGRADE_ENV]: "60000",
    });

    expect(resolveSynapseReadyTimeoutMs(true)).toBe(7_200_000);
  });

  it("keeps waiting past the fresh-install deadline while an existing database migrates", async () => {
    const { DockerComposeBundledMatrixProvisioner } = await loadMatrixModule({
      [READY_ENV]: "50",
      [UPGRADE_ENV]: "20000",
    });

    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-matrix-upgrade-test-"));
    const recordedExecCalls: ExecInput[] = [];
    let versionsRequests = 0;

    const fakeExecRunner: ExecRunner = {
      run: async (input): Promise<ExecResult> => {
        recordedExecCalls.push(input);
        const args = input.args ?? [];
        const stdout =
          args.includes("ps") && args.includes("--format")
            ? [
                JSON.stringify({ Service: "postgres", State: "running", Status: "Up" }),
                JSON.stringify({ Service: "synapse", State: "running", Status: "Up" }),
              ].join("\n")
            : "ok";
        return { command: [input.command, ...args].join(" "), exitCode: 0, stdout, stderr: "" };
      },
    };

    // Synapse applies schema deltas before it opens its listener, so the
    // readiness probe sees connection failures for the whole migration.
    const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.endsWith("/_matrix/key/v2/server")) {
        return jsonResponse({ server_name: "matrix.local.test" });
      }
      if (url.endsWith("/_matrix/client/versions")) {
        versionsRequests += 1;
        if (versionsRequests === 1) {
          throw new Error("fetch failed");
        }
        return jsonResponse({ versions: ["v1.12"] });
      }
      if (url.endsWith("/_matrix/client/v3/login")) {
        const payload = JSON.parse(String(init?.body ?? "{}")) as {
          identifier?: { user?: string };
        };
        const localpart = payload.identifier?.user ?? "unknown";
        return jsonResponse({
          access_token: `token-${localpart}`,
          user_id: `@${localpart}:matrix.local.test`,
        });
      }
      return jsonResponse({});
    };

    const projectDir = join(tempRoot, "state", "bundled-matrix", "matrix-local-test");
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, ".env"), "POSTGRES_PASSWORD=pg_existing\n", "utf8");

    const provisioner = new DockerComposeBundledMatrixProvisioner(
      fakeExecRunner,
      createLogger(),
      buildPaths(tempRoot),
      fakeFetch,
    );

    try {
      const request = buildInstallRequest();
      const provision = await provisioner.provision(request);
      expect(provision.existingDatabase).toBe(true);

      const accounts = await provisioner.bootstrapAccounts(request, provision);

      expect(accounts.operator.userId).toBe("@operator:matrix.local.test");
      expect(versionsRequests).toBe(2);
      // No readiness-timeout recovery: the stack was started exactly once.
      const composeUpCalls = recordedExecCalls.filter(
        (call) => call.command === "docker" && (call.args ?? []).includes("up"),
      );
      expect(composeUpCalls).toHaveLength(1);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
