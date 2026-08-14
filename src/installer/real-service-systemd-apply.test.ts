import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FilesystemBotCatalog } from "../bots/catalog.js";
import type { SovereignPaths } from "../config/paths.js";
import { createLogger } from "../logging/logger.js";
import type { OpenClawBootstrapper } from "../openclaw/bootstrap.js";
import type { ImapTester } from "../system/imap.js";
import type { BundledMatrixProvisioner } from "../system/matrix.js";
import type { HostPreflightChecker } from "../system/preflight.js";
import { RealInstallerService } from "./real-service.js";

/**
 * Issue #224: a device passed every install/update check with Mail Sentinel
 * installed and correctly pinned — and no scan service/timer anywhere on the
 * filesystem, so mail was never scanned. Two converging causes:
 *
 *  1. reconcileAgentWorkspaces (the update path) refreshed workspaces but
 *     never applied the compiled systemd host resources, so a device missing
 *     its units stayed unscheduled through every update.
 *  2. applyCompiledSystemdResources silently returned when not running as
 *     root, so the wizard's unprivileged configure step skipped the units on
 *     every fresh install.
 *
 * These tests drive reconcileAgentWorkspaces against a real on-disk catalog
 * whose fixture bot declares a scan service + timer, and assert both repair
 * paths: root (updater) writes directly, unprivileged (wizard) elevates via
 * `sudo -n tee` / `sudo -n systemctl`, and any unit that cannot be converged
 * fails the reconcile instead of passing silently.
 */

const noopDeps = {
  openclawBootstrapper: {
    detectInstalled: async () => null,
    ensureInstalled: async () => ({
      binaryPath: "/usr/local/bin/openclaw",
      version: "pinned",
      installMethod: "install_sh" as const,
    }),
  } as unknown as OpenClawBootstrapper,
  openclawGatewayServiceManager: {
    install: async () => {},
    start: async () => {},
    restart: async () => {},
  },
  preflightChecker: {
    run: async () => ({
      mode: "bundled_matrix",
      overall: "pass",
      checks: [],
      recommendedActions: [],
    }),
  } as unknown as HostPreflightChecker,
  imapTester: {
    test: async () => ({ ok: true, host: "h", port: 993, tls: true, auth: "ok" as const }),
  } as unknown as ImapTester,
  matrixProvisioner: {
    provision: async () => {
      throw new Error("not used");
    },
  } as unknown as BundledMatrixProvisioner,
};

const fixtureManifest = (): string =>
  `${JSON.stringify(
    {
      kind: "sovereign-bot-package",
      manifestVersion: 2,
      id: "fixture-bot",
      version: "1.0.0",
      displayName: "Fixture Bot",
      description: "Systemd host resource fixture bot",
      matrixIdentity: { mode: "dedicated-account", localpartPrefix: "fixture-bot" },
      configDefaults: {},
      hostResources: [
        {
          id: "scan-service",
          kind: "systemdService",
          spec: {
            name: { join: ["sovereign-", { from: "agent.id" }, "-scan.service"] },
            description: "Fixture scan",
            type: "oneshot",
            user: "fixture-svc",
            group: "fixture-svc",
            workingDirectory: { from: "agent.workspace" },
            execStart: [
              "/usr/bin/env",
              "node",
              { join: [{ from: "agent.workspace" }, "/bin/fixture.js"] },
              "scan",
            ],
            wantedBy: [],
            desiredState: { enabled: false, active: false },
          },
        },
        {
          id: "scan-timer",
          kind: "systemdTimer",
          dependsOn: ["scan-service"],
          spec: {
            name: { join: ["sovereign-", { from: "agent.id" }, "-scan.timer"] },
            description: "Fixture scan timer",
            unit: { join: ["sovereign-", { from: "agent.id" }, "-scan.service"] },
            onActiveSec: "5min",
            onUnitActiveSec: "30min",
            persistent: true,
            wantedBy: ["timers.target"],
            desiredState: { enabled: true, active: true },
          },
          checks: [
            {
              kind: "resource-state",
              id: "timer-enabled",
              property: "enabled",
              equals: true,
              severity: "fail",
            },
          ],
        },
      ],
      agentTemplate: {
        id: "fixture-bot",
        version: "1.0.0",
        description: "Systemd host resource fixture bot",
        matrix: { localpartPrefix: "fixture-bot" },
      },
    },
    null,
    2,
  )}\n`;

