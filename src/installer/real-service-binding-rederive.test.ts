import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import type { GatewayReadinessOutcome } from "./gateway-readiness.js";
import { RealInstallerService } from "./real-service.js";
import type { RuntimeConfig } from "./real-service-shared.js";

/**
 * A node installed by an older release carries the node-derived bindings of
 * that release: its review tool has no `scanAgentId` and its plugin allow
 * list lacks plugins the current rules require. Reconcile (the update path)
 * must re-derive both the way the install job does, so the next render sends
 * reviews to the scan agent.
 */

type Internals = {
  writeInstallerJsonFile(path: string, value: unknown, mode: number): Promise<void>;
  writeOpenClawRuntimeArtifacts(config: RuntimeConfig): Promise<void>;
  setManagedOpenClawEnv(config: RuntimeConfig): void;
  refreshGatewayAfterRuntimeConfig(config: RuntimeConfig): Promise<GatewayReadinessOutcome>;
};

const BOT_ID = "review-bot";
const REVIEW_TOOL = "review-tool@1.0.0";
const PLAIN_TOOL = "plain-tool@1.0.0";

type FixtureAgent = {
  id: string;
  botId?: string;
  templateRef?: string;
  workspace: string;
  toolInstanceIds?: string[];
};
type FixtureTool = {
  id: string;
  templateRef: string;
  capabilities: string[];
  config?: Record<string, string>;
  secretRefs: Record<string, string>;
  createdAt: string;
  updatedAt: string;
};
type FixtureConfig = {
  matrix: Record<string, unknown>;
  openclawProfile?: { plugins?: { allow: string[] }; agents: FixtureAgent[] } | undefined;
  sovereignTools?: { instances: FixtureTool[] } | undefined;
  operatorNote?: string;
};
type FixtureOverrides = Pick<FixtureConfig, "openclawProfile" | "sovereignTools">;

const profileOf = (config: FixtureConfig): NonNullable<FixtureConfig["openclawProfile"]> => {
  if (config.openclawProfile === undefined) {
    throw new Error("fixture config has no openclawProfile");
  }
  return config.openclawProfile;
};
const toolsOf = (config: FixtureConfig): FixtureTool[] => config.sovereignTools?.instances ?? [];
const reviewOf = (config: FixtureConfig): FixtureTool => {
  const review = toolsOf(config).find((tool) => tool.id === "review");
  if (review === undefined) {
    throw new Error("fixture config has no review tool");
  }
  return review;
};

const toolTemplate = (id: string, extra: Record<string, unknown> = {}) => ({
  kind: "sovereign-tool-template",
  id,
  version: "1.0.0",
  description: `${id} template`,
  capabilities: ["x.read"],
  ...extra,
});

const botManifest = (id: string): string =>
  `${JSON.stringify(
    {
      kind: "sovereign-bot-package",
      manifestVersion: 2,
      id,
      version: "1.0.0",
      displayName: "Review Bot",
      description: "Binding re-derivation fixture bot",
      matrixIdentity: { mode: "dedicated-account", localpartPrefix: id },
      configDefaults: {},
      toolTemplates: [
        toolTemplate("review-tool", {
          openclawPlugins: ["lobster"],
          openclawScanAgent: { toolNames: ["llm-task"] },
        }),
        toolTemplate("plain-tool"),
      ],
      toolInstances: [],
      hostResources: [],
      agentTemplate: {
        id,
        version: "1.0.0",
        description: "Binding re-derivation fixture template",
        matrix: { localpartPrefix: id },
      },
    },
    null,
    2,
  )}\n`;

const readyOutcome: GatewayReadinessOutcome = {
  unitStarted: true,
  ready: true,
  waitedMs: 10,
  deadlineMs: 300_000,
  unit: "sovereign-openclaw-gateway.service",
};

