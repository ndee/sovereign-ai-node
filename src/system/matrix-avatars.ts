import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { BotCatalog } from "../bots/catalog.js";

const ALERT_ROOM_AVATAR_FILE = "alert-room.png";
const SERVICE_BOT_AVATAR_FILE = "service-bot.png";
const BOT_AVATAR_FILE = "avatar.png";
const BOT_AVATAR_CONTENT_TYPE = "image/png";

export type MatrixAvatarAsset = {
  path: string;
  data: Uint8Array;
  sha256: string;
  contentType: string;
  fileName: string;
};

export interface MatrixAvatarResolver {
  resolveAlertRoomAvatar(): Promise<MatrixAvatarAsset | null>;
  resolveServiceBotAvatar(): Promise<MatrixAvatarAsset | null>;
  resolveBotAvatar(botPackageId: string): Promise<MatrixAvatarAsset | null>;
}

export class FilesystemMatrixAvatarResolver implements MatrixAvatarResolver {
  constructor(private readonly catalog: BotCatalog) {}

  async resolveAlertRoomAvatar(): Promise<MatrixAvatarAsset | null> {
    const repoDir = await this.catalog.getRepoDir();
    return await readAvatarIfPresent(join(repoDir, ALERT_ROOM_AVATAR_FILE), ALERT_ROOM_AVATAR_FILE);
  }

  async resolveServiceBotAvatar(): Promise<MatrixAvatarAsset | null> {
    const repoDir = await this.catalog.getRepoDir();
    return await readAvatarIfPresent(
      join(repoDir, SERVICE_BOT_AVATAR_FILE),
      SERVICE_BOT_AVATAR_FILE,
    );
  }

  async resolveBotAvatar(botPackageId: string): Promise<MatrixAvatarAsset | null> {
    const trimmed = botPackageId.trim();
    if (trimmed.length === 0) {
      return null;
    }
    let rootDir: string | null = null;
    try {
      rootDir = (await this.catalog.getPackage(trimmed)).rootDir;
    } catch {
      const pkg = await this.catalog.findPackageByTemplateRef(trimmed);
      rootDir = pkg?.rootDir ?? null;
    }
    if (rootDir === null) {
      return null;
    }
    return await readAvatarIfPresent(join(rootDir, BOT_AVATAR_FILE), BOT_AVATAR_FILE);
  }
}

const readAvatarIfPresent = async (
  path: string,
  fileName: string,
): Promise<MatrixAvatarAsset | null> => {
  try {
    await access(path, fsConstants.R_OK);
  } catch {
    return null;
  }
  const data = await readFile(path);
  const sha256 = createHash("sha256").update(data).digest("hex");
  return {
    path,
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    sha256,
    contentType: BOT_AVATAR_CONTENT_TYPE,
    fileName,
  };
};
