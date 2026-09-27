import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_PATHS } from "../config/paths.js";
import {
  buildInstallDiagnostics,
  collectSystemSummary,
  DEFAULT_MAX_TOTAL_BYTES,
  type DiagnosticsManifest,
  type DiagnosticsRunCommand,
  type DiagnosticsSource,
  decodeThrottled,
  defaultDiagnosticsRun,
  defaultNodeDiagnosticsSources,
  defaultNodeKnownSecretSources,
  diagnosticsFileName,
  npmLogsDir,
  pickFields,
  pickInstallJobRecord,
  renderReadme,
  scrubDiagnosticText,
  scrubDiagnosticValue,
  shedToFit,
} from "./install-diagnostics.js";
import { KnownSecretSet, REDACTED_KNOWN } from "./known-secrets.js";
import { REDACTED, REDACTED_PII } from "./redact.js";
import { readZip } from "./zip.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "install-diag-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const noCommands: DiagnosticsRunCommand = async () => {
  throw new Error("command not available");
};

const entriesOf = (archive: Buffer): Map<string, string> =>
  new Map(readZip(archive).map((entry) => [entry.name, entry.data.toString("utf8")]));

const manifestOf = (archive: Buffer): DiagnosticsManifest =>
  JSON.parse(entriesOf(archive).get("manifest.json") ?? "{}") as DiagnosticsManifest;

const build = (
  sources: DiagnosticsSource[],
  extra: Partial<Parameters<typeof buildInstallDiagnostics>[0]> = {},
) =>
  buildInstallDiagnostics({
    sources,
    generatedBy: "test",
    run: noCommands,
    now: () => new Date("2026-09-27T12:00:00Z"),
    ...extra,
  });

interface PickedStep {
  readonly durationMs?: number | null;
  readonly error?: { readonly details: Record<string, unknown> };
  readonly [key: string]: unknown;
}

interface PickedRecord {
  readonly recordVersion: unknown;
  readonly job: {
    readonly jobId: string;
    readonly durationMs: number | null;
    readonly steps: PickedStep[];
  };
  readonly error?: { readonly code: string };
}

interface FailingStep {
  error: { details: unknown };
}

const jobRecord = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  installationId: "inst-1",
  request: { imap: { host: "imap.example.com", password: "cleartext-imap-pw" } },
  response: {
    job: {
      jobId: "job-abc",
      state: "failed",
      createdAt: "2026-09-27T10:00:00.000Z",
      startedAt: "2026-09-27T10:00:01.000Z",
      endedAt: "2026-09-27T10:05:01.000Z",
      currentStepId: "openclaw_bootstrap_cli",
      steps: [
        {
          id: "preflight",
          label: "Preflight",
          state: "succeeded",
          startedAt: "2026-09-27T10:00:01.000Z",
          endedAt: "2026-09-27T10:00:03.500Z",
          details: { internal: "dropped" },
        },
        {
          id: "openclaw_bootstrap_cli",
          label: "Install runtime",
          state: "failed",
          startedAt: "2026-09-27T10:00:04.000Z",
          endedAt: "2026-09-27T10:05:01.000Z",
          error: {
            code: "OPENCLAW_INSTALL_FAILED",
            message: "install failed",
            retryable: true,
            details: { stderr: "npm error code EACCES" },
          },
        },
      ],
    },
    error: { code: "OPENCLAW_INSTALL_FAILED", message: "install failed", retryable: true },
  },
  updatedAt: "2026-09-27T10:05:01.000Z",
  ...overrides,
});

describe("scrubDiagnosticText", () => {
  it("scrubs known values, patterns and email local parts, without a length bound", () => {
    const known = new KnownSecretSet(["no-shape-password"]);
    const long = "x".repeat(20_000);
    const text = `${long}\nlogin no-shape-password for alice@example.com password=hunter2 end`;
    const scrubbed = scrubDiagnosticText(text, known);
    expect(scrubbed).toContain(REDACTED_KNOWN);
    expect(scrubbed).toContain("***@example.com");
    expect(scrubbed).toContain(`password=${REDACTED}`);
    expect(scrubbed.endsWith("end")).toBe(true);
    expect(scrubbed.length).toBeGreaterThan(20_000);
  });

  it("works without a known set", () => {
    expect(scrubDiagnosticText("token=abc")).toBe(`token=${REDACTED}`);
  });
});

