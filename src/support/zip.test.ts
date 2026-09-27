import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { crc32, createZip, isSafeEntryName, readZip, toDosDateTime } from "./zip.js";

const execFileAsync = promisify(execFile);

const hasUnzip = await execFileAsync("unzip", ["-v"]).then(
  () => true,
  () => false,
);

const when = new Date("2026-09-27T10:11:12Z");

describe("crc32", () => {
  it("matches the standard check value", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });
});

describe("toDosDateTime", () => {
  it("encodes date and time", () => {
    const { time, date } = toDosDateTime(when);
    expect(date >> 9).toBe(2026 - 1980);
    expect((date >> 5) & 0xf).toBe(9);
    expect(date & 0x1f).toBe(27);
    expect(time >> 11).toBe(10);
    expect((time >> 5) & 0x3f).toBe(11);
    expect((time & 0x1f) * 2).toBe(12);
  });

  it("clamps years the format cannot express", () => {
    expect(toDosDateTime(new Date("1970-01-01T00:00:00Z")).date >> 9).toBe(0);
    expect(toDosDateTime(new Date("2200-01-01T00:00:00Z")).date >> 9).toBe(127);
  });
});

describe("isSafeEntryName", () => {
  it.each([
    "manifest.json",
    "files/a.txt",
    "files/npm-logs/x_debug-0.log",
  ])("accepts %s", (name) => {
    expect(isSafeEntryName(name)).toBe(true);
  });
  it.each([
    "/abs",
    "../x",
    "files/../x",
    "files//x",
    "",
    "a\\b",
    "files/..",
    "files/.",
  ])("rejects %s", (name) => {
    expect(isSafeEntryName(name)).toBe(false);
  });
});

describe("createZip / readZip", () => {
  it("round-trips entries byte for byte", () => {
    const entries = [
      { name: "manifest.json", data: Buffer.from('{"a":1}\n') },
      { name: "files/log.txt", data: Buffer.from("x".repeat(100_000)) },
      { name: "files/empty.txt", data: Buffer.alloc(0) },
      { name: "files/utf8.txt", data: Buffer.from("äöü ✓") },
    ];
    const archive = createZip(entries, when);
    expect(archive.readUInt32LE(0)).toBe(0x04034b50);
    const back = readZip(archive);
    expect(back.map((entry) => entry.name)).toEqual(entries.map((entry) => entry.name));
    for (const [index, entry] of back.entries()) {
      expect(entry.data.equals(entries[index]?.data ?? Buffer.alloc(1))).toBe(true);
    }
    // Deflate actually compresses.
    expect(archive.byteLength).toBeLessThan(10_000);
  });

  it("refuses unsafe and duplicate names", () => {
    expect(() => createZip([{ name: "../evil", data: Buffer.alloc(1) }], when)).toThrow(
      "refusing entry name",
    );
    expect(() =>
      createZip(
        [
          { name: "a", data: Buffer.alloc(1) },
          { name: "a", data: Buffer.alloc(1) },
        ],
        when,
      ),
    ).toThrow("refusing entry name");
  });

  it("refuses more entries than the format holds", () => {
    const entries = Array.from({ length: 0x10000 }, (_, index) => ({
      name: `f${index}`,
      data: Buffer.alloc(0),
    }));
    expect(() => createZip(entries, when)).toThrow("too many entries");
  });

  it("detects corruption on read", () => {
    const archive = createZip([{ name: "a.txt", data: Buffer.from("hello") }], when);
    const corrupt = Buffer.from(archive);
    // Flip the stored CRC in the central directory.
    const central = corrupt.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    corrupt.writeUInt32LE(0, central + 16);
    expect(() => readZip(corrupt)).toThrow("checksum mismatch");
    expect(() => readZip(Buffer.from("not a zip at all, definitely not"))).toThrow(
      "end of central directory not found",
    );
    const badCentral = Buffer.from(archive);
    badCentral.writeUInt32LE(0, central);
    expect(() => readZip(badCentral)).toThrow("bad central directory entry");
  });

  it("reads stored (uncompressed) entries too", () => {
    const archive = createZip([{ name: "a.txt", data: Buffer.from("hello") }], when);
    const stored = Buffer.from(archive);
    const central = stored.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    stored.writeUInt16LE(0, central + 10);
    // Method 0 now claims the deflated bytes are the file: the CRC must catch it.
    expect(() => readZip(stored)).toThrow("checksum mismatch");
  });

  it.skipIf(!hasUnzip)("is accepted by the system unzip", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zip-test-"));
    try {
      const path = join(dir, "t.zip");
      await writeFile(
        path,
        createZip(
          [
            { name: "README.txt", data: Buffer.from("hello\n") },
            { name: "files/log.txt", data: Buffer.from("log\n".repeat(1000)) },
          ],
          when,
        ),
      );
      const { stdout } = await execFileAsync("unzip", ["-t", path]);
      expect(stdout).toContain("No errors detected");
      await execFileAsync("unzip", ["-q", path, "-d", join(dir, "out")]);
      expect(await readFile(join(dir, "out", "files", "log.txt"), "utf8")).toBe(
        "log\n".repeat(1000),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
