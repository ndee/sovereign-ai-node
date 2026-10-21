// privileged-reclaim-ownership: hand a node directory that a container or an
// earlier root run left root-owned back to the service user.
//
// Usage: reclaim-ownership <path>
//
// The path must be one of a fixed set of node directories, every component
// below its fixed root must be a real directory (no symlinks), and the new
// owner is always the configured service identity, never a caller-supplied
// uid:gid. The recursive change runs through coreutils `chown -R -P`, which
// walks the tree without following symlinks.

import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { HELPER_PATH_ENV, isCanonicalAbsolutePath, refuse } from "./privileged-helper-config.mjs";

const PROJECT_NAME = /^[a-z0-9][a-z0-9-]*$/;
const MATRIX_CRYPTO_PACKAGE =
  "openclaw/extensions/matrix/node_modules/@matrix-org/matrix-sdk-crypto-nodejs";
export const NPM_GLOBAL_ROOTS = ["/usr/lib/node_modules", "/usr/local/lib/node_modules"];

// Returns the fixed root that the path is allowed below, or undefined.
export const resolveReclaimTarget = (path, identity) => {
  if (!isCanonicalAbsolutePath(path)) {
    return undefined;
  }
  const bundledMatrix = join(identity.stateDir, "bundled-matrix");
  if (path.startsWith(`${bundledMatrix}/`)) {
    const parts = path.slice(bundledMatrix.length + 1).split("/");
    const valid =
      PROJECT_NAME.test(parts[0]) &&
      (parts.length === 1 || (parts.length === 2 && parts[1] === "postgres-data"));
    return valid ? { root: identity.stateDir, path } : undefined;
  }
  if (path === join(identity.configDir, "secrets")) {
    return { root: identity.configDir, path };
  }
  const npmRoot = NPM_GLOBAL_ROOTS.find((root) => path === join(root, MATRIX_CRYPTO_PACKAGE));
  return npmRoot === undefined ? undefined : { root: npmRoot, path };
};

export const assertRealDirectoryChain = (target, lstat) => {
  let current = target.root;
  for (const part of target.path.slice(target.root.length + 1).split("/")) {
    current = join(current, part);
    let stat;
    try {
      stat = lstat(current);
    } catch {
      refuse(`${current} does not exist`);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      refuse(`${current} must be a directory, not a symlink`);
    }
  }
};

// With protected hardlinks off, a user could hard-link a root-owned file into
// a directory it owns and have the recursive chown hand that file over.
export const assertProtectedHardlinks = (readFile) => {
  let value = "";
  try {
    value = readFile("/proc/sys/fs/protected_hardlinks", "utf8").trim();
  } catch {
    // Unreadable is treated like disabled.
  }
  if (value !== "1") {
    refuse("fs.protected_hardlinks must be enabled");
  }
};

export const reclaimOwnership = ({
  argv,
  identity,
  spawn = spawnSync,
  lstat = lstatSync,
  readFile = readFileSync,
}) => {
  if (argv.length !== 1) {
    refuse("usage: reclaim-ownership <path>");
  }
  const target = resolveReclaimTarget(argv[0], identity);
  if (target === undefined) {
    refuse(`${argv[0]} is not a directory the node may reclaim`);
  }
  assertRealDirectoryChain(target, lstat);
  assertProtectedHardlinks(readFile);
  const result = spawn(
    "chown",
    [
      "-R",
      "-P",
      "--no-dereference",
      "--preserve-root",
      `${identity.serviceUid}:${identity.serviceGid}`,
      "--",
      target.path,
    ],
    { stdio: "inherit", env: { PATH: HELPER_PATH_ENV } },
  );
  if (result.error !== undefined) {
    throw result.error;
  }
  return result.status ?? 1;
};
