/**
 * Install-failure diagnostics bundle.
 *
 * Answers one question a person without a terminal must be able to hand over:
 * "why did this install fail?". The support bundle in `bundle.ts` describes a
 * RUNNING node; this one is built for a node whose install stopped half-way,
 * so its evidence is different — install job records with the failing step's
 * `error.details`, the npm debug logs a failed package install leaves behind,
 * and windowed journal tails — and its size discipline is different too.
 *
 * # Redaction: allowlist first, then three layers
 *
 * 1. **Source allowlist.** Only the files, directories and units a caller
 *    names are read. Nothing is swept; symlinks are refused.
 * 2. **Field allowlist.** Structured sources (job records, JSON files) are
 *    reduced to named fields before anything else happens. Unknown fields are
 *    dropped, not redacted.
 * 3. **Free-text scrub.** Text (logs, journal, `error.details`) cannot be
 *    field-allowlisted, so it passes, in order, through the known-secret value
 *    scrub (`known-secrets.ts`), pattern redaction (`redact.ts`) and email
 *    local-part masking — and finally the fail-closed shape guard
 *    (`shape-guard.ts`): if anything credential-shaped survives, the whole
 *    artifact is WITHHELD and listed as such. The bundle is not aborted.
 *
 * # Size: tail-preserving, priority-shedding, never aborting
 *
 * Each source has its own cap and keeps the TAIL of what it reads (`tail.ts`).
 * If the total still exceeds the bundle cap, the least important artifacts are
 * shortened and then dropped, and the manifest says so. A partial bundle that
 * still carries the failing step's error is worth far more than no bundle.
 *
 * # No network
 *
 * Nothing here constructs a network client. The archive is returned as a
 * buffer; writing it anywhere is the caller's decision.
 */

import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { arch, release, totalmem, uptime } from "node:os";
import { join } from "node:path";

import { DEFAULT_PATHS, type SovereignPaths } from "../config/paths.js";
import { runBoundedCommand } from "./collectors.js";
import type { KnownSecretSet, KnownSecretSources } from "./known-secrets.js";
import {
  isPiiKey,
  isSecretKey,
  maskEmailLocalParts,
  REDACTED,
  REDACTED_PII,
  redactText,
} from "./redact.js";
import { findSecretShapes } from "./shape-guard.js";
import {
  type ReadConstraints,
  readFileTail,
  readSmallFile,
  tailText,
  UnreadableFileError,
} from "./tail.js";
import { createZip } from "./zip.js";

/** Bumped when the manifest shape changes. */
export const INSTALL_DIAGNOSTICS_FORMAT_VERSION = 1;

/** Uncompressed cap for the whole bundle. Exceeding it sheds, never aborts. */
export const DEFAULT_MAX_TOTAL_BYTES = 8 * 1024 * 1024;

/** Per-source caps. Each keeps the tail of what it reads. */
export const DEFAULT_SOURCE_CAPS = {
  installJobRecordBytes: 256 * 1024,
  installJobRecords: 5,
  npmLogBytes: 512 * 1024,
  npmLogs: 3,
  journalBytes: 1024 * 1024,
  fileTailBytes: 512 * 1024,
  jsonFileBytes: 1024 * 1024,
} as const;

/**
 * Default priorities: lower is more important and is shed last. Job records
 * first, because in the incidents this was built from they alone named the
 * failing command; npm logs second, because they carry that command's tail.
 */
export const DIAGNOSTICS_PRIORITY = {
  installJobs: 10,
  npmLogs: 20,
  installJournal: 30,
  logs: 40,
  journal: 50,
  versions: 60,
  system: 70,
} as const;

/** A shortened text artifact is never cut below this; below it, it is dropped. */
const MIN_SHORTENED_BYTES = 16 * 1024;

/** Per-string cap inside structured artifacts (e.g. one `error.details.stderr`). */
const JSON_STRING_BYTES = 64 * 1024;
/** Fallback per-string cap when a structured artifact is still over its cap. */
const JSON_STRING_BYTES_TIGHT = 8 * 1024;
const MAX_JSON_DEPTH = 12;
const MAX_JSON_ARRAY_ENTRIES = 200;

/** Job records larger than this are not parsed at all. */
const MAX_JOB_RECORD_FILE_BYTES = 8 * 1024 * 1024;

/** Journal lines requested per boot before the byte cap applies. */
const JOURNAL_LINES = 20_000;

const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]{1,120}$/u;
const SAFE_UNIT_RE = /^[A-Za-z0-9@_][A-Za-z0-9@._-]{0,120}$/u;
const NPM_DEBUG_LOG_RE = /debug(?:-\d+)?\.log$/u;

// ── Types ──────────────────────────────────────────────────────────────────

