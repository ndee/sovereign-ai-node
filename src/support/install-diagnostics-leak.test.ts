/**
 * End-to-end secret-leak matrix for the install diagnostics bundle.
 *
 * Every source kind the builder reads gets a DISTINCT planted secret, in the
 * shapes a real install produces: a value in the secrets directory that also
 * shows up in a log, a credential echoed into a failing step's `error.details`,
 * an older job record that still carries its install request in cleartext, an
 * npm log with a registry token, a journal line with a bearer token, and so on.
 * The archive is then unpacked and every sentinel is searched for in raw,
 * URL-encoded and JSON-escaped form.
 *
 * The matrix asserts two things per source: the secret is absent AND the file
 * that carried it is still in the bundle. The second half matters — a guard
 * that withheld every file would pass a "no sentinel" check trivially and
 * leave the person debugging with nothing.
 *
 * A second block covers adversarial inputs designed to slip past the scrubber
 * (near-miss prefixes, encoded forms, a secret split by a truncation point),
 * and a third replays a failed global npm install to prove the bundle still
 * carries the one line that explains the failure.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildInstallDiagnostics,
  type DiagnosticsRunCommand,
  type DiagnosticsSource,
  pickFields,
} from "./install-diagnostics.js";
import { loadKnownSecrets } from "./known-secrets.js";
import { readZip } from "./zip.js";

const SENTINEL = {
  // No recognisable shape: only the known-secret scrub can remove these.
  imapPassword: "Qx7-plain-IMAP-sentinel-4411",
  openrouterFile: "or-file-sentinel-5522",
  bootstrapToken: "c0ffee-bootstrap-sentinel-6633",
  relayToken: "relay-tunnel-sentinel-7744",
  legacyOperatorPassword: "legacy-operator-sentinel-8855",
  matrixPassword: "matrix-bot-pw-sentinel-9966",
  envToken: "env-file-token-sentinel-1177",
  // Shaped: pattern redaction must remove these.
  openrouterKey: "sk-or-v1-0000sentinel1111aaaa2222bbbb",
  npmToken: "npm_TOKENsentinel0123456789",
  bearer: "eyJBEARERsentinelxxxxxxxxxxxx",
  matrixAccess: "syt_c2VudGluZWw_sentinelAccess_42",
  urlPassword: "urlPwSentinel33",
  mailbox: "private.person.sentinel",
} as const;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "install-diag-leak-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Every form a sentinel could take in the archive. */
const forms = (value: string): string[] => [
  value,
  encodeURIComponent(value),
  JSON.stringify(value).slice(1, -1),
];

const unpack = (archive: Buffer): Map<string, string> =>
  new Map(readZip(archive).map((entry) => [entry.name, entry.data.toString("utf8")]));

const findLeaks = (entries: Map<string, string>, sentinels: readonly string[]): string[] => {
  const leaks: string[] = [];
  for (const [name, text] of entries) {
    for (const sentinel of sentinels) {
      if (forms(sentinel).some((form) => text.includes(form))) {
        leaks.push(`${sentinel} in ${name}`);
      }
    }
  }
  return leaks;
};

interface Fixture {
  readonly sources: DiagnosticsSource[];
  readonly run: DiagnosticsRunCommand;
  readonly secretsDir: string;
  readonly configPath: string;
  readonly jobsDir: string;
  readonly tokenPath: string;
  readonly envPath: string;
}