describe("reconcileAgentWorkspaces systemd host resource convergence", () => {
  let tempRoot: string;
  let paths: SovereignPaths;
  let catalogDir: string;
  let systemdDir: string;
  let workspaceDir: string;
  let getuidMock: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "systemd-apply-test-"));
    paths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };
    catalogDir = join(tempRoot, "bots-catalog");
    systemdDir = join(tempRoot, "etc", "systemd", "system");
    workspaceDir = join(paths.stateDir, "fixture-bot", "workspace");
    await mkdir(join(catalogDir, "bots", "fixture-bot"), { recursive: true });
    await mkdir(join(tempRoot, "etc"), { recursive: true });
    await mkdir(systemdDir, { recursive: true });
    await writeFile(
      join(catalogDir, "bots", "fixture-bot", "sovereign-bot.json"),
      fixtureManifest(),
      "utf8",
    );
    const config = {
      matrix: {
        publicBaseUrl: "http://matrix.example.org",
        adminBaseUrl: "http://127.0.0.1:8008",
        operator: { userId: "@operator:matrix.example.org" },
        bot: {
          localpart: "sovereign-bot",
          userId: "@sovereign-bot:matrix.example.org",
          accessTokenSecretRef: "file:/tmp/token",
        },
        alertRoom: { roomId: "!alerts:matrix.example.org" },
      },
      openclawProfile: {
        agents: [
          {
            id: "fixture-bot",
            botId: "fixture-bot",
            workspace: workspaceDir,
          },
        ],
      },
    };
    await writeFile(paths.configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    process.env.SOVEREIGN_NODE_SYSTEMD_UNIT_DIR = systemdDir;
  });

  afterEach(async () => {
    getuidMock?.mockRestore();
    getuidMock = null;
    delete process.env.SOVEREIGN_NODE_SYSTEMD_UNIT_DIR;
    // A test may have made the unit dir read-only; restore so rm succeeds.
    await chmod(systemdDir, 0o755).catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  });

  const mockUid = (uid: number): void => {
    getuidMock =
      typeof process.getuid === "function"
        ? vi
            .spyOn(process as typeof process & { getuid: () => number }, "getuid")
            .mockImplementation(() => uid)
        : null;
  };

  type ExecCall = { command: string; args: string[] };

  const makeService = (input?: {
    execExitCodes?: (call: ExecCall) => number;
    calls?: ExecCall[];
  }): RealInstallerService =>
    new RealInstallerService(createLogger(), paths, {
      ...noopDeps,
      botCatalog: new FilesystemBotCatalog(catalogDir),
      execRunner: {
        run: async ({ command, args }: { command: string; args?: string[] }) => {
          const call = { command, args: args ?? [] };
          input?.calls?.push(call);
          const exitCode = input?.execExitCodes?.(call) ?? 0;
          return {
            command: [command, ...(args ?? [])].join(" "),
            exitCode,
            stdout: "",
            stderr: "",
          };
        },
      },
    });

  it("writes missing bot systemd units and enables the timer when running as root", async () => {
    mockUid(0);
    const calls: ExecCall[] = [];
    const result = await makeService({ calls }).reconcileAgentWorkspaces();

    expect(result.reconciled).toContain("fixture-bot");
    expect(result.systemdUnits.applied).toEqual([
      "sovereign-fixture-bot-scan.service",
      "sovereign-fixture-bot-scan.timer",
    ]);

    const serviceUnit = await readFile(
      join(systemdDir, "sovereign-fixture-bot-scan.service"),
      "utf8",
    );
    expect(serviceUnit).toContain("Description=Fixture scan");
    expect(serviceUnit).toContain("Type=oneshot");
    const timerUnit = await readFile(join(systemdDir, "sovereign-fixture-bot-scan.timer"), "utf8");
    expect(timerUnit).toContain("WantedBy=timers.target");

    const serialized = calls.map((call) => [call.command, ...call.args].join(" "));
    expect(serialized).toContain("systemctl daemon-reload");
    expect(serialized).toContain("systemctl enable sovereign-fixture-bot-scan.timer");
    expect(serialized).toContain("systemctl restart sovereign-fixture-bot-scan.timer");
    // The service unit declares desiredState enabled=false/active=false.
    expect(serialized).not.toContain("systemctl enable sovereign-fixture-bot-scan.service");
    expect(serialized).not.toContain("systemctl restart sovereign-fixture-bot-scan.service");
  });

  it("is idempotent: a second reconcile with unchanged units applies nothing", async () => {
    mockUid(0);
    await makeService().reconcileAgentWorkspaces();

    const calls: ExecCall[] = [];
    const second = await makeService({ calls }).reconcileAgentWorkspaces();
    expect(second.systemdUnits.applied).toEqual([]);
    const serialized = calls.map((call) => [call.command, ...call.args].join(" "));
    expect(serialized).not.toContain("systemctl daemon-reload");
  });

  it("elevates unit writes through sudo -n tee when unprivileged", async () => {
    if (process.getuid?.() === 0) {
      // Under a root test runner the direct-write fast path always succeeds;
      // the elevation fallback is unreachable. Covered by the root test above.
      return;
    }
    mockUid(1000);
    await chmod(systemdDir, 0o555);
    const calls: ExecCall[] = [];
    const result = await makeService({ calls }).reconcileAgentWorkspaces();

    const serialized = calls.map((call) => [call.command, ...call.args].join(" "));
    expect(serialized).toContain(
      `sudo -n tee ${join(systemdDir, "sovereign-fixture-bot-scan.service")}`,
    );
    expect(serialized).toContain(
      `sudo -n tee ${join(systemdDir, "sovereign-fixture-bot-scan.timer")}`,
    );
    expect(serialized).toContain("systemctl daemon-reload");
    expect(result.systemdUnits.applied).toEqual([
      "sovereign-fixture-bot-scan.service",
      "sovereign-fixture-bot-scan.timer",
    ]);
  });

  it("fails the reconcile when daemon-reload fails instead of passing silently", async () => {
    mockUid(0);
    await expect(
      makeService({
        execExitCodes: (call) =>
          call.command === "systemctl" && call.args[0] === "daemon-reload" ? 1 : 0,
      }).reconcileAgentWorkspaces(),
    ).rejects.toMatchObject({
      code: "BOT_SYSTEMD_APPLY_FAILED",
      retryable: true,
    });
  });

  it("fails the reconcile when enabling the timer fails", async () => {
    mockUid(0);
    await expect(
      makeService({
        execExitCodes: (call) =>
          call.command === "systemctl" && call.args[0] === "enable" ? 1 : 0,
      }).reconcileAgentWorkspaces(),
    ).rejects.toMatchObject({
      code: "BOT_SYSTEMD_APPLY_FAILED",
    });
  });
});