export type DiagnosticsSource =
  | {
      /** Newest install job records, field-allowlisted. */
      readonly kind: "install-jobs";
      readonly dir: string;
      /** Required file owner uid (see `ReadConstraints`); for less-privileged directories. */
      readonly owner?: number;
      readonly limit?: number;
      readonly maxBytesPerRecord?: number;
      readonly priority?: number;
    }
  | {
      /** Newest npm debug logs across the given `_logs` directories (tail). */
      readonly kind: "npm-logs";
      readonly dirs: readonly string[];
      readonly owner?: number;
      readonly limit?: number;
      readonly maxBytes?: number;
      readonly priority?: number;
    }
  | {
      /** Tail of one named log file. */
      readonly kind: "file-tail";
      readonly name: string;
      readonly path: string;
      readonly owner?: number;
      /**
       * Absence of this file is normal on some devices (written only after an
       * update, only on flashed images, …). A missing file is still listed,
       * but does not mark the bundle incomplete.
       */
      readonly optional?: boolean;
      readonly purpose: string;
      readonly maxBytes?: number;
      readonly priority?: number;
    }
  | {
      /** One JSON file, reduced by `pick` (a field allowlist) before scrubbing. */
      readonly kind: "json-file";
      readonly name: string;
      readonly path: string;
      readonly owner?: number;
      /**
       * Absence of this file is normal on some devices (written only after an
       * update, only on flashed images, …). A missing file is still listed,
       * but does not mark the bundle incomplete.
       */
      readonly optional?: boolean;
      readonly purpose: string;
      readonly pick?: (parsed: unknown) => unknown;
      readonly maxBytes?: number;
      readonly priority?: number;
    }
  | {
      /** Journal of one unit for the current (and optionally previous) boot. */
      readonly kind: "journal";
      readonly unit: string;
      readonly previousBoot?: boolean;
      readonly maxBytes?: number;
      readonly priority?: number;
    }
  | {
      /** Hardware and OS summary. */
      readonly kind: "system";
      readonly priority?: number;
    }
  | {
      /** A value the caller computed (versions, presence flags). Scrubbed like JSON. */
      readonly kind: "value";
      readonly name: string;
      readonly purpose: string;
      readonly value: unknown;
      readonly priority?: number;
    };

export type ArtifactStatus = "collected" | "unavailable" | "withheld" | "shed";

export interface DiagnosticsManifestEntry {
  /** Path inside the archive. Entries that are not `collected` are not in it. */
  readonly file: string;
  readonly purpose: string;
  readonly priority: number;
  readonly status: ArtifactStatus;
  readonly bytes: number;
  readonly sha256: string;
  /** True when the head of the source was dropped to fit a cap. */
  readonly truncated: boolean;
  readonly truncatedBytes: number;
  readonly reason?: string;
  /** Present (true) when an optional source was simply not on this device. */
  readonly optional?: boolean;
}

export interface DiagnosticsManifest {
  readonly formatVersion: number;
  readonly kind: "install-diagnostics";
  readonly generatedAt: string;
  readonly generatedBy: string;
  /** False when any source was unavailable, withheld or shed. */
  readonly complete: boolean;
  /** Caller-supplied identity (product and component versions, image stamp). */
  readonly product: unknown;
  readonly limits: { readonly maxTotalBytes: number };
  readonly totalBytes: number;
  readonly redactionPolicy: readonly string[];
  readonly excluded: readonly string[];
  readonly files: readonly DiagnosticsManifestEntry[];
  readonly notes: readonly string[];
}

export interface InstallDiagnosticsResult {
  readonly archive: Buffer;
  readonly sha256: string;
  readonly bytes: number;
  readonly complete: boolean;
  readonly manifest: DiagnosticsManifest;
}

/** Injectable process runner: no shell, fixed argv, bounded output. */
export type DiagnosticsRunCommand = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string }>;

export interface InstallDiagnosticsOptions {
  readonly sources: readonly DiagnosticsSource[];
  readonly knownSecrets?: KnownSecretSet;
  readonly generatedBy: string;
  readonly product?: unknown;
  readonly maxTotalBytes?: number;
  readonly now?: () => Date;
  readonly run?: DiagnosticsRunCommand;
  /** Reads fixed kernel paths (`/proc`, `/sys`) for the system summary. */
  readonly readKernelFile?: (path: string) => Promise<string>;
}

interface Artifact {
  readonly file: string;
  readonly purpose: string;
  readonly priority: number;
  readonly kind: "text" | "json";
  status: ArtifactStatus;
  content?: string | undefined;
  truncatedBytes: number;
  reason?: string;
  /** An optional source that is absent: listed, but not a gap. */
  optional?: boolean;
}

// ── Defaults ───────────────────────────────────────────────────────────────

/** Default runner: see `runBoundedCommand` (no shell, fixed env, bounded output). */
export const defaultDiagnosticsRun: DiagnosticsRunCommand = runBoundedCommand;

const defaultReadKernelFile = async (path: string): Promise<string> => readFile(path, "utf8");

// ── Scrubbing ──────────────────────────────────────────────────────────────

/**
 * Free-text pipeline: known values, then patterns, then email local parts.
 * Length is NOT bounded here — callers keep the tail afterwards.
 */
