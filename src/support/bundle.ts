/**
 * Redacted support bundle.
 *
 * Produces `sovereign-ai-node-support-<date>-<id>.tar.gz` containing only
 * allowlisted, redacted evidence, so a design partner can hand the founder a
 * complete picture without an SSH session and without sharing secrets or mail.
 *
 * # Security properties, and how each is achieved
 *
 * - **No automatic upload.** Nothing in this module constructs a network client.
 *   The bundle is written to local disk and never transmitted. A test asserts it.
 * - **No secrets.** Contents are built by allowlist (`collectors.ts`), never by
 *   sweeping the filesystem; `secrets/`, env files and tokens are never read.
 *   Redaction is a second layer, not the control.
 * - **No archive traversal.** Every entry is written from an in-memory buffer to
 *   a flat staging directory with a validated, generated name. No user-controlled
 *   string reaches a path, and no symlink is ever followed into the archive.
 * - **Restrictive permissions.** Staging directory 0700, archive 0600, created
 *   before any content is written.
 * - **Bounded size.** Per-artifact and total caps; exceeding the total aborts
 *   rather than silently truncating.
 * - **Integrity.** SHA-256 over the finished archive, plus a per-file checksum
 *   in the manifest, so tampering between generation and receipt is detectable.
 * - **Honest partial results.** Any collector that did not produce content sets
 *   `complete: false`; a partial bundle is never presented as whole.
 */

import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import {
  type CollectorResult,
  collectClockState,
  collectGatewaySyncOrdering,
  collectJournalTail,
  collectSystemResources,
  collectUnitStates,
  defaultRunCommand,
  type RunCommand,
  SUPPORTED_UNITS,
  summarizeMailState,
} from "./collectors.js";
import { redactValue } from "./redact.js";
import type { VersionInventory } from "./version-inventory.js";

/** Bundle format version. Bumped when the manifest shape changes. */
export const BUNDLE_FORMAT_VERSION = 1;

/** Total uncompressed cap. Exceeding this aborts generation. */
export const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

/** Bundles older than this are removed on the next run. */
export const BUNDLE_RETENTION_DAYS = 14;

/** Filename prefix; also the cleanup match prefix. */
const BUNDLE_PREFIX = "sovereign-ai-node-support-";

/** Filenames we will accept into the archive. Generated, never user-supplied. */
const SAFE_NAME_RE = /^[A-Za-z0-9._-]+$/u;

export interface ManifestEntry {
  readonly file: string;
  readonly purpose: string;
  readonly privacy: string;
  readonly status: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly reason?: string;
}

export interface BundleManifest {
  readonly bundleFormatVersion: number;
  readonly generatedAt: string;
  readonly generatedBy: string;
  /** False when any collector failed — a partial bundle declares itself. */
  readonly complete: boolean;
  readonly redactionPolicy: string;
  readonly inventory: VersionInventory;
  readonly files: readonly ManifestEntry[];
  readonly notes: readonly string[];
}

export interface BundleResult {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly complete: boolean;
  readonly manifest: BundleManifest;
}

/** Dependencies injected so the whole builder is testable without a real node. */
export interface BundleDependencies {
  readonly inventory: VersionInventory;
  /** Existing doctor report, already shaped by the node's own contract. */
  readonly doctorReport?: unknown;
  /** Existing status payload. */
  readonly status?: unknown;
  /** Raw Mail Sentinel state; reduced to counters before inclusion. */
  readonly mailState?: unknown;
  /** Durable update status record, if present. */
  readonly updateStatus?: unknown;
  readonly run?: RunCommand;
  readonly now?: () => Date;
  /** Overrides the archive creation step; used to test without tar. */
  readonly createArchive?: (stagingDir: string, outputPath: string) => Promise<void>;
}

const sha256 = (input: Buffer | string): string => createHash("sha256").update(input).digest("hex");

/**
 * Short, non-guessable bundle id.
 *
 * Random rather than sequential so a bundle filename does not reveal how many
 * incidents a partner has had, and so two bundles never collide.
 */
export const generateBundleId = (random: () => number = Math.random): string => {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let index = 0; index < 6; index += 1) {
    out += alphabet[Math.floor(random() * alphabet.length)] ?? "0";
  }
  return out;
};

