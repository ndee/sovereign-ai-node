import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Class-level guard over the WHOLE source tree.
 *
 * "The spawn cannot find what the install just placed" has now surfaced three
 * times in this repo: detection (#261), the bot unit PATHs (#232), and the
 * gateway/managed-agent spawns. Each was fixed where it burned.
 *
 * The mechanism is always identical. An unprivileged install cannot write to
 * npm's root-owned global prefix, so OpenClaw is installed into
 * `<serviceHome>/.npm-global` instead (#254). That directory is NOT on
 * `process.env.PATH`. A spawn that names the CLI by the bare word `openclaw`
 * and passes an `env` without a PATH therefore inherits a PATH that cannot
 * see the binary, and fails ENOENT — a *name-resolution* failure, which looks
 * nothing like the cwd/EACCES class and is not fixed by anything that class
 * did.
 *
 * So the rule enforced here is narrow but total: any file that spawns the
 * OpenClaw CLI by bare name must resolve its lookup PATH through the shared
 * helper, rather than inheriting the ambient PATH or hardcoding a prefix.
 * A call site added tomorrow is covered without anyone remembering to
 * extend this test.
 */

const SRC_DIR = new URL("..", import.meta.url).pathname;

const collectSourceFiles = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        return collectSourceFiles(full);
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
        return [];
      }
      return [full];
    }),
  );
  return files.flat();
};

describe("OpenClaw CLI lookup PATH coverage across src/", () => {
  it("resolves a lookup PATH at every bare-name OpenClaw CLI spawn", async () => {
    const files = await collectSourceFiles(SRC_DIR);
    expect(files.length).toBeGreaterThan(50);

    const offenders: { file: string; reason: string }[] = [];

    for (const file of files) {
      // bootstrap.ts DEFINES the helper; it is the one file allowed to be the
      // source of the resolution rather than a consumer of it.
      if (file.endsWith("/openclaw/bootstrap.ts")) {
        continue;
      }
      const source = await readFile(file, "utf8");
      // A bare-name CLI spawn is recognisable by the command literal. An
      // absolute path (resolved via resolveExecutablePath) is a different
      // shape and is not PATH-sensitive at spawn time.
      if (!/command:\s*"openclaw"/.test(source)) {
        continue;
      }
      const relative = `src/${file.replace(SRC_DIR, "")}`.replace("src//", "src/");
      if (!/resolveOpenClaw(?:Spawn)?LookupPath/.test(source)) {
        offenders.push({
          file: relative,
          reason: "spawns the OpenClaw CLI by bare name without a resolved lookup PATH",
        });
        continue;
      }
      // Resolving the PATH but never putting it on the spawn env is the same
      // bug with extra steps.
      if (!/PATH:\s*\w*[lL]ookupPath/.test(source)) {
        offenders.push({
          file: relative,
          reason: "resolves a lookup PATH but never passes it as the spawn env PATH",
        });
      }
    }

    // An unprivileged install writes the CLI to `<npmPrefix>/bin`, which is
    // not on the inherited PATH; a bare-name spawn without this resolution
    // dies ENOENT while the binary sits on disk, executable, the whole time.
    expect(offenders).toEqual([]);
  });

  it("keeps the shared lookup-PATH resolution in place", async () => {
    const bootstrapSource = await readFile(join(SRC_DIR, "openclaw", "bootstrap.ts"), "utf8");
    // Pin the behaviour, not just the helper name: if the prefix bin dir stops
    // being prepended, every consumer silently becomes vulnerable again.
    expect(bootstrapSource).toMatch(/export const resolveOpenClawLookupPath/);
    expect(bootstrapSource).toMatch(/export const resolveOpenClawSpawnLookupPath/);
    expect(bootstrapSource).toMatch(/export const resolveOpenClawNpmPrefix/);
    expect(bootstrapSource).toMatch(/\.npm-global/);
  });

  it("does not hardcode the npm-global bin dir at new call sites", async () => {
    const files = await collectSourceFiles(SRC_DIR);
    /**
     * A ratchet: it may shrink, never grow. Two hardcoded copies of this path
     * already exist (the systemd unit and the lobster helper's own prefix
     * derivation). Hardcoding a third at a spawn site is how the definition of
     * "where the CLI lives" drifts away from where the install puts it.
     */
    const KNOWN_HARDCODED_PREFIX_FILES = [
      "src/installer/real-service-lobster.ts",
      // Mentions the path only in prose, documenting the unit PATH of #232.
      "src/installer/real-service.ts",
      "src/openclaw/bootstrap.ts",
    ];

    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (!/\.npm-global/.test(source)) {
        continue;
      }
      const relative = `src/${file.replace(SRC_DIR, "")}`.replace("src//", "src/");
      if (!KNOWN_HARDCODED_PREFIX_FILES.includes(relative)) {
        offenders.push(relative);
      }
    }

    expect(offenders).toEqual([]);
  });
});
