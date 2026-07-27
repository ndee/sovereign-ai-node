/**
 * Immutable build identity for the running sovereign-node bundle.
 *
 * The values below are replaced at BUILD time by tsup `define` (see
 * tsup.config.ts). They are compile-time literals in the shipped bundle, so the
 * running process reports what was actually built — not what a mutable checkout
 * or a JSON file on disk happens to say right now.
 *
 * This exists because the previous version source was
 * `process.env.npm_package_version ?? "2.0.0"` (installer/real-service.ts).
 * `npm_package_version` is only set when a process is launched *by npm*; a
 * systemd-launched API or a direct binary invocation has it unset, so every
 * production install reported the literal "2.0.0" while actually running a much
 * later version. A confidently wrong version is worse for support than no
 * version at all, so unavailable values are reported as `unknown` and callers
 * must render that honestly.
 *
 * Resolution order is build-time define, then the package.json that ships
 * alongside this module (which keeps `tsx` dev runs and unbundled consumers
 * truthful), then `unknown`. Nothing is ever guessed.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

declare const __SOVEREIGN_NODE_VERSION__: string | undefined;
declare const __SOVEREIGN_NODE_COMMIT__: string | undefined;
declare const __BUILD_TIMESTAMP__: string | undefined;

/** Reported when a build-time value was unavailable or the code runs unbundled. */
export const UNKNOWN_BUILD_VALUE = "unknown";

/** Bound so a malformed/hostile define can never produce unbounded output. */
const MAX_FIELD_LENGTH = 200;

export interface NodeBuildInfo {
  readonly component: "sovereign-node";
  /** Semantic version of the built bundle, or `unknown`. */
  readonly version: string;
  /** Full lowercase source commit SHA, or `unknown`. */
  readonly commit: string;
  /** ISO-8601 UTC build timestamp, or `unknown`. */
  readonly buildTimestamp: string;
}

/**
 * Normalize a build-time value, falling back to `unknown`.
 *
 * Exported so the sanitization rules are directly tested: the tsup `define`
 * substitution itself cannot run under vitest, but everything we do with the
 * substituted value can and must be.
 */
export const readDefine = (value: unknown): string => {
  if (typeof value !== "string") {
    return UNKNOWN_BUILD_VALUE;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return UNKNOWN_BUILD_VALUE;
  }
  return trimmed.slice(0, MAX_FIELD_LENGTH);
};

/**
 * Read `version` from a package.json next to the running module.
 *
 * This is the fallback that keeps `tsx` runs and library consumers honest when
 * no build-time define was substituted. It deliberately reads the package.json
 * *adjacent to this file* rather than the current working directory: resolving
 * from cwd would report the version of whatever project happens to invoke us.
 *
 * Exported for testing with an injected reader; production callers use the
 * zero-argument form.
 */
export const readPackageVersion = (
  moduleDir: string,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): string => {
  // dist/ layout puts the bundle one level below the package root; src/ layout
  // puts this file one level below it too. Both resolve with the same walk.
  const candidates = [
    join(moduleDir, "..", "package.json"),
    join(moduleDir, "..", "..", "package.json"),
  ];
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(readFile(candidate));
      if (typeof parsed === "object" && parsed !== null) {
        const version = (parsed as { version?: unknown }).version;
        if (typeof version === "string" && version.trim().length > 0) {
          return version.trim().slice(0, MAX_FIELD_LENGTH);
        }
      }
    } catch {
      // Unreadable or malformed candidate: try the next one, then give up to
      // `unknown`. A missing package.json is normal in some bundle layouts and
      // must not throw on a diagnostic path.
    }
  }
  return UNKNOWN_BUILD_VALUE;
};

/*  Reading the defines is the one part the test runner cannot reach: vitest
    imports this TypeScript directly, so the identifiers are never substituted
    and only the `undefined` arm exists at test time. The normalization applied
    to whatever comes back is covered by the readDefine tests. */
/* v8 ignore start -- tsup `define` substitution never occurs under vitest. */
const rawVersion = (): unknown =>
  typeof __SOVEREIGN_NODE_VERSION__ === "undefined" ? undefined : __SOVEREIGN_NODE_VERSION__;
const rawCommit = (): unknown =>
  typeof __SOVEREIGN_NODE_COMMIT__ === "undefined" ? undefined : __SOVEREIGN_NODE_COMMIT__;
const rawBuildTimestamp = (): unknown =>
  typeof __BUILD_TIMESTAMP__ === "undefined" ? undefined : __BUILD_TIMESTAMP__;
/* v8 ignore stop */

/**
 * Resolve the version with the documented precedence.
 *
 * Exported with injectable inputs so every branch is testable without a build.
 */
export const resolveVersion = (
  defineValue: unknown,
  packageVersion: string = UNKNOWN_BUILD_VALUE,
): string => {
  const fromDefine = readDefine(defineValue);
  if (fromDefine !== UNKNOWN_BUILD_VALUE) {
    return fromDefine;
  }
  return packageVersion;
};

/** Resolve the immutable identity of the running bundle. */
export const getNodeBuildInfo = (): NodeBuildInfo => ({
  component: "sovereign-node",
  version: resolveVersion(
    rawVersion(),
    /* v8 ignore next -- filesystem probe is exercised via readPackageVersion tests. */
    readPackageVersion(dirname(fileURLToPath(import.meta.url))),
  ),
  commit: readDefine(rawCommit()),
  buildTimestamp: readDefine(rawBuildTimestamp()),
});

/** Short commit form for chat output. Full hash stays available in JSON. */
export const shortCommit = (commit: string): string =>
  commit === UNKNOWN_BUILD_VALUE ? UNKNOWN_BUILD_VALUE : commit.slice(0, 7);

/** True when every build field resolved — used to flag partial identity. */
export const isNodeBuildIdentityComplete = (info: NodeBuildInfo): boolean =>
  info.version !== UNKNOWN_BUILD_VALUE && info.commit !== UNKNOWN_BUILD_VALUE;
