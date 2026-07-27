/**
 * Canonical node identity and version inventory.
 *
 * One machine-readable answer to "what is actually installed here", reused by
 * the CLI, the support bundle, `/readyz`, and (in-process) by pro-api. Before
 * this existed, `status.version.sovereignNode` came from
 * `process.env.npm_package_version ?? "2.0.0"` — an env var that is only set
 * when a process is launched *by npm*, so every systemd-launched node reported
 * the literal "2.0.0" regardless of what it was running.
 *
 * # Rules
 *
 * 1. Prefer build-time metadata (tsup `define`) over anything mutable.
 * 2. Never infer a version from a directory name, a branch, or a git checkout
 *    that may have moved since install.
 * 3. Report `unknown` for anything unavailable. Never substitute a plausible
 *    default — a confidently wrong version costs more support time than an
 *    honest gap, because it sends the founder down the wrong path.
 * 4. Never expose repository credentials, tokens, or remote URLs that may
 *    embed them. Provenance repo URLs are emitted only after scrubbing
 *    userinfo, and are omitted entirely if scrubbing cannot be verified.
 */

import { createHash } from "node:crypto";
import { arch, hostname, platform, release, type } from "node:os";

import { getNodeBuildInfo, UNKNOWN_BUILD_VALUE } from "../build-info.js";

const sha256Hex = (input: string): string =>
  createHash("sha256").update(input, "utf8").digest("hex");

/** Re-exported so callers compare against one constant, not a string literal. */
export const UNKNOWN = UNKNOWN_BUILD_VALUE;

export interface ComponentVersion {
  /** Component identifier, e.g. `sovereign-node`. */
  readonly component: string;
  /** Semantic version, or `unknown`. */
  readonly version: string;
  /** Full commit SHA where known, or `unknown`. */
  readonly commit: string;
  /** Where the value came from — lets a reviewer judge how much to trust it. */
  readonly source: "build-define" | "package-json" | "provenance" | "runtime-probe" | "unavailable";
}

export interface OperatingEnvironment {
  readonly os: string;
  readonly kernel: string;
  readonly arch: string;
  /** Hostnames can identify a person or an employer; carried only as a hash. */
  readonly hostnameHash: string;
  readonly nodeRuntime: string;
}

export interface VersionInventory {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly components: readonly ComponentVersion[];
  readonly environment: OperatingEnvironment;
  /** Install timestamp from provenance, or `unknown`. */
  readonly installedAt: string;
  /** Install mechanism from provenance, or `unknown`. */
  readonly installSource: string;
  /** Contract version the node speaks. */
  readonly contractVersion: string;
  /** True when any component resolved to `unknown` — surfaced, never hidden. */
  readonly incomplete: boolean;
}

/**
 * Stable, non-reversible hostname identifier.
 *
 * A hostname is frequently a person's name or an employer's. The founder needs
 * to correlate two bundles from the same machine, which a hash provides, without
 * the bundle carrying the name itself.
 */
export const hashHostname = (
  value: string,
  hasher: (input: string) => string = sha256Hex,
): string => (value.trim().length === 0 ? UNKNOWN : `h:${hasher(value).slice(0, 16)}`);

/**
 * Remove credentials from a repository URL.
 *
 * Provenance records repo URLs, and a URL of the form
 * `https://x-access-token:ghp_…@github.com/owner/repo` embeds a PAT. Returns
 * `undefined` when the input cannot be parsed, so an unparseable URL is dropped
 * rather than emitted unscrubbed.
 */
export const scrubRepoUrl = (url: string): string | undefined => {
  const trimmed = url.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  // git@host:owner/repo has no userinfo to strip and no parseable authority.
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:/u.test(trimmed)) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
};

/** Minimal shape of the provenance record this module consumes. */
export interface ProvenanceLike {
  readonly nodeVersion?: string | undefined;
  readonly nodeCommitSha?: string | undefined;
  readonly botsVersion?: string | undefined;
  readonly botsCommitSha?: string | undefined;
  readonly installedAt?: string | undefined;
  readonly installSource?: string | undefined;
}

