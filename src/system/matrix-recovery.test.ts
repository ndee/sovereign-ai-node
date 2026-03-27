import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SovereignPaths } from "../config/paths.js";
import type { InstallRequest } from "../contracts/index.js";
import { createLogger } from "../logging/logger.js";
import type { ExecInput, ExecResult, ExecRunner } from "./exec.js";

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
  openrouter: {
    model: "qwen/qwen3.5-9b",
    apiKey: "sk-or-test",
  },
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
  operator: {
    username: "operator",
  },
  advanced: {
    nonInteractive: true,
  },
});

const buildPaths = (root: string): SovereignPaths => ({
  configPath: join(root, "etc", "sovereign-node.json5"),
  secretsDir: join(root, "etc", "secrets"),
  stateDir: join(root, "state"),
  logsDir: join(root, "logs"),
  installJobsDir: join(root, "install-jobs"),
  openclawServiceHome: join(root, "openclaw-home"),
  provenancePath: join(root, "install-provenance.json"),
});

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });

describe("DockerComposeBundledMatrixProvisioner readiness recovery", () => {
  const priorReadyTimeout = process.env.SOVEREIGN_MATRIX_READY_TIMEOUT_MS;

  afterEach(() => {
    if (priorReadyTimeout === undefined) {
      delete process.env.SOVEREIGN_MATRIX_READY_TIMEOUT_MS;
    } else {
      process.env.SOVEREIGN_MATRIX_READY_TIMEOUT_MS = priorReadyTimeout;
    }
    vi.resetModules();
  });

  it("retries compose stack start once after an initial readiness timeout", async () => {
    process.env.SOVEREIGN_MATRIX_READY_TIMEOUT_MS = "50";
    vi.resetModules();

    const { DockerComposeBundledMatrixProvisioner } = await import("./matrix.js");

    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-matrix-recovery-test-"));
    const recordedExecCalls: ExecInput[] = [];
    let versionsRequests = 0;

    const fakeExecRunner: ExecRunner = {
      run: async (input): Promise<ExecResult> => {
        recordedExecCalls.push(input);
        if (input.command === "docker") {
          return {
            command: [input.command, ...(input.args ?? [])].join(" "),
            exitCode: 0,
            stdout: "ok",
            stderr: "",
          };
        }
        return {
          command: [input.command, ...(input.args ?? [])].join(" "),
          exitCode: 127,
          stdout: "",
          stderr: "command not found",
        };
      },
    };

    const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.endsWith("/_matrix/client/versions")) {
        versionsRequests += 1;
        if (versionsRequests === 1) {
          throw new Error("fetch failed");
        }
        return jsonResponse({
          versions: ["v1.1"],
        });
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

    const provisioner = new DockerComposeBundledMatrixProvisioner(
      fakeExecRunner,
      createLogger(),
      buildPaths(tempRoot),
      fakeFetch,
    );

    try {
      const request = buildInstallRequest();
      const provision = await provisioner.provision(request);
      const accounts = await provisioner.bootstrapAccounts(request, provision);

      expect(accounts.operator.userId).toBe("@operator:matrix.local.test");
      expect(accounts.bot.userId).toBe("@service-bot:matrix.local.test");
      const composeUpCalls = recordedExecCalls.filter(
        (call) => call.command === "docker" && (call.args ?? []).includes("up"),
      );
      expect(composeUpCalls).toHaveLength(2);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
