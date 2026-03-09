import { DEFAULT_BOT_REPO_URL } from "../bots/catalog.js";

export type BotCatalogSourceOptions = {
  botsRepoUrl?: string;
  botsRepoRef?: string;
  botsSourceDir?: string;
};

const BOT_REPO_DIR_ENV = "SOVEREIGN_BOTS_REPO_DIR";
const BOT_REPO_URL_ENV = "SOVEREIGN_BOTS_REPO_URL";
const BOT_REPO_REF_ENV = "SOVEREIGN_BOTS_REPO_REF";

export const applyBotCatalogSourceOptions = (options: BotCatalogSourceOptions): void => {
  const botsRepoUrl = trimString(options.botsRepoUrl);
  const botsRepoRef = trimString(options.botsRepoRef);
  const botsSourceDir = trimString(options.botsSourceDir);

  if (botsRepoUrl !== undefined && botsSourceDir !== undefined) {
    throw new Error("Use either --bots-repo-url or --bots-source-dir, not both.");
  }
  if (botsRepoRef !== undefined && botsSourceDir !== undefined) {
    throw new Error("--bots-repo-ref cannot be combined with --bots-source-dir.");
  }

  if (botsSourceDir !== undefined) {
    process.env[BOT_REPO_DIR_ENV] = botsSourceDir;
    delete process.env[BOT_REPO_URL_ENV];
    delete process.env[BOT_REPO_REF_ENV];
    return;
  }

  if (botsRepoUrl !== undefined || botsRepoRef !== undefined) {
    process.env[BOT_REPO_URL_ENV] = botsRepoUrl ?? DEFAULT_BOT_REPO_URL;
    delete process.env[BOT_REPO_DIR_ENV];
    if (botsRepoRef === undefined) {
      delete process.env[BOT_REPO_REF_ENV];
    } else {
      process.env[BOT_REPO_REF_ENV] = botsRepoRef;
    }
  }
};

const trimString = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};
