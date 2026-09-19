import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Class-level guard over the WHOLE source tree.
 *
 * "The spawn cannot find what the install just placed" has now surfaced four
 * times in this repo: detection (#261), the bot unit PATHs (#232), the
 * gateway/managed-agent spawns (#270), and the installer's own `safeExec`
 * wrapper. Each was fixed where it burned.
 *
 * The mechanism is always identical. An unprivileged install cannot write to
 * npm's root-owned global prefix, so OpenClaw is installed into
 * `<serviceHome>/.npm-global` instead (#254). That directory is NOT on
 * `process.env.PATH`. A spawn that names the CLI by the bare word `openclaw`
 * and passes an `env` without a resolved PATH therefore inherits a PATH that
 * cannot see the binary, and fails ENOENT — a *name-resolution* failure,
 * which looks nothing like the cwd/EACCES class and is not fixed by anything
 * that class did.
 *
 * WHY THIS TEST WAS REWRITTEN. The previous version was file-level and keyed
 * on the literal `command: "openclaw"`. Both properties were load-bearing
 * blind spots:
 *
 *  - It never examined `src/installer/real-service.ts` at all, because that
 *    file writes `command: "openclaw"` zero times. It routes its bare-name
 *    spawns through a *wrapper* — `this.safeExec("openclaw", args)` — whose
 *    own spawn names `effectiveCommand`. The guard's detector simply did not
 *    see six real spawn sites.
 *  - Being file-level, it asked only "does this FILE mention a resolved
 *    lookup PATH somewhere". A file with three spawn sites passed if any one
 *    of them was correct. Nothing tied a resolution to the site that needed
 *    it.
 *
 * So the rule is now enforced PER SPAWN SITE, and a site is recognised
 * whether it is a direct runner call or a call into a bare-name wrapper.
 */

const SRC_DIR = new URL("..", import.meta.url).pathname;

const collectSourceFiles = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Sibling worktrees carry their own full copy of src/. Collecting them
        // makes this guard grade a stale snapshot of the tree and report green
        // for code that is not the code under test.
        if (entry.name === ".worktrees" || entry.name === "node_modules") {
          return [];
        }
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

const relativeTo = (file: string): string =>
  `src/${file.replace(SRC_DIR, "")}`.replace("src//", "src/");

/**
 * Every way this tree spawns the OpenClaw CLI under its bare name.
 *
 * `command: "openclaw"` is the direct runner form. The wrapper form passes
 * the bare name as the first argument to a helper that spawns on the
 * caller's behalf — invisible to a detector that only knows the direct form,
 * which is exactly how the `safeExec` sites escaped this guard.
 */
const BARE_NAME_SPAWN_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "runner spawn", pattern: /command:\s*"openclaw"/g },
  { label: "wrapper spawn", pattern: /\b\w+\s*\(\s*"openclaw"\s*,/g },
];

/** Line number (1-based) of a character offset. */
const lineOf = (source: string, index: number): number => source.slice(0, index).split("\n").length;

/**
 * The enclosing function/method body for a spawn site, used as the scope in
 * which its PATH resolution must appear.
 *
 * Scoping per site rather than per file is the whole point: it is what makes
 * "this file resolves a PATH somewhere" insufficient.
 */
const enclosingScope = (source: string, index: number): string => {
  const lines = source.split("\n");
  const siteLine = lineOf(source, index) - 1;
  const indentOf = (line: string): number => {
    const found = line.search(/\S/);
    return found === -1 ? Number.MAX_SAFE_INTEGER : found;
  };

  // Walk back to the nearest member declaration at class-body indent (2). That
  // is the method containing this spawn — a scope, not the whole file.
  let start = 0;
  for (let i = siteLine; i >= 0; i -= 1) {
    const line = lines[i] ?? "";
    if (indentOf(line) <= 2 && /\(|=>/.test(line) && !/^\s*[})\]]/.test(line)) {
      start = i;
      break;
    }
  }
  // Walk forward to where that member closes.
  const startIndent = indentOf(lines[start] ?? "");
  let end = lines.length - 1;
  for (let i = siteLine + 1; i < lines.length; i += 1) {
    if (indentOf(lines[i] ?? "") <= startIndent && /^\s*[})]/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  let scope = lines.slice(start, end + 1).join("\n");

  // Follow ONE level of indirection: a site may legitimately delegate the
  // resolution to a small named helper (`this.resolveLookupPath()`), as the
  // gateway and managed-agent spawns do. Inline that helper's body so the
  // site is judged on the resolution it actually gets — without widening the
  // check back out to "somewhere in this file", which is the blind spot that
  // let a broken site sit beside a correct one.
  const delegations = scope.match(/this\.(\w*[lL]ookupPath\w*)\s*\(/g) ?? [];
  for (const delegation of delegations) {
    const name = delegation.replace(/^this\./, "").replace(/\s*\($/, "");
    const helper = new RegExp(`\\b${name}\\s*\\([^)]*\\)[^{]*\\{([\\s\\S]{0,400}?)\\n  \\}`, "m");
    const body = source.match(helper);
    if (body !== null) {
      scope += `\n${body[1]}`;
    }
  }
  return scope;
};

const RESOLVES_LOOKUP_PATH = /resolveOpenClaw(?:Spawn)?LookupPath\s*\(/;
const PASSES_LOOKUP_PATH_AS_ENV =
  /PATH:\s*[\s\S]{0,200}?resolveOpenClaw(?:Spawn)?LookupPath|PATH:\s*\w*[lL]ookupPath/;

describe("OpenClaw CLI lookup PATH coverage across src/", () => {
  it("resolves a lookup PATH at every bare-name OpenClaw CLI spawn site", async () => {
    const files = await collectSourceFiles(SRC_DIR);
    expect(files.length).toBeGreaterThan(50);

    const offenders: { site: string; reason: string }[] = [];
    let siteCount = 0;

    for (const file of files) {
      // bootstrap.ts DEFINES the helper; it is the one file allowed to be the
      // source of the resolution rather than a consumer of it.
      if (file.endsWith("/openclaw/bootstrap.ts")) {
        continue;
      }
      const source = await readFile(file, "utf8");

      for (const { label, pattern } of BARE_NAME_SPAWN_PATTERNS) {
        pattern.lastIndex = 0;
        let match = pattern.exec(source);
        while (match !== null) {
          const matched = match[0];
          // Skip the wrapper's own definition and non-spawn helpers that merely
          // take the name as data (e.g. `resolveExecutablePath("openclaw", …)`,
          // which resolves to an absolute path and is not PATH-sensitive at
          // spawn time).
          const isResolver = /resolveExecutablePath|join|push|find|includes/.test(matched);
          if (isResolver) {
            match = pattern.exec(source);
            continue;
          }
          siteCount += 1;
          let scope = enclosingScope(source, match.index);
          const site = `${relativeTo(file)}:${lineOf(source, match.index)} (${label})`;

          // A wrapper call site does not spawn directly — it hands the bare
          // name to a helper that spawns on its behalf. The resolution that
          // matters for such a site lives in the WRAPPER's body, so judge the
          // site by that body. This is the indirection the old guard could not
          // see at all, and it is deliberately resolved to a specific named
          // wrapper rather than to "anywhere in the file".
          if (label === "wrapper spawn") {
            const wrapperName = matched.replace(/\s*\(\s*"openclaw"\s*,$/, "").trim();
            const wrapperBody = source.match(
              new RegExp(
                `(?:private |public )?(?:async )?${wrapperName}\\s*\\((?!\\s*")[\\s\\S]*?\\n  \\}`,
                "m",
              ),
            );
            if (wrapperBody === null) {
              offenders.push({
                site,
                reason: `routes a bare-name spawn through wrapper "${wrapperName}" whose body could not be located`,
              });
              match = pattern.exec(source);
              continue;
            }
            scope = wrapperBody[0];
          }

          if (!RESOLVES_LOOKUP_PATH.test(scope)) {
            offenders.push({
              site,
              reason: "spawns the OpenClaw CLI by bare name without resolving a lookup PATH",
            });
          } else if (!PASSES_LOOKUP_PATH_AS_ENV.test(scope)) {
            // Resolving the PATH but never putting it on the spawn env is the
            // same bug with extra steps.
            offenders.push({
              site,
              reason: "resolves a lookup PATH but never passes it as the spawn env PATH",
            });
          }
          match = pattern.exec(source);
        }
      }
    }

    // If the detector stops finding sites, it has gone blind rather than the
    // tree having become safe — which is precisely the failure mode that let
    // the `safeExec` sites through.
    expect(siteCount).toBeGreaterThanOrEqual(3);

    // An unprivileged install writes the CLI to `<npmPrefix>/bin`, which is
    // not on the inherited PATH; a bare-name spawn without this resolution
    // dies ENOENT while the binary sits on disk, executable, the whole time.
    expect(offenders).toEqual([]);
  });

  it("detects bare-name spawns routed through a wrapper, not just direct runner calls", async () => {
    // A detector that only knows `command: "openclaw"` cannot see
    // `this.safeExec("openclaw", args)`. Pin that it can, so the blind spot
    // cannot silently return.
    const wrapperPattern = BARE_NAME_SPAWN_PATTERNS.find(
      (entry) => entry.label === "wrapper spawn",
    );
    expect(wrapperPattern).toBeDefined();
    const pattern = new RegExp(wrapperPattern?.pattern ?? /$^/, "g");
    const sample = `const result = await this.safeExec("openclaw", ["gateway", "status"]);`;
    expect(pattern.test(sample)).toBe(true);

    const realService = await readFile(join(SRC_DIR, "installer", "real-service.ts"), "utf8");
    // The file that escaped the old guard must now be seen by the new one.
    expect(realService).not.toMatch(/command:\s*"openclaw"/);
    const wrapperSites = realService.match(/\b\w+\s*\(\s*"openclaw"\s*,/g) ?? [];
    expect(wrapperSites.length).toBeGreaterThanOrEqual(3);
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
      const relative = relativeTo(file);
      if (!KNOWN_HARDCODED_PREFIX_FILES.includes(relative)) {
        offenders.push(relative);
      }
    }

    expect(offenders).toEqual([]);
  });
});
