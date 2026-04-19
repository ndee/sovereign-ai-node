import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_BOT_REPO_URL, FilesystemBotCatalog } from "./catalog.js";

const tempRoots: string[] = [];
const priorRepoDir = process.env.SOVEREIGN_BOTS_REPO_DIR;
const priorRepoUrl = process.env.SOVEREIGN_BOTS_REPO_URL;
const priorRepoRef = process.env.SOVEREIGN_BOTS_REPO_REF;

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })),
  );
  if (priorRepoDir === undefined) {
    delete process.env.SOVEREIGN_BOTS_REPO_DIR;
  } else {
    process.env.SOVEREIGN_BOTS_REPO_DIR = priorRepoDir;
  }
  if (priorRepoUrl === undefined) {
    delete process.env.SOVEREIGN_BOTS_REPO_URL;
  } else {
    process.env.SOVEREIGN_BOTS_REPO_URL = priorRepoUrl;
  }
  if (priorRepoRef === undefined) {
    delete process.env.SOVEREIGN_BOTS_REPO_REF;
  } else {
    process.env.SOVEREIGN_BOTS_REPO_REF = priorRepoRef;
  }
});

const writeBotPackage = async (
  rootDir: string,
  input: {
    id: string;
    displayName: string;
    defaultInstall: boolean;
    agentTemplateModel?: string;
    matrixRouting?: {
      defaultAccount?: boolean;
      dm?: {
        enabled?: boolean;
      };
      alertRoom?: {
        autoReply?: boolean;
        requireMention?: boolean;
      };
    };
  },
): Promise<void> => {
  const packageDir = join(rootDir, "bots", input.id);
  await mkdir(join(packageDir, "workspace"), { recursive: true });
  await writeFile(join(packageDir, "workspace", "README.md"), `# ${input.displayName}\n`, "utf8");
  await writeFile(join(packageDir, "workspace", "AGENTS.md"), `# ${input.id}\n`, "utf8");
  await writeFile(
    join(packageDir, "sovereign-bot.json"),
    JSON.stringify(
      {
        kind: "sovereign-bot-package",
        manifestVersion: 2,
        id: input.id,
        version: "2.0.0",
        displayName: input.displayName,
        description: `${input.displayName} bot`,
        defaultInstall: input.defaultInstall,
        matrixIdentity: {
          mode: "service-account",
          localpartPrefix: input.id,
        },
        ...(input.matrixRouting === undefined ? {} : { matrixRouting: input.matrixRouting }),
        configDefaults: {},
        toolInstances: [],
        hostResources: [
          {
            id: "workspace-readme",
            kind: "managedFile",
            spec: {
              path: {
                join: [{ from: "agent.workspace" }, "/README.md"],
              },
              source: "workspace/README.md",
              writePolicy: "always",
            },
          },
          {
            id: "workspace-agents",
            kind: "managedFile",
            spec: {
              path: {
                join: [{ from: "agent.workspace" }, "/AGENTS.md"],
              },
              source: "workspace/AGENTS.md",
              writePolicy: "always",
            },
          },
        ],
        agentTemplate: {
          id: input.id,
          version: "2.0.0",
          description: `${input.displayName} template`,
          ...(input.agentTemplateModel === undefined ? {} : { model: input.agentTemplateModel }),
          matrix: {
            localpartPrefix: input.id,
          },
          requiredToolTemplates: [],
          optionalToolTemplates: [],
        },
      },
      null,
      2,
    ),
    "utf8",
  );
};

const commitGitRepo = async (repoDir: string): Promise<void> => {
  await execa("git", ["init", "--initial-branch", "main", repoDir]);
  await execa("git", ["-C", repoDir, "config", "user.name", "Sovereign Test"]);
  await execa("git", ["-C", repoDir, "config", "user.email", "test@example.org"]);
  await execa("git", ["-C", repoDir, "add", "."]);
  await execa("git", ["-C", repoDir, "commit", "-m", "Initial bots"]);
};

