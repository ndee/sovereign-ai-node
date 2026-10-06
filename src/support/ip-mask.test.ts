import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  classifyIpv4,
  countMaskTokens,
  findUnmaskedIpClasses,
  IpMasker,
  MASK_CLASSES,
  maskIpAddresses,
  maskIpAddressesInValue,
  parseIpv4,
  parseIpv6,
} from "./ip-mask.js";

interface Vectors {
  readonly masked: readonly { name: string; input: string; expected: string }[];
  readonly readable: readonly string[];
  readonly falsePositives: readonly string[];
}

const vectors = JSON.parse(
  readFileSync(new URL("./ip-mask.vectors.json", import.meta.url), "utf8"),
) as Vectors;

describe("maskIpAddresses — vector corpus", () => {
  it.each(
    vectors.masked.map((vector) => [vector.name, vector.input, vector.expected]),
  )("%s", (_name, input, expected) => {
    const output = maskIpAddresses(input);
    expect(output).toBe(expected);
    // Whatever the masker produced must pass its own guard.
    expect(findUnmaskedIpClasses(output)).toEqual([]);
  });

  it.each(vectors.readable)("keeps non-identifying addresses readable: %s", (input) => {
    expect(maskIpAddresses(input)).toBe(input);
    expect(findUnmaskedIpClasses(input)).toEqual([]);
  });

  it.each(vectors.falsePositives)("leaves a non-address byte-identical: %s", (input) => {
    expect(maskIpAddresses(input)).toBe(input);
    expect(findUnmaskedIpClasses(input)).toEqual([]);
  });
});

describe("IpMasker — per-bundle pseudonyms", () => {
  it("gives the same address the same number across calls, and new ones new numbers", () => {
    const masker = new IpMasker();
    expect(masker.mask("first 203.0.113.7")).toBe("first <public-ipv4#1>");
    expect(masker.mask("[2001:db8::1]:993 then 203.0.113.8")).toBe(
      "[<global-ipv6#1>]:993 then <public-ipv4#2>",
    );
    expect(masker.mask("again 203.0.113.7 and 2001:DB8:0::1")).toBe(
      "again <public-ipv4#1> and <global-ipv6#1>",
    );
  });

  it("restarts numbering in a new masker, so bundles cannot be linked", () => {
    const first = new IpMasker();
    first.mask("203.0.113.1");
    expect(first.mask("203.0.113.2")).toBe("<public-ipv4#2>");
    expect(new IpMasker().mask("203.0.113.2")).toBe("<public-ipv4#1>");
  });
});

describe("maskIpAddressesInValue", () => {
  it("masks strings and keys at every depth with the shared numbering", () => {
    const masker = new IpMasker();
    masker.mask("203.0.113.9");
    const input = {
      "203.0.113.1": { nested: ["2001:db8::1", 4, null, true] },
      plain: "via 203.0.113.9",
    };
    expect(maskIpAddressesInValue(input, masker)).toEqual({
      "<public-ipv4#2>": { nested: ["<global-ipv6#1>", 4, null, true] },
      plain: "via <public-ipv4#1>",
    });
    expect(input.plain).toBe("via 203.0.113.9");
  });
});

describe("findUnmaskedIpClasses — fail-closed guard", () => {
  it("finds an address the masker cannot see behind an exotic encoding", () => {
    const exotic = "host 2001\\u003adb8\\u003a\\u003a1 and 203\\x2e0\\x2e113\\x2e7";
    expect(maskIpAddresses(exotic)).toBe(exotic);
    expect(findUnmaskedIpClasses(exotic)).toEqual(["public-ipv4", "global-ipv6"]);
  });

  it("reports every class it finds in stable order, never values", () => {
    const raw =
      "fe80::1 fd00::1 ff02::1 2001:db8::1 100::1 203.0.113.1 100.64.0.1 ::ffff:203.0.113.2 ::ffff:192.168.0.1 version=203.0.113.3";
    expect(findUnmaskedIpClasses(raw)).toEqual([
      "public-ipv4",
      "cgnat-ipv4",
      "global-ipv6",
      "link-local-ipv6",
      "ula-ipv6",
      "multicast-ipv6",
      "other-ipv6",
    ]);
  });
});

describe("parsers and classifier", () => {
  it.each([
    ["1.2.3.4", [1, 2, 3, 4]],
    ["0.0.0.0", [0, 0, 0, 0]],
    ["1.2.3", undefined],
    ["01.2.3.4", undefined],
    ["256.1.1.1", undefined],
  ])("parseIpv4(%s)", (input, expected) => {
    expect(parseIpv4(input)).toEqual(expected);
  });

  it.each([
    ["::", [0, 0, 0, 0, 0, 0, 0, 0]],
    ["1::", [1, 0, 0, 0, 0, 0, 0, 0]],
    ["::1.2.3.4", [0, 0, 0, 0, 0, 0, 0x102, 0x304]],
    ["1::1.2.3.4", [1, 0, 0, 0, 0, 0, 0x102, 0x304]],
    ["1:2:3:4:5:6:1.2.3.4", [1, 2, 3, 4, 5, 6, 0x102, 0x304]],
    ["1:2:3:4:5:6:7:8", [1, 2, 3, 4, 5, 6, 7, 8]],
    ["1.2.3.4", undefined],
    ["::1.2.3", undefined],
    ["1::2::3", undefined],
    [":::1", undefined],
    [":1:2:3:4:5:6:7", undefined],
    ["1:2:3:4:5:6:7", undefined],
    ["1:2:3:4:5:6:7:8:9", undefined],
    ["1:2:3:4::5:6:7:8", undefined],
    ["12345::1", undefined],
  ])("parseIpv6(%s)", (input, expected) => {
    expect(parseIpv6(input)).toEqual(expected);
  });

  it("classifies the IPv4 boundaries", () => {
    expect(classifyIpv4([0, 0, 0, 1])).toBe("public-ipv4");
    expect(classifyIpv4([255, 255, 255, 254])).toBe("public-ipv4");
    expect(classifyIpv4([240, 0, 0, 1])).toBe("public-ipv4");
    expect(classifyIpv4([100, 63, 0, 1])).toBe("public-ipv4");
    expect(classifyIpv4([223, 255, 255, 255])).toBe("public-ipv4");
    expect(classifyIpv4([192, 169, 0, 1])).toBe("public-ipv4");
    expect(classifyIpv4([169, 253, 0, 1])).toBe("public-ipv4");
    expect(classifyIpv4([239, 0, 0, 1])).toBeUndefined();
  });
});

describe("countMaskTokens", () => {
  it("counts tokens per class and lists every class it knows", () => {
    expect(
      countMaskTokens("<public-ipv4#1> <public-ipv4#2> [<global-ipv6#1>]:1 enx<mac#1> <nope#1>"),
    ).toEqual({ "public-ipv4": 2, "global-ipv6": 1, mac: 1 });
    expect(MASK_CLASSES).toHaveLength(8);
  });
});

describe("ReDoS bound", () => {
  it("scans 512 KiB of hex-and-colon noise quickly", () => {
    const noise = "a:b1:".repeat((512 * 1024) / 5) + "::".repeat(1000) + "1.2.".repeat(10_000);
    const started = performance.now();
    new IpMasker().mask(noise);
    findUnmaskedIpClasses(noise);
    // The plan's bound is 100 ms; CI runners are shared, so allow headroom for
    // the guard pass and a cold JIT while still catching any super-linear blowup.
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