describe("scrubDiagnosticValue", () => {
  it("redacts secret and PII keys, masks address keys, scrubs and tails strings", () => {
    const value = scrubDiagnosticValue(
      {
        apiKey: "sk-or-v1-whatever",
        subject: "private subject",
        "bob@example.com": 3,
        note: `${"a".repeat(200)}\ntail line`,
        list: [1, true, null, "x"],
        missing: undefined,
      },
      undefined,
      160,
    ) as Record<string, unknown>;
    expect(value.apiKey).toBe(REDACTED);
    expect(value.subject).toBe(REDACTED_PII);
    expect(value["***@example.com"]).toBe(3);
    expect(value.note).toContain("tail line");
    expect(String(value.note)).not.toContain("a".repeat(200));
    expect(value.list).toEqual([1, true, null, "x"]);
    expect(value.missing).toBeNull();
  });

  it("bounds depth and array length", () => {
    let deep: unknown = "leaf";
    for (let index = 0; index < 20; index += 1) {
      deep = { d: deep };
    }
    expect(JSON.stringify(scrubDiagnosticValue(deep))).toContain("[REDACTED:DEPTH]");
    const long = scrubDiagnosticValue(Array.from({ length: 500 }, (_, index) => index)) as number[];
    expect(long).toHaveLength(200);
    expect(long.at(-1)).toBe(499);
  });
});

describe("field allowlists", () => {
  it("pickFields copies only present named keys", () => {
    expect(pickFields({ a: 1, b: 2, c: undefined }, ["a", "c", "d"])).toEqual({ a: 1 });
    expect(pickFields("not an object", ["a"])).toEqual({});
    expect(pickFields([1, 2], ["0"])).toEqual({});
  });

  it("pickInstallJobRecord keeps job, steps, timings and error details, drops the request", () => {
    const picked = pickInstallJobRecord(jobRecord()) as unknown as PickedRecord;
    expect(picked).not.toHaveProperty("request");
    expect(picked).not.toHaveProperty("installationId");
    expect(picked.job.jobId).toBe("job-abc");
    expect(picked.job.durationMs).toBe(300_000);
    expect(picked.job.steps[0]).not.toHaveProperty("details");
    expect(picked.job.steps[0]?.durationMs).toBe(2500);
    expect(picked.job.steps[0]).not.toHaveProperty("error");
    expect(picked.job.steps[1]?.error?.details.stderr).toBe("npm error code EACCES");
    expect(picked.error?.code).toBe("OPENCLAW_INSTALL_FAILED");
  });

  it("pickInstallJobRecord accepts a bare job shape and tolerates odd steps", () => {
    const picked = pickInstallJobRecord({
      job: { jobId: "j", steps: ["junk", { id: "x", startedAt: "bad", endedAt: "worse" }] },
    }) as unknown as PickedRecord;
    expect(picked.recordVersion).toBeNull();
    expect(picked.job.durationMs).toBeNull();
    expect(picked.job.steps).toEqual([
      { durationMs: null },
      { id: "x", startedAt: "bad", endedAt: "worse", durationMs: null },
    ]);
    expect(pickInstallJobRecord({ job: { jobId: "j", steps: "nope" } })).toMatchObject({
      job: { steps: [] },
    });
  });

  it("pickInstallJobRecord rejects anything without a job", () => {
    expect(pickInstallJobRecord(null)).toBeUndefined();
    expect(pickInstallJobRecord({ response: {} })).toBeUndefined();
  });
});

