/**
 * Tail-preserving truncation for diagnostic text.
 *
 * Logs put the decisive line LAST: an npm debug log ends with the error code
 * and the failing syscall, a journal ends with the crash. Keeping the head of
 * an over-long log (what a plain `slice(0, n)` does) throws away exactly the
 * evidence a diagnosis needs, so everything here keeps the tail and says how
 * much of the head it dropped.
 *
 * # Cuts happen on line boundaries
 *
 * A cut in the middle of a line can leave the second half of a secret at the
 * start of the kept text, where no redaction rule can recognise it any more.
 * Both helpers therefore drop the partial first line after a cut. Combined
 * with redacting the full text BEFORE cutting (the caller's job), a secret can
 * never be split by a truncation point into a fragment that survives.
 */

import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";

/** Newline byte; UTF-8 never uses it inside a multi-byte sequence. */
const NEWLINE = 0x0a;

/** Extra bytes read beyond the cap so a line-boundary cut still keeps ~cap bytes. */
export const TAIL_READ_MARGIN_BYTES = 64 * 1024;

/** Room reserved for the truncation marker so the result stays within the cap. */
const MARKER_RESERVE_BYTES = 96;

/** Marker written at the top of truncated text. */
export const truncationMarker = (droppedBytes: number): string =>
  `…[truncated ${droppedBytes} bytes from head]\n`;

export interface TailResult {
  readonly text: string;
  /** Bytes removed from the head, 0 when nothing was removed. */
  readonly droppedBytes: number;
}

/**
 * Drop everything up to and including the first newline.
 *
 * Returns an empty buffer when there is no newline: the whole buffer is one
 * partial line, and a partial line is exactly what must not be kept.
 */
const dropPartialFirstLine = (buffer: Buffer): Buffer => {
  const index = buffer.indexOf(NEWLINE);
  return index < 0 ? Buffer.alloc(0) : buffer.subarray(index + 1);
};

/**
 * Keep the last `maxBytes` of `text`, cut on a line boundary.
 *
 * The result, marker included, never exceeds `maxBytes` (for any cap larger
 * than the marker itself).
 */
export const tailText = (text: string, maxBytes: number): TailResult => {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return { text, droppedBytes: 0 };
  }
  const budget = Math.max(0, maxBytes - MARKER_RESERVE_BYTES);
  const kept = dropPartialFirstLine(buffer.subarray(buffer.byteLength - budget));
  const droppedBytes = buffer.byteLength - kept.byteLength;
  return { text: `${truncationMarker(droppedBytes)}${kept.toString("utf8")}`, droppedBytes };
};

export interface FileTail {
  /** File content from the start of the first whole line inside the read window. */
  readonly text: string;
  /** Bytes of the file before the returned text. */
  readonly skippedBytes: number;
  /** Total file size. */
  readonly fileBytes: number;
}

/** Why a file could not be read, phrased for a manifest reader. */
export class UnreadableFileError extends Error {}

/**
 * Open a file for reading without following a symlink and without blocking on
 * a FIFO, then confirm through the open descriptor that it is a regular file.
 *
 * This runs as root in some deployments. Checking with `lstat` and THEN
 * opening would leave a window in which a planted symlink turns "read this
 * log" into "read any file on the host"; `O_NOFOLLOW` plus `fstat` on the
 * descriptor closes it.
 *
 * `O_NOFOLLOW` guards only the LAST path component. When a file sits in a
 * directory a less privileged account can write to, that account could swap a
 * parent directory for a symlink. Callers reading such locations pass the
 * account's uid as `owner`: a file it does not own is refused, so a swapped
 * directory can only ever lead to files the account could read anyway.
 */
export interface ReadConstraints {
  /** Required owner uid of the file, checked on the open descriptor. */
  readonly owner?: number;
}

export const openRegularFile = async (
  path: string,
  constraints: ReadConstraints = {},
): Promise<FileHandle> => {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") {
      throw new UnreadableFileError("refused: path is a symbolic link");
    }
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new UnreadableFileError("not present");
    }
    throw new UnreadableFileError(`unreadable (${String(code)})`);
  }
  const info = await handle.stat();
  if (!info.isFile()) {
    await handle.close();
    throw new UnreadableFileError("refused: not a regular file");
  }
  if (constraints.owner !== undefined && info.uid !== constraints.owner) {
    await handle.close();
    throw new UnreadableFileError("refused: not owned by the expected account");
  }
  return handle;
};

/**
 * Read the tail of a file without loading all of it.
 *
 * Reads at most `maxBytes + TAIL_READ_MARGIN_BYTES` from the end. When the read
 * does not start at offset 0, the partial first line is dropped, so a line —
 * and any secret on it — is either returned whole or not at all.
 */
export const readFileTail = async (
  path: string,
  maxBytes: number,
  constraints: ReadConstraints = {},
): Promise<FileTail> => {
  const handle = await openRegularFile(path, constraints);
  try {
    const fileBytes = (await handle.stat()).size;
    const windowBytes = Math.min(fileBytes, maxBytes + TAIL_READ_MARGIN_BYTES);
    const start = fileBytes - windowBytes;
    const buffer = Buffer.alloc(windowBytes);
    const { bytesRead } = await handle.read(buffer, 0, windowBytes, start);
    const window = buffer.subarray(0, bytesRead);
    const kept = start === 0 ? window : dropPartialFirstLine(window);
    return {
      text: kept.toString("utf8"),
      skippedBytes: start + (window.byteLength - kept.byteLength),
      fileBytes,
    };
  } finally {
    await handle.close();
  }
};

/**
 * Read a whole small file through the same no-follow, regular-file-only path.
 * Files above `maxBytes` are refused rather than silently cut, because the
 * callers parse the content (JSON, a secret value) and half a value is wrong.
 */
export const readSmallFile = async (
  path: string,
  maxBytes: number,
  constraints: ReadConstraints = {},
): Promise<string> => {
  const handle = await openRegularFile(path, constraints);
  try {
    const size = (await handle.stat()).size;
    if (size > maxBytes) {
      throw new UnreadableFileError(`refused: larger than ${maxBytes} bytes`);
    }
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
};