export const scrubDiagnosticText = (text: string, known?: KnownSecretSet): string => {
  const afterKnown = known === undefined ? text : known.scrub(text).text;
  const redacted = redactText(afterKnown, {
    redactEmails: false,
    maxLength: Number.POSITIVE_INFINITY,
  });
  return maskEmailLocalParts(redacted);
};

/**
 * Structured pipeline: secret-named keys lose their value, PII-named keys
 * lose theirs, every string runs the free-text pipeline and keeps its tail.
 */
export const scrubDiagnosticValue = (
  input: unknown,
  known?: KnownSecretSet,
  stringBytes: number = JSON_STRING_BYTES,
  depth = 0,
): unknown => {
  if (depth > MAX_JSON_DEPTH) {
    return "[REDACTED:DEPTH]";
  }
  if (typeof input === "string") {
    return tailText(scrubDiagnosticText(input, known), stringBytes).text;
  }
  if (input === null || typeof input === "number" || typeof input === "boolean") {
    return input;
  }
  if (Array.isArray(input)) {
    return input
      .slice(-MAX_JSON_ARRAY_ENTRIES)
      .map((entry) => scrubDiagnosticValue(entry, known, stringBytes, depth + 1));
  }
  if (typeof input === "object") {
    const output: Record<string, unknown> = {};
    for (const [rawKey, value] of Object.entries(input as Record<string, unknown>)) {
      const key = maskEmailLocalParts(rawKey);
      if (isSecretKey(rawKey)) {
        output[key] = REDACTED;
      } else if (isPiiKey(rawKey)) {
        output[key] = REDACTED_PII;
      } else {
        output[key] = scrubDiagnosticValue(value, known, stringBytes, depth + 1);
      }
    }
    return output;
  }
  // undefined, bigint, function, symbol: nothing diagnostic to keep.
  return null;
};

const serialize = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

// ── Field allowlists ───────────────────────────────────────────────────────

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Copy only the named keys that are present. */
export const pickFields = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  const record = asRecord(value) ?? {};
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    if (record[key] !== undefined) {
      output[key] = record[key];
    }
  }
  return output;
};

const pickError = (value: unknown): Record<string, unknown> | undefined => {
  const error = asRecord(value);
  return error === undefined
    ? undefined
    : pickFields(error, ["code", "message", "retryable", "details"]);
};

const durationMs = (startedAt: unknown, endedAt: unknown): number | undefined => {
  if (typeof startedAt !== "string" || typeof endedAt !== "string") {
    return undefined;
  }
  const value = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isFinite(value) ? value : undefined;
};

/**
 * Field allowlist for a persisted install job record.
 *
 * Keeps the job's identity, state and timings and, per step, the state,
 * timings and error — including `error.details`, which is where the failing
 * command's output lives. Everything else is dropped, notably the embedded
 * install request: older releases persisted it with credentials inline.
 */
export const pickInstallJobRecord = (record: unknown): Record<string, unknown> | undefined => {
  const root = asRecord(record);
  const response = asRecord(root?.response);
  const job = asRecord(response?.job) ?? asRecord(root?.job);
  if (job === undefined) {
    return undefined;
  }
  const steps = Array.isArray(job.steps) ? job.steps : [];
  const topError = pickError(response?.error ?? root?.error);
  return {
    recordVersion: root?.version ?? null,
    updatedAt: root?.updatedAt ?? null,
    job: {
      ...pickFields(job, ["jobId", "state", "createdAt", "startedAt", "endedAt", "currentStepId"]),
      durationMs: durationMs(job.startedAt, job.endedAt) ?? null,
      steps: steps.map((entry) => {
        const step = asRecord(entry) ?? {};
        const error = pickError(step.error);
        return {
          ...pickFields(step, ["id", "label", "state", "startedAt", "endedAt", "progressNote"]),
          durationMs: durationMs(step.startedAt, step.endedAt) ?? null,
          ...(error === undefined ? {} : { error }),
        };
      }),
    },
    ...(topError === undefined ? {} : { error: topError }),
  };
};

// ── Collectors ─────────────────────────────────────────────────────────────

const ownerConstraint = (owner: number | undefined): ReadConstraints =>
  owner === undefined ? {} : { owner };

const unavailable = (
  file: string,
  purpose: string,
  priority: number,
  kind: Artifact["kind"],
  reason: string,
): Artifact => ({
  file,
  purpose,
  priority,
  kind,
  status: "unavailable",
  truncatedBytes: 0,
  reason,
});

/** One redacted line: a manifest reason, not a stack or a command echo. */
const describeFailure = (error: unknown): string => {
  if (error instanceof UnreadableFileError) {
    return error.message;
  }
  const lines = (error instanceof Error ? error.message : String(error))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  // execFile errors start with "Command failed: <argv>"; the cause follows.
  const cause = lines.find((line) => !line.startsWith("Command failed:")) ?? lines[0] ?? "failed";
  return redactText(cause).slice(0, 300);
};