describe("install job collection", () => {
  it("takes the newest records up to the limit, named by job id", async () => {
    const jobs = join(dir, "jobs");
    await mkdir(jobs);
    for (const [index, id] of ["old", "mid", "new"].entries()) {
      const path = join(jobs, `${id}.json`);
      await writeFile(path, JSON.stringify(jobRecord()));
      const time = new Date(Date.UTC(2026, 8, 20 + index));
      await utimes(path, time, time);
    }
    await writeFile(join(jobs, "readme.txt"), "not a record");
    await mkdir(join(jobs, "sub.json"));
    const result = await build([{ kind: "install-jobs", dir: jobs, limit: 2 }]);
    const files = result.manifest.files.map((entry) => entry.file);
    expect(files).toEqual(["files/install-jobs/new.json", "files/install-jobs/mid.json"]);
    expect(result.complete).toBe(true);
  });

  it("records missing, invalid, foreign, unsafe-named and oversized records honestly", async () => {
    const jobs = join(dir, "jobs");
    await mkdir(jobs);
    await writeFile(join(jobs, "bad.json"), "{not json");
    await writeFile(join(jobs, "foreign.json"), JSON.stringify({ hello: "world" }));
    await writeFile(join(jobs, "we ird!.json"), JSON.stringify(jobRecord()));
    const huge = jobRecord();
    (huge.response.job.steps[1] as unknown as FailingStep).error.details = {
      a: "x\n".repeat(60_000),
      b: "y\n".repeat(60_000),
      c: "z\n".repeat(60_000),
    };
    await writeFile(join(jobs, "huge.json"), JSON.stringify(huge));
    const tooHuge = jobRecord();
    (tooHuge.response.job.steps[1] as unknown as FailingStep).error.details = Object.fromEntries(
      Array.from({ length: 60 }, (_, index) => [`k${index}`, "q\n".repeat(10_000)]),
    );
    await writeFile(join(jobs, "toohuge.json"), JSON.stringify(tooHuge));
    await symlink("/etc/hostname", join(jobs, "link.json"));

    const result = await build([{ kind: "install-jobs", dir: jobs, limit: 10 }]);
    const byFile = new Map(result.manifest.files.map((entry) => [entry.file, entry]));
    expect(byFile.get("files/install-jobs/bad.json")?.reason).toBe("not valid JSON");
    expect(byFile.get("files/install-jobs/foreign.json")?.reason).toBe("not an install job record");
    expect([...byFile.keys()].some((file) => /job-\d+\.json$/u.test(file))).toBe(true);
    expect(byFile.get("files/install-jobs/huge.json")?.status).toBe("collected");
    expect(byFile.get("files/install-jobs/huge.json")?.truncated).toBe(true);
    expect(byFile.get("files/install-jobs/toohuge.json")?.reason).toContain("after shortening");
    expect(byFile.has("files/install-jobs/link.json")).toBe(false);
    expect(result.complete).toBe(false);
  });

  it("reports an absent directory as unavailable", async () => {
    const result = await build([{ kind: "install-jobs", dir: join(dir, "nope") }]);
    expect(result.manifest.files[0]).toMatchObject({
      file: "files/install-jobs/",
      status: "unavailable",
      reason: "no install job records found",
    });
  });

  it("reports a record that cannot be read", async () => {
    const jobs = join(dir, "jobs");
    await mkdir(jobs);
    const path = join(jobs, "locked.json");
    await writeFile(path, "{}");
    // Replace the file with a FIFO-like non-regular entry after listing is not
    // portable; a record over the read cap exercises the same branch.
    await writeFile(path, " ".repeat(8 * 1024 * 1024 + 1));
    const result = await build([{ kind: "install-jobs", dir: jobs }]);
    expect(result.manifest.files[0]?.reason).toContain("refused: larger than");
  });
});