describe("FilesystemBotCatalog", () => {
  it("loads bot packages from an explicit repository directory", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-bot-catalog-test-"));
    tempRoots.push(tempRoot);
    await writeBotPackage(tempRoot, {
      id: "mail-sentinel",
      displayName: "Mail Sentinel",
      defaultInstall: true,
      agentTemplateModel: "qwen/qwen-2.5-32b-instruct",
    });
    await writeBotPackage(tempRoot, {
      id: "node-operator",
      displayName: "Node Operator",
      defaultInstall: false,
    });

    const catalog = new FilesystemBotCatalog(tempRoot);
    const packages = await catalog.listPackages();

    expect(packages.map((entry) => entry.manifest.id)).toEqual(["mail-sentinel", "node-operator"]);
    expect(packages[0]?.templateRef).toBe("mail-sentinel@2.0.0");
    expect(packages[0]?.manifest.matrixRouting).toBeUndefined();
    expect(packages[0]?.template.model).toBe("qwen/qwen-2.5-32b-instruct");
    expect(packages[0]?.manifest.hostResources).toHaveLength(2);
  });

  it("returns default-selected IDs and resolves packages by template ref", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-bot-catalog-test-"));
    tempRoots.push(tempRoot);
    await writeBotPackage(tempRoot, {
      id: "mail-sentinel",
      displayName: "Mail Sentinel",
      defaultInstall: true,
    });
    await writeBotPackage(tempRoot, {
      id: "node-operator",
      displayName: "Node Operator",
      defaultInstall: false,
    });

    const catalog = new FilesystemBotCatalog(tempRoot);

    await expect(catalog.getDefaultSelectedIds()).resolves.toEqual(["mail-sentinel"]);
    await expect(catalog.findPackageByTemplateRef("node-operator@2.0.0")).resolves.toMatchObject({
      manifest: {
        id: "node-operator",
      },
    });
  });

  it("loads bot packages from a git repository URL", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-bot-catalog-test-"));
    tempRoots.push(tempRoot);
    await writeBotPackage(tempRoot, {
      id: "bitcoin-skill-match",
      displayName: "Bitcoin Skill Match",
      defaultInstall: false,
      matrixRouting: {
        defaultAccount: true,
        dm: {
          enabled: true,
        },
        alertRoom: {
          autoReply: true,
          requireMention: false,
        },
      },
    });
    await writeBotPackage(tempRoot, {
      id: "mail-sentinel",
      displayName: "Mail Sentinel",
      defaultInstall: true,
    });
    await commitGitRepo(tempRoot);

    const catalog = new FilesystemBotCatalog({
      repoUrl: tempRoot,
      repoRef: "main",
    });

    const packages = await catalog.listPackages();

    expect(packages.map((entry) => entry.manifest.id)).toEqual([
      "bitcoin-skill-match",
      "mail-sentinel",
    ]);
    expect(packages[0]?.manifest.matrixRouting).toEqual({
      defaultAccount: true,
      dm: {
        enabled: true,
      },
      alertRoom: {
        autoReply: true,
        requireMention: false,
      },
    });
    await expect(catalog.getDefaultSelectedIds()).resolves.toEqual(["mail-sentinel"]);
  });

  it("defaults to the canonical sovereign-ai-bots GitHub URL when no source is configured", () => {
    delete process.env.SOVEREIGN_BOTS_REPO_DIR;
    delete process.env.SOVEREIGN_BOTS_REPO_URL;
    delete process.env.SOVEREIGN_BOTS_REPO_REF;

    const catalog = new FilesystemBotCatalog() as unknown as {
      resolveConfiguredSource: () => { repoUrl?: string; repoRef?: string; repoDir?: string };
    };

    expect(catalog.resolveConfiguredSource()).toEqual({
      repoUrl: DEFAULT_BOT_REPO_URL,
    });
  });
});
