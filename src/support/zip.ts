/**
 * Minimal ZIP writer (and reader, for verification).
 *
 * A diagnostics file is opened by a non-technical person on whatever desktop
 * they have, before they decide to send it. Every mainstream desktop opens a
 * `.zip` natively; a `.tar.gz` needs extra software on some of them. The format
 * subset needed here — a flat list of deflated files, no encryption, no
 * ZIP64 — is small enough to write directly on top of `node:zlib` instead of
 * adding a dependency to a package that runs as root.
 *
 * Entries are built from in-memory buffers under generated names; nothing is
 * read from disk and no name comes from outside the caller.
 */

import { deflateRawSync, inflateRawSync } from "node:zlib";

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
/** Version 2.0: deflate. */
const VERSION_NEEDED = 20;
/** Made by UNIX (3), spec version 2.0 — so the permission bits are honoured. */
const VERSION_MADE_BY = (3 << 8) | 20;
/** General purpose flag bit 11: names are UTF-8. */
const FLAG_UTF8 = 0x0800;
const METHOD_DEFLATE = 8;
/** Regular file, mode 0644, in the high 16 bits of the external attributes. */
const EXTERNAL_ATTRIBUTES = (0o100644 << 16) >>> 0;
/** Without ZIP64, sizes and offsets are 32-bit and entry counts 16-bit. */
const MAX_UINT32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;

/** Entry names we accept: relative, `/`-separated, no `..`, no empty segment. */
const SAFE_ENTRY_NAME_RE = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE 802.3), as ZIP requires. */
export const crc32 = (data: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

/** MS-DOS date and time, the only timestamp a basic ZIP header carries. */
export const toDosDateTime = (date: Date): { time: number; date: number } => {
  const year = Math.min(Math.max(date.getUTCFullYear(), 1980), 2107);
  return {
    time:
      (date.getUTCHours() << 11) |
      (date.getUTCMinutes() << 5) |
      Math.floor(date.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
};

export interface ZipEntry {
  readonly name: string;
  readonly data: Buffer;
}

export const isSafeEntryName = (name: string): boolean =>
  SAFE_ENTRY_NAME_RE.test(name) && !name.split("/").some((segment) => /^\.+$/u.test(segment));

/** Build a ZIP archive in memory. */
export const createZip = (entries: readonly ZipEntry[], modifiedAt: Date): Buffer => {
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`zip: too many entries (${entries.length})`);
  }
  const { time, date } = toDosDateTime(modifiedAt);
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  const seen = new Set<string>();
  let offset = 0;

  for (const entry of entries) {
    if (!isSafeEntryName(entry.name) || seen.has(entry.name)) {
      throw new Error(`zip: refusing entry name ${JSON.stringify(entry.name)}`);
    }
    seen.add(entry.name);
    const name = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.data);
    const checksum = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(METHOD_DEFLATE, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.byteLength, 18);
    local.writeUInt32LE(entry.data.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, 0);
    central.writeUInt16LE(VERSION_MADE_BY, 4);
    central.writeUInt16LE(VERSION_NEEDED, 6);
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(METHOD_DEFLATE, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.byteLength, 20);
    central.writeUInt32LE(entry.data.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    // extra, comment, disk number start, internal attributes: all zero.
    central.writeUInt32LE(EXTERNAL_ATTRIBUTES, 38);
    central.writeUInt32LE(offset, 42);

    localParts.push(local, name, compressed);
    centralParts.push(central, name);
    offset += local.byteLength + name.byteLength + compressed.byteLength;
    /* v8 ignore next 3 -- needs a >4 GiB archive; the diagnostics cap is 8 MiB. */
    if (offset > MAX_UINT32) {
      throw new Error("zip: archive exceeds 4 GiB");
    }
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
};

/**
 * Read back an archive produced by `createZip`. Used to verify output (tests,
 * self-checks); it supports exactly the subset `createZip` writes.
 */
export const readZip = (archive: Buffer): ZipEntry[] => {
  const endOffset = archive.lastIndexOf(
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    archive.byteLength - 22,
  );
  if (endOffset < 0) {
    throw new Error("zip: end of central directory not found");
  }
  const count = archive.readUInt16LE(endOffset + 10);
  let cursor = archive.readUInt32LE(endOffset + 16);
  const entries: ZipEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(cursor) !== CENTRAL_HEADER_SIGNATURE) {
      throw new Error("zip: bad central directory entry");
    }
    const method = archive.readUInt16LE(cursor + 10);
    const checksum = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = archive.subarray(dataStart, dataStart + compressedSize);
    const data = method === METHOD_DEFLATE ? inflateRawSync(raw) : Buffer.from(raw);
    if (crc32(data) !== checksum) {
      throw new Error(`zip: checksum mismatch for ${name}`);
    }
    entries.push({ name, data });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
};