const plantFixture = async (): Promise<Fixture> => {
  const secretsDir = join(dir, "secrets");
  const jobsDir = join(dir, "install-jobs");
  const npmDir = join(dir, "home", ".npm", "_logs");
  await mkdir(secretsDir, { recursive: true });
  await mkdir(jobsDir, { recursive: true });
  await mkdir(npmDir, { recursive: true });

  await writeFile(join(secretsDir, "imap-password"), `${SENTINEL.imapPassword}\n`);
  await writeFile(join(secretsDir, "openrouter-api-key"), SENTINEL.openrouterFile);
  await writeFile(
    join(secretsDir, "matrix-bot.env"),
    `MATRIX_PASSWORD=${SENTINEL.matrixPassword}\n`,
  );

  const configPath = join(dir, "node.json5");
  await writeFile(
    configPath,
    `{ relay: { tunnel: { token: "${SENTINEL.relayToken}" } }, imap: { secretRef: "file:${join(secretsDir, "imap-password")}" } }`,
  );
  const tokenPath = join(dir, "bootstrap-token");
  await writeFile(tokenPath, SENTINEL.bootstrapToken);
  const envPath = join(dir, "service.env");
  await writeFile(envPath, `LISTEN=1\nUPDATE_TOKEN=${SENTINEL.envToken}\n`);

  // A current job record: secrets only inside error.details free text.
  await writeFile(
    join(jobsDir, "job-current.json"),
    JSON.stringify({
      version: 1,
      request: { imap: { host: "imap.example.com", secretRef: "file:/x" } },
      response: {
        job: {
          jobId: "job-current",
          state: "failed",
          createdAt: "2026-09-27T10:00:00.000Z",
          steps: [
            {
              id: "imap_validate",
              label: "Validate mailbox",
              state: "failed",
              error: {
                code: "IMAP_AUTH_FAILED",
                message: `login ${SENTINEL.mailbox}@example.com failed`,
                retryable: false,
                details: {
                  command: `curl imaps://${SENTINEL.mailbox}:${SENTINEL.urlPassword}@imap.example.com`,
                  stderr: `auth rejected for password ${SENTINEL.imapPassword} (url ${encodeURIComponent(SENTINEL.imapPassword)})`,
                  env: { OPENROUTER_API_KEY: SENTINEL.openrouterKey },
                  echoed: JSON.stringify({ token: SENTINEL.bootstrapToken }),
                },
              },
            },
          ],
        },
      },
    }),
  );
  // An older record written before request secrets were stripped.
  await writeFile(
    join(jobsDir, "job-legacy.json"),
    JSON.stringify({
      version: 1,
      request: {
        imap: { password: SENTINEL.imapPassword },
        operator: { password: SENTINEL.legacyOperatorPassword },
        relay: { tunnel: { token: SENTINEL.relayToken } },
      },
      response: {
        job: {
          jobId: "job-legacy",
          state: "failed",
          createdAt: "2026-09-26T10:00:00.000Z",
          steps: [
            {
              id: "matrix_bootstrap_accounts",
              label: "Accounts",
              state: "failed",
              error: {
                code: "MATRIX_FAILED",
                message: "operator login failed",
                retryable: true,
                details: { note: `operator pw was ${SENTINEL.legacyOperatorPassword}` },
              },
            },
          ],
        },
      },
    }),
  );

  await writeFile(
    join(npmDir, "2026-09-27T10_00_00_000Z-debug-0.log"),
    [
      "0 verbose cli /usr/bin/node /usr/bin/npm",
      `1 silly config //registry.npmjs.org/:_authToken=${SENTINEL.npmToken}`,
      `2 verbose env OPENROUTER_API_KEY=${SENTINEL.openrouterKey}`,
      `3 verbose password ${SENTINEL.imapPassword}`,
      "4 error code EACCES",
    ].join("\n"),
  );

  const installerLog = join(dir, "installer.log");
  await writeFile(
    installerLog,
    `curl -H "Authorization: Bearer ${SENTINEL.bearer}" https://relay\nrelay token ${SENTINEL.relayToken}\n`,
  );
  const updateLog = join(dir, "update.log");
  await writeFile(
    updateLog,
    `matrix login ok access_token=${SENTINEL.matrixAccess}\nmatrix pw ${SENTINEL.matrixPassword}\n`,
  );
  const statusPath = join(dir, "status.json");
  await writeFile(
    statusPath,
    JSON.stringify({
      phase: "failed",
      note: `token ${SENTINEL.bootstrapToken}`,
      apiKey: SENTINEL.openrouterKey,
    }),
  );

  const run: DiagnosticsRunCommand = async (file) => {
    if (file === "journalctl") {
      return {
        stdout: [
          `Sep 27 api[1]: request Authorization: Bearer ${SENTINEL.bearer}`,
          `Sep 27 api[1]: ${JSON.stringify({ msg: "config", openrouter: { apiKey: SENTINEL.openrouterKey } })}`,
          `Sep 27 api[1]: imap password ${SENTINEL.imapPassword} for ${SENTINEL.mailbox}@example.com`,
          `Sep 27 api[1]: env ${SENTINEL.envToken}`,
        ].join("\n"),
      };
    }
    throw new Error("unavailable");
  };

  const sources: DiagnosticsSource[] = [
    { kind: "install-jobs", dir: jobsDir },
    { kind: "npm-logs", dirs: [npmDir] },
    { kind: "journal", unit: "sovereign-node-api" },
    { kind: "file-tail", name: "installer.log", path: installerLog, purpose: "installer log" },
    { kind: "file-tail", name: "update.log", path: updateLog, purpose: "update log" },
    { kind: "json-file", name: "status.json", path: statusPath, purpose: "status" },
    {
      kind: "json-file",
      name: "status-picked.json",
      path: statusPath,
      purpose: "status (allowlisted)",
      pick: (parsed) => pickFields(parsed, ["phase"]),
    },
    {
      kind: "value",
      name: "facts.json",
      purpose: "facts",
      value: { firstbootPending: true, echoed: `imap ${SENTINEL.imapPassword}` },
    },
    { kind: "system" },
  ];
  return { sources, run, secretsDir, configPath, jobsDir, tokenPath, envPath };
};

