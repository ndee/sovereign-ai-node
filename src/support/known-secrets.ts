/**
 * Known-secret value scrubbing.
 *
 * Pattern redaction (`redact.ts`) recognises secrets by their SHAPE or by the
 * word next to them. A mailbox password has no shape: `Tr0ub4dor&3` in a log
 * line looks like any other token, and nothing guarantees the word "password"
 * sits beside it. The only reliable defence for such a value is to know it.
 *
 * The node owns its secrets — they sit in the secrets directory, are referenced
 * from its config, and (on older releases) were persisted inline in install job
 * records. This module reads those VALUES into memory and replaces every exact
 * occurrence, plus the encoded forms a value takes in URLs and JSON, with a
 * marker.
 *
 * # The set never leaves memory
 *
 * `KnownSecretSet` has no accessor for its values, serialises to a fixed
 * placeholder (`toJSON`) and inspects to one too, so a stray `JSON.stringify`
 * or a debug log of the object cannot write the secrets it exists to remove.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { inspect } from "node:util";

import JSON5 from "json5";

import { isSecretKey } from "./redact.js";
import { readSmallFile } from "./tail.js";

/** Marker written in place of a known secret value. */
export const REDACTED_KNOWN = "[REDACTED:known]";

/**
 * Values shorter than this are not scrubbed. Replacing every occurrence of a
 * three-character value would shred ordinary text while protecting nothing a
 * reader could use.
 */
export const MIN_KNOWN_SECRET_LENGTH = 6;

/** Secret files are small; anything larger is not a credential file. */
const MAX_SECRET_FILE_BYTES = 64 * 1024;

/** Config files and job records can be larger than a single secret. */
const MAX_STRUCTURED_FILE_BYTES = 4 * 1024 * 1024;

/** Bound the walk of a secrets directory. */
const MAX_SECRET_FILES = 256;
const MAX_SECRET_DIR_DEPTH = 3;

/** Bound the walk of a parsed config or record. */
const MAX_HARVEST_DEPTH = 16;

const PLACEHOLDER = "[KnownSecretSet]";

/**
 * Every form in which a value can appear in the text we scrub: verbatim,
 * URL-encoded (query strings, `user:pass@` URLs) and JSON-escaped (a value
 * inside a serialised log line).
 */
const encodedForms = (value: string): string[] => {
  const forms = new Set<string>([value]);
  forms.add(encodeURIComponent(value));
  forms.add(JSON.stringify(value).slice(1, -1));
  return [...forms];
};

export class KnownSecretSet {
  // A true private field: not enumerable, not reachable through Object.keys,
  // JSON.stringify or structuredClone.
  readonly #needles: string[];

  constructor(values: Iterable<string>) {
    const needles = new Set<string>();
    for (const raw of values) {
      const value = raw.trim();
      if (value.length < MIN_KNOWN_SECRET_LENGTH) {
        continue;
      }
      for (const form of encodedForms(value)) {
        needles.add(form);
      }
    }
    // Longest first, so a secret that contains another secret is replaced as a
    // whole instead of leaving its remainder behind.
    this.#needles = [...needles].sort((left, right) => right.length - left.length);
  }

  /** Number of distinct needles (values × encodings). Safe to log. */
  get size(): number {
    return this.#needles.length;
  }

  /** Replace every known value in `text`; reports how many replacements happened. */
  scrub(text: string): { text: string; replaced: number } {
    let output = text;
    let replaced = 0;
    for (const needle of this.#needles) {
      if (!output.includes(needle)) {
        continue;
      }
      const parts = output.split(needle);
      replaced += parts.length - 1;
      output = parts.join(REDACTED_KNOWN);
    }
    return { text: output, replaced };
  }

  toJSON(): string {
    return PLACEHOLDER;
  }

  toString(): string {
    return PLACEHOLDER;
  }

  [inspect.custom](): string {
    return PLACEHOLDER;
  }
}

/**
 * Split a secret file's content into the values it holds.
 *
 * Most secret files hold one value. Some hold `KEY=value` lines (env files) or
 * several lines (a PEM key). Every whole line is a candidate, and for
 * assignment lines the right-hand side is one too, with surrounding quotes
 * removed.
 */