describe("npm debug log collection", () => {
  it("takes the newest logs across directories, tail only", async () => {
    const a = join(dir, "a");
    const b = join(dir, "b");
    await mkdir(a);
    await mkdir(b);
    const files = [
      [a, "2026-09-27T10_00_00_000Z-debug-0.log", 1],
      [b, "2026-09-27T11_00_00_000Z-debug-0.log", 2],
      [a, "2026-09-27T12_00_00_000Z-debug-0.log", 3],
      [b, "unrelated.txt", 4],
    ] as const;
    for (const [folder, name, day] of files) {
      const path = join(folder, name);
      await writeFile(path, `${"filler line\n".repeat(10_000)}npm error ${name}\n`);
      const time = new Date(Date.UTC(2026, 8, day));
      await utimes(path, time, time);
    }
    const result = await build([
      { kind: "npm-logs", dirs: [a, b, join(dir, "missing")], limit: 2, maxBytes: 4096 },
    ]);
    const entries = entriesOf(result.archive);
    expect(result.manifest.files.map((entry) => entry.file)).toEqual([
      "files/npm-logs/2026-09-27T12_00_00_000Z-debug-0.log",
      "files/npm-logs/2026-09-27T11_00_00_000Z-debug-0.log",
    ]);
    const newest = entries.get("files/npm-logs/2026-09-27T12_00_00_000Z-debug-0.log") ?? "";
    expect(newest).toContain("npm error 2026-09-27T12_00_00_000Z-debug-0.log");
    expect(Buffer.byteLength(newest)).toBeLessThanOrEqual(4096);
    expect(result.manifest.files[0]?.truncated).toBe(true);
  });

  it("renames duplicate and unsafe names", async () => {
    const a = join(dir, "a");
    const b = join(dir, "b");
    await mkdir(a);
    await mkdir(b);
    await writeFile(join(a, "x-debug-0.log"), "one\n");
    await writeFile(join(b, "x-debug-0.log"), "two\n");
    await writeFile(join(b, "we ird-debug-0.log"), "three\n");
    const result = await build([{ kind: "npm-logs", dirs: [a, b] }]);
    const names = result.manifest.files.map((entry) => entry.file);
    expect(names).toContain("files/npm-logs/x-debug-0.log");
    expect(names.filter((name) => /npm-debug-\d\.log$/u.test(name))).toHaveLength(2);
  });

  it("reports no logs as unavailable", async () => {
    const result = await build([{ kind: "npm-logs", dirs: [join(dir, "none")] }]);
    expect(result.manifest.files[0]).toMatchObject({
      file: "files/npm-logs/",
      status: "unavailable",
    });
  });
});

describe("file, json and value sources", () => {
  it("collects a file tail, a picked JSON file and a value", async () => {
    await writeFile(join(dir, "install.log"), "step 1\nstep 2 failed\n");
    await writeFile(
      join(dir, "status.json"),
      JSON.stringify({ phase: "x", secretish: 1, extra: "dropped" }),
    );
    const result = await build([
      { kind: "file-tail", name: "installer.log", path: join(dir, "install.log"), purpose: "log" },
      {
        kind: "json-file",
        name: "status.json",
        path: join(dir, "status.json"),
        purpose: "status",
        pick: (parsed) => pickFields(parsed, ["phase"]),
      },
      { kind: "json-file", name: "raw.json", path: join(dir, "status.json"), purpose: "raw" },
      { kind: "value", name: "versions.json", purpose: "versions", value: { pro: "1.2.3" } },
    ]);
    const entries = entriesOf(result.archive);
    expect(entries.get("files/installer.log")).toBe("step 1\nstep 2 failed\n");
    expect(JSON.parse(entries.get("files/status.json") ?? "")).toEqual({ phase: "x" });
    expect(JSON.parse(entries.get("files/raw.json") ?? "")).toMatchObject({ extra: "dropped" });
    expect(JSON.parse(entries.get("files/versions.json") ?? "")).toEqual({ pro: "1.2.3" });
  });

  it("records missing, invalid and symlinked files as unavailable", async () => {
    await writeFile(join(dir, "bad.json"), "{");
    await symlink("/etc/hostname", join(dir, "link.log"));
    const result = await build([
      { kind: "file-tail", name: "missing.log", path: join(dir, "missing.log"), purpose: "p" },
      { kind: "file-tail", name: "link.log", path: join(dir, "link.log"), purpose: "p" },
      { kind: "json-file", name: "bad.json", path: join(dir, "bad.json"), purpose: "p" },
      { kind: "json-file", name: "gone.json", path: join(dir, "gone.json"), purpose: "p" },
    ]);
    expect(result.manifest.files.map((entry) => entry.reason)).toEqual([
      "not present",
      "refused: path is a symbolic link",
      "not valid JSON",
      "not present",
    ]);
  });

  it("refuses unsafe names and unit names before collecting anything", async () => {
    await expect(build([{ kind: "value", name: "../x", purpose: "p", value: 1 }])).rejects.toThrow(
      "unsafe diagnostics source name",
    );
    await expect(build([{ kind: "value", name: "..", purpose: "p", value: 1 }])).rejects.toThrow(
      "unsafe diagnostics source name",
    );
    await expect(build([{ kind: "journal", unit: "--all" }])).rejects.toThrow(
      "unsafe journal unit name",
    );
  });

  it("refuses two sources that produce the same file", async () => {
    await expect(
      build([
        { kind: "value", name: "a.json", purpose: "p", value: 1 },
        { kind: "value", name: "a.json", purpose: "p", value: 2 },
      ]),
    ).rejects.toThrow("duplicate diagnostics file name");
  });
});

