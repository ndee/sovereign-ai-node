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
 *
 * A fourth block does the same for IP addresses: a public IPv4, a global
 * EUI-64 IPv6, a ULA and a link-local address (documentation ranges only) are
 * planted in every source kind and must be absent from the archive in every
 * encoding, while the files that carried them are still collected.
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
import { findUnmaskedIpClasses } from "./ip-mask.js";
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
    // Nothing in the replay is an address: the masker touched no byte of it.
    expect(result.manifest.files.map((entry) => entry.masked)).toEqual([{}, {}]);
  });
});

/**
 * Documentation ranges only — the masker classifies them as PUBLIC on purpose,
 * so no real address is ever needed here. The ULA and link-local addresses
 * carry an EUI-64 interface id (`…ff:fe…`), the part that encodes a MAC.
 */
const ADDRESS = {
  publicIpv4: "203.0.113.45",
  otherPublicIpv4: "198.51.100.77",
  globalEui64: "2001:db8:4:5:a8bb:ccff:fe11:2233",
  ula: "fd12:3456:789a:1:a8bb:ccff:fe11:2244",
  linkLocal: "fe80::a8bb:ccff:fe11:2255",
  mac: "a8:bb:cc:11:22:66",
} as const;

/** Fragments that identify on their own: each /64 prefix and each interface id. */
const ADDRESS_FRAGMENTS = [
  "2001:db8:4:5:",
  "fd12:3456:789a:1:",
  "fe11:2233",
  "fe11:2244",
  "fe11:2255",
  "a8bb:ccff",
  "a8bbcc112266",
];

/** Every form an address could take in the archive. */
const addressForms = (value: string): string[] => [
  ...new Set([
    value,
    value.toUpperCase(),
    value.toLowerCase(),
    value.replaceAll(":", "%3A"),
    value.replaceAll(":", "%3a"),
    encodeURIComponent(value),
    JSON.stringify(value).slice(1, -1),
  ]),
];

const findAddressLeaks = (entries: Map<string, string>): string[] => {
  const leaks: string[] = [];
  for (const [name, text] of entries) {
    for (const value of [...Object.values(ADDRESS), ...ADDRESS_FRAGMENTS]) {
      if (addressForms(value).some((form) => text.includes(form))) {
        leaks.push(`${value} in ${name}`);
      }
    }
  }
  return leaks;
};

const plantAddresses = async (): Promise<{
  sources: DiagnosticsSource[];
  run: DiagnosticsRunCommand;
}> => {
  const { publicIpv4: v4, globalEui64: g6, ula, linkLocal: ll, mac } = ADDRESS;
  const jobsDir = join(dir, "install-jobs");
  const npmDir = join(dir, "npm-logs");
  await mkdir(jobsDir, { recursive: true });
  await mkdir(npmDir, { recursive: true });

  // A failing preflight's DNS error, as text and as the structured fields the
  // resolver check writes, plus an address-keyed map.
  await writeFile(
    join(jobsDir, "job-dns.json"),
    JSON.stringify({
      version: 1,
      response: {
        job: {
          jobId: "job-dns",
          state: "failed",
          createdAt: "2026-10-05T10:00:00.000Z",
          steps: [
            {
              id: "preflight",
              label: "Preflight",
              state: "failed",
              error: {
                code: "RELAY_UNREACHABLE",
                message: `relay.example.net resolved (${v4}), connect ETIMEDOUT ${v4}:443`,
                retryable: true,
                details: {
                  stderr: `queryAaaa relay.example.net -> [${g6}]:443 ETIMEDOUT`,
                  address: g6,
                  family: 6,
                  resolvers: { [ula]: "timeout", [`${ll}%eth0`]: "ok" },
                },
              },
            },
          ],
        },
      },
    }),
  );
  await writeFile(
    join(npmDir, "2026-10-05T10_00_00_000Z-debug-0.log"),
    [
      "0 verbose cli /usr/bin/node /usr/bin/npm",
      `1 http fetch GET https://registry.example/?via=${g6.replaceAll(":", "%3A")} failed`,
      `2 error connect ECONNREFUSED ${v4}:443`,
      `3 verbose source ${ll.toUpperCase()}`,
      "4 error code EACCES",
    ].join("\n"),
  );
  const fileTail = join(dir, "installer.log");
  await writeFile(
    fileTail,
    [
      `inet6 ${g6.toUpperCase()}/64 scope global`,
      `inet6 ${ula.toUpperCase()}/64`,
      `inet6 ${ll.toUpperCase()}%ENXA8BBCC112266 scope link`,
      `link/ether ${mac.toUpperCase()} brd ff:ff:ff:ff:ff:ff`,
      `wan ${ADDRESS.otherPublicIpv4} lan 192.168.1.20`,
    ].join("\n"),
  );
  const jsonPath = join(dir, "network.json");
  await writeFile(
    jsonPath,
    JSON.stringify({ wan: v4, peers: { [g6]: { via: `${ll}%eth0` } }, ula, mac }),
  );

  const run: DiagnosticsRunCommand = async (file, args) => {
    if (file === "journalctl" && args.includes("sovereign-node-api")) {
      return {
        stdout: [
          `Oct 05 api[1]: listening on [${ula}]:8787`,
          `Oct 05 api[1]: neighbour ${ll}%wlan0 lladdr ${mac}`,
          `Oct 05 api[1]: ${JSON.stringify({ msg: "dns", address: g6, family: 6 })}`,
          `Oct 05 api[1]: upstream ${v4}`,
        ].join("\n"),
      };
    }
    // The unreadable source: its failure reason carries an address.
    throw new Error(`connect ETIMEDOUT ${v4}:443`);
  };

  const sources: DiagnosticsSource[] = [
    { kind: "install-jobs", dir: jobsDir },
    { kind: "npm-logs", dirs: [npmDir] },
    { kind: "journal", unit: "sovereign-node-api" },
    { kind: "journal", unit: "sovereign-relay-tunnel" },
    { kind: "file-tail", name: "installer.log", path: fileTail, purpose: "installer log" },
    { kind: "json-file", name: "network.json", path: jsonPath, purpose: "network" },
    {
      kind: "value",
      name: "facts.json",
      purpose: "facts",
      value: { [v4]: "seen", list: [ula, `[${g6}]:993`] },
    },
    { kind: "system" },
  ];
  return { sources, run };
};

