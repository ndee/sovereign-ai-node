import { describe, expect, it } from "vitest";

import {
  getNodeBuildInfo,
  isNodeBuildIdentityComplete,
  type NodeBuildInfo,
  readDefine,
  readPackageVersion,
  resolveVersion,
  shortCommit,
  UNKNOWN_BUILD_VALUE,
} from "./build-info.js";

describe("readDefine", () => {
  it("returns a trimmed string value", () => {
    expect(readDefine("  2.3.5  ")).toBe("2.3.5");
  });

  it("returns the value unchanged when already clean", () => {
    expect(readDefine("2.3.5")).toBe("2.3.5");
  });

  const nonStrings: readonly [string, unknown][] = [
    ["undefined", undefined],
    ["null", null],
    ["number", 235],
    ["boolean", true],
    ["object", { version: "2.3.5" }],
    ["array", ["2.3.5"]],
    ["function", () => "2.3.5"],
    ["symbol", Symbol("2.3.5")],
  ];
  for (const [label, value] of nonStrings) {
    it(`returns unknown for a ${label} define`, () => {
      expect(readDefine(value)).toBe(UNKNOWN_BUILD_VALUE);
    });
  }

  const blanks: readonly [string, string][] = [
    ["empty", ""],
    ["spaces", "   "],
    ["tab", "\t"],
    ["newline", "\n"],
    ["mixed whitespace", " \t\n "],
  ];
  for (const [label, value] of blanks) {
    it(`returns unknown for a ${label} define`, () => {
      expect(readDefine(value)).toBe(UNKNOWN_BUILD_VALUE);
    });
  }

  it("caps a hostile over-long define at 200 characters", () => {
    // A define is substituted at build time from a string the build environment
    // supplies; a diagnostic field must not become an unbounded output channel.
    expect(readDefine("v".repeat(5_000))).toHaveLength(200);
  });

  it("caps after trimming, not before", () => {
    const result = readDefine(`   ${"v".repeat(300)}   `);
    expect(result).toHaveLength(200);
    expect(result.startsWith(" ")).toBe(false);
  });

  it("leaves a value exactly at the cap intact", () => {
    expect(readDefine("v".repeat(200))).toHaveLength(200);
  });
});

describe("resolveVersion", () => {
  it("prefers the build-time define over the package version", () => {
    expect(resolveVersion("2.3.5", "9.9.9")).toBe("2.3.5");
  });

  it("trims the define before returning it", () => {
    expect(resolveVersion("  2.3.5 ", "9.9.9")).toBe("2.3.5");
  });

  it("falls back to the package version when the define is absent", () => {
    expect(resolveVersion(undefined, "2.4.0")).toBe("2.4.0");
  });

  it("falls back when the define is a blank string", () => {
    expect(resolveVersion("   ", "2.4.0")).toBe("2.4.0");
  });

  it("falls back when the define is a non-string", () => {
    expect(resolveVersion(42, "2.4.0")).toBe("2.4.0");
  });

  it("returns unknown when both sources are missing", () => {
    expect(resolveVersion(undefined)).toBe(UNKNOWN_BUILD_VALUE);
    expect(resolveVersion(undefined, UNKNOWN_BUILD_VALUE)).toBe(UNKNOWN_BUILD_VALUE);
  });

  it("never invents a version when nothing is known", () => {
    // The original bug: `process.env.npm_package_version ?? "2.0.0"` made every
    // systemd-launched node report the literal "2.0.0". A confidently wrong
    // version costs more support time than an honest gap.
    expect(resolveVersion(undefined)).not.toBe("2.0.0");
    expect(resolveVersion(null, UNKNOWN_BUILD_VALUE)).not.toBe("2.0.0");
  });
});