describe("journal collection", () => {
  it("collects current and previous boot with fixed argv", async () => {
    const calls: string[][] = [];
    const run: DiagnosticsRunCommand = async (file, args) => {
      calls.push([file, ...args]);
      return { stdout: `line for boot ${args[3]}\n` };
    };
    const result = await build(
      [{ kind: "journal", unit: "sovereign-node-api", previousBoot: true }],
      { run },
    );
    expect(calls[0]).toEqual([
      "journalctl",
      "--unit",
      "sovereign-node-api",
      "--boot",
      "-1",
      "--merge",
      "--no-pager",
      "--quiet",
      "--output=short-iso",
      "--lines",
      "20000",
    ]);
    const text = entriesOf(result.archive).get("files/journal/sovereign-node-api.txt") ?? "";
    expect(text).toContain("=== boot previous ===\nline for boot -1");
    expect(text).toContain("=== boot current ===\nline for boot 0");
  });

  it("marks a partially available journal and an unavailable one", async () => {
    const run: DiagnosticsRunCommand = async (_file, args) => {
      if (args[3] === "-1") {
        throw new Error(
          "Specifying boot ID or boot offset has no effect, no persistent journal was found.",
        );
      }
      return { stdout: "current only\n" };
    };
    const partial = await build([{ kind: "journal", unit: "u1", previousBoot: true }], { run });
    expect(partial.manifest.files[0]?.status).toBe("collected");
    expect(partial.manifest.files[0]?.reason).toContain("partially available");
    const none = await build([{ kind: "journal", unit: "u2" }]);
    expect(none.manifest.files[0]).toMatchObject({
      status: "unavailable",
      reason: "boot 0: command not available",
    });
    const nonError = await build([{ kind: "journal", unit: "u3" }], {
      run: async () => {
        throw "plain string failure";
      },
    });
    expect(nonError.manifest.files[0]?.reason).toBe("boot 0: plain string failure");
    const execStyle = await build([{ kind: "journal", unit: "u4" }], {
      run: async () => {
        throw new Error("Command failed: journalctl --unit u4\nNo journal boot entry found.\n");
      },
    });
    expect(execStyle.manifest.files[0]?.reason).toBe("boot 0: No journal boot entry found.");
    const onlyArgv = await build([{ kind: "journal", unit: "u5" }], {
      run: async () => {
        throw new Error("Command failed: journalctl --unit u5");
      },
    });
    expect(onlyArgv.manifest.files[0]?.reason).toBe("boot 0: Command failed: journalctl --unit u5");
    const empty = await build([{ kind: "journal", unit: "u6" }], {
      run: async () => {
        throw new Error("");
      },
    });
    expect(empty.manifest.files[0]?.reason).toBe("boot 0: failed");
  });

  it("keeps the tail of a long journal", async () => {
    const run: DiagnosticsRunCommand = async () => ({
      stdout: `${"noise\n".repeat(50_000)}the crash line\n`,
    });
    const result = await build([{ kind: "journal", unit: "u", maxBytes: 2048 }], { run });
    const text = entriesOf(result.archive).get("files/journal/u.txt") ?? "";
    expect(text).toContain("the crash line");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(2048);
    expect(result.manifest.files[0]?.truncated).toBe(true);
  });
});

