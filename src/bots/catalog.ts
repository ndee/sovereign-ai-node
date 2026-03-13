import { createHash } from "node:crypto";
import { access, mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";
import { z } from "zod";

import {
  type AgentTemplateManifest,
  formatTemplateRef,
  type ToolTemplateDefinition,
} from "../templates/catalog.js";

export type BotConfigValue = string | number | boolean;
export type BotConfigRecord = Record<string, BotConfigValue>;

const BOT_PACKAGE_KEY_ID = "repo:sovereign-ai-bots";
const BOT_MANIFEST_FILE = "sovereign-bot.json";
const BOT_REPO_DIR_ENV = "SOVEREIGN_BOTS_REPO_DIR";
const BOT_REPO_URL_ENV = "SOVEREIGN_BOTS_REPO_URL";
const BOT_REPO_REF_ENV = "SOVEREIGN_BOTS_REPO_REF";
export const DEFAULT_BOT_REPO_URL = "https://github.com/ndee/sovereign-ai-bots";

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
  announce: z.boolean().optional(),
  message: z.string().min(1),
});

const matrixRoutingSchema = z.object({
  defaultAccount: z.boolean().optional(),
  dm: z
    .object({
      enabled: z.boolean().optional(),
    })
    .optional(),
  alertRoom: z
    .object({
      autoReply: z.boolean().optional(),
      requireMention: z.boolean().optional(),
    })
    .optional(),
});

const workspaceFileSchema = z.object({
  path: z.string().min(1),
  source: z.string().min(1),
  mode: z.string().regex(/^[0-7]{3,4}$/).optional(),
});

const toolTemplateSchema = z.object({
  kind: z.literal("sovereign-tool-template"),
  id: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  capabilities: z.array(z.string().min(1)).min(1),
  requiredSecretRefs: z.array(z.string().min(1)).default([]),
  requiredConfigKeys: z.array(z.string().min(1)).default([]),
  allowedCommands: z.array(z.string().min(1)).default([]),
  openclawPlugins: z.array(z.string().min(1)).default([]),
  openclawToolNames: z.array(z.string().min(1)).default([]),
});

const agentTemplateSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  model: z.string().min(1).optional(),
  matrix: z.object({
    localpartPrefix: z.string().min(1),
  }),
  requiredToolTemplates: z
    .array(
      z.object({
        id: z.string().min(1),
        version: z.string().min(1),
      }),
    )
    .default([]),
  optionalToolTemplates: z
    .array(
      z.object({
        id: z.string().min(1),
        version: z.string().min(1),
      }),
    )
    .default([]),
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
  matrixRouting: matrixRoutingSchema.optional(),
  configDefaults: z.record(z.string(), botConfigValueSchema).default({}),
  toolTemplates: z.array(toolTemplateSchema).default([]),
  toolInstances: z.array(toolInstanceSchema).default([]),
  openclaw: z
    .object({
      cron: botCronSchema.optional(),
    })
    .default({}),
  agentTemplate: agentTemplateSchema,
});

export type SovereignBotPackageManifest = z.infer<typeof botPackageSchema>;

