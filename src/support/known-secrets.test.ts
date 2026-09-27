import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  harvestSecretValues,
  KnownSecretSet,
  loadKnownSecrets,
  REDACTED_KNOWN,
  valuesFromSecretText,
} from "./known-secrets.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "known-secrets-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("KnownSecretSet", () => {
  it("replaces verbatim, URL-encoded and JSON-escaped occurrences", () => {
    const secret = 'p@ss w/"q"';
    const set = new KnownSecretSet([secret]);
    const text = [
      `login ${secret}`,
      `url https://x/?p=${encodeURIComponent(secret)}`,
      `json ${JSON.stringify({ value: secret })}`,
    ].join("\n");
    const { text: scrubbed, replaced } = set.scrub(text);
    expect(replaced).toBe(3);
    expect(scrubbed).not.toContain("p@ss");
    expect(scrubbed.split(REDACTED_KNOWN)).toHaveLength(4);
  });

  it("replaces a containing secret whole before a contained one", () => {
    const set = new KnownSecretSet(["abcdef", "abcdefghij"]);
    expect(set.scrub("x abcdefghij y").text).toBe(`x ${REDACTED_KNOWN} y`);
  });

  it("ignores values shorter than the minimum and trims whitespace", () => {
    const set = new KnownSecretSet(["abc", "  longer-value  \n"]);
    expect(set.scrub("abc longer-value").text).toBe(`abc ${REDACTED_KNOWN}`);
    expect(set.size).toBe(1);
  });

  it("returns text unchanged when nothing matches", () => {
    expect(new KnownSecretSet(["zzzzzzzz"]).scrub("hello")).toEqual({ text: "hello", replaced: 0 });
  });

  it("never serialises or inspects to its values", () => {
    const set = new KnownSecretSet(["TOP-SECRET-VALUE"]);
    expect(JSON.stringify({ set })).not.toContain("TOP-SECRET");
    expect(String(set)).toBe("[KnownSecretSet]");
    expect(inspect(set)).toBe("[KnownSecretSet]");
    expect(Object.keys(set)).toEqual([]);
  });
});

describe("valuesFromSecretText", () => {
  it("yields the whole text, every line, and assignment right-hand sides", () => {
    const values = valuesFromSecretText('A=first\nexport B="second"\nplain line');
    expect(values).toContain('A=first\nexport B="second"\nplain line');
    expect(values).toContain("first");
    expect(values).toContain("second");
    expect(values).toContain("plain line");
  });
});

describe("harvestSecretValues", () => {
  it("collects values under secret-named keys and file refs anywhere", () => {
    const { values, fileRefs } = harvestSecretValues({
      imap: { host: "imap.example.com", password: "imap-secret-1" },
      openrouter: { secretRef: "file:/etc/x/openrouter" },
      relay: { tunnel: { token: "tunnel-token-1", tokenSecretRef: "env:TUNNEL" } },
      nested: [{ apiKey: "api-key-value" }],
      tokenExpiresAt: "2026-09-27T10:00:00Z",
      secretsDir: "/etc/sovereign-node/secrets",
      tokenCount: "12",
      passwordRequired: "true",
      unrelated: 5,
      alsoUnrelated: null,
    });
    expect(values.sort()).toEqual(["api-key-value", "imap-secret-1", "tunnel-token-1"]);
    expect(fileRefs).toEqual(["/etc/x/openrouter"]);
  });

  it("stops at the depth bound", () => {
    let deep: Record<string, unknown> = { password: "too-deep-value" };
    for (let index = 0; index < 20; index += 1) {
      deep = { inner: deep };
    }
    expect(harvestSecretValues(deep).values).toEqual([]);
  });
});

describe("loadKnownSecrets", () => {
  it("loads secret dirs, files, structured files, env files, record dirs and values", async () => {
    const secrets = join(dir, "secrets");
    await mkdir(join(secrets, "matrix"), { recursive: true });
    await writeFile(join(secrets, "imap-password"), "imap-pass-SENTINEL\n");
    await writeFile(join(secrets, "matrix", "token"), "matrix-token-SENTINEL");
    await symlink("/etc/hostname", join(secrets, "link"));
    const refTarget = join(dir, "referenced");
    await writeFile(refTarget, "referenced-SENTINEL");
    const config = join(dir, "config.json5");
    await writeFile(
      config,
      `{ // json5\n openrouter: { apiKey: 'or-key-SENTINEL', secretRef: 'file:${refTarget}' } }`,
    );
    const env = join(dir, "app.env");
    await writeFile(env, "PORT=8080\nAPI_TOKEN='env-token-SENTINEL'\n# comment\n");
    const jobs = join(dir, "jobs");
    await mkdir(jobs);
    await writeFile(
      join(jobs, "j1.json"),
      JSON.stringify({ request: { imap: { password: "old-cleartext-SENTINEL" } } }),
    );
    await writeFile(join(jobs, "notes.txt"), "ignored");
    const tokenFile = join(dir, "bootstrap-token");
    await writeFile(tokenFile, "bootstrap-SENTINEL");

    const set = await loadKnownSecrets({
      secretDirs: [secrets, join(dir, "missing-dir")],
      secretFiles: [tokenFile, join(dir, "missing-file")],
      structuredFiles: [config, join(dir, "missing.json"), env],
      envFiles: [env, join(dir, "missing.env")],
      recordDirs: [jobs],
      values: ["caller-SENTINEL"],
    });
    const text = [
      "imap-pass-SENTINEL",
      "matrix-token-SENTINEL",
      "referenced-SENTINEL",
      "or-key-SENTINEL",
      "env-token-SENTINEL",
      "old-cleartext-SENTINEL",
      "bootstrap-SENTINEL",
      "caller-SENTINEL",
      "PORT=8080",
    ].join(" ");
    const scrubbed = set.scrub(text).text;
    expect(scrubbed).not.toMatch(/[a-z-]+SENTINEL/u);
    expect(scrubbed).toContain("PORT=8080");
  });

  it("bounds the walk of a large secrets directory", async () => {
    const secrets = join(dir, "many");
    await mkdir(secrets);
    await Promise.all(
      Array.from({ length: 300 }, (_, index) =>
        writeFile(join(secrets, `s${index}`), `value-${index}-xyz`),
      ),
    );
    const set = await loadKnownSecrets({ secretDirs: [secrets] });
    // 256 files are read; each yields one needle (value == its only line).
    expect(set.size).toBeLessThanOrEqual(256);
    expect(set.size).toBeGreaterThan(0);
  });

  it("bounds directory depth", async () => {
    let path = join(dir, "d");
    for (let index = 0; index < 6; index += 1) {
      path = join(path, `l${index}`);
    }
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "deep"), "deep-secret-value");
    await writeFile(join(dir, "d", "top"), "top-secret-value");
    const set = await loadKnownSecrets({ secretDirs: [join(dir, "d")] });
    expect(set.scrub("top-secret-value deep-secret-value").text).toBe(
      `${REDACTED_KNOWN} deep-secret-value`,
    );
  });

  it("returns an empty set for no sources", async () => {
    expect((await loadKnownSecrets({})).size).toBe(0);
  });
});
