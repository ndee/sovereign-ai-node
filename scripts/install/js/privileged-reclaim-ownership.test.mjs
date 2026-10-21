import { describe, expect, it } from "vitest";

import {
  assertProtectedHardlinks,
  assertRealDirectoryChain,
  NPM_GLOBAL_ROOTS,
  reclaimOwnership,
  resolveReclaimTarget,
} from "./privileged-reclaim-ownership.mjs";

const identity = {
  serviceUser: "sovereign-node",
  serviceGroup: "sovereign-node",
  serviceUid: 998,
  serviceGid: 997,
  stateDir: "/var/lib/sovereign-node",
  configDir: "/etc/sovereign-node",
  appDir: "/opt/sovereign-ai-node/app",
};
const PROJECT = "/var/lib/sovereign-node/bundled-matrix/matrix-example-org";
const CRYPTO =
  "openclaw/extensions/matrix/node_modules/@matrix-org/matrix-sdk-crypto-nodejs";

const dirStat = { isDirectory: () => true, isSymbolicLink: () => false };
const linkStat = { isDirectory: () => false, isSymbolicLink: () => true };
const lstatFrom =
  (overrides = {}) =>
  (path) => {
    if (overrides[path] === "missing") {
      throw new Error("ENOENT");
    }
    return overrides[path] ?? dirStat;
  };
const hardlinksOn = () => "1\n";

describe("resolveReclaimTarget", () => {
  it.each([
    [PROJECT, "/var/lib/sovereign-node"],
    [`${PROJECT}/postgres-data`, "/var/lib/sovereign-node"],
    ["/etc/sovereign-node/secrets", "/etc/sovereign-node"],
    [`/usr/lib/node_modules/${CRYPTO}`, "/usr/lib/node_modules"],
    [`/usr/local/lib/node_modules/${CRYPTO}`, "/usr/local/lib/node_modules"],
  ])("accepts %s", (path, root) => {
    expect(resolveReclaimTarget(path, identity)).toEqual({ root, path });
  });

  it.each([
    ["/etc"],
    ["/etc/sovereign-node"],
    ["/etc/sovereign-node/secrets/../../shadow"],
    ["/var/lib/sovereign-node"],
    ["/var/lib/sovereign-node/bundled-matrix/Bad"],
    [`${PROJECT}/synapse`],
    [`${PROJECT}/postgres-data/base`],
    ["/usr/lib/node_modules/openclaw"],
    ["relative/path"],
  ])("refuses %s", (path) => {
    expect(resolveReclaimTarget(path, identity)).toBeUndefined();
  });

  it("lists both npm global roots", () => {
    expect(NPM_GLOBAL_ROOTS).toEqual(["/usr/lib/node_modules", "/usr/local/lib/node_modules"]);
  });
});

describe("assertRealDirectoryChain", () => {
  const target = { root: "/var/lib/sovereign-node", path: `${PROJECT}/postgres-data` };

  it("accepts a chain of real directories", () => {
    expect(() => assertRealDirectoryChain(target, lstatFrom())).not.toThrow();
  });

  it.each([
    ["a symlinked intermediate", { "/var/lib/sovereign-node/bundled-matrix": linkStat }, /must be a directory/],
    ["a symlinked leaf", { [`${PROJECT}/postgres-data`]: linkStat }, /must be a directory/],
    ["a missing leaf", { [`${PROJECT}/postgres-data`]: "missing" }, /does not exist/],
  ])("refuses %s", (_label, overrides, message) => {
    expect(() => assertRealDirectoryChain(target, lstatFrom(overrides))).toThrow(message);
  });
});

describe("assertProtectedHardlinks", () => {
  it("passes when the kernel protects hard links", () => {
    expect(() => assertProtectedHardlinks(hardlinksOn)).not.toThrow();
  });

  it.each([
    ["disabled", () => "0\n"],
    [
      "unreadable",
      () => {
        throw new Error("EACCES");
      },
    ],
  ])("refuses when the setting is %s", (_label, readFile) => {
    expect(() => assertProtectedHardlinks(readFile)).toThrow(/protected_hardlinks/);
  });
});

describe("reclaimOwnership", () => {
  const run = (argv, result = { status: 0 }) => {
    const calls = [];
    const status = reclaimOwnership({
      argv,
      identity,
      lstat: lstatFrom(),
      readFile: hardlinksOn,
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        return result;
      },
    });
    return { status, calls };
  };

  it("hands the directory to the configured service identity without following symlinks", () => {
    const { status, calls } = run(["/etc/sovereign-node/secrets"]);
    expect(status).toBe(0);
    expect(calls).toEqual([
      {
        command: "chown",
        args: [
          "-R",
          "-P",
          "--no-dereference",
          "--preserve-root",
          "998:997",
          "--",
          "/etc/sovereign-node/secrets",
        ],
        options: { stdio: "inherit", env: { PATH: expect.any(String) } },
      },
    ]);
  });

  it("passes chown's failure status through", () => {
    expect(run([PROJECT], { status: 1 }).status).toBe(1);
    expect(run([PROJECT], { status: null }).status).toBe(1);
  });

  it("rethrows when chown cannot be started", () => {
    expect(() => run([PROJECT], { error: new Error("spawn chown ENOENT") })).toThrow(/ENOENT/);
  });

  it.each([
    [[], /usage/],
    [["/etc/sovereign-node/secrets", "/etc"], /usage/],
    [["/etc"], /not a directory the node may reclaim/],
  ])("refuses %j", (argv, message) => {
    expect(() => run(argv)).toThrow(message);
  });

  it("uses the real filesystem probes by default", () => {
    // Nothing under the fixed node paths exists on a test runner.
    expect(() =>
      reclaimOwnership({ argv: ["/etc/sovereign-node/secrets"], identity, spawn: () => ({ status: 0 }) }),
    ).toThrow(/does not exist|protected_hardlinks/);
  });
});
