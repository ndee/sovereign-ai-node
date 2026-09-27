import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  openRegularFile,
  readFileTail,
  readSmallFile,
  TAIL_READ_MARGIN_BYTES,
  tailText,
  truncationMarker,
  UnreadableFileError,
} from "./tail.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tail-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const lines = (count: number, prefix = "line"): string =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index}`).join("\n");

describe("tailText", () => {
  it("returns short text unchanged", () => {
    expect(tailText("abc\ndef", 100)).toEqual({ text: "abc\ndef", droppedBytes: 0 });
  });

  it("keeps the tail, not the head, with a marker naming the dropped bytes", () => {
    const text = `${lines(2000)}\nFINAL ERROR LINE`;
    const result = tailText(text, 1024);
    expect(result.text).toContain("FINAL ERROR LINE");
    expect(result.text).not.toContain("line 0\n");
    expect(result.text.startsWith("…[truncated ")).toBe(true);
    expect(result.droppedBytes).toBeGreaterThan(0);
    expect(result.text).toContain(truncationMarker(result.droppedBytes));
  });

  it("never exceeds the cap, marker included", () => {
    const text = lines(5000);
    for (const cap of [200, 1024, 4096]) {
      expect(Buffer.byteLength(tailText(text, cap).text)).toBeLessThanOrEqual(cap);
    }
  });

  it("cuts on a line boundary so no partial first line survives", () => {
    const text = `AAAA-SECRET-PREFIX-${"x".repeat(300)}-SUFFIX\nkept line\n`;
    const result = tailText(text, 200);
    expect(result.text).not.toContain("SUFFIX");
    expect(result.text).toContain("kept line");
  });

  it("keeps nothing but the marker when the tail is a single partial line", () => {
    const result = tailText("y".repeat(5000), 500);
    expect(result.text).toBe(truncationMarker(5000));
  });

  it("handles a cap smaller than the marker reserve", () => {
    const result = tailText(lines(100), 10);
    expect(result.droppedBytes).toBe(Buffer.byteLength(lines(100)));
  });

  it("does not split multi-byte characters", () => {
    const text = `${"ä".repeat(3000)}\nüöß end`;
    const result = tailText(text, 400);
    expect(result.text).toContain("üöß end");
    expect(result.text).not.toContain("�");
  });
});

describe("readFileTail", () => {
  it("reads a small file whole", async () => {
    const path = join(dir, "small.log");
    await writeFile(path, "a\nb\n");
    expect(await readFileTail(path, 1024)).toEqual({
      text: "a\nb\n",
      skippedBytes: 0,
      fileBytes: 4,
    });
  });

  it("reads only a window at the end of a large file, dropping the partial first line", async () => {
    const path = join(dir, "big.log");
    const content = `${lines(40_000, "entry")}\nTHE END\n`;
    await writeFile(path, content);
    const result = await readFileTail(path, 1024);
    expect(result.fileBytes).toBe(Buffer.byteLength(content));
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(1024 + TAIL_READ_MARGIN_BYTES);
    expect(result.text.endsWith("THE END\n")).toBe(true);
    // The window starts on a whole line.
    expect(result.text.startsWith("entry ")).toBe(true);
    expect(result.skippedBytes + Buffer.byteLength(result.text)).toBe(result.fileBytes);
  });

  it("refuses a symlink", async () => {
    const target = join(dir, "target");
    await writeFile(target, "secret");
    await symlink(target, join(dir, "link"));
    await expect(readFileTail(join(dir, "link"), 100)).rejects.toThrow(
      "refused: path is a symbolic link",
    );
  });

  it("refuses a directory", async () => {
    await mkdir(join(dir, "sub"));
    await expect(readFileTail(join(dir, "sub"), 100)).rejects.toThrow(
      "refused: not a regular file",
    );
  });

  it("reports a missing file as not present", async () => {
    await expect(readFileTail(join(dir, "missing"), 100)).rejects.toBeInstanceOf(
      UnreadableFileError,
    );
    await expect(readFileTail(join(dir, "missing"), 100)).rejects.toThrow("not present");
    await expect(readFileTail(join(dir, "missing", "deeper"), 100)).rejects.toThrow("not present");
  });

  it("reports other open failures with their code", async () => {
    await expect(openRegularFile("\0bad")).rejects.toBeInstanceOf(UnreadableFileError);
  });
});

describe("readSmallFile", () => {
  it("reads a file under the limit", async () => {
    const path = join(dir, "value");
    await writeFile(path, "hello");
    expect(await readSmallFile(path, 10)).toBe("hello");
  });

  it("refuses a file over the limit instead of cutting it", async () => {
    const path = join(dir, "value");
    await writeFile(path, "hello world");
    await expect(readSmallFile(path, 5)).rejects.toThrow("refused: larger than 5 bytes");
  });
});
