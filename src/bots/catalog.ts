import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { formatTemplateRef, type AgentTemplateManifest } from "../templates/catalog.js";

export type BotConfigValue = string | number | boolean;
export type BotConfigRecord = Record<string, BotConfigValue>;

const BOT_PACKAGE_KEY_ID = "repo:sovereign-ai-bots";
const BOT_MANIFEST_FILE = "sovereign-bot.json";

const botConfigValueSchema = z.union([z.string(), z.number().finite(), z.boolean()]);

const toolValueBindingSchema = z.object({
  from: z.string().min(1),
  stringify: z.boolean().optional(),
});

const enabledWhenSchema = z.object({
  path: z.string().min(1),
  equals: botConfigValueSchema.optional(),
});

const toolInstanceSchema = z.object({
  id: z.string().min(1),
  templateRef: z.string().min(1),
  enabledWhen: enabledWhenSchema.optional(),
  config: z.record(z.string(), toolValueBindingSchema).default({}),
  secretRefs: z.record(z.string(), toolValueBindingSchema).default({}),
});

const botCronSchema = z.object({
  id: z.string().min(1),
  everyConfigKey: z.string().min(1).optional(),
  defaultEvery: z.string().min(1).optional(),
  session: z.enum(["isolated"]).optional(),
  message: z.string().min(1),
});

const workspaceFileSchema = z.object({
  path: z.string().min(1),
  source: z.string().min(1),
});

const agentTemplateSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  matrix: z.object({
    localpartPrefix: z.string().min(1),
  }),
  requiredToolTemplates: z.array(
    z.object({
      id: z.string().min(1),
      version: z.string().min(1),
    }),
  ).default([]),
  optionalToolTemplates: z.array(
    z.object({
      id: z.string().min(1),
      version: z.string().min(1),
    }),
  ).default([]),
  workspaceFiles: z.array(workspaceFileSchema).min(1),
});

const botPackageSchema = z.object({
  kind: z.literal("sovereign-bot-package"),
  id: z.string().min(1),
  version: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().min(1),
  defaultInstall: z.boolean().optional(),
  helloMessage: z.string().min(1).optional(),
  matrixIdentity: z.object({
    mode: z.enum(["service-account", "dedicated-account"]),
    localpartPrefix: z.string().min(1),
  }),
  configDefaults: z.record(z.string(), botConfigValueSchema).default({}),
  toolInstances: z.array(toolInstanceSchema).default([]),
  openclaw: z.object({
    cron: botCronSchema.optional(),
  }).default({}),
  agentTemplate: agentTemplateSchema,
});

export type SovereignBotPackageManifest = z.infer<typeof botPackageSchema>;

export type LoadedBotPackage = {
  manifest: SovereignBotPackageManifest;
  template: AgentTemplateManifest;
  templateRef: string;
  keyId: string;
  manifestSha256: string;
  rootDir: string;
};

export interface BotCatalog {
  listPackages(): Promise<LoadedBotPackage[]>;
  getPackage(id: string): Promise<LoadedBotPackage>;
  getDefaultSelectedIds(): Promise<string[]>;
  findPackageByTemplateRef(ref: string): Promise<LoadedBotPackage | null>;
}

export class FilesystemBotCatalog implements BotCatalog {
  private packageCache: Promise<LoadedBotPackage[]> | null = null;

  constructor(private readonly repoDir?: string) {}

  async listPackages(): Promise<LoadedBotPackage[]> {
    if (this.packageCache === null) {
      this.packageCache = this.loadPackages();
    }
    return await this.packageCache;
  }

  async getPackage(id: string): Promise<LoadedBotPackage> {
    const normalized = id.trim();
    const found = (await this.listPackages()).find((entry) => entry.manifest.id === normalized);
    if (found === undefined) {
      throw {
        code: "BOT_PACKAGE_NOT_FOUND",
        message: `Bot package '${normalized}' was not found in the configured bot repository`,
        retryable: false,
      };
    }
    return found;
  }

  async getDefaultSelectedIds(): Promise<string[]> {
    return (await this.listPackages())
      .filter((entry) => entry.manifest.defaultInstall === true)
      .map((entry) => entry.manifest.id)
      .sort((left, right) => left.localeCompare(right));
  }

  async findPackageByTemplateRef(ref: string): Promise<LoadedBotPackage | null> {
    const normalized = ref.trim();
    const found = (await this.listPackages()).find((entry) => entry.templateRef === normalized);
    return found ?? null;
  }

