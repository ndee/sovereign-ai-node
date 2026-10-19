import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { writeCliSuccess } from "./output.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const capture = (): string[] => {
  const written: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
  return written;
};

describe("writeCliSuccess", () => {
  const schema = z.object({ ranges: z.array(z.tuple([z.number(), z.number()])) });
  const result = { ranges: [[1, 5] as [number, number]] };

  it("pretty-prints the JSON envelope by default", () => {
    const written = capture();
    writeCliSuccess("example", result, schema, true);
    expect(written.join("")).toContain('\n  "ok": true,\n');
    expect(JSON.parse(written.join(""))).toMatchObject({ ok: true, command: "example", result });
  });

  it("emits one compact line when asked to", () => {
    const written = capture();
    writeCliSuccess("example", result, schema, true, { compact: true });
    const output = written.join("");
    expect(output.trimEnd().split("\n")).toHaveLength(1);
    expect(JSON.parse(output)).toMatchObject({ ok: true, result });
  });
});
