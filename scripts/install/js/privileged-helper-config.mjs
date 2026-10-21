// privileged-helper-config: shared settings for the root-owned helpers that
// the unprivileged runtime API reaches through sudo.
//
// The installer writes the settings file as root next to the helpers. The
// helpers trust nothing the calling user can influence: the service identity
// and the fixed directories come from this file, never from argv or the
// environment, and the file is refused unless root owns it and nobody else
// can write it.

import { lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, normalize } from "node:path";

export const HELPER_DIR = "/usr/local/lib/sovereign-node";
export const HELPER_CONFIG_PATH = `${HELPER_DIR}/privileged-helpers.conf`;
export const HELPER_PATH_ENV = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

// Exit codes shared by every helper: 2 means the request was refused (bad
// arguments or a policy violation), so callers can tell it from a failing
// docker/chown run, which passes its own status through.
export const EXIT_REFUSED = 2;

export class HelperRefusal extends Error {}

export const refuse = (message) => {
  throw new HelperRefusal(message);
};

const KEYS = [
  "SERVICE_USER",
  "SERVICE_GROUP",
  "SERVICE_UID",
  "SERVICE_GID",
  "STATE_DIR",
  "CONFIG_DIR",
  "APP_DIR",
];
const PATH_KEYS = new Set(["STATE_DIR", "CONFIG_DIR", "APP_DIR"]);
const NAME_PATTERN = /^[a-z_][a-z0-9_-]*$/;

export const isCanonicalAbsolutePath = (value) =>
  typeof value === "string" &&
  isAbsolute(value) &&
  normalize(value) === value &&
  value !== "/" &&
  !value.endsWith("/") &&
  !/[\s%\\]/.test(value);

export const parseHelperConfig = (text) => {
  const values = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const match = /^([A-Z_]+)=(.*)$/.exec(trimmed);
    if (match === null || !KEYS.includes(match[1])) {
      refuse(`unexpected line in helper config: ${trimmed}`);
    }
    values[match[1]] = match[2];
  }
  for (const key of KEYS) {
    if (values[key] === undefined || values[key].length === 0) {
      refuse(`helper config is missing ${key}`);
    }
  }
  for (const key of PATH_KEYS) {
    if (!isCanonicalAbsolutePath(values[key])) {
      refuse(`helper config ${key} is not a canonical absolute path`);
    }
  }
  if (!NAME_PATTERN.test(values.SERVICE_USER) || !NAME_PATTERN.test(values.SERVICE_GROUP)) {
    refuse("helper config has an invalid service user or group name");
  }
  const uid = Number(values.SERVICE_UID);
  const gid = Number(values.SERVICE_GID);
  if (!/^[0-9]+$/.test(values.SERVICE_UID) || !/^[0-9]+$/.test(values.SERVICE_GID)) {
    refuse("helper config has a non-numeric service uid or gid");
  }
  if (uid === 0 || values.SERVICE_USER === "root") {
    refuse("helper config names root as the service identity");
  }
  return {
    serviceUser: values.SERVICE_USER,
    serviceGroup: values.SERVICE_GROUP,
    serviceUid: uid,
    serviceGid: gid,
    stateDir: values.STATE_DIR,
    configDir: values.CONFIG_DIR,
    appDir: values.APP_DIR,
  };
};

const assertRootOwned = (path, stat) => {
  if (stat.isSymbolicLink()) {
    refuse(`${path} must not be a symlink`);
  }
  if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
    refuse(`${path} must be owned by root and not writable by group or others`);
  }
};

export const loadHelperConfig = ({ path = HELPER_CONFIG_PATH, fs = { lstatSync, readFileSync } } = {}) => {
  assertRootOwned(dirname(path), fs.lstatSync(dirname(path)));
  const stat = fs.lstatSync(path);
  assertRootOwned(path, stat);
  if (!stat.isFile()) {
    refuse(`${path} must be a regular file`);
  }
  return parseHelperConfig(fs.readFileSync(path, "utf8"));
};

// Runs a helper's main function and maps its outcome onto the shared exit
// code contract. `main` returns the exit status to use on success.
export const runHelper = async (main, { stderr = process.stderr, name } = {}) => {
  try {
    return await main();
  } catch (error) {
    const refused = error instanceof HelperRefusal;
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${name}: ${refused ? "refused" : "failed"}: ${message}\n`);
    return refused ? EXIT_REFUSED : 1;
  }
};
