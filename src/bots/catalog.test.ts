import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
  await Promise.all(tempRoots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
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

const writeBotPackage = async (rootDir: string, input: {
  id: string;
  displayName: string;
  defaultInstall: boolean;
}): Promise<void> => {
  const packageDir = join(rootDir, "bots", input.id);
  await mkdir(join(packageDir, "workspace"), { recursive: true });
  await writeFile(join(packageDir, "workspace", "README.md"), `# ${input.displayName}\n`, "utf8");
  await writeFile(join(packageDir, "workspace", "AGENTS.md"), `# ${input.id}\n`, "utf8");
  await writeFile(
    join(packageDir, "sovereign-bot.json"),
    JSON.stringify({
      kind: "sovereign-bot-package",
      id: input.id,
      version: "1.0.0",
      displayName: input.displayName,
      description: `${input.displayName} bot`,
      defaultInstall: input.defaultInstall,
      matrixIdentity: {
        mode: "service-account",
        localpartPrefix: input.id,
      },
      configDefaults: {},
      toolInstances: [],
      openclaw: {},
      agentTemplate: {
        id: input.id,
        version: "1.0.0",
        description: `${input.displayName} template`,
        matrix: {
          localpartPrefix: input.id,
        },
        requiredToolTemplates: [],
        optionalToolTemplates: [],
        workspaceFiles: [
          {
            path: "README.md",
            source: "workspace/README.md",
          },
          {
            path: "AGENTS.md",
            source: "workspace/AGENTS.md",
          },
        ],
      },
    }, null, 2),
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
    });
    await writeBotPackage(tempRoot, {
      id: "node-operator",
      displayName: "Node Operator",
      defaultInstall: false,
    });

    const catalog = new FilesystemBotCatalog(tempRoot);
    const packages = await catalog.listPackages();

    expect(packages.map((entry) => entry.manifest.id)).toEqual(["mail-sentinel", "node-operator"]);
    expect(packages[0]?.templateRef).toBe("mail-sentinel@1.0.0");
    expect(packages[0]?.template.workspaceFiles).toEqual([
      {
        path: "README.md",
        content: "# Mail Sentinel\n",
      },
      {
        path: "AGENTS.md",
        content: "# mail-sentinel\n",
      },
    ]);
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
    await expect(catalog.findPackageByTemplateRef("node-operator@1.0.0")).resolves.toMatchObject({
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