describe("reconcileAgentWorkspaces re-derives node-owned bindings", () => {
  let tempRoot: string;
  let paths: SovereignPaths;
  let catalogDir: string;
  let workspaceDir: string;

  const baseConfig = (overrides: FixtureOverrides = {}): FixtureConfig => ({
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
      plugins: { allow: ["matrix"] },
      agents: [
        {
          id: BOT_ID,
          botId: BOT_ID,
          workspace: workspaceDir,
          toolInstanceIds: ["review", "plain"],
        },
      ],
    },
    sovereignTools: {
      instances: [
        {
          id: "review",
          templateRef: REVIEW_TOOL,
          capabilities: ["x.read"],
          config: { agentId: BOT_ID },
          secretRefs: {},
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "plain",
          templateRef: PLAIN_TOOL,
          capabilities: ["x.read"],
          config: { agentId: BOT_ID },
          secretRefs: {},
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    },
    operatorNote: "kept as written",
    ...overrides,
  });

  const writeConfig = async (config: FixtureConfig): Promise<void> => {
    await writeFile(paths.configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  };

  const readConfig = async (): Promise<FixtureConfig> =>
    JSON.parse(await readFile(paths.configPath, "utf8"));

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "binding-rederive-test-"));
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
    workspaceDir = join(paths.stateDir, BOT_ID, "workspace");
    await mkdir(join(catalogDir, "bots", BOT_ID), { recursive: true });
    await mkdir(join(tempRoot, "etc"), { recursive: true });
    await writeFile(join(catalogDir, "bots", BOT_ID, "sovereign-bot.json"), botManifest(BOT_ID));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempRoot, { recursive: true, force: true });
  });

  const makeService = () => {
    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {} as unknown as OpenClawBootstrapper,
      openclawGatewayServiceManager: {
        install: async () => {},
        start: async () => {},
        restart: async () => {},
      },
      preflightChecker: {} as unknown as HostPreflightChecker,
      imapTester: {} as unknown as ImapTester,
      matrixProvisioner: {} as unknown as BundledMatrixProvisioner,
      botCatalog: new FilesystemBotCatalog(catalogDir),
      execRunner: {
        run: async ({ command, args }) => ({
          command: [command, ...(args ?? [])].join(" "),
          exitCode: 0,
          stdout: "",
          stderr: "",
        }),
      },
    });
    const internals = service as unknown as Internals;
    const configWrites = vi.spyOn(internals, "writeInstallerJsonFile");
    const rendered: RuntimeConfig[] = [];
    vi.spyOn(internals, "writeOpenClawRuntimeArtifacts").mockImplementation(async (config) => {
      rendered.push(structuredClone(config));
    });
    vi.spyOn(internals, "setManagedOpenClawEnv").mockImplementation(() => {});
    vi.spyOn(internals, "refreshGatewayAfterRuntimeConfig").mockResolvedValue(readyOutcome);
    const writesOfConfig = () =>
      configWrites.mock.calls.filter(([path]) => path === paths.configPath).length;
    return { service, writesOfConfig, rendered };
  };

  it("adds the scan agent id and the required plugins to a node installed by an older release", async () => {
    await writeConfig(baseConfig());
    const { service, writesOfConfig } = makeService();

    await service.reconcileAgentWorkspaces();

    const config = await readConfig();
    const [review, plain] = toolsOf(config);
    expect(review?.config).toEqual({ agentId: BOT_ID, scanAgentId: `${BOT_ID}-scan` });
    expect(plain?.config).toEqual({ agentId: BOT_ID });
    expect(profileOf(config).plugins?.allow).toEqual(["lobster", "matrix"]);
    expect(config.operatorNote).toBe("kept as written");
    expect(profileOf(config).agents).toEqual(profileOf(baseConfig()).agents);
    expect(writesOfConfig()).toBe(1);
  });

  it("writes nothing on a second reconcile", async () => {
    await writeConfig(baseConfig());
    await makeService().service.reconcileAgentWorkspaces();
    const afterFirst = await readFile(paths.configPath, "utf8");

    const { service, writesOfConfig } = makeService();
    await service.reconcileAgentWorkspaces();

    expect(writesOfConfig()).toBe(0);
    expect(await readFile(paths.configPath, "utf8")).toBe(afterFirst);
  });

  it("leaves a node whose bindings are already current untouched, whatever the allow-list order", async () => {
    const config = baseConfig();
    profileOf(config).plugins = { allow: ["lobster", "matrix"] };
    reviewOf(config).config = { agentId: BOT_ID, scanAgentId: `${BOT_ID}-scan` };
    await writeConfig(config);
    const before = await readFile(paths.configPath, "utf8");
    const { service, writesOfConfig } = makeService();

    await service.reconcileAgentWorkspaces();

    expect(writesOfConfig()).toBe(0);
    expect(await readFile(paths.configPath, "utf8")).toBe(before);
  });

  it("corrects a scan agent id that points at another agent and drops a stale plugin", async () => {
    const config = baseConfig();
    profileOf(config).plugins = { allow: ["matrix", "lobster", "gone"] };
    reviewOf(config).config = { agentId: BOT_ID, scanAgentId: BOT_ID };
    await writeConfig(config);

    await makeService().service.reconcileAgentWorkspaces();

    const after = await readConfig();
    expect(reviewOf(after).config?.scanAgentId).toBe(`${BOT_ID}-scan`);
    expect(profileOf(after).plugins?.allow).toEqual(["lobster", "matrix"]);
  });

  it("keeps the allow list when a bot agent's package is missing from the catalog", async () => {
    const config = baseConfig();
    const profile = profileOf(config);
    profile.agents.push({ id: "gone-bot", botId: "gone-bot", workspace: join(tempRoot, "gone") });
    await writeConfig(config);

    await makeService().service.reconcileAgentWorkspaces();

    const after = await readConfig();
    expect(profileOf(after).plugins?.allow).toEqual(["matrix"]);
    expect(reviewOf(after).config?.scanAgentId).toBe(`${BOT_ID}-scan`);
  });

  it("matches a bot agent by its template ref and ignores operator agents", async () => {
    const config = baseConfig();
    const profile = profileOf(config);
    profile.agents = [
      {
        id: "second-review",
        templateRef: `${BOT_ID}@1.0.0`,
        workspace: join(tempRoot, "second"),
        toolInstanceIds: ["review"],
      },
      { id: "operator-agent", workspace: join(tempRoot, "operator"), toolInstanceIds: ["plain"] },
    ];
    await writeConfig(config);

    await makeService().service.reconcileAgentWorkspaces();

    const after = await readConfig();
    expect(reviewOf(after).config?.scanAgentId).toBe("second-review-scan");
    expect(toolsOf(after).find((tool) => tool.id === "plain")?.config).toEqual({ agentId: BOT_ID });
    expect(profileOf(after).plugins?.allow).toEqual(["lobster", "matrix"]);
  });

  it("re-derives only the allow list for a bot agent that binds no tools", async () => {
    const config = baseConfig();
    delete profileOf(config).agents[0]?.toolInstanceIds;
    await writeConfig(config);

    await makeService().service.reconcileAgentWorkspaces();

    const after = await readConfig();
    expect(reviewOf(after).config).toEqual({ agentId: BOT_ID });
    expect(profileOf(after).plugins?.allow).toEqual(["lobster", "matrix"]);
  });

  it("writes the allow list into a config that has no plugin or tool section yet", async () => {
    const config = baseConfig({ sovereignTools: undefined });
    delete profileOf(config).plugins;
    await writeConfig(config);

    await makeService().service.reconcileAgentWorkspaces();

    const after = await readConfig();
    expect(profileOf(after).plugins).toEqual({ allow: ["lobster", "matrix"] });
    expect(after.sovereignTools).toBeUndefined();
  });

  it("leaves a node without bot agents and without a plugin profile untouched", async () => {
    await writeConfig(baseConfig({ openclawProfile: undefined, sovereignTools: undefined }));
    const before = await readFile(paths.configPath, "utf8");
    const { service, writesOfConfig } = makeService();

    await service.reconcileAgentWorkspaces();

    expect(writesOfConfig()).toBe(0);
    expect(await readFile(paths.configPath, "utf8")).toBe(before);
  });

  it("sets the scan agent id on a tool instance that was written without a config", async () => {
    const config = baseConfig();
    delete reviewOf(config).config;
    await writeConfig(config);

    await makeService().service.reconcileAgentWorkspaces();

    expect(reviewOf(await readConfig()).config).toEqual({
      scanAgentId: `${BOT_ID}-scan`,
    });
  });

  it("renders the repaired bindings when the runtime is refreshed", async () => {
    await writeConfig(baseConfig());
    const { service, rendered } = makeService();

    const result = await service.reconcileAgentWorkspaces({ refreshRuntime: true });

    expect(result.runtimeRefresh).toMatchObject({ rendered: true, ready: true });
    expect(rendered).toHaveLength(1);
    const [config] = rendered;
    expect(config?.sovereignTools.instances.find((tool) => tool.id === "review")?.config).toEqual({
      agentId: BOT_ID,
      scanAgentId: `${BOT_ID}-scan`,
    });
    expect(config?.openclawProfile.plugins.allow).toEqual(["lobster", "matrix"]);
  });
});
