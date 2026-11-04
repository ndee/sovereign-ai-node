import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  isSupportedNodeVersion,
  parseNodeVersion,
  SUPPORTED_NODE_MAJOR_LIMIT,
  SUPPORTED_NODE_MIN_VERSION,
  SUPPORTED_NODE_RANGE,
} from "./node-runtime-floor.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("parseNodeVersion", () => {
  it("parses process.versions.node and `node --version` shapes", () => {
    expect(parseNodeVersion("22.22.3")).toEqual([22, 22, 3]);
    expect(parseNodeVersion("v22.23.4\n")).toEqual([22, 23, 4]);
    expect(parseNodeVersion("v22.22.3-nightly20261101")).toEqual([22, 22, 3]);
  });

  it("rejects anything that is not a full version", () => {
    expect(parseNodeVersion("")).toBeNull();
    expect(parseNodeVersion("v22")).toBeNull();
    expect(parseNodeVersion("node: command not found")).toBeNull();
  });
});

describe("isSupportedNodeVersion", () => {
  it.each([
    ["22.22.3", true],
    ["v22.22.10", true],
    ["22.23.0", true],
    ["22.99.99", true],
    ["22.22.2", false],
    ["22.21.9", false],
    ["21.99.99", false],
    ["18.19.0", false],
    ["23.0.0", false],
    ["24.15.0", false],
    ["garbage", false],
  ])("%s -> %s", (version, expected) => {
    expect(isSupportedNodeVersion(version)).toBe(expected);
  });
});

describe("the supported Node range stays in sync across its declarations", () => {
  it("matches the label", () => {
    expect(SUPPORTED_NODE_RANGE).toBe(
      `>=${SUPPORTED_NODE_MIN_VERSION.join(".")} <${SUPPORTED_NODE_MAJOR_LIMIT}`,
    );
  });

  it("matches package.json engines.node", async () => {
    const pkg = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8")) as {
      engines: { node: string };
    };
    expect(pkg.engines.node).toBe(SUPPORTED_NODE_RANGE);
  });

  it("matches the floor install.sh enforces", async () => {
    const lib = await readFile(join(REPO_ROOT, "scripts/install/lib-runtime-deps.sh"), "utf8");
    const [major, minor, patch] = SUPPORTED_NODE_MIN_VERSION;
    expect(lib).toContain(`NODE_RUNTIME_MIN_VERSION="${major}.${minor}.${patch}"`);
    expect(lib).toContain(`NODE_RUNTIME_MAJOR_LIMIT="${SUPPORTED_NODE_MAJOR_LIMIT}"`);
  });
});