  private async loadPackages(): Promise<LoadedBotPackage[]> {
    const repoDir = await this.resolveRepoDir();
    const botsDir = join(repoDir, "bots");
    const dirEntries = await readdir(botsDir, { withFileTypes: true });
    const packages = await Promise.all(
      dirEntries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => await this.loadPackage(join(botsDir, entry.name))),
    );
    return packages.sort((left, right) =>
      `${left.manifest.id}:${left.manifest.version}`.localeCompare(
        `${right.manifest.id}:${right.manifest.version}`,
      ));
  }

  private async loadPackage(packageDir: string): Promise<LoadedBotPackage> {
    const manifestPath = join(packageDir, BOT_MANIFEST_FILE);
    const raw = await readFile(manifestPath, "utf8");
    const manifest = botPackageSchema.parse(JSON.parse(raw) as unknown);
    const workspaceFiles = await Promise.all(
      manifest.agentTemplate.workspaceFiles.map(
        async (
          file: SovereignBotPackageManifest["agentTemplate"]["workspaceFiles"][number],
        ) => ({
          path: file.path,
          content: await readFile(join(packageDir, file.source), "utf8"),
        }),
      ),
    );
    const template: AgentTemplateManifest = {
      kind: "sovereign-agent-template",
      id: manifest.agentTemplate.id,
      version: manifest.agentTemplate.version,
      description: manifest.agentTemplate.description,
      matrix: {
        localpartPrefix: manifest.agentTemplate.matrix.localpartPrefix,
      },
      requiredToolTemplates: manifest.agentTemplate.requiredToolTemplates.map((
        entry: SovereignBotPackageManifest["agentTemplate"]["requiredToolTemplates"][number],
      ) => ({
        id: entry.id,
        version: entry.version,
      })),
      optionalToolTemplates: manifest.agentTemplate.optionalToolTemplates.map((
        entry: SovereignBotPackageManifest["agentTemplate"]["optionalToolTemplates"][number],
      ) => ({
        id: entry.id,
        version: entry.version,
      })),
      workspaceFiles,
      signature: {
        algorithm: "ed25519",
        keyId: BOT_PACKAGE_KEY_ID,
        value: "filesystem-trust",
      },
    };
    const manifestSha256 = createHash("sha256")
      .update(stableSerialize({
        manifest,
        template,
      }))
      .digest("hex");

    return {
      manifest,
      template,
      templateRef: formatTemplateRef(template.id, template.version),
      keyId: BOT_PACKAGE_KEY_ID,
      manifestSha256,
      rootDir: packageDir,
    };
  }

  private async resolveRepoDir(): Promise<string> {
    if (this.repoDir !== undefined && this.repoDir.trim().length > 0) {
      await ensureDirectory(join(this.repoDir, "bots"));
      return this.repoDir;
    }
    const envRepo = process.env.SOVEREIGN_BOTS_REPO_DIR;
    if (envRepo !== undefined && envRepo.trim().length > 0) {
      await ensureDirectory(join(envRepo, "bots"));
      return envRepo;
    }

    const currentRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const workspaceRoot = dirname(currentRepoRoot);
    const preferred = [
      join(workspaceRoot, "sovereign-ai-bots"),
    ];
    for (const candidate of preferred) {
      if (await pathExists(join(candidate, "bots"))) {
        return candidate;
      }
    }

    const siblings = await readdir(workspaceRoot, { withFileTypes: true });
    for (const sibling of siblings) {
      if (!sibling.isDirectory() || !sibling.name.startsWith("sovereign-ai-bots")) {
        continue;
      }
      const candidate = join(workspaceRoot, sibling.name);
      if (await pathExists(join(candidate, "bots"))) {
        return candidate;
      }
    }

    throw {
      code: "BOT_REPO_NOT_FOUND",
      message:
        "The Sovereign bot repository was not found. Set SOVEREIGN_BOTS_REPO_DIR or place sovereign-ai-bots beside sovereign-ai-node.",
      retryable: false,
      details: {
        workspaceRoot,
      },
    };
  }
}

const pathExists = async (value: string): Promise<boolean> => {
  try {
    await access(value);
    return true;
  } catch {
    return false;
  }
};

const ensureDirectory = async (value: string): Promise<void> => {
  await access(value);
};

const stableSerialize = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
