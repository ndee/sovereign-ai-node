import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { defineConfig } from "tsup";

/**
 * Build identity baked into the sovereign-node bundles.
 *
 * Resolved at build time because the running process cannot derive it: an
 * installed node has no reliable `.git`, and the previous approach
 * (`process.env.npm_package_version`) is only populated when a process is
 * launched by npm — which a systemd unit never is. That silently pinned every
 * production node's reported version to a stale `"2.0.0"` fallback.
 *
 * Every value degrades to "unknown" rather than to a guess. A wrong version is
 * worse than an absent one: it sends support down the wrong path with
 * confidence, whereas "unknown" prompts the right question.
 *
 * Mirrors the mechanism already proven in sovereign-ai-bots.
 */
const UNKNOWN = "unknown";

const readPackageVersion = (): string => {
  try {
    const parsed: unknown = JSON.parse(readFileSync("package.json", "utf8"));
    if (typeof parsed === "object" && parsed !== null) {
      const version = (parsed as { version?: unknown }).version;
      if (typeof version === "string" && version.length > 0) {
        return version;
      }
    }
  } catch {
    // Fall through to UNKNOWN — never guess a version.
  }
  return UNKNOWN;
};

const readGitCommit = (): string => {
  // SOURCE_COMMIT lets a build from an exported tree (no .git) still carry a
  // true commit, supplied by whoever did the export.
  const supplied = process.env.SOURCE_COMMIT?.trim();
  if (supplied !== undefined && /^[0-9a-f]{40}$/u.test(supplied)) {
    return supplied;
  }
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^[0-9a-f]{40}$/u.test(sha) ? sha : UNKNOWN;
  } catch {
    return UNKNOWN;
  }
};

const BUILD_DEFINES = {
  __SOVEREIGN_NODE_VERSION__: JSON.stringify(readPackageVersion()),
  __SOVEREIGN_NODE_COMMIT__: JSON.stringify(readGitCommit()),
  __BUILD_TIMESTAMP__: JSON.stringify(new Date().toISOString()),
};

export default defineConfig([
  {
    entry: {
      "sovereign-node": "src/bin/sovereign-node.ts",
      "sovereign-node-api": "src/bin/sovereign-node-api.ts",
      "sovereign-node-onboarding-api": "src/bin/sovereign-node-onboarding-api.ts",
      "sovereign-tool": "src/bin/sovereign-tool.ts",
    },
    outDir: "dist",
    format: "esm",
    dts: true,
    clean: true,
    target: "es2022",
    define: BUILD_DEFINES,
  },
  {
    entry: {
      "lib/index": "src/lib/index.ts",
      "lib/installer": "src/lib/installer.ts",
      "lib/api": "src/lib/api.ts",
      "lib/system": "src/lib/system.ts",
      "lib/app": "src/lib/app.ts",
      "lib/contracts": "src/lib/contracts.ts",
      "lib/support": "src/lib/support.ts",
    },
    outDir: "dist",
    format: "esm",
    dts: true,
    clean: false,
    target: "es2022",
    // The lib bundle carries the same identity: pro-api consumes the node
    // package in-process on web installs and must report the same version the
    // CLI would.
    define: BUILD_DEFINES,
  },
]);