export const valuesFromSecretText = (text: string): string[] => {
  const values = [text];
  for (const line of text.split(/\r?\n/u)) {
    values.push(line);
    const assignment = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/u.exec(line);
    if (assignment?.[1] !== undefined) {
      values.push(assignment[1].replace(/^(["'])(.*)\1$/u, "$2"));
    }
  }
  return values;
};

/**
 * Values under a secret-named key that are evidently NOT secrets: an absolute
 * path (`secretsDir`), a timestamp (`tokenExpiresAt`), a number or a boolean.
 * Scrubbing those would erase ordinary diagnostic text everywhere they occur.
 */
const NOT_A_SECRET_RE =
  /^(?:\/.*|\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?|-?\d+(?:\.\d+)?|true|false|null)$/u;

/**
 * Collect secret values from a parsed config or record.
 *
 * Any string under a secret-named key is a value to scrub. `file:` references
 * are returned separately so the caller can read the referenced file; `env:`
 * references name a variable, not a value, and are skipped.
 */
export const harvestSecretValues = (input: unknown): { values: string[]; fileRefs: string[] } => {
  const values: string[] = [];
  const fileRefs: string[] = [];
  const walk = (node: unknown, underSecretKey: boolean, depth: number): void => {
    if (depth > MAX_HARVEST_DEPTH || node === null || node === undefined) {
      return;
    }
    if (typeof node === "string") {
      if (node.startsWith("file:")) {
        fileRefs.push(node.slice("file:".length));
      } else if (underSecretKey && !node.startsWith("env:") && !NOT_A_SECRET_RE.test(node)) {
        values.push(node);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const entry of node) {
        walk(entry, underSecretKey, depth + 1);
      }
      return;
    }
    if (typeof node === "object") {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        walk(value, underSecretKey || isSecretKey(key), depth + 1);
      }
    }
  };
  walk(input, false, 0);
  return { values, fileRefs };
};

export interface KnownSecretSources {
  /** Directories whose regular files are each a secret (walked, bounded). */
  readonly secretDirs?: readonly string[];
  /** Individual secret files (tokens, keys). */
  readonly secretFiles?: readonly string[];
  /** JSON / JSON5 files whose secret-named fields and `file:` refs are harvested. */
  readonly structuredFiles?: readonly string[];
  /** Env files: every assignment value under a secret-named key is harvested. */
  readonly envFiles?: readonly string[];
  /** Directories of JSON records (e.g. install job records) to harvest. */
  readonly recordDirs?: readonly string[];
  /** Values the caller already holds. */
  readonly values?: readonly string[];
}

const readOptional = async (
  path: string,
  maxBytes: number = MAX_SECRET_FILE_BYTES,
): Promise<string | undefined> => {
  try {
    return await readSmallFile(path, maxBytes);
  } catch {
    return undefined;
  }
};

const listFiles = async (directory: string, depth: number, out: string[]): Promise<void> => {
  if (depth > MAX_SECRET_DIR_DEPTH || out.length >= MAX_SECRET_FILES) {
    return;
  }
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_SECRET_FILES) {
      return;
    }
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      await listFiles(full, depth + 1, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
};

const parseStructured = (text: string): unknown => {
  try {
    return JSON5.parse(text);
  } catch {
    return undefined;
  }
};

/**
 * Build the known-secret set from the node's own secret stores.
 *
 * Every source is optional and failure-tolerant: a missing directory or an
 * unreadable file contributes nothing, and never stops a diagnostic run. The
 * contents are held only in the returned set.
 */
export const loadKnownSecrets = async (sources: KnownSecretSources): Promise<KnownSecretSet> => {
  const values: string[] = [...(sources.values ?? [])];
  const secretFiles: string[] = [...(sources.secretFiles ?? [])];

  for (const directory of sources.secretDirs ?? []) {
    await listFiles(directory, 0, secretFiles);
  }

  const structuredFiles: string[] = [...(sources.structuredFiles ?? [])];
  for (const directory of sources.recordDirs ?? []) {
    const found: string[] = [];
    await listFiles(directory, MAX_SECRET_DIR_DEPTH, found);
    structuredFiles.push(...found.filter((path) => path.endsWith(".json")));
  }

  for (const path of structuredFiles) {
    const text = await readOptional(path, MAX_STRUCTURED_FILE_BYTES);
    if (text === undefined) {
      continue;
    }
    const harvested = harvestSecretValues(parseStructured(text));
    values.push(...harvested.values);
    secretFiles.push(...harvested.fileRefs);
  }

  for (const path of sources.envFiles ?? []) {
    const text = await readOptional(path, MAX_STRUCTURED_FILE_BYTES);
    for (const line of text?.split(/\r?\n/u) ?? []) {
      const assignment = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
      if (assignment?.[1] !== undefined && isSecretKey(assignment[1])) {
        values.push(String(assignment[2]).replace(/^(["'])(.*)\1$/u, "$2"));
      }
    }
  }

  for (const path of new Set(secretFiles)) {
    const text = await readOptional(path);
    if (text !== undefined) {
      values.push(...valuesFromSecretText(text));
    }
  }

  return new KnownSecretSet(values);
};
