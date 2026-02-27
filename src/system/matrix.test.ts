import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { SovereignPaths } from "../config/paths.js";
import type { InstallRequest } from "../contracts/index.js";
import { createLogger } from "../logging/logger.js";
import type { ExecInput, ExecResult, ExecRunner } from "./exec.js";
import { DockerComposeBundledMatrixProvisioner } from "./matrix.js";

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

describe("DockerComposeBundledMatrixProvisioner", () => {
  it("writes a local-dev compose bundle and validates it with docker compose config", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-matrix-test-"));
    const recordedExecCalls: ExecInput[] = [];

    const fakeExecRunner: ExecRunner = {
      run: async (input): Promise<ExecResult> => {
        recordedExecCalls.push(input);
        if (input.command === "docker") {
          return {
            command: [input.command, ...(input.args ?? [])].join(" "),
            exitCode: 0,
            stdout: "services:\n  postgres: {}\n  synapse: {}\n",
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

    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "state"),
      logsDir: join(tempRoot, "logs"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
    };

    const provisioner = new DockerComposeBundledMatrixProvisioner(
      fakeExecRunner,
      createLogger(),
      paths,
    );

    try {
      const result = await provisioner.provision(buildInstallRequest());

      expect(result.tlsMode).toBe("local-dev");
      expect(result.homeserverDomain).toBe("matrix.local.test");

      const composeText = await readFile(result.composeFilePath, "utf8");
      expect(composeText).toContain("matrixdotorg/synapse");
      expect(composeText).toContain("postgres:16-alpine");

      const homeserverText = await readFile(join(result.projectDir, "synapse", "homeserver.yaml"), "utf8");
      expect(homeserverText).toContain('server_name: "matrix.local.test"');
      expect(homeserverText).toContain('public_baseurl: "http://matrix.local.test:8008/"');

      expect(recordedExecCalls).toHaveLength(1);
      expect(recordedExecCalls[0]?.command).toBe("docker");
      expect(recordedExecCalls[0]?.args).toContain("compose");
      expect(recordedExecCalls[0]?.args).toContain("config");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
