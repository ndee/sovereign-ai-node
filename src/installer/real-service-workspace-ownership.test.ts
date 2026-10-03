import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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
 * Issue #235: a fresh, root-run install created the Mail Sentinel workspace's
 * data/ (declared only implicitly, as the parent of data/README.md and
 * data/mail-sentinel-state.json) and the bot state dir above the workspace
 * root-owned — only the leaf directory or file was chowned. The scan service
 * runs as the service user, so its first run failed with EACCES creating
 * data/mail-sentinel-state.json.lock until a later --update re-chowned the
 * whole state dir.
 *
 * chown is recorded rather than performed so the root path can be exercised
 * by an unprivileged test runner.
 */

const chownedPaths = vi.hoisted(() => [] as string[]);

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    chown: async (path: string) => {
      chownedPaths.push(path);
    },
  };
});

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

const workspacePath = (suffix: string) => ({ join: [{ from: "agent.workspace" }, suffix] });

// Mirrors the Mail Sentinel manifest shape: files one level below the
// workspace with no directory resource for their parent, plus a nested
// directory resource whose own parent is implicit as well.
const fixtureManifest = (): string =>
  `${JSON.stringify(
    {
      kind: "sovereign-bot-package",
      manifestVersion: 2,
      id: "fixture-bot",
      version: "1.0.0",
      displayName: "Fixture Bot",
      description: "Workspace ownership fixture bot",
      matrixIdentity: { mode: "dedicated-account", localpartPrefix: "fixture-bot" },
      configDefaults: {},
      hostResources: [
        {
          id: "data-readme",
          kind: "managedFile",
          spec: {
            path: workspacePath("/data/README.md"),
            inlineContent: "data\n",
            writePolicy: "ifMissing",
          },
        },
        {
          id: "state",
          kind: "stateFile",
          spec: {
            path: workspacePath("/data/state.json"),
            inlineContent: "{}\n",
            writePolicy: "ifMissing",
          },
        },
        {
          id: "cache-dir",
          kind: "directory",
          spec: { path: workspacePath("/cache/nested"), mode: "0750" },
        },
      ],
      agentTemplate: {
        id: "fixture-bot",
        version: "1.0.0",
        description: "Workspace ownership fixture bot",
        matrix: { localpartPrefix: "fixture-bot" },
      },
    },
    null,
    2,
  )}\n`;

describe("reconcileAgentWorkspaces workspace directory ownership", () => {
  let tempRoot: string;
  let paths: SovereignPaths;
  let catalogDir: string;
  let getuidMock: ReturnType<typeof vi.spyOn> | null = null;

  const writeConfig = async (workspace: string): Promise<void> => {
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
        agents: [{ id: "fixture-bot", botId: "fixture-bot", workspace }],
      },
    };
    await writeFile(paths.configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  };

  beforeEach(async () => {
    chownedPaths.length = 0;
    tempRoot = await mkdtemp(join(tmpdir(), "workspace-ownership-test-"));
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
    await mkdir(join(catalogDir, "bots", "fixture-bot"), { recursive: true });
    await mkdir(join(tempRoot, "etc"), { recursive: true });
    // install.sh creates (and owns) the state dir before the installer runs.
    await mkdir(paths.stateDir, { recursive: true });
    await writeFile(
      join(catalogDir, "bots", "fixture-bot", "sovereign-bot.json"),
      fixtureManifest(),
      "utf8",
    );
    process.env.SOVEREIGN_NODE_SYSTEMD_UNIT_DIR = join(tempRoot, "systemd");
  });

  afterEach(async () => {
    getuidMock?.mockRestore();
    getuidMock = null;
    delete process.env.SOVEREIGN_NODE_SYSTEMD_UNIT_DIR;
    await rm(tempRoot, { recursive: true, force: true });
  });

  const mockUid = (uid: number): void => {
    getuidMock = vi
      .spyOn(process as typeof process & { getuid: () => number }, "getuid")
      .mockImplementation(() => uid);
  };

  const makeService = (): RealInstallerService =>
    new RealInstallerService(createLogger(), paths, {
      ...noopDeps,
      botCatalog: new FilesystemBotCatalog(catalogDir),
      execRunner: {
        run: async ({ command, args }: { command: string; args?: string[] }) => ({
          command: [command, ...(args ?? [])].join(" "),
          exitCode: 0,
          stdout: "",
          stderr: "",
        }),
      },
    });

  it("gives the service identity every directory it creates for a fresh bot", async () => {
    const botStateDir = join(paths.stateDir, "fixture-bot");
    const workspace = join(botStateDir, "workspace");
    await writeConfig(workspace);
    mockUid(0);

    await makeService().reconcileAgentWorkspaces();

    expect(chownedPaths).toEqual(
      expect.arrayContaining([
        botStateDir,
        workspace,
        join(workspace, ".openclaw"),
        join(workspace, "data"),
        join(workspace, "data", "README.md"),
        join(workspace, "data", "state.json"),
        join(workspace, "cache"),
        join(workspace, "cache", "nested"),
      ]),
    );
    // Never above the boundary: the state dir root belongs to install.sh.
    expect(chownedPaths).not.toContain(paths.stateDir);
    expect(chownedPaths).not.toContain(join(tempRoot, "var"));
  });

  it("repairs a data/ directory a previous fresh install left behind", async () => {
    const workspace = join(paths.stateDir, "fixture-bot", "workspace");
    await mkdir(join(workspace, "data"), { recursive: true });
    await writeFile(join(workspace, "data", "README.md"), "data\n", "utf8");
    await writeFile(join(workspace, "data", "state.json"), "{}\n", "utf8");
    await writeConfig(workspace);
    mockUid(0);

    await makeService().reconcileAgentWorkspaces();

    // Both files exist (ifMissing: not rewritten), yet their parent is
    // re-owned so the bot can create its lock file next to the state.
    expect(chownedPaths).toContain(join(workspace, "data"));
    expect(chownedPaths).not.toContain(join(workspace, "data", "state.json"));
    // Pre-existing directories above the leaf are not created by this run.
    expect(chownedPaths).not.toContain(join(paths.stateDir, "fixture-bot"));
  });

  it("does not walk up to directories outside the state dir", async () => {
    const outside = join(tempRoot, "elsewhere");
    const workspace = join(outside, "workspace");
    await writeConfig(workspace);
    mockUid(0);

    await makeService().reconcileAgentWorkspaces();

    expect(chownedPaths).toContain(workspace);
    expect(chownedPaths).toContain(join(workspace, "data"));
    expect(chownedPaths).not.toContain(outside);
  });

  it("only creates the directories when not running as root", async () => {
    const workspace = join(paths.stateDir, "fixture-bot", "workspace");
    await writeConfig(workspace);
    mockUid(1000);

    await makeService().reconcileAgentWorkspaces();

    expect(chownedPaths).toEqual([]);
    expect((await stat(join(workspace, "data"))).isDirectory()).toBe(true);
    expect((await stat(join(workspace, "cache", "nested"))).isDirectory()).toBe(true);
  });
});