export type LoadedBotPackage = {
  manifest: SovereignBotPackageManifest;
  template: AgentTemplateManifest;
  toolTemplates: Array<{
    manifest: ToolTemplateDefinition;
    templateRef: string;
    keyId: string;
    manifestSha256: string;
  }>;
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

export type FilesystemBotCatalogOptions = {
  repoDir?: string;
  repoUrl?: string;
  repoRef?: string;
};

export class FilesystemBotCatalog implements BotCatalog {
  private packageCache: Promise<LoadedBotPackage[]> | null = null;
  private readonly repoDir: string | undefined;
  private readonly repoUrl: string | undefined;
  private readonly repoRef: string | undefined;

  constructor(options?: string | FilesystemBotCatalogOptions) {
    if (typeof options === "string") {
      this.repoDir = options;
      return;
    }
    this.repoDir = options?.repoDir;
    this.repoUrl = options?.repoUrl;
    this.repoRef = options?.repoRef;
  }

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
      ),
    );
  }

  private async loadPackage(packageDir: string): Promise<LoadedBotPackage> {
    const manifestPath = join(packageDir, BOT_MANIFEST_FILE);
    const raw = await readFile(manifestPath, "utf8");
    const manifest = botPackageSchema.parse(JSON.parse(raw) as unknown);
    const workspaceFiles = await Promise.all(
      manifest.agentTemplate.workspaceFiles.map(
        async (file: SovereignBotPackageManifest["agentTemplate"]["workspaceFiles"][number]) => ({
          path: file.path,
          content: await readFile(join(packageDir, file.source), "utf8"),
          ...(file.mode === undefined ? {} : { mode: file.mode }),
        }),
      ),
    );
    const template: AgentTemplateManifest = {
      kind: "sovereign-agent-template",
      id: manifest.agentTemplate.id,
      version: manifest.agentTemplate.version,
      description: manifest.agentTemplate.description,
      ...(manifest.agentTemplate.model === undefined ? {} : { model: manifest.agentTemplate.model }),
      matrix: {
        localpartPrefix: manifest.agentTemplate.matrix.localpartPrefix,
      },
      requiredToolTemplates: manifest.agentTemplate.requiredToolTemplates.map(
        (entry: SovereignBotPackageManifest["agentTemplate"]["requiredToolTemplates"][number]) => ({
          id: entry.id,
          version: entry.version,
        }),
      ),
      optionalToolTemplates: manifest.agentTemplate.optionalToolTemplates.map(
        (entry: SovereignBotPackageManifest["agentTemplate"]["optionalToolTemplates"][number]) => ({
          id: entry.id,
          version: entry.version,
        }),
      ),
      workspaceFiles,
      signature: {
        algorithm: "ed25519",
        keyId: BOT_PACKAGE_KEY_ID,
        value: "filesystem-trust",
      },
    };
    const manifestSha256 = createHash("sha256")
      .update(
        stableSerialize({
          manifest,
          template,
        }),
      )
      .digest("hex");
    const toolTemplates = manifest.toolTemplates.map((entry) => {
      const templateRef = formatTemplateRef(entry.id, entry.version);
      return {
        manifest: {
          kind: "sovereign-tool-template" as const,
          id: entry.id,
          version: entry.version,
          description: entry.description,
          capabilities: [...entry.capabilities],
          requiredSecretRefs: [...entry.requiredSecretRefs],
          requiredConfigKeys: [...entry.requiredConfigKeys],
          allowedCommands: [...entry.allowedCommands],
          openclawPlugins: [...entry.openclawPlugins],
          openclawToolNames: [...entry.openclawToolNames],
        },
        templateRef,
        keyId: BOT_PACKAGE_KEY_ID,
        manifestSha256: createHash("sha256").update(stableSerialize(entry)).digest("hex"),
      };
    });

    return {
      manifest,
      template,
      toolTemplates,
      templateRef: formatTemplateRef(template.id, template.version),
      keyId: BOT_PACKAGE_KEY_ID,
      manifestSha256,
      rootDir: packageDir,
    };
  }

  private async resolveRepoDir(): Promise<string> {
    const configuredSource = this.resolveConfiguredSource();
    if (configuredSource.repoDir !== undefined) {
      await ensureDirectory(join(configuredSource.repoDir, "bots"));
      return configuredSource.repoDir;
    }
    if (configuredSource.repoUrl !== undefined) {
      return await this.cloneRepo(configuredSource.repoUrl, configuredSource.repoRef);
    }

    const currentRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const workspaceRoot = dirname(currentRepoRoot);
    const preferred = Array.from(
      new Set([
        join(currentRepoRoot, "sovereign-ai-bots"),
        join(workspaceRoot, "sovereign-ai-bots"),
      ]),
    );
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
        "The Sovereign bot repository was not found. Set SOVEREIGN_BOTS_REPO_DIR, set SOVEREIGN_BOTS_REPO_URL, or place sovereign-ai-bots beside sovereign-ai-node.",
      retryable: false,
      details: {
        currentRepoRoot,
        workspaceRoot,
        searched: preferred,
      },
    };
  }

  private resolveConfiguredSource(): FilesystemBotCatalogOptions {
    const repoDir = trimString(this.repoDir) ?? trimString(process.env[BOT_REPO_DIR_ENV]);
    const repoUrl = trimString(this.repoUrl) ?? trimString(process.env[BOT_REPO_URL_ENV]);
    const repoRef = trimString(this.repoRef) ?? trimString(process.env[BOT_REPO_REF_ENV]);

    if (repoDir !== undefined && repoUrl !== undefined) {
      throw {
        code: "BOT_REPO_SOURCE_CONFLICT",
        message: `Configure either ${BOT_REPO_DIR_ENV} or ${BOT_REPO_URL_ENV}, but not both at the same time.`,
        retryable: false,
      };
    }

    if (repoRef !== undefined && repoDir !== undefined) {
      throw {
        code: "BOT_REPO_REF_REQUIRES_URL",
        message: `${BOT_REPO_REF_ENV} cannot be combined with ${BOT_REPO_DIR_ENV}.`,
        retryable: false,
      };
    }

    return {
      ...(repoDir === undefined ? {} : { repoDir }),
      ...(repoDir === undefined
        ? { repoUrl: repoUrl ?? DEFAULT_BOT_REPO_URL }
        : repoUrl === undefined
          ? {}
          : { repoUrl }),
      ...(repoRef === undefined ? {} : { repoRef }),
    };
  }

  private async cloneRepo(repoUrl: string, repoRef?: string): Promise<string> {
    const tempPrefix = join(tmpdir(), "sovereign-bot-catalog-");

    if (repoRef !== undefined) {
      const shallowDir = await mkdtemp(tempPrefix);
      const shallowClone = await execa(
        "git",
        ["clone", "--depth", "1", "--branch", repoRef, repoUrl, shallowDir],
        { reject: false },
      );
      if (shallowClone.exitCode === 0) {
        await ensureDirectory(join(shallowDir, "bots"));
        return shallowDir;
      }

      const fullDir = await mkdtemp(tempPrefix);
      const fullClone = await execa("git", ["clone", repoUrl, fullDir], {
        reject: false,
      });
      const checkout =
        fullClone.exitCode === 0
          ? await execa("git", ["-C", fullDir, "checkout", repoRef], {
              reject: false,
            })
          : null;

      if (fullClone.exitCode === 0 && checkout?.exitCode === 0) {
        await ensureDirectory(join(fullDir, "bots"));
        return fullDir;
      }

      throw {
        code: "BOT_REPO_CLONE_FAILED",
        message: `Failed to clone bot repository '${repoUrl}' at ref '${repoRef}'.`,
        retryable: false,
        details: {
          shallowClone: {
            exitCode: shallowClone.exitCode,
            stderr: shallowClone.stderr,
          },
          fullClone: {
            exitCode: fullClone.exitCode,
            stderr: fullClone.stderr,
          },
          checkout:
            checkout === null
              ? null
              : {
                  exitCode: checkout.exitCode,
                  stderr: checkout.stderr,
                },
        },
      };
    }

    const repoDir = await mkdtemp(tempPrefix);
    const clone = await execa("git", ["clone", "--depth", "1", repoUrl, repoDir], {
      reject: false,
    });
    if (clone.exitCode !== 0) {
      throw {
        code: "BOT_REPO_CLONE_FAILED",
        message: `Failed to clone bot repository '${repoUrl}'.`,
        retryable: false,
        details: {
          exitCode: clone.exitCode,
          stderr: clone.stderr,
        },
      };
    }
    await ensureDirectory(join(repoDir, "bots"));
    return repoDir;
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

const trimString = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

const stableSerialize = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};