describe("system summary", () => {
  it("collects a Raspberry Pi summary", async () => {
    const files: Record<string, string> = {
      "/proc/device-tree/model": "Raspberry Pi 5 Model B Rev 1.0\0",
      "/proc/meminfo": "MemTotal:        8245632 kB\nMemFree: 1 kB\n",
      "/etc/os-release":
        'PRETTY_NAME="Debian GNU/Linux 13 (trixie)"\nID=debian\nVERSION_ID="13"\nHOME_URL="x"\n',
    };
    const run: DiagnosticsRunCommand = async (file) => {
      if (file === "df") {
        return {
          stdout:
            "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/root 100 40 60 40% /\n/dev/root 100 40 60 40% /var/lib\n",
        };
      }
      if (file === "timedatectl") {
        return { stdout: "NTPSynchronized=yes\nTimezone=Europe/Berlin\n" };
      }
      return { stdout: "throttled=0x50005\n" };
    };
    const summary = await collectSystemSummary(run, async (path) => {
      const value = files[path];
      if (value === undefined) {
        throw new Error("ENOENT");
      }
      return value;
    });
    expect(summary.model).toBe("Raspberry Pi 5 Model B Rev 1.0");
    expect(summary.memoryTotalBytes).toBe(8245632 * 1024);
    expect(summary.os).toEqual({
      PRETTY_NAME: "Debian GNU/Linux 13 (trixie)",
      ID: "debian",
      VERSION_ID: "13",
    });
    expect(summary.disks).toEqual([
      { mountedOn: "/", totalKb: 100, availableKb: 60, usePercent: "40%" },
      { mountedOn: "/var/lib", totalKb: 100, availableKb: 60, usePercent: "40%" },
    ]);
    expect(summary.clock).toEqual({ NTPSynchronized: "yes", Timezone: "Europe/Berlin" });
    expect(summary.piThrottling).toMatchObject({
      underVoltageNow: true,
      underVoltageOccurred: true,
      throttledNow: true,
    });
  });

  it("degrades to nulls on a host without any of it", async () => {
    const summary = await collectSystemSummary(noCommands, async () => {
      throw new Error("ENOENT");
    });
    expect(summary.model).toBeNull();
    expect(summary.memoryTotalBytes).toBeGreaterThan(0);
    expect(summary.os).toEqual({});
    expect(summary.disks).toBeNull();
    expect(summary.clock).toBeNull();
    expect(summary.piThrottling).toBeNull();
  });

  it("falls back to DMI product name and tolerates a meminfo without MemTotal", async () => {
    const summary = await collectSystemSummary(
      async (file) => ({ stdout: file === "df" ? "header\n/dev/sda 1 2 3 4% \n" : "garbage" }),
      async (path) => {
        if (path === "/sys/class/dmi/id/product_name") return "Standard PC\n";
        if (path === "/proc/meminfo") return "nothing here";
        if (path === "/etc/os-release") return "ID\n";
        throw new Error("ENOENT");
      },
    );
    expect(summary.model).toBe("Standard PC");
    expect(summary.memoryTotalBytes).toBeGreaterThan(0);
    expect(summary.piThrottling).toBeNull();
    expect(summary.clock).toEqual({});
    expect(summary.disks).toEqual([]);
  });

  it("is included as files/system.json", async () => {
    const result = await build([{ kind: "system" }], { readKernelFile: async () => "" });
    expect(result.manifest.files[0]).toMatchObject({
      file: "files/system.json",
      status: "collected",
    });
  });

  it("decodes throttling flags and rejects junk", () => {
    expect(decodeThrottled("throttled=0x0")).toMatchObject({ raw: "0x0", underVoltageNow: false });
    expect(decodeThrottled("nope")).toBeNull();
  });
});

describe("credential guard", () => {
  it("withholds a file in which a credential shape survives redaction", async () => {
    await writeFile(join(dir, "a.log"), "near miss xsk-or-v1-abcdefghij0123 here\n");
    const result = await build([
      { kind: "file-tail", name: "a.log", path: join(dir, "a.log"), purpose: "p" },
    ]);
    expect(result.manifest.files[0]).toMatchObject({ status: "withheld", bytes: 0 });
    expect(result.manifest.files[0]?.reason).toContain("openrouter-key");
    expect(entriesOf(result.archive).has("files/a.log")).toBe(false);
    expect(result.complete).toBe(false);
  });
});

