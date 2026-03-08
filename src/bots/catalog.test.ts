import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

import { FilesystemBotCatalog } from "./catalog.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
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
});