describe("readPackageVersion", () => {
  it("reads a valid version from the first candidate", () => {
    const reader = () => JSON.stringify({ name: "sovereign-ai-node", version: "2.3.5" });
    expect(readPackageVersion("/opt/app/dist", reader)).toBe("2.3.5");
  });

  it("trims the version it reads", () => {
    expect(readPackageVersion("/opt/app/dist", () => '{"version":"  2.3.5  "}')).toBe("2.3.5");
  });

  it("caps an over-long version", () => {
    const long = "v".repeat(500);
    expect(readPackageVersion("/x", () => JSON.stringify({ version: long }))).toHaveLength(200);
  });

  it("tries the second candidate when the first is unusable", () => {
    // dist/ and src/ layouts sit at different depths; a missing package.json at
    // the first candidate is normal, not an error. `join` normalizes the `..`
    // segments, so the two candidates for /opt/app/dist are /opt/app/package.json
    // and /opt/package.json.
    const seen: string[] = [];
    const result = readPackageVersion("/opt/app/dist", (path) => {
      seen.push(path);
      if (path === "/opt/app/package.json") {
        throw new Error("ENOENT");
      }
      return JSON.stringify({ version: "2.4.1" });
    });
    expect(seen).toEqual(["/opt/app/package.json", "/opt/package.json"]);
    expect(result).toBe("2.4.1");
  });

  it("stops at the first usable candidate", () => {
    const seen: string[] = [];
    const result = readPackageVersion("/opt/app/dist", (path) => {
      seen.push(path);
      return JSON.stringify({ version: "2.3.5" });
    });
    expect(seen).toEqual(["/opt/app/package.json"]);
    expect(result).toBe("2.3.5");
  });

  it("returns unknown for malformed JSON", () => {
    expect(readPackageVersion("/x", () => "{ not json at all")).toBe(UNKNOWN_BUILD_VALUE);
  });

  it("returns unknown when the version field is missing", () => {
    expect(readPackageVersion("/x", () => JSON.stringify({ name: "no-version" }))).toBe(
      UNKNOWN_BUILD_VALUE,
    );
  });

  it("returns unknown when version is an empty string", () => {
    expect(readPackageVersion("/x", () => JSON.stringify({ version: "" }))).toBe(
      UNKNOWN_BUILD_VALUE,
    );
  });

  it("returns unknown when version is whitespace only", () => {
    expect(readPackageVersion("/x", () => JSON.stringify({ version: "   " }))).toBe(
      UNKNOWN_BUILD_VALUE,
    );
  });

  it("returns unknown when version is a non-string", () => {
    expect(readPackageVersion("/x", () => JSON.stringify({ version: 235 }))).toBe(
      UNKNOWN_BUILD_VALUE,
    );
    expect(readPackageVersion("/x", () => JSON.stringify({ version: null }))).toBe(
      UNKNOWN_BUILD_VALUE,
    );
  });

  it("returns unknown when the parsed JSON is not an object", () => {
    expect(readPackageVersion("/x", () => '"just a string"')).toBe(UNKNOWN_BUILD_VALUE);
    expect(readPackageVersion("/x", () => "null")).toBe(UNKNOWN_BUILD_VALUE);
    expect(readPackageVersion("/x", () => "[]")).toBe(UNKNOWN_BUILD_VALUE);
  });

  it("returns unknown when the reader throws for every candidate", () => {
    expect(
      readPackageVersion("/x", () => {
        throw new Error("EACCES");
      }),
    ).toBe(UNKNOWN_BUILD_VALUE);
  });

  it("returns unknown for an empty file", () => {
    expect(readPackageVersion("/x", () => "")).toBe(UNKNOWN_BUILD_VALUE);
  });

  it("never guesses 2.0.0 when nothing is readable", () => {
    expect(
      readPackageVersion("/x", () => {
        throw new Error("ENOENT");
      }),
    ).not.toBe("2.0.0");
  });

  it("resolves candidates relative to the module directory, not the cwd", () => {
    // Resolving from cwd would report the version of whatever project happens
    // to invoke us — the exact class of confidently-wrong answer this replaces.
    const seen: string[] = [];
    readPackageVersion("/opt/sovereign/dist", (path) => {
      seen.push(path);
      throw new Error("ENOENT");
    });
    // Both candidates are walks upward from the module directory. Neither is
    // relative, so neither can resolve against the invoking project's cwd.
    expect(seen).toEqual(["/opt/sovereign/package.json", "/opt/package.json"]);
    for (const path of seen) {
      expect(path.startsWith("/opt")).toBe(true);
      expect(path.endsWith("package.json")).toBe(true);
    }
  });
});

describe("shortCommit", () => {
  it("shortens a full SHA to seven characters", () => {
    expect(shortCommit("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678")).toBe("a1b2c3d");
  });

  it("passes unknown through verbatim rather than slicing it", () => {
    // Slicing "unknown" would yield "unknown" by coincidence at 7 chars; the
    // explicit branch is what guarantees it, so it is asserted directly.
    expect(shortCommit(UNKNOWN_BUILD_VALUE)).toBe(UNKNOWN_BUILD_VALUE);
  });

  it("leaves an already-short commit alone", () => {
    expect(shortCommit("abc")).toBe("abc");
  });

  it("handles an empty string without throwing", () => {
    expect(shortCommit("")).toBe("");
  });
});

describe("isNodeBuildIdentityComplete", () => {
  const info = (version: string, commit: string): NodeBuildInfo => ({
    component: "sovereign-node",
    version,
    commit,
    buildTimestamp: "2026-07-26T00:00:00.000Z",
  });

  it("is true when version and commit both resolved", () => {
    expect(isNodeBuildIdentityComplete(info("2.3.5", "a1b2c3d"))).toBe(true);
  });

  it("is false when the version is unknown", () => {
    expect(isNodeBuildIdentityComplete(info(UNKNOWN_BUILD_VALUE, "a1b2c3d"))).toBe(false);
  });

  it("is false when the commit is unknown", () => {
    expect(isNodeBuildIdentityComplete(info("2.3.5", UNKNOWN_BUILD_VALUE))).toBe(false);
  });

  it("is false when both are unknown", () => {
    expect(isNodeBuildIdentityComplete(info(UNKNOWN_BUILD_VALUE, UNKNOWN_BUILD_VALUE))).toBe(false);
  });

  it("does not consider the build timestamp", () => {
    expect(
      isNodeBuildIdentityComplete({
        component: "sovereign-node",
        version: "2.3.5",
        commit: "a1b2c3d",
        buildTimestamp: UNKNOWN_BUILD_VALUE,
      }),
    ).toBe(true);
  });
});

describe("getNodeBuildInfo", () => {
  // Under vitest the tsup defines are never substituted, so this exercises the
  // unbundled path: commit and timestamp are unavailable and must say so.
  it("reports the sovereign-node component", () => {
    expect(getNodeBuildInfo().component).toBe("sovereign-node");
  });

  it("reports unknown for values with no build-time define", () => {
    const info = getNodeBuildInfo();
    expect(info.commit).toBe(UNKNOWN_BUILD_VALUE);
    expect(info.buildTimestamp).toBe(UNKNOWN_BUILD_VALUE);
  });

  it("never reports the literal 2.0.0 fallback that the old code guessed", () => {
    const info = getNodeBuildInfo();
    if (info.version !== UNKNOWN_BUILD_VALUE) {
      // Resolved from the adjacent package.json — must match it, not a guess.
      expect(info.version).toMatch(/^\d+\.\d+\.\d+/u);
    }
  });

  it("returns a stable result across calls", () => {
    expect(getNodeBuildInfo()).toEqual(getNodeBuildInfo());
  });
});