describe("size cap: priority shedding", () => {
  const artifact = (
    file: string,
    priority: number,
    bytes: number,
    kind: "text" | "json" = "text",
  ) => ({
    file,
    purpose: "p",
    priority,
    kind,
    status: "collected" as const,
    content: kind === "text" ? "line\n".repeat(bytes / 5) : `"${"j".repeat(bytes - 3)}"\n`,
    truncatedBytes: 0,
    reason: undefined as string | undefined,
  });

  it("shortens the least important text first, keeping its tail", () => {
    const items = [artifact("a", 10, 50_000), artifact("b", 50, 50_000)];
    shedToFit(items as never, 80_000);
    expect(items[0]?.content?.length).toBe(50_000);
    expect(items[1]?.status).toBe("collected");
    expect(Buffer.byteLength(items[1]?.content ?? "")).toBeLessThanOrEqual(30_000);
    expect(items[1]?.reason).toBe("shortened to fit the bundle size cap");
  });

  it("drops JSON and text that would fall below the floor, in priority order", () => {
    const items = [
      artifact("keep", 10, 40_000),
      artifact("json", 60, 40_000, "json"),
      artifact("small", 70, 20_000),
    ];
    shedToFit(items as never, 45_000);
    expect(items.map((item) => item.status)).toEqual(["collected", "shed", "shed"]);
    expect(items[1]?.content).toBeUndefined();
  });

  it("does nothing under the cap and ignores non-collected artifacts", () => {
    const items = [
      artifact("a", 10, 1000),
      { ...artifact("b", 90, 1000), status: "withheld" as const, content: undefined },
    ];
    shedToFit(items as never, DEFAULT_MAX_TOTAL_BYTES);
    expect(items[0]?.status).toBe("collected");
    expect(items[1]?.status).toBe("withheld");
  });

  it("keeps a bundle within the cap end to end, never aborting", async () => {
    for (const name of ["a", "b", "c"]) {
      await writeFile(join(dir, `${name}.log`), `${"z".repeat(99)}\n`.repeat(4000));
    }
    const result = await build(
      [
        { kind: "file-tail", name: "a.log", path: join(dir, "a.log"), purpose: "p", priority: 10 },
        { kind: "file-tail", name: "b.log", path: join(dir, "b.log"), purpose: "p", priority: 40 },
        { kind: "file-tail", name: "c.log", path: join(dir, "c.log"), purpose: "p", priority: 90 },
      ],
      { maxTotalBytes: 500_000 },
    );
    expect(result.manifest.totalBytes).toBeLessThanOrEqual(500_000);
    const [a, b, c] = result.manifest.files;
    expect(a).toMatchObject({ status: "collected", truncated: false });
    expect(c?.status === "shed" || c?.truncated === true).toBe(true);
    expect(b?.status).toBe("collected");
    expect(result.manifest.notes[0]).toContain("INCOMPLETE");
  });
});

describe("optional sources", () => {
  it("lists an absent optional file without marking the bundle incomplete", async () => {
    await writeFile(join(dir, "bad.json"), "{");
    const absent = await build([
      {
        kind: "json-file",
        name: "a.json",
        path: join(dir, "a.json"),
        purpose: "p",
        optional: true,
      },
      { kind: "file-tail", name: "b.log", path: join(dir, "b.log"), purpose: "p", optional: true },
    ]);
    expect(absent.complete).toBe(true);
    expect(absent.manifest.files.map((entry) => entry.optional)).toEqual([true, true]);
    const readme = entriesOf(absent.archive).get("README.txt") ?? "";
    expect(readme).toContain("Not present on this device (normal):\n  files/a.json\n  files/b.log");
    expect(readme).not.toContain("Not included:");
    // Only plain absence is excused: a broken optional file is still a gap.
    const broken = await build([
      {
        kind: "json-file",
        name: "bad.json",
        path: join(dir, "bad.json"),
        purpose: "p",
        optional: true,
      },
    ]);
    expect(broken.complete).toBe(false);
    expect(broken.manifest.files[0]).not.toHaveProperty("optional");
  });
});