/** Inputs the inventory cannot discover for itself, injected for testability. */
export interface InventoryInputs {
  /** Parsed `install-provenance.json`, or null when absent (web installs). */
  readonly provenance: ProvenanceLike | null;
  /** OpenClaw runtime version from the existing detector, if any. */
  readonly openclawVersion?: string | undefined;
  /** Bot versions discovered from installed bot manifests. */
  readonly botVersions?: Readonly<Record<string, string>> | undefined;
  readonly contractVersion: string;
  readonly now?: () => Date;
}

const normalize = (value: string | undefined | null): string => {
  if (typeof value !== "string") {
    return UNKNOWN;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? UNKNOWN : trimmed;
};

/**
 * Build the inventory.
 *
 * Pure apart from `os` reads and the injected clock, so every branch is testable
 * without an installed node.
 */
export const buildVersionInventory = (inputs: InventoryInputs): VersionInventory => {
  const build = getNodeBuildInfo();
  const provenance = inputs.provenance;

  const components: ComponentVersion[] = [];

  // sovereign-node: build-time define wins; provenance is the fallback because
  // it records what the installer actually placed on disk.
  const nodeFromBuild = build.version !== UNKNOWN;
  const nodeVersion = nodeFromBuild ? build.version : normalize(provenance?.nodeVersion);
  const nodeCommit = build.commit !== UNKNOWN ? build.commit : normalize(provenance?.nodeCommitSha);
  components.push({
    component: "sovereign-node",
    version: nodeVersion,
    commit: nodeCommit,
    source: nodeFromBuild ? "build-define" : nodeVersion === UNKNOWN ? "unavailable" : "provenance",
  });

  const botsVersion = normalize(provenance?.botsVersion);
  components.push({
    component: "sovereign-ai-bots",
    version: botsVersion,
    commit: normalize(provenance?.botsCommitSha),
    source: botsVersion === UNKNOWN ? "unavailable" : "provenance",
  });

  const openclaw = normalize(inputs.openclawVersion);
  components.push({
    component: "openclaw",
    version: openclaw,
    commit: UNKNOWN,
    source: openclaw === UNKNOWN ? "unavailable" : "runtime-probe",
  });

  for (const [botId, botVersion] of Object.entries(inputs.botVersions ?? {})) {
    const normalized = normalize(botVersion);
    components.push({
      component: botId,
      version: normalized,
      commit: UNKNOWN,
      source: normalized === UNKNOWN ? "unavailable" : "package-json",
    });
  }

  const clock = inputs.now ?? (() => new Date());

  return {
    schemaVersion: 1,
    generatedAt: clock().toISOString(),
    components,
    environment: {
      os: `${type()} ${release()}`,
      kernel: platform(),
      arch: arch(),
      hostnameHash: hashHostname(hostname()),
      nodeRuntime: process.version,
    },
    installedAt: normalize(provenance?.installedAt),
    installSource: normalize(provenance?.installSource),
    contractVersion: inputs.contractVersion,
    incomplete: components.some((entry) => entry.version === UNKNOWN),
  };
};

/**
 * One-line human summary for chat and CLI headers.
 *
 * Renders `unknown` verbatim so a partner reading it over Matrix can tell the
 * difference between "old version" and "we cannot tell".
 */
export const summarizeInventory = (inventory: VersionInventory): string => {
  const find = (id: string): string =>
    inventory.components.find((entry) => entry.component === id)?.version ?? UNKNOWN;
  return [
    `node ${find("sovereign-node")}`,
    `bots ${find("sovereign-ai-bots")}`,
    `openclaw ${find("openclaw")}`,
    `${inventory.environment.arch} ${inventory.environment.os}`,
  ].join(" · ");
};
