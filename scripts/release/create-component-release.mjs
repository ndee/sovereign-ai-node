#!/usr/bin/env node

import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { readFileSync, statSync, writeFileSync } from "node:fs";

const [, , outputPath, component, version, tag, commitSha, ...assetPaths] = process.argv;

const fail = (message) => {
  process.stderr.write(`create-component-release: ${message}\n`);
  process.exit(1);
};

if (
  outputPath === undefined ||
  component === undefined ||
  version === undefined ||
  tag === undefined ||
  commitSha === undefined ||
  assetPaths.length === 0
) {
  fail(
    "usage: create-component-release.mjs <output> <component> <version> <tag> <commit-sha> <asset>...",
  );
}
if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) {
  fail(`invalid component version: ${version}`);
}
if (tag !== `v${version}`) {
  fail(`tag ${tag} does not match version ${version}`);
}
if (!/^[0-9a-f]{40}$/u.test(commitSha)) {
  fail(`invalid commit SHA: ${commitSha}`);
}

const assets = assetPaths
  .map((assetPath) => {
    const absolutePath = resolve(assetPath);
    const stat = statSync(absolutePath);
    if (!stat.isFile() || stat.size === 0) {
      fail(`release asset is missing or empty: ${assetPath}`);
    }
    return {
      name: basename(absolutePath),
      size: stat.size,
      sha256: createHash("sha256").update(readFileSync(absolutePath)).digest("hex"),
    };
  })
  .sort((left, right) => left.name.localeCompare(right.name));

if (new Set(assets.map(({ name }) => name)).size !== assets.length) {
  fail("release asset names must be unique");
}

const manifest = {
  schemaVersion: 1,
  component,
  version,
  tag,
  commitSha,
  assets,
};

writeFileSync(resolve(outputPath), `${JSON.stringify(manifest, null, 2)}\n`, {
  mode: 0o644,
});