interface ListedFile {
  readonly path: string;
  readonly name: string;
  readonly mtimeMs: number;
}

/** Regular files (never symlinks) in `dir` matching `accept`, newest first. */
const listNewestFiles = async (
  dir: string,
  accept: (name: string) => boolean,
): Promise<ListedFile[]> => {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files: ListedFile[] = [];
  for (const name of names) {
    if (!accept(name)) {
      continue;
    }
    const path = join(dir, name);
    try {
      const info = await lstat(path);
      if (info.isFile()) {
        files.push({ path, name, mtimeMs: info.mtimeMs });
      }
      /* v8 ignore next 3 -- race: the entry vanished between readdir and lstat. */
    } catch {
      // Vanished between readdir and lstat — not evidence of anything.
    }
  }
  return files.sort((left, right) => right.mtimeMs - left.mtimeMs);
};

const collectInstallJobs = async (
  source: Extract<DiagnosticsSource, { kind: "install-jobs" }>,
  known: KnownSecretSet | undefined,
): Promise<Artifact[]> => {
  const priority = source.priority ?? DIAGNOSTICS_PRIORITY.installJobs;
  const cap = source.maxBytesPerRecord ?? DEFAULT_SOURCE_CAPS.installJobRecordBytes;
  const purpose = "Install job record: steps, timings and the failing step's error details";
  const files = (await listNewestFiles(source.dir, (name) => name.endsWith(".json"))).slice(
    0,
    source.limit ?? DEFAULT_SOURCE_CAPS.installJobRecords,
  );
  if (files.length === 0) {
    return [
      unavailable("files/install-jobs/", purpose, priority, "json", "no install job records found"),
    ];
  }
  const artifacts: Artifact[] = [];
  for (const [index, entry] of files.entries()) {
    const id = entry.name.slice(0, -".json".length);
    const file = `files/install-jobs/${SAFE_SEGMENT_RE.test(id) ? id : `job-${index + 1}`}.json`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        await readSmallFile(entry.path, MAX_JOB_RECORD_FILE_BYTES, ownerConstraint(source.owner)),
      );
    } catch (error) {
      artifacts.push(
        unavailable(
          file,
          purpose,
          priority,
          "json",
          error instanceof SyntaxError ? "not valid JSON" : describeFailure(error),
        ),
      );
      continue;
    }
    const picked = pickInstallJobRecord(parsed);
    if (picked === undefined) {
      artifacts.push(unavailable(file, purpose, priority, "json", "not an install job record"));
      continue;
    }
    let content = serialize(scrubDiagnosticValue(picked, known));
    let truncatedBytes = 0;
    if (Buffer.byteLength(content) > cap) {
      const full = Buffer.byteLength(content);
      content = serialize(scrubDiagnosticValue(picked, known, JSON_STRING_BYTES_TIGHT));
      truncatedBytes = full - Buffer.byteLength(content);
    }
    if (Buffer.byteLength(content) > cap) {
      artifacts.push(
        unavailable(
          file,
          purpose,
          priority,
          "json",
          `record exceeds ${cap} bytes after shortening`,
        ),
      );
      continue;
    }
    artifacts.push({
      file,
      purpose,
      priority,
      kind: "json",
      status: "collected",
      content,
      truncatedBytes,
    });
  }
  return artifacts;
};

/** Read, scrub and tail one text file into an artifact. */
const collectTextFile = async (
  file: string,
  path: string,
  purpose: string,
  priority: number,
  maxBytes: number,
  known: KnownSecretSet | undefined,
  owner: number | undefined,
): Promise<Artifact> => {
  try {
    const read = await readFileTail(path, maxBytes, ownerConstraint(owner));
    const tail = tailText(scrubDiagnosticText(read.text, known), maxBytes);
    return {
      file,
      purpose,
      priority,
      kind: "text",
      status: "collected",
      content: tail.text,
      truncatedBytes: read.skippedBytes + tail.droppedBytes,
    };
  } catch (error) {
    return unavailable(file, purpose, priority, "text", describeFailure(error));
  }
};

const collectNpmLogs = async (
  source: Extract<DiagnosticsSource, { kind: "npm-logs" }>,
  known: KnownSecretSet | undefined,
): Promise<Artifact[]> => {
  const priority = source.priority ?? DIAGNOSTICS_PRIORITY.npmLogs;
  const purpose = "npm debug log (tail): the package install's own record of what failed";
  const found: ListedFile[] = [];
  for (const dir of source.dirs) {
    found.push(...(await listNewestFiles(dir, (name) => NPM_DEBUG_LOG_RE.test(name))));
  }
  const newest = found
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, source.limit ?? DEFAULT_SOURCE_CAPS.npmLogs);
  if (newest.length === 0) {
    return [unavailable("files/npm-logs/", purpose, priority, "text", "no npm debug logs found")];
  }
  const artifacts: Artifact[] = [];
  const used = new Set<string>();
  for (const [index, entry] of newest.entries()) {
    const name =
      SAFE_SEGMENT_RE.test(entry.name) && !used.has(entry.name)
        ? entry.name
        : `npm-debug-${index + 1}.log`;
    used.add(name);
    artifacts.push(
      await collectTextFile(
        `files/npm-logs/${name}`,
        entry.path,
        purpose,
        priority,
        source.maxBytes ?? DEFAULT_SOURCE_CAPS.npmLogBytes,
        known,
        source.owner,
      ),
    );
  }
  return artifacts;
};

