// The unit install helper must accept the gateway unit the installer renders,
// or an unprivileged reconfigure could no longer rewrite it.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLogger } from "../../../src/logging/logger.ts";
import { RealInstallerService } from "../../../src/installer/real-service.ts";
import { validateUnit } from "./privileged-systemd-unit.mjs";

describe("gateway unit rendered by the installer", () => {
  let tempRoot;
  let priorUnitPath;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "privileged-unit-contract-"));
    priorUnitPath = process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH;
    process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH = join(tempRoot, "gateway.service");
  });

  afterEach(async () => {
    if (priorUnitPath === undefined) {
      delete process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH;
    } else {
      process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH = priorUnitPath;
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  it.each(["http://127.0.0.1:8008", "https://matrix.example.org"])(
    "passes the helper's validation (Matrix at %s)",
    async (adminBaseUrl) => {
      const stateDir = join(tempRoot, "var", "lib", "sovereign-node");
      const configDir = join(tempRoot, "etc", "sovereign-node");
      const openclawServiceHome = join(stateDir, "openclaw-home");
      const service = new RealInstallerService(
        createLogger(),
        {
          configPath: join(configDir, "sovereign-node.json5"),
          secretsDir: join(configDir, "secrets"),
          stateDir,
          logsDir: join(tempRoot, "var", "log"),
          installJobsDir: join(stateDir, "install-jobs"),
          openclawServiceHome,
          provenancePath: join(stateDir, "install-provenance.json"),
          backupsDir: join(stateDir, "backups"),
        },
        {
          execRunner: {
            run: async ({ command, args }) => ({
              command: [command, ...(args ?? [])].join(" "),
              exitCode: 0,
              stdout: "",
              stderr: "",
            }),
          },
          fetchImpl: async () => new Response("not found", { status: 404 }),
        },
      );
      let clock = 0;
      service.gatewayReadinessClock = {
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      };
      await service.ensureSystemGatewayServiceFallback({
        matrix: { adminBaseUrl },
        openclaw: {
          serviceUser: "sovereign-node",
          serviceGroup: "sovereign-node",
          gatewayEnvPath: join(openclawServiceHome, "gateway.env"),
        },
      });
      const unit = await readFile(join(tempRoot, "gateway.service"), "utf8");
      expect(unit).toContain("[Service]");
      expect(() =>
        validateUnit("sovereign-openclaw-gateway.service", unit, {
          serviceUser: "sovereign-node",
          serviceGroup: "sovereign-node",
          serviceUid: 998,
          serviceGid: 997,
          stateDir,
          configDir,
          appDir: "/opt/sovereign-ai-node/app",
        }),
      ).not.toThrow();
    },
  );
});
