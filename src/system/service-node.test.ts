import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  resolveServiceNode,
  resolveServiceNodeCommand,
  SYSTEM_PROGRAM_SEARCH_PATH,
} from "./service-node.js";

describe("resolveServiceNode", () => {
  let root: string;
  let systemBin: string;
  let privateDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sovereign-service-node-"));
    // mkdtemp creates 0700; the root stands in for a world-traversable /usr.
    await chmod(root, 0o755);
    systemBin = join(root, "bin");
    await mkdir(systemBin, { mode: 0o755 });
    privateDir = join(root, "private");
    await mkdir(join(privateDir, "bin"), { recursive: true });
    await chmod(privateDir, 0o700);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("looks in the fixed system directories by default", () => {
    expect(SYSTEM_PROGRAM_SEARCH_PATH).toBe(
      "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    );
  });

  it("resolves the first node every user can execute", async () => {
    await writeFile(join(systemBin, "node"), "#!/bin/sh\n", { mode: 0o755 });
    expect(await resolveServiceNode(`:${join(root, "missing")}:${systemBin}`)).toEqual({
      ok: true,
      path: join(systemBin, "node"),
    });
    expect(await resolveServiceNodeCommand(systemBin)).toBe(join(systemBin, "node"));
  });

  it("skips a node that lives under a private directory and names the blocking path", async () => {
    const privateNode = join(privateDir, "bin", "node");
    await writeFile(privateNode, "#!/bin/sh\n", { mode: 0o755 });
    await symlink(privateNode, join(systemBin, "node"));

    const resolution = await resolveServiceNode(systemBin);
    expect(resolution).toEqual({
      ok: false,
      searchPath: systemBin,
      problems: [
        `${join(systemBin, "node")} (resolves to ${privateNode}) is not executable by the service user: ${privateDir} (mode 0700) lacks the execute bit for other users`,
      ],
    });

    const fallbackBin = join(root, "fallback");
    await mkdir(fallbackBin, { mode: 0o755 });
    await writeFile(join(fallbackBin, "node"), "#!/bin/sh\n", { mode: 0o755 });
    expect(await resolveServiceNode(`${systemBin}:${fallbackBin}`)).toEqual({
      ok: true,
      path: join(fallbackBin, "node"),
    });
  });

  it("rejects a node binary without the execute bit for other users", async () => {
    await writeFile(join(systemBin, "node"), "#!/bin/sh\n", { mode: 0o750 });
    expect(await resolveServiceNode(systemBin)).toEqual({
      ok: false,
      searchPath: systemBin,
      problems: [
        `${join(systemBin, "node")} is not executable by the service user: ${join(systemBin, "node")} (mode 0750) lacks the execute bit for other users`,
      ],
    });
  });

  it("rejects a node that is not a regular file", async () => {
    await mkdir(join(systemBin, "node"), { mode: 0o755 });
    expect(await resolveServiceNode(systemBin)).toEqual({
      ok: false,
      searchPath: systemBin,
      problems: [`${join(systemBin, "node")} is not a regular file`],
    });
  });

  it("reports no problems when no node exists on the search path", async () => {
    expect(await resolveServiceNode(systemBin)).toEqual({
      ok: false,
      searchPath: systemBin,
      problems: [],
    });
  });

  it("falls back to the running node for a spawn when no system node is usable", async () => {
    expect(await resolveServiceNodeCommand(systemBin)).toBe(process.execPath);
  });
});
