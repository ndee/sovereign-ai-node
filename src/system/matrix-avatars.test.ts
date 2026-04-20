import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { BotCatalog, LoadedBotPackage } from "../bots/catalog.js";
import { FilesystemMatrixAvatarResolver } from "./matrix-avatars.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

const createRepoWith = async (
  files: Record<string, Buffer>,
): Promise<{ repoDir: string; catalog: BotCatalog }> => {
  const repoDir = await mkdtemp(join(tmpdir(), "matrix-avatars-test-"));
  tempRoots.push(repoDir);
  for (const [relPath, data] of Object.entries(files)) {
    const full = join(repoDir, relPath);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, data);
  }
  const fakePackage: LoadedBotPackage = {
    manifest: {
      id: "test-bot",
      version: "0.0.0",
      description: "",
      defaultInstall: false,
      capabilities: [],
      matrixIdentity: { mode: "per-agent", localpartPrefix: "test-bot" },
    } as unknown as LoadedBotPackage["manifest"],
    template: {} as LoadedBotPackage["template"],
    toolTemplates: [],
    templateRef: "test-bot@0.0.0",
    keyId: "repo:test",
    manifestSha256: "0",
    rootDir: join(repoDir, "bots", "test-bot"),
  };
  const catalog: BotCatalog = {
    listPackages: async () => [fakePackage],
    getPackage: async (id) => {
      if (id !== "test-bot") {
        throw { code: "BOT_PACKAGE_NOT_FOUND", message: "not found", retryable: false };
      }
      return fakePackage;
    },
    getDefaultSelectedIds: async () => [],
    findPackageByTemplateRef: async (ref) => (ref === fakePackage.templateRef ? fakePackage : null),
    getRepoDir: async () => repoDir,
  };
  return { repoDir, catalog };
};

const sha = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

describe("FilesystemMatrixAvatarResolver", () => {
  it("resolves the alert-room avatar when present", async () => {
    const data = Buffer.from("alert-room-png");
    const { catalog, repoDir } = await createRepoWith({ "alert-room.png": data });
    const resolver = new FilesystemMatrixAvatarResolver(catalog);
    const asset = await resolver.resolveAlertRoomAvatar();
    expect(asset?.path).toBe(join(repoDir, "alert-room.png"));
    expect(asset?.sha256).toBe(sha(data));
    expect(asset?.contentType).toBe("image/png");
    expect(asset?.fileName).toBe("alert-room.png");
    expect(Buffer.from(asset?.data ?? new Uint8Array()).equals(data)).toBe(true);
  });

  it("returns null when the alert-room avatar is missing", async () => {
    const { catalog } = await createRepoWith({});
    const resolver = new FilesystemMatrixAvatarResolver(catalog);
    expect(await resolver.resolveAlertRoomAvatar()).toBeNull();
  });

  it("resolves the service-bot avatar when present", async () => {
    const data = Buffer.from("service-bot-png");
    const { catalog } = await createRepoWith({ "service-bot.png": data });
    const resolver = new FilesystemMatrixAvatarResolver(catalog);
    const asset = await resolver.resolveServiceBotAvatar();
    expect(asset?.sha256).toBe(sha(data));
  });

  it("returns null when the service-bot avatar is missing", async () => {
    const { catalog } = await createRepoWith({});
    const resolver = new FilesystemMatrixAvatarResolver(catalog);
    expect(await resolver.resolveServiceBotAvatar()).toBeNull();
  });

  it("resolves a per-bot avatar via getPackage", async () => {
    const data = Buffer.from("bot-avatar-png");
    const { catalog } = await createRepoWith({ "bots/test-bot/avatar.png": data });
    const resolver = new FilesystemMatrixAvatarResolver(catalog);
    const asset = await resolver.resolveBotAvatar("test-bot");
    expect(asset?.sha256).toBe(sha(data));
    expect(asset?.fileName).toBe("avatar.png");
  });

  it("falls back to findPackageByTemplateRef when getPackage throws", async () => {
    const data = Buffer.from("bot-avatar-png");
    const { catalog } = await createRepoWith({ "bots/test-bot/avatar.png": data });
    const resolver = new FilesystemMatrixAvatarResolver(catalog);
    const asset = await resolver.resolveBotAvatar("test-bot@0.0.0");
    expect(asset?.sha256).toBe(sha(data));
  });

  it("returns null for a per-bot avatar when the bot package has no avatar.png", async () => {
    const { catalog } = await createRepoWith({});
    const resolver = new FilesystemMatrixAvatarResolver(catalog);
    expect(await resolver.resolveBotAvatar("test-bot")).toBeNull();
  });

  it("returns null for an unknown bot id", async () => {
    const { catalog } = await createRepoWith({});
    const resolver = new FilesystemMatrixAvatarResolver(catalog);
    expect(await resolver.resolveBotAvatar("ghost")).toBeNull();
  });

  it("returns null for an empty bot id", async () => {
    const { catalog } = await createRepoWith({});
    const resolver = new FilesystemMatrixAvatarResolver(catalog);
    expect(await resolver.resolveBotAvatar("   ")).toBeNull();
  });
});
