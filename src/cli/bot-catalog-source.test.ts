import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_BOT_REPO_URL } from "../bots/catalog.js";
import { applyBotCatalogSourceOptions } from "./bot-catalog-source.js";

const priorRepoDir = process.env.SOVEREIGN_BOTS_REPO_DIR;
const priorRepoUrl = process.env.SOVEREIGN_BOTS_REPO_URL;
const priorRepoRef = process.env.SOVEREIGN_BOTS_REPO_REF;

afterEach(() => {
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

describe("applyBotCatalogSourceOptions", () => {
  it("configures a local bots source directory and clears git source env", () => {
    process.env.SOVEREIGN_BOTS_REPO_URL = "https://github.com/example/sovereign-ai-bots";
    process.env.SOVEREIGN_BOTS_REPO_REF = "main";

    applyBotCatalogSourceOptions({
      botsSourceDir: "/tmp/sovereign-ai-bots",
    });

    expect(process.env.SOVEREIGN_BOTS_REPO_DIR).toBe("/tmp/sovereign-ai-bots");
    expect(process.env.SOVEREIGN_BOTS_REPO_URL).toBeUndefined();
    expect(process.env.SOVEREIGN_BOTS_REPO_REF).toBeUndefined();
  });

  it("configures a git repository source and clears a local source override", () => {
    process.env.SOVEREIGN_BOTS_REPO_DIR = "/tmp/old-bots";

    applyBotCatalogSourceOptions({
      botsRepoUrl: "https://github.com/example/sovereign-ai-bots",
      botsRepoRef: "feature/custom-bots",
    });

    expect(process.env.SOVEREIGN_BOTS_REPO_DIR).toBeUndefined();
    expect(process.env.SOVEREIGN_BOTS_REPO_URL).toBe("https://github.com/example/sovereign-ai-bots");
    expect(process.env.SOVEREIGN_BOTS_REPO_REF).toBe("feature/custom-bots");
  });

  it("uses the default bot repo URL when only a ref override is provided", () => {
    applyBotCatalogSourceOptions({
      botsRepoRef: "feature/test-bots",
    });

    expect(process.env.SOVEREIGN_BOTS_REPO_URL).toBe(DEFAULT_BOT_REPO_URL);
    expect(process.env.SOVEREIGN_BOTS_REPO_REF).toBe("feature/test-bots");
  });

  it("rejects combining a repo ref with a local source directory", () => {
    expect(() =>
      applyBotCatalogSourceOptions({
        botsRepoRef: "main",
        botsSourceDir: "/tmp/sovereign-ai-bots",
      })).toThrow("--bots-repo-ref cannot be combined with --bots-source-dir.");
  });
});