const buildFromFixture = async (fixture: Fixture) =>
  buildInstallDiagnostics({
    sources: fixture.sources,
    run: fixture.run,
    readKernelFile: async () => "",
    generatedBy: "leak-test",
    product: { version: "1.0.0", note: `built with ${SENTINEL.relayToken}` },
    knownSecrets: await loadKnownSecrets({
      secretDirs: [fixture.secretsDir],
      secretFiles: [fixture.tokenPath],
      structuredFiles: [fixture.configPath],
      envFiles: [fixture.envPath],
      recordDirs: [fixture.jobsDir],
    }),
  });

describe("install diagnostics — sentinel matrix", () => {
  it("contains no planted secret, in any encoding, in any entry", async () => {
    const result = await buildFromFixture(await plantFixture());
    const entries = unpack(result.archive);
    expect(findLeaks(entries, Object.values(SENTINEL))).toEqual([]);
  });

  it("still ships every source that carried a secret (nothing vacuously withheld)", async () => {
    const result = await buildFromFixture(await plantFixture());
    const statuses = Object.fromEntries(
      result.manifest.files.map((entry) => [entry.file, entry.status]),
    );
    expect(statuses).toEqual({
      "files/install-jobs/job-current.json": "collected",
      "files/install-jobs/job-legacy.json": "collected",
      "files/npm-logs/2026-09-27T10_00_00_000Z-debug-0.log": "collected",
      "files/journal/sovereign-node-api.txt": "collected",
      "files/installer.log": "collected",
      "files/update.log": "collected",
      "files/status.json": "collected",
      "files/status-picked.json": "collected",
      "files/facts.json": "collected",
      "files/system.json": "collected",
    });
    const entries = unpack(result.archive);
    // The diagnostic content around the secrets survives.
    expect(entries.get("files/install-jobs/job-current.json")).toContain("IMAP_AUTH_FAILED");
    expect(entries.get("files/install-jobs/job-current.json")).toContain("***@example.com");
    expect(entries.get("files/install-jobs/job-current.json")).toContain("imap.example.com");
    expect(entries.get("files/npm-logs/2026-09-27T10_00_00_000Z-debug-0.log")).toContain(
      "error code EACCES",
    );
    expect(entries.get("files/install-jobs/job-legacy.json")).not.toContain("request");
  });

  it("negative control: the same search finds a sentinel that was not scrubbed", async () => {
    const fixture = await plantFixture();
    const result = await buildInstallDiagnostics({
      sources: fixture.sources,
      run: fixture.run,
      readKernelFile: async () => "",
      generatedBy: "leak-test",
      // No known-secret set: shapeless secrets must now be found by the search.
    });
    const leaks = findLeaks(unpack(result.archive), [SENTINEL.imapPassword, SENTINEL.relayToken]);
    expect(leaks.length).toBeGreaterThan(0);
  });
});

describe("install diagnostics — adversarial inputs", () => {
  const buildOne = async (content: string, known: string[] = [], maxBytes?: number) => {
    await writeFile(join(dir, "x.log"), content);
    return buildInstallDiagnostics({
      sources: [
        {
          kind: "file-tail",
          name: "x.log",
          path: join(dir, "x.log"),
          purpose: "p",
          ...(maxBytes === undefined ? {} : { maxBytes }),
        },
      ],
      generatedBy: "adversarial",
      knownSecrets: await loadKnownSecrets({ values: known }),
    });
  };

  it.each([
    ["near-miss vendor prefix glued to a word", "idxsk-or-v1-0123456789abcdef"],
    ["percent-encoded key", "key=sk%2Dor%2Dv1%2D0123456789abcdef"],
    ["JSON-escaped key", `"sk\\u002dor\\u002dv1\\u002d0123456789abcdef"`],
    ["hex-escaped key", "sk\\x2dor\\x2dv1\\x2d0123456789abcdef"],
    ["private key header", "-----BEGIN RSA PRIVATE KEY-----"],
  ])("withholds the file for a %s", async (_name, content) => {
    const result = await buildOne(`before\n${content}\nafter\n`);
    expect(result.manifest.files[0]?.status).toBe("withheld");
    expect(unpack(result.archive).has("files/x.log")).toBe(false);
  });

  it.each([
    ["matrix token glued to an identifier", "session_syt_abcdefghij_0123", "abcdefghij_0123"],
    ["uppercase bearer", "BEARER abcdefghijklmnopqrstuvwxyz0123", "abcdefghijklmnopqrstuvwxyz0123"],
    ["password in a URL", "imaps://me:Hunter2Hunter2@imap.example.com", "Hunter2Hunter2"],
  ])("never ships a %s: redacted in place or withheld", async (_name, content, core) => {
    const result = await buildOne(`before\n${content}\nafter\n`);
    const text = unpack(result.archive).get("files/x.log");
    expect(text === undefined || !text.includes(core)).toBe(true);
  });

  it("scrubs a known value in every encoding without withholding the file", async () => {
    const secret = 'sp ace&amp/"quoted"';
    const result = await buildOne(
      `a ${secret}\nb ${encodeURIComponent(secret)}\nc ${JSON.stringify(secret)}\n`,
      [secret],
    );
    expect(result.manifest.files[0]?.status).toBe("collected");
    expect(findLeaks(unpack(result.archive), [secret])).toEqual([]);
  });

  it("never lets a truncation point split a secret into a surviving fragment", async () => {
    const secret = "SPLITsecretVALUE0123456789";
    const cap = 4096;
    // Place the secret so the read window (cap + margin) and the final cut
    // each start inside it, in two separate runs.
    for (const offsetFromEnd of [cap + 64 * 1024 + 10, cap + 10, cap - 5]) {
      const tail = "t\n".repeat(Math.floor(offsetFromEnd / 2));
      const content = `${"h".repeat(200_000)}\nprefix ${secret} suffix${tail}`;
      const result = await buildOne(content, [secret], cap);
      const text = unpack(result.archive).get("files/x.log") ?? "";
      for (let length = 6; length < secret.length; length += 1) {
        expect(text).not.toContain(secret.slice(secret.length - length));
      }
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(cap);
    }
  });
});