describe("manifest and README", () => {
  it("describes included, missing and excluded content", async () => {
    await writeFile(join(dir, "a.log"), "hello\n");
    const result = await build(
      [
        { kind: "file-tail", name: "a.log", path: join(dir, "a.log"), purpose: "The log" },
        { kind: "file-tail", name: "b.log", path: join(dir, "b.log"), purpose: "Missing log" },
      ],
      { product: { pro: "1.0.0", token: "should-go" } },
    );
    const entries = entriesOf(result.archive);
    const manifest = manifestOf(result.archive);
    expect(manifest).toMatchObject({
      formatVersion: 1,
      kind: "install-diagnostics",
      generatedAt: "2026-09-27T12:00:00.000Z",
      complete: false,
      product: { pro: "1.0.0", token: REDACTED },
    });
    expect(manifest.files[0]?.sha256).toMatch(/^[0-9a-f]{64}$/u);
    const readme = entries.get("README.txt") ?? "";
    expect(readme).toContain("files/a.log");
    expect(readme).toContain("The log");
    expect(readme).toContain("Not included:");
    expect(readme).toContain("files/b.log — unavailable: not present");
    expect(readme).toContain("Never included:");
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.bytes).toBe(result.archive.byteLength);
  });

  it("renders a complete README without a missing section", () => {
    const readme = renderReadme({
      formatVersion: 1,
      kind: "install-diagnostics",
      generatedAt: "t",
      generatedBy: "g",
      complete: true,
      product: null,
      limits: { maxTotalBytes: 1 },
      totalBytes: 0,
      redactionPolicy: ["r"],
      excluded: ["e"],
      files: [
        {
          file: "files/x",
          purpose: "px",
          priority: 1,
          status: "collected",
          bytes: 1,
          sha256: "s",
          truncated: true,
          truncatedBytes: 1,
        },
        {
          file: "files/y",
          purpose: "py",
          priority: 1,
          status: "shed",
          bytes: 0,
          sha256: "",
          truncated: false,
          truncatedBytes: 0,
        },
      ],
      notes: [],
    });
    expect(readme).toContain("All sources were collected.");
    expect(readme).toContain("files/x (tail only)");
    expect(readme).toContain("files/y — shed: ");
  });
});

describe("defaults", () => {
  it("names node sources and secret stores from the path table", () => {
    const sources = defaultNodeDiagnosticsSources();
    expect(sources.map((source) => source.kind)).toEqual([
      "install-jobs",
      "npm-logs",
      "journal",
      "journal",
      "json-file",
      "system",
    ]);
    expect(sources[1]).toMatchObject({
      dirs: [npmLogsDir(DEFAULT_PATHS.stateDir), "/root/.npm/_logs"],
    });
    const provenance = sources[4] as Extract<DiagnosticsSource, { kind: "json-file" }>;
    expect(provenance.pick?.({ installedAt: "t", repoUrl: "https://x:y@z", source: "s" })).toEqual({
      installedAt: "t",
      source: "s",
    });
    expect(defaultNodeKnownSecretSources()).toEqual({
      secretDirs: [DEFAULT_PATHS.secretsDir],
      structuredFiles: [DEFAULT_PATHS.configPath],
      recordDirs: [DEFAULT_PATHS.installJobsDir],
    });
  });

  it("formats the file name and runs commands without a shell", async () => {
    expect(diagnosticsFileName(new Date("2026-09-27T23:59:00Z"), "abc123")).toBe(
      "sovereign-ai-node-diagnostics-2026-09-27-abc123.zip",
    );
    expect((await defaultDiagnosticsRun("echo", ["a;b"])).stdout).toBe("a;b\n");
  });

  it("uses real kernel files and the real runner by default", async () => {
    const result = await buildInstallDiagnostics({
      sources: [{ kind: "system" }],
      generatedBy: "t",
    });
    expect(result.manifest.files[0]?.status).toBe("collected");
  });
});

describe("owner constraint on less-privileged locations", () => {
  const uid = process.getuid?.() ?? 0;

  it("reads files owned by the named account and refuses the rest, per source", async () => {
    const jobs = join(dir, "jobs");
    const logs = join(dir, "logs");
    await mkdir(jobs);
    await mkdir(logs);
    await writeFile(join(jobs, "j.json"), JSON.stringify(jobRecord()));
    await writeFile(join(logs, "a-debug-0.log"), "npm error\n");
    await writeFile(join(dir, "f.log"), "log\n");
    await writeFile(join(dir, "f.json"), "{}");
    const sources = (owner: number): DiagnosticsSource[] => [
      { kind: "install-jobs", dir: jobs, owner },
      { kind: "npm-logs", dirs: [logs], owner },
      { kind: "file-tail", name: "f.log", path: join(dir, "f.log"), purpose: "p", owner },
      { kind: "json-file", name: "f.json", path: join(dir, "f.json"), purpose: "p", owner },
    ];
    const ok = await build(sources(uid));
    expect(ok.manifest.files.map((entry) => entry.status)).toEqual([
      "collected",
      "collected",
      "collected",
      "collected",
    ]);
    const refused = await build(sources(uid + 1));
    expect(refused.manifest.files.map((entry) => entry.reason)).toEqual([
      "refused: not owned by the expected account",
      "refused: not owned by the expected account",
      "refused: not owned by the expected account",
      "refused: not owned by the expected account",
    ]);
  });
});