const collectJsonFile = async (
  source: Extract<DiagnosticsSource, { kind: "json-file" }>,
  known: KnownSecretSet | undefined,
): Promise<Artifact> => {
  const priority = source.priority ?? DIAGNOSTICS_PRIORITY.versions;
  const file = `files/${source.name}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      await readSmallFile(
        source.path,
        source.maxBytes ?? DEFAULT_SOURCE_CAPS.jsonFileBytes,
        ownerConstraint(source.owner),
      ),
    );
  } catch (error) {
    return unavailable(
      file,
      source.purpose,
      priority,
      "json",
      error instanceof SyntaxError ? "not valid JSON" : describeFailure(error),
    );
  }
  const picked = source.pick === undefined ? parsed : source.pick(parsed);
  return {
    file,
    purpose: source.purpose,
    priority,
    kind: "json",
    status: "collected",
    content: serialize(scrubDiagnosticValue(picked, known)),
    truncatedBytes: 0,
  };
};

const collectJournal = async (
  source: Extract<DiagnosticsSource, { kind: "journal" }>,
  run: DiagnosticsRunCommand,
  known: KnownSecretSet | undefined,
): Promise<Artifact> => {
  const priority = source.priority ?? DIAGNOSTICS_PRIORITY.journal;
  const maxBytes = source.maxBytes ?? DEFAULT_SOURCE_CAPS.journalBytes;
  const file = `files/journal/${source.unit}.txt`;
  const purpose = `Journal of ${source.unit} for the ${
    source.previousBoot === true ? "previous and current boot" : "current boot"
  } (tail)`;
  const boots = source.previousBoot === true ? ["-1", "0"] : ["0"];
  const sections: string[] = [];
  const failures: string[] = [];
  for (const boot of boots) {
    try {
      const { stdout } = await run("journalctl", [
        "--unit",
        source.unit,
        "--boot",
        boot,
        "--no-pager",
        "--quiet",
        "--output=short-iso",
        "--lines",
        String(JOURNAL_LINES),
      ]);
      sections.push(`=== boot ${boot === "0" ? "current" : "previous"} ===\n${stdout}`);
    } catch (error) {
      failures.push(`boot ${boot}: ${describeFailure(error)}`);
    }
  }
  if (sections.length === 0) {
    return unavailable(file, purpose, priority, "text", failures.join("; "));
  }
  const tail = tailText(scrubDiagnosticText(sections.join("\n"), known), maxBytes);
  return {
    file,
    purpose,
    priority,
    kind: "text",
    status: "collected",
    content: tail.text,
    truncatedBytes: tail.droppedBytes,
    ...(failures.length === 0 ? {} : { reason: `partially available (${failures.join("; ")})` }),
  };
};

/** `vcgencmd get_throttled` bit meanings (Raspberry Pi firmware). */
const THROTTLE_BITS: readonly (readonly [number, string])[] = [
  [0, "underVoltageNow"],
  [1, "frequencyCappedNow"],
  [2, "throttledNow"],
  [3, "softTemperatureLimitNow"],
  [16, "underVoltageOccurred"],
  [17, "frequencyCappedOccurred"],
  [18, "throttledOccurred"],
  [19, "softTemperatureLimitOccurred"],
];

export const decodeThrottled = (raw: string): Record<string, unknown> | null => {
  const match = /throttled=(0x[0-9a-fA-F]+)/u.exec(raw);
  if (match?.[1] === undefined) {
    return null;
  }
  const value = Number.parseInt(match[1], 16);
  const flags: Record<string, unknown> = { raw: match[1] };
  for (const [bit, name] of THROTTLE_BITS) {
    flags[name] = (value & (1 << bit)) !== 0;
  }
  return flags;
};

const OS_RELEASE_KEYS = ["PRETTY_NAME", "ID", "VERSION_ID", "VERSION_CODENAME"];

/**
 * Hardware and OS summary. Everything a "is this device fit to install on?"
 * question needs: model, memory, disk, OS, kernel, clock, and on a Raspberry
 * Pi the firmware's under-voltage / throttling flags — a classic cause of
 * install failures that looks like anything but a power problem.
 */
export const collectSystemSummary = async (
  run: DiagnosticsRunCommand,
  readKernelFile: (path: string) => Promise<string>,
): Promise<Record<string, unknown>> => {
  const summary: Record<string, unknown> = {};
  const tryRead = async (path: string): Promise<string | null> => {
    try {
      return await readKernelFile(path);
    } catch {
      return null;
    }
  };

  const model =
    (await tryRead("/proc/device-tree/model")) ?? (await tryRead("/sys/class/dmi/id/product_name"));
  summary.model = model === null ? null : model.replace(/\0/gu, "").trim();

  const meminfo = await tryRead("/proc/meminfo");
  const memTotalKb = meminfo === null ? null : /MemTotal:\s+(\d+)/u.exec(meminfo)?.[1];
  summary.memoryTotalBytes =
    memTotalKb === null || memTotalKb === undefined ? totalmem() : Number(memTotalKb) * 1024;

  const osRelease = await tryRead("/etc/os-release");
  const os: Record<string, string> = {};
  for (const line of osRelease?.split("\n") ?? []) {
    const match = /^([A-Z_]+)=(.*)$/u.exec(line.trim());
    if (match?.[1] !== undefined && OS_RELEASE_KEYS.includes(match[1])) {
      os[match[1]] = String(match[2]).replace(/^"(.*)"$/u, "$1");
    }
  }
  summary.os = os;
  summary.kernel = release();
  summary.arch = arch();
  summary.uptimeSeconds = Math.floor(uptime());
  summary.nodeRuntime = process.version;

  try {
    const { stdout } = await run("df", ["-Pk", "/", "/var/lib"]);
    summary.disks = stdout
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => line.split(/\s+/u))
      .filter((fields) => fields.length >= 6)
      .map(([, total, , available, usePercent, mountedOn]) => ({
        mountedOn,
        totalKb: Number(total),
        availableKb: Number(available),
        usePercent,
      }));
  } catch {
    summary.disks = null;
  }

  try {
    const { stdout } = await run("timedatectl", [
      "show",
      "-p",
      "NTPSynchronized",
      "-p",
      "Timezone",
    ]);
    summary.clock = Object.fromEntries(
      stdout
        .trim()
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
  } catch {
    summary.clock = null;
  }
  summary.observedAt = new Date().toISOString();

  try {
    const { stdout } = await run("vcgencmd", ["get_throttled"]);
    summary.piThrottling = decodeThrottled(stdout);
  } catch {
    // Not a Raspberry Pi, or firmware tools absent: absent, not "fine".
    summary.piThrottling = null;
  }
  return summary;
};

/** Mark an optional source's plain absence (and only that) as expected. */
const excuseAbsence = (source: { readonly optional?: boolean }, artifact: Artifact): Artifact => {
  if (
    source.optional === true &&
    artifact.status === "unavailable" &&
    artifact.reason === "not present"
  ) {
    artifact.optional = true;
  }
  return artifact;
};

const collectSource = async (
  source: DiagnosticsSource,
  known: KnownSecretSet | undefined,
  run: DiagnosticsRunCommand,
  readKernelFile: (path: string) => Promise<string>,
): Promise<Artifact[]> => {
  switch (source.kind) {
    case "install-jobs":
      return await collectInstallJobs(source, known);
    case "npm-logs":
      return await collectNpmLogs(source, known);
    case "file-tail":
      return [
        excuseAbsence(
          source,
          await collectTextFile(
            `files/${source.name}`,
            source.path,
            source.purpose,
            source.priority ?? DIAGNOSTICS_PRIORITY.logs,
            source.maxBytes ?? DEFAULT_SOURCE_CAPS.fileTailBytes,
            known,
            source.owner,
          ),
        ),
      ];
    case "json-file":
      return [excuseAbsence(source, await collectJsonFile(source, known))];
    case "journal":
      return [await collectJournal(source, run, known)];
    case "system":
      return [
        {
          file: "files/system.json",
          purpose: "Hardware and OS: model, memory, disk, OS, kernel, clock, Pi power/throttling",
          priority: source.priority ?? DIAGNOSTICS_PRIORITY.system,
          kind: "json",
          status: "collected",
          content: serialize(
            scrubDiagnosticValue(await collectSystemSummary(run, readKernelFile), known),
          ),
          truncatedBytes: 0,
        },
      ];
    case "value":
      return [
        {
          file: `files/${source.name}`,
          purpose: source.purpose,
          priority: source.priority ?? DIAGNOSTICS_PRIORITY.versions,
          kind: "json",
          status: "collected",
          content: serialize(scrubDiagnosticValue(source.value, known)),
          truncatedBytes: 0,
        },
      ];
  }
};

/** Reject names a caller supplied that could escape `files/` or collide. */
const validateSourceName = (source: DiagnosticsSource): void => {
  if (source.kind === "file-tail" || source.kind === "json-file" || source.kind === "value") {
    if (!SAFE_SEGMENT_RE.test(source.name) || /^\.+$/u.test(source.name)) {
      throw new Error(`unsafe diagnostics source name: ${JSON.stringify(source.name)}`);
    }
  }
  if (source.kind === "journal" && !SAFE_UNIT_RE.test(source.unit)) {
    throw new Error(`unsafe journal unit name: ${JSON.stringify(source.unit)}`);
  }
};

// ── Guard, shedding, packaging ─────────────────────────────────────────────

const applyShapeGuard = (artifact: Artifact): void => {
  if (artifact.status !== "collected" || artifact.content === undefined) {
    return;
  }
  const hits = findSecretShapes(artifact.content);
  if (hits.length > 0) {
    artifact.status = "withheld";
    artifact.content = undefined;
    artifact.reason = `withheld: text still matched credential shape(s) after redaction (${hits.join(", ")})`;
  }
};

const contentBytes = (artifact: Artifact): number =>
  artifact.content === undefined ? 0 : Buffer.byteLength(artifact.content);

/**
 * Bring the total under `maxTotalBytes` by shortening, then dropping, the
 * least important artifacts. Text is shortened (tail kept) down to a floor
 * before it is dropped; JSON is dropped whole, because half a JSON document
 * is not a document.
 */
export const shedToFit = (artifacts: Artifact[], maxTotalBytes: number): void => {
  let total = artifacts.reduce((sum, artifact) => sum + contentBytes(artifact), 0);
  const byLeastImportant = artifacts
    .filter((artifact) => artifact.status === "collected")
    .sort(
      (left, right) => right.priority - left.priority || contentBytes(right) - contentBytes(left),
    );
  for (const artifact of byLeastImportant) {
    if (total <= maxTotalBytes) {
      return;
    }
    const size = contentBytes(artifact);
    const excess = total - maxTotalBytes;
    if (
      artifact.kind === "text" &&
      artifact.content !== undefined &&
      size - excess >= MIN_SHORTENED_BYTES
    ) {
      const tail = tailText(artifact.content, size - excess);
      artifact.content = tail.text;
      artifact.truncatedBytes += tail.droppedBytes;
      artifact.reason = "shortened to fit the bundle size cap";
      total -= size - contentBytes(artifact);
      continue;
    }
    artifact.status = "shed";
    artifact.content = undefined;
    artifact.reason = "dropped to fit the bundle size cap (lower priority than the kept files)";
    total -= size;
  }
};

const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

export const REDACTION_POLICY: readonly string[] = [
  "Only named files, directories and system journals are read; nothing is swept, symlinks are refused.",
  "Structured records keep only allowlisted fields; install job records never include the install request.",
  "Every value the device holds as a secret (secrets directory, config secret references, tokens) is replaced wherever it appears, including URL-encoded and JSON-escaped forms.",
  "Pattern redaction removes passwords, API keys, access tokens, bearer credentials, private keys and URL credentials.",
  "Email addresses keep only their domain (***@example.com).",
  "A file that still contains anything shaped like a credential after redaction is withheld, not shipped.",
];

export const EXCLUDED_CONTENT: readonly string[] = [
  "Passwords, API keys, access tokens, private keys and the secrets directory itself",
  "Mail content: no subjects, senders, recipients or message bodies",
  "The install request as submitted (it held credentials on older releases)",
  "Configuration files as a whole",
];

export const renderReadme = (manifest: DiagnosticsManifest): string => {
  const lines = [
    "DIAGNOSTICS FILE — what is in here",
    "==================================",
    "",
    `Created ${manifest.generatedAt} by ${manifest.generatedBy}.`,
    "It was created on the device itself and has not been sent anywhere.",
    "Read it before you send it: every included file is plain text.",
    "",
    manifest.complete
      ? "All sources were collected."
      : "Some sources were unavailable, withheld or dropped — see the list below.",
    "",
    "Included:",
  ];
  for (const entry of manifest.files) {
    if (entry.status === "collected") {
      lines.push(
        `  ${entry.file}${entry.truncated ? " (tail only)" : ""}`,
        `      ${entry.purpose}`,
      );
    }
  }
  const missing = manifest.files.filter(
    (entry) => entry.status !== "collected" && entry.optional !== true,
  );
  if (missing.length > 0) {
    lines.push("", "Not included:");
    for (const entry of missing) {
      lines.push(`  ${entry.file} — ${entry.status}: ${entry.reason ?? ""}`);
    }
  }
  const absent = manifest.files.filter((entry) => entry.optional === true);
  if (absent.length > 0) {
    lines.push("", "Not present on this device (normal):");
    for (const entry of absent) {
      lines.push(`  ${entry.file}`);
    }
  }
  lines.push("", "Never included:");
  for (const item of manifest.excluded) {
    lines.push(`  - ${item}`);
  }
  lines.push("", "How it was cleaned:");
  for (const item of manifest.redactionPolicy) {
    lines.push(`  - ${item}`);
  }
  lines.push("", "manifest.json lists every file with its size and SHA-256 checksum.", "");
  return lines.join("\n");
};

/**
 * Build the install diagnostics archive.
 *
 * Never throws for a missing or unreadable source — that is recorded. Throws
 * only for caller errors (an unsafe source name).
 */
export const buildInstallDiagnostics = async (
  options: InstallDiagnosticsOptions,
): Promise<InstallDiagnosticsResult> => {
  for (const source of options.sources) {
    validateSourceName(source);
  }
  const now = (options.now ?? (() => new Date()))();
  const run = options.run ?? defaultDiagnosticsRun;
  const readKernelFile = options.readKernelFile ?? defaultReadKernelFile;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const known = options.knownSecrets;

  const artifacts: Artifact[] = [];
  const seen = new Set<string>();
  for (const source of options.sources) {
    for (const artifact of await collectSource(source, known, run, readKernelFile)) {
      if (seen.has(artifact.file)) {
        throw new Error(`duplicate diagnostics file name: ${artifact.file}`);
      }
      seen.add(artifact.file);
      applyShapeGuard(artifact);
      artifacts.push(artifact);
    }
  }
  shedToFit(artifacts, maxTotalBytes);

  const entries: { name: string; data: Buffer }[] = [];
  const files: DiagnosticsManifestEntry[] = artifacts.map((artifact) => {
    const data = artifact.content === undefined ? undefined : Buffer.from(artifact.content, "utf8");
    if (data !== undefined) {
      entries.push({ name: artifact.file, data });
    }
    return {
      file: artifact.file,
      purpose: artifact.purpose,
      priority: artifact.priority,
      status: artifact.status,
      bytes: data?.byteLength ?? 0,
      sha256: data === undefined ? "" : sha256(data),
      truncated: artifact.truncatedBytes > 0,
      truncatedBytes: artifact.truncatedBytes,
      ...(artifact.reason === undefined ? {} : { reason: artifact.reason }),
      ...(artifact.optional === true ? { optional: true } : {}),
    };
  });
  const complete = artifacts.every(
    (artifact) => artifact.status === "collected" || artifact.optional === true,
  );

  const manifest: DiagnosticsManifest = {
    formatVersion: INSTALL_DIAGNOSTICS_FORMAT_VERSION,
    kind: "install-diagnostics",
    generatedAt: now.toISOString(),
    generatedBy: options.generatedBy,
    complete,
    product: scrubDiagnosticValue(options.product ?? null, known),
    limits: { maxTotalBytes },
    totalBytes: files.reduce((sum, entry) => sum + entry.bytes, 0),
    redactionPolicy: REDACTION_POLICY,
    excluded: EXCLUDED_CONTENT,
    files,
    notes: complete
      ? []
      : [
          "This file is INCOMPLETE. Some sources could not be collected, were withheld by the " +
            "credential guard, or were dropped to fit the size cap; see each file's status and reason.",
        ],
  };

  const archive = createZip(
    [
      { name: "manifest.json", data: Buffer.from(serialize(manifest), "utf8") },
      { name: "README.txt", data: Buffer.from(renderReadme(manifest), "utf8") },
      ...entries,
    ],
    now,
  );
  return { archive, sha256: sha256(archive), bytes: archive.byteLength, complete, manifest };
};

// ── Node defaults (used by the CLI; consumers compose their own) ───────────

/** Where npm writes debug logs for a given HOME. */
export const npmLogsDir = (home: string): string => join(home, ".npm", "_logs");

/**
 * The node's own sources: its install job records, the npm logs of the
 * service account and of root (CLI installs run as root), its services'
 * journals, the install provenance and the system summary.
 */
export const defaultNodeDiagnosticsSources = (
  paths: SovereignPaths = DEFAULT_PATHS,
): DiagnosticsSource[] => [
  { kind: "install-jobs", dir: paths.installJobsDir },
  { kind: "npm-logs", dirs: [npmLogsDir(paths.stateDir), npmLogsDir("/root")] },
  {
    kind: "journal",
    unit: "sovereign-node-api",
    previousBoot: true,
    priority: DIAGNOSTICS_PRIORITY.installJournal,
  },
  { kind: "journal", unit: "sovereign-openclaw-gateway", previousBoot: true },
  {
    kind: "json-file",
    name: "install-provenance.json",
    path: paths.provenancePath,
    purpose: "How and when this node was installed (source, ref, versions)",
    optional: true,
    pick: (parsed) =>
      pickFields(parsed, ["installedAt", "source", "ref", "version", "commit", "installMode"]),
  },
  { kind: "system" },
];

/** The node's own secret stores. */
export const defaultNodeKnownSecretSources = (
  paths: SovereignPaths = DEFAULT_PATHS,
): KnownSecretSources => ({
  secretDirs: [paths.secretsDir],
  structuredFiles: [paths.configPath],
  recordDirs: [paths.installJobsDir],
});

/** `sovereign-ai-node-diagnostics-<YYYY-MM-DD>-<id>.zip` */
export const diagnosticsFileName = (date: Date, id: string): string =>
  `sovereign-ai-node-diagnostics-${date.toISOString().slice(0, 10)}-${id}.zip`;