describe("install diagnostics — failed global npm install replay", () => {
  /**
   * Shaped like a real failed install: the job record's failing step carries
   * npm's stderr in `error.details`, and the npm debug log is ~3000 lines with
   * the decisive error at the very end.
   */
  it("carries the EACCES line from both the job record and the tail of the npm log", async () => {
    const jobsDir = join(dir, "install-jobs");
    const npmDir = join(dir, ".npm", "_logs");
    await mkdir(jobsDir, { recursive: true });
    await mkdir(npmDir, { recursive: true });
    const eacces =
      "npm error Error: EACCES: permission denied, mkdir '/usr/lib/node_modules/openclaw'";
    const stderr = [
      "npm error code EACCES",
      "npm error syscall mkdir",
      "npm error path /usr/lib/node_modules/openclaw",
      "npm error errno -13",
      eacces,
      "npm error The operation was rejected by your operating system.",
    ].join("\n");
    await writeFile(
      join(jobsDir, "job-replay.json"),
      JSON.stringify({
        version: 1,
        response: {
          job: {
            jobId: "job-replay",
            state: "failed",
            createdAt: "2026-09-20T18:00:00.000Z",
            steps: [
              { id: "preflight", label: "Preflight", state: "succeeded" },
              {
                id: "openclaw_bootstrap_cli",
                label: "Install runtime",
                state: "failed",
                error: {
                  code: "OPENCLAW_BOOTSTRAP_FAILED",
                  message: "OpenClaw CLI installation failed",
                  retryable: true,
                  details: {
                    exitCode: 243,
                    stderr: `${"npm http fetch GET 200\n".repeat(400)}${stderr}`,
                  },
                },
              },
            ],
          },
        },
      }),
    );
    const debugLog = [
      ...Array.from(
        { length: 3000 },
        (_, index) => `${index} silly placeDep ROOT pkg-${index}@1.0.0 OK`,
      ),
      ...stderr.split("\n").map((line, index) => `${3000 + index} ${line.replace(/^npm /u, "")}`),
      "3006 verbose exit 243",
    ].join("\n");
    await writeFile(join(npmDir, "2026-09-20T18_01_00_000Z-debug-0.log"), debugLog);

    const result = await buildInstallDiagnostics({
      sources: [
        { kind: "install-jobs", dir: jobsDir },
        { kind: "npm-logs", dirs: [npmDir], maxBytes: 64 * 1024 },
      ],
      generatedBy: "replay",
    });
    const entries = unpack(result.archive);
    const record = entries.get("files/install-jobs/job-replay.json") ?? "";
    const npmLog = entries.get("files/npm-logs/2026-09-20T18_01_00_000Z-debug-0.log") ?? "";
    expect(record).toContain("EACCES: permission denied, mkdir '/usr/lib/node_modules/openclaw'");
    expect(npmLog).toContain("EACCES: permission denied, mkdir '/usr/lib/node_modules/openclaw'");
    expect(npmLog).toContain("verbose exit 243");
    expect(
      result.manifest.files.find((entry) => entry.file.startsWith("files/npm-logs/"))?.truncated,
    ).toBe(true);
    expect(result.complete).toBe(true);
    expect(result.bytes).toBeLessThan(2 * 1024 * 1024);
  });
});
