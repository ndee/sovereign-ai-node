import { chmod, chown } from "node:fs/promises";
import type { Logger } from "../logging/logger.js";
import type { ExecRunner } from "./exec.js";

/**
 * File and directory modes for the bundled-Matrix project directory.
 *
 * Every file the renderer writes carries credentials (Postgres password,
 * Synapse shared secrets, signing key, deSEC token) or is the compose
 * definition that references them, so nothing here is world-readable.
 *
 * The containers that must read those files do not rely on permissive modes:
 * - Synapse: the image's `start.py` runs as root, `chown -R`s /data to the
 *   `UID`/`GID` it is given and drops privileges via gosu. We hand it the
 *   owner below, so it reads 0640 files as their owner.
 * - Postgres: the image entrypoint runs as root and adopts `postgres-data`
 *   itself (`chown postgres`, `chmod 0700`) before dropping privileges.
 * - Caddy / onboarding-api: run as root inside their containers and read
 *   bind mounts regardless of host modes.
 * Bind-mount path resolution is performed by the Docker daemon (root), so
 * parent directories do not need to be traversable by the container UIDs.
 */
export const BUNDLED_MATRIX_DIR_MODE = 0o750;
export const BUNDLED_MATRIX_CONFIG_FILE_MODE = 0o640;
export const BUNDLED_MATRIX_ENV_FILE_MODE = 0o600;

/** Synapse image default UID/GID; used only when no service user resolves. */
export const SYNAPSE_IMAGE_DEFAULT_UID = 991;
export const SYNAPSE_IMAGE_DEFAULT_GID = 991;
export const DEFAULT_SERVICE_USER = "sovereign-node";

export type BundledMatrixOwner = { uid: number; gid: number };

export type OwnerResolutionDeps = {
  execRunner: ExecRunner;
  logger: Logger;
  env?: NodeJS.ProcessEnv;
  getuid?: () => number;
  getgid?: () => number;
};

const processUid = (): number => process.getuid?.() ?? 0;
const processGid = (): number => process.getgid?.() ?? 0;

const parseId = (stdout: string): number | null => {
  const trimmed = stdout.trim();
  return /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : null;
};

/**
 * Resolve the uid:gid that owns the bundled-Matrix project files and that the
 * Synapse container runs as.
 *
 * - When the renderer runs unprivileged (the runtime API service user), the
 *   owner is the current process identity.
 * - When it runs as root (the CLI installer), the owner is the configured
 *   service user (`SOVEREIGN_NODE_SERVICE_USER`, default `sovereign-node`) so
 *   the runtime API can later re-render the project without escalation. If
 *   that user cannot be resolved, fall back to the Synapse image default
 *   (991:991) instead of running the homeserver as root.
 */
export const resolveBundledMatrixOwner = async (
  deps: OwnerResolutionDeps,
): Promise<BundledMatrixOwner> => {
  const getuid = deps.getuid ?? processUid;
  const getgid = deps.getgid ?? processGid;
  const uid = getuid();
  if (uid !== 0) {
    return { uid, gid: getgid() };
  }
  const env = deps.env ?? process.env;
  const configured = env.SOVEREIGN_NODE_SERVICE_USER?.trim();
  const serviceUser =
    configured !== undefined && configured.length > 0 ? configured : DEFAULT_SERVICE_USER;
  const [uidResult, gidResult] = await Promise.all([
    deps.execRunner.run({ command: "id", args: ["-u", serviceUser], options: { timeout: 5_000 } }),
    deps.execRunner.run({ command: "id", args: ["-g", serviceUser], options: { timeout: 5_000 } }),
  ]);
  const resolvedUid = uidResult.exitCode === 0 ? parseId(uidResult.stdout) : null;
  const resolvedGid = gidResult.exitCode === 0 ? parseId(gidResult.stdout) : null;
  if (resolvedUid === null || resolvedGid === null || resolvedUid === 0) {
    deps.logger.warn(
      { serviceUser, uidExitCode: uidResult.exitCode, gidExitCode: gidResult.exitCode },
      "Could not resolve a non-root service user for bundled Matrix; falling back to the Synapse image default uid/gid",
    );
    return { uid: SYNAPSE_IMAGE_DEFAULT_UID, gid: SYNAPSE_IMAGE_DEFAULT_GID };
  }
  return { uid: resolvedUid, gid: resolvedGid };
};

export type HardenFsDeps = {
  chmod?: typeof chmod;
  chown?: typeof chown;
  getuid?: () => number;
  logger?: Logger;
};

const errnoCode = (error: unknown): string | undefined =>
  error !== null && typeof error === "object" && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;

const applyOwnerIfRoot = async (
  path: string,
  owner: BundledMatrixOwner,
  deps: HardenFsDeps,
): Promise<void> => {
  const getuid = deps.getuid ?? processUid;
  const chownImpl = deps.chown ?? chown;
  if (getuid() !== 0) {
    return;
  }
  await chownImpl(path, owner.uid, owner.gid);
};

/**
 * Set `mode` on a file the renderer just wrote and, when running as root,
 * hand it to `owner`. Missing files are ignored so optional outputs can be
 * hardened unconditionally; every other error propagates.
 */
export const hardenFile = async (
  path: string,
  mode: number,
  owner: BundledMatrixOwner,
  deps: HardenFsDeps = {},
): Promise<void> => {
  try {
    await (deps.chmod ?? chmod)(path, mode);
    await applyOwnerIfRoot(path, owner, deps);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") {
      return;
    }
    throw error;
  }
};

/**
 * Set 0750 on a project directory and, when running as root, hand it to
 * `owner`. Directories a container has already adopted (postgres-data is
 * chowned to the in-container postgres user on first boot) raise EPERM/EACCES
 * for an unprivileged renderer; those are left as the container set them
 * (already 0700) and only logged. The directory is never recursed into: the
 * contents of data directories belong to the containers.
 */
export const hardenDirectory = async (
  path: string,
  owner: BundledMatrixOwner,
  deps: HardenFsDeps = {},
): Promise<void> => {
  try {
    await (deps.chmod ?? chmod)(path, BUNDLED_MATRIX_DIR_MODE);
    await applyOwnerIfRoot(path, owner, deps);
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT") {
      return;
    }
    if (code === "EPERM" || code === "EACCES") {
      deps.logger?.warn(
        { path, code },
        "Bundled Matrix directory is owned by a container user; leaving its mode unchanged",
      );
      return;
    }
    throw error;
  }
};