const buildWithAddresses = async () => {
  const { sources, run } = await plantAddresses();
  return buildInstallDiagnostics({
    sources,
    run,
    readKernelFile: async () => "",
    generatedBy: "ip-leak-test",
    product: { version: "1.0.0", wan: ADDRESS.globalEui64, [ADDRESS.publicIpv4]: true },
  });
};

describe("install diagnostics — IP address matrix", () => {
  it("contains no planted address, prefix or interface id, in any encoding, in any entry", async () => {
    const entries = unpack((await buildWithAddresses()).archive);
    expect(entries.has("manifest.json")).toBe(true);
    expect(findAddressLeaks(entries)).toEqual([]);
  });

  it("fails if any identifying address at all survives anywhere in the archive", async () => {
    const entries = unpack((await buildWithAddresses()).archive);
    const survivors = [...entries].flatMap(([name, text]) =>
      findUnmaskedIpClasses(text).map((cls) => `${cls} in ${name}`),
    );
    expect(survivors).toEqual([]);
  });

  it("negative control: the same search finds an address that was not masked", () => {
    const entries = new Map([["x", `x ${ADDRESS.linkLocal.toUpperCase()} x`]]);
    expect(findAddressLeaks(entries)).not.toEqual([]);
    expect(findUnmaskedIpClasses(`x ${ADDRESS.otherPublicIpv4} x`)).toEqual(["public-ipv4"]);
  });

  it("still ships every source that carried an address, with counts in the manifest", async () => {
    const result = await buildWithAddresses();
    const byFile = new Map(result.manifest.files.map((entry) => [entry.file, entry]));
    expect(Object.fromEntries([...byFile].map(([file, entry]) => [file, entry.status]))).toEqual({
      "files/install-jobs/job-dns.json": "collected",
      "files/npm-logs/2026-10-05T10_00_00_000Z-debug-0.log": "collected",
      "files/journal/sovereign-node-api.txt": "collected",
      "files/journal/sovereign-relay-tunnel.txt": "unavailable",
      "files/installer.log": "collected",
      "files/network.json": "collected",
      "files/facts.json": "collected",
      "files/system.json": "collected",
    });
    expect(byFile.get("files/install-jobs/job-dns.json")?.masked).toEqual({
      "public-ipv4": 2,
      "global-ipv6": 2,
      "link-local-ipv6": 1,
      "ula-ipv6": 1,
    });
    expect(byFile.get("files/installer.log")?.masked).toEqual({
      "public-ipv4": 1,
      "global-ipv6": 1,
      "link-local-ipv6": 1,
      "ula-ipv6": 1,
      mac: 2,
    });
    // The unreadable source's reason is masked, not dropped.
    expect(byFile.get("files/journal/sovereign-relay-tunnel.txt")?.reason).toMatch(
      /^boot 0: connect ETIMEDOUT <public-ipv4#\d+>:443$/u,
    );
    const entries = unpack(result.archive);
    // Diagnostic content around the addresses survives: class, port, zone, LAN.
    const log = entries.get("files/installer.log") ?? "";
    expect(log).toMatch(/<link-local-ipv6#\d+>%ENX<mac#\d+> scope link/u);
    expect(log).toContain("brd ff:ff:ff:ff:ff:ff");
    expect(log).toContain("lan 192.168.1.20");
    expect(entries.get("files/journal/sovereign-node-api.txt")).toMatch(
      /listening on \[<ula-ipv6#\d+>\]:8787/u,
    );
    expect(entries.get("files/npm-logs/2026-10-05T10_00_00_000Z-debug-0.log")).toContain(
      "error code EACCES",
    );
    expect(result.manifest.product).toMatchObject({ version: "1.0.0" });
  });

  it("gives one address one token across every file and the manifest, and others other tokens", async () => {
    const result = await buildWithAddresses();
    const entries = unpack(result.archive);
    const tokenOf = (text: string | undefined, pattern: RegExp): string =>
      pattern.exec(text ?? "")?.[1] ?? `no match for ${pattern}`;
    const v4 = /(<public-ipv4#\d+>):443/u;
    const inJob = tokenOf(entries.get("files/install-jobs/job-dns.json"), v4);
    const inNpm = tokenOf(entries.get("files/npm-logs/2026-10-05T10_00_00_000Z-debug-0.log"), v4);
    const inReason = tokenOf(
      result.manifest.files.find((entry) => entry.status === "unavailable")?.reason,
      v4,
    );
    const inProduct = Object.keys(result.manifest.product as object).find((key) =>
      key.startsWith("<public-ipv4#"),
    );
    expect(inJob).toMatch(/^<public-ipv4#\d+>$/u);
    expect([inNpm, inReason, inProduct]).toEqual([inJob, inJob, inJob]);
    const other = tokenOf(entries.get("files/installer.log"), /wan (<public-ipv4#\d+>)/u);
    expect(other).toMatch(/^<public-ipv4#\d+>$/u);
    expect(other).not.toBe(inJob);
    // The same global address, bracketed in a job record and quoted in a journal.
    const g6Job = tokenOf(
      entries.get("files/install-jobs/job-dns.json"),
      /\[(<global-ipv6#\d+>)\]:443/u,
    );
    const g6Journal = tokenOf(
      entries.get("files/journal/sovereign-node-api.txt"),
      /"address":"(<global-ipv6#\d+>)"/u,
    );
    expect(g6Journal).toBe(g6Job);
    expect((result.manifest.product as Record<string, unknown>).wan).toBe(g6Job);
  });

  it("numbers afresh in the next bundle", async () => {
    const first = await buildWithAddresses();
    const second = await buildWithAddresses();
    expect(second.manifest.product).toEqual(first.manifest.product);
  });

  const buildText = async (content: string, maxBytes?: number) => {
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
      generatedBy: "ip-adversarial",
    });
  };

  it.each([
    [
      "JSON-escaped colons",
      String.raw`host 2001\u003adb8\u003a4\u003a5\u003a\u003a1`,
      "global-ipv6",
    ],
    ["hex-escaped dots", String.raw`upstream 203\x2e0\x2e113\x2e45`, "public-ipv4"],
  ])("withholds the file for an address behind %s, naming only the class", async (_n, line, cls) => {
    const result = await buildText(`before\n${line}\nafter\n`);
    const entry = result.manifest.files[0];
    expect(entry?.status).toBe("withheld");
    expect(entry?.reason).toBe(
      `withheld: text still contained an IP address after masking (${cls})`,
    );
    expect(unpack(result.archive).has("files/x.log")).toBe(false);
    expect(findAddressLeaks(unpack(result.archive))).toEqual([]);
  });

  it("withholds a reason or product value the masker could not clean", async () => {
    const exotic = String.raw`2001\u003adb8\u003a\u003a9`;
    const result = await buildInstallDiagnostics({
      sources: [{ kind: "journal", unit: "x" }],
      run: async () => {
        throw new Error(`dns ${exotic}`);
      },
      generatedBy: "ip-adversarial",
      product: { note: exotic },
    });
    expect(result.manifest.files[0]?.reason).toBe(
      "reason withheld: it still contained an IP address after masking (global-ipv6)",
    );
    expect(result.manifest.product).toBe(
      "[withheld: it still contained an IP address after masking (global-ipv6)]",
    );
  });

  it("never lets a truncation point leave the tail of an address behind", async () => {
    const address = ADDRESS.globalEui64;
    const cap = 4096;
    for (const offsetFromEnd of [cap + 64 * 1024 + 10, cap + 10, cap - 5]) {
      const tail = "t\n".repeat(Math.floor(offsetFromEnd / 2));
      const content = `${"h".repeat(200_000)}\nwan ${address} up${tail}`;
      const result = await buildText(content, cap);
      expect(result.manifest.files[0]?.status).toBe("collected");
      const text = unpack(result.archive).get("files/x.log") ?? "";
      for (let length = 4; length < address.length; length += 1) {
        expect(text).not.toContain(address.slice(address.length - length));
      }
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(cap);
    }
  });
});