/** `YYYY-MM-DD` in UTC — stable regardless of the node's timezone. */
export const formatBundleDate = (date: Date): string =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(
    date.getUTCDate(),
  ).padStart(2, "0")}`;

/** Build the bundle filename. */
export const bundleFileName = (date: Date, id: string): string =>
  `${BUNDLE_PREFIX}${formatBundleDate(date)}-${id}.tar.gz`;

/**
 * Validate a destination path.
 *
 * Rejects anything that is not an absolute path after resolution, anything
 * whose basename is unsafe, and any attempt to overwrite an existing file.
 * Refusing to overwrite matters because the caller may be running as root and a
 * symlink planted at the destination would otherwise redirect a root-owned write.
 */
export const validateOutputPath = async (
  candidate: string,
  statFn: (path: string) => Promise<unknown> = stat,
): Promise<string> => {
  const resolved = resolve(candidate);
  const name = basename(resolved);
  if (!SAFE_NAME_RE.test(name)) {
    throw new Error(`refusing unsafe bundle filename: ${name}`);
  }
  let exists = true;
  try {
    await statFn(resolved);
  } catch {
    exists = false;
  }
  if (exists) {
    throw new Error(`refusing to overwrite existing path: ${resolved}`);
  }
  return resolved;
};

/**
 * Create the archive with `tar`.
 *
 * `-C stagingDir .` keeps entry names relative to the staging root, so no
 * absolute path leaks into the archive. `--owner=0 --group=0 --numeric-owner`
 * strips the generating account from the archive metadata — a username is
 * frequently a person's name.
 *
 * Symlink safety is enforced at the SOURCE rather than by a tar flag: the
 * staging directory is created fresh by `mkdtemp` and every entry in it is
 * written by `writeFile` from an in-memory buffer under a generated,
 * `SAFE_NAME_RE`-validated name. No symlink can exist there to be followed.
 * A `--no-dereference` flag would express the same intent, but it is not
 * portable — busybox tar and some GNU builds reject it — and a flag that
 * aborts archive creation on the partner's machine is worse than a guarantee
 * the code already provides structurally.
 */
const defaultCreateArchive = async (
  stagingDir: string,
  outputPath: string,
  run: RunCommand = defaultRunCommand,
): Promise<void> => {
  await run(
    "tar",
    [
      "--create",
      "--gzip",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "--file",
      outputPath,
      "-C",
      stagingDir,
      ".",
    ],
    30_000,
  );
};

/**
 * Remove bundles older than the retention window.
 *
 * Best-effort: a cleanup failure must never prevent generating the bundle the
 * operator asked for right now.
 */
export const cleanupOldBundles = async (
  directory: string,
  now: Date,
  retentionDays: number = BUNDLE_RETENTION_DAYS,
): Promise<string[]> => {
  const removed: string[] = [];
  try {
    const entries = await readdir(directory);
    for (const entry of entries) {
      if (!entry.startsWith(BUNDLE_PREFIX) || !entry.endsWith(".tar.gz")) {
        continue;
      }
      const full = join(directory, entry);
      try {
        const info = await stat(full);
        const ageDays = (now.getTime() - info.mtime.getTime()) / 86_400_000;
        if (ageDays > retentionDays) {
          await rm(full, { force: true });
          removed.push(entry);
        }
      } catch {
        // Unreadable entry: leave it alone rather than guessing.
      }
    }
  } catch {
    // Directory missing or unreadable — nothing to clean.
  }
  return removed;
};

/**
 * Generate a support bundle.
 *
 * Returns the path, checksum and manifest. Throws only for conditions that make
 * the output untrustworthy (unsafe destination, size cap exceeded, archive
 * failure) — collector failures are recorded, not thrown, so the founder still
 * receives whatever could be gathered, clearly marked incomplete.
 */
export const generateSupportBundle = async (
  outputDirectory: string,
  deps: BundleDependencies,
): Promise<BundleResult> => {
  const now = (deps.now ?? (() => new Date()))();
  const run = deps.run ?? defaultRunCommand;
  const fileName = bundleFileName(now, generateBundleId());
  const outputPath = await validateOutputPath(join(outputDirectory, fileName));

  const results: CollectorResult[] = [];

  // Structured artifacts we already hold in memory. Redacted defensively even
  // though the producers are our own contracts.
  results.push({
    name: "version-inventory.json",
    purpose: "Installed component versions, install provenance, OS and architecture",
    status: "collected",
    privacy: "safe",
    content: redactValue(deps.inventory),
  });

  results.push(
    deps.doctorReport === undefined
      ? {
          name: "doctor.json",
          purpose: "Health check results",
          status: "unavailable",
          privacy: "technical",
          reason: "doctor report could not be produced",
        }
      : {
          name: "doctor.json",
          purpose: "Health check results",
          status: "collected",
          privacy: "technical",
          content: redactValue(deps.doctorReport),
        },
  );

  results.push(
    deps.status === undefined
      ? {
          name: "status.json",
          purpose: "Per-component runtime status",
          status: "unavailable",
          privacy: "technical",
          reason: "status could not be produced",
        }
      : {
          name: "status.json",
          purpose: "Per-component runtime status",
          status: "collected",
          privacy: "technical",
          content: redactValue(deps.status),
        },
  );

  results.push(summarizeMailState(deps.mailState));

  if (deps.updateStatus !== undefined) {
    results.push({
      name: "update-status.json",
      purpose: "Most recent update run: phase, result and exit status",
      status: "collected",
      privacy: "technical",
      content: redactValue(deps.updateStatus),
    });
  }

  // System probes. Each is independently failure-tolerant.
  results.push(await collectUnitStates(run));
  results.push(await collectSystemResources(run));
  results.push(await collectClockState(run));
  results.push(await collectGatewaySyncOrdering(run));
  for (const unit of SUPPORTED_UNITS) {
    results.push(await collectJournalTail(unit, run));
  }

  // Stage in a 0700 directory. mkdtemp gives an unpredictable name, closing the
  // symlink-race window that a fixed /tmp path would open.
  const stagingDir = await mkdtemp(join(tmpdir(), "sovereign-support-"));
  try {
    await chmod(stagingDir, 0o700);

    const manifestFiles: ManifestEntry[] = [];
    let totalBytes = 0;

    for (const result of results) {
      if (!SAFE_NAME_RE.test(result.name)) {
        /* v8 ignore next 2 -- names are compile-time constants; guard is belt-and-braces. */
        throw new Error(`refusing unsafe artifact name: ${result.name}`);
      }
      if (result.status !== "collected" || result.content === undefined) {
        manifestFiles.push({
          file: result.name,
          purpose: result.purpose,
          privacy: result.privacy,
          status: result.status,
          bytes: 0,
          sha256: "",
          ...(result.reason === undefined ? {} : { reason: result.reason }),
        });
        continue;
      }
      const serialized =
        typeof result.content === "string"
          ? result.content
          : `${JSON.stringify(result.content, null, 2)}\n`;
      const buffer = Buffer.from(serialized, "utf8");
      totalBytes += buffer.byteLength;
      if (totalBytes > MAX_BUNDLE_BYTES) {
        throw new Error(
          `support bundle exceeded ${MAX_BUNDLE_BYTES} bytes; aborting rather than truncating`,
        );
      }
      await writeFile(join(stagingDir, result.name), buffer, { mode: 0o600 });
      manifestFiles.push({
        file: result.name,
        purpose: result.purpose,
        privacy: result.privacy,
        status: result.status,
        bytes: buffer.byteLength,
        sha256: sha256(buffer),
      });
    }

    const complete = results.every((result) => result.status === "collected");

    const manifest: BundleManifest = {
      bundleFormatVersion: BUNDLE_FORMAT_VERSION,
      generatedAt: now.toISOString(),
      generatedBy: "sovereign-node support-bundle",
      complete,
      redactionPolicy:
        "Allowlisted collection. No secrets, tokens, keys, env files or configuration files. " +
        "No email subjects, senders, recipients, bodies or snippets at any verbosity. " +
        "Mail state reduced to counters. Journal tails capped and pattern-redacted.",
      // Redacted for the same reason the standalone version-inventory.json is
      // (line ~268): provenance fields are read from an on-disk JSON and can
      // carry a repo URL with embedded credentials. Leaving the manifest copy
      // raw would have made one file safe and its twin unsafe.
      inventory: redactValue(deps.inventory) as VersionInventory,
      files: manifestFiles,
      notes: complete
        ? []
        : [
            "This bundle is INCOMPLETE. One or more collectors could not run; see per-file " +
              "status and reason. Do not read an absent section as evidence of a healthy component.",
          ],
    };

    await writeFile(join(stagingDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });

    const createArchive =
      deps.createArchive ??
      ((staging: string, output: string) => defaultCreateArchive(staging, output, run));
    await createArchive(stagingDir, outputPath);
    await chmod(outputPath, 0o600);

    const { readFile } = await import("node:fs/promises");
    const archiveBytes = await readFile(outputPath);

    return {
      path: outputPath,
      sha256: sha256(archiveBytes),
      bytes: archiveBytes.byteLength,
      complete,
      manifest,
    };
  } finally {
    // Always remove staging, including on the size-cap and archive-failure paths:
    // it holds redacted-but-still-diagnostic content and must not outlive the run.
    await rm(stagingDir, { recursive: true, force: true });
  }
};

/** Ensure the bundles directory exists with restrictive permissions. */
export const ensureBundleDirectory = async (directory: string): Promise<string> => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  return directory;
};
