import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BUNDLE_FORMAT_VERSION,
  BUNDLE_RETENTION_DAYS,
  bundleFileName,
  cleanupOldBundles,
  ensureBundleDirectory,
  formatBundleDate,
  generateBundleId,
  generateSupportBundle,
  MAX_BUNDLE_BYTES,
  validateOutputPath,
} from "./bundle.js";
import type { RunCommand } from "./collectors.js";
import type { VersionInventory } from "./version-inventory.js";

const FIXED_NOW = new Date("2026-07-26T10:15:30.000Z");

const inventory: VersionInventory = {
  schemaVersion: 1,
  generatedAt: FIXED_NOW.toISOString(),
  components: [
    { component: "sovereign-node", version: "2.3.5", commit: "a1b2c3d", source: "build-define" },
  ],
  environment: {
    os: "Linux 6.1.0",
    kernel: "linux",
    arch: "arm64",
    hostnameHash: "h:0123456789abcdef",
    nodeRuntime: "v22.0.0",
  },
  installedAt: "2026-05-01T00:00:00.000Z",
  installSource: "curl-installer",
  contractVersion: "2.0.0",
  incomplete: false,
};

/** A runner that satisfies every collector so the happy path is complete. */
const healthyRun: RunCommand = async (file) => {
  if (file === "systemctl") {
    return { stdout: "LoadState=loaded\nActiveState=active\nNRestarts=0", stderr: "" };
  }
  if (file === "journalctl") {
    return { stdout: "2026-07-26T10:00:00 node started\n", stderr: "" };
  }
  if (file === "df") {
    return {
      stdout:
        "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100 20 80 20% /",
      stderr: "",
    };
  }
  if (file === "timedatectl") {
    return { stdout: "NTPSynchronized=yes\nTimezone=UTC", stderr: "" };
  }
  return { stdout: "", stderr: "" };
};

/** Captures the staging directory so cleanup can be asserted after the fact. */
const makeArchiveSpy = () => {
  const seen: { stagingDir?: string; outputPath?: string } = {};
  const createArchive = async (stagingDir: string, outputPath: string): Promise<void> => {
    seen.stagingDir = stagingDir;
    seen.outputPath = outputPath;
    // Stand in for tar: concatenate the staged files so the output is real bytes
    // whose checksum can be recomputed, without depending on a tar binary.
    const entries = await readdir(stagingDir);
    const parts: Buffer[] = [];
    for (const entry of entries.sort()) {
      parts.push(Buffer.from(`--${entry}--\n`), await readFile(join(stagingDir, entry)));
    }
    await writeFile(outputPath, Buffer.concat(parts), { mode: 0o600 });
  };
  return { seen, createArchive };
};

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "bundle-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("generateSupportBundle — successful generation", () => {
  it("produces a bundle with a path, checksum and manifest", async () => {
    const { createArchive } = makeArchiveSpy();
    const result = await generateSupportBundle(workDir, {
      inventory,
      doctorReport: { overall: "pass", checks: [] },
      status: { openclaw: { version: "0.9.1" } },
      mailState: { messages: [], alerts: [] },
      updateStatus: { result: "success", phase: "done" },
      run: healthyRun,
      now: () => FIXED_NOW,
      createArchive,
    });

    expect(result.path.startsWith(workDir)).toBe(true);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.complete).toBe(true);
    expect(result.manifest.bundleFormatVersion).toBe(BUNDLE_FORMAT_VERSION);
    expect(result.manifest.generatedAt).toBe(FIXED_NOW.toISOString());
  });

  it("names the file with the bundle prefix, date and id", async () => {
    const { createArchive } = makeArchiveSpy();
    const result = await generateSupportBundle(workDir, {
      inventory,
      run: healthyRun,
      now: () => FIXED_NOW,
      createArchive,
    });
    expect(result.path).toMatch(/sovereign-ai-node-support-2026-07-26-[a-z0-9]{6}\.tar\.gz$/u);
  });

  it("includes every collector in the manifest", async () => {
    const { createArchive } = makeArchiveSpy();
    const result = await generateSupportBundle(workDir, {
      inventory,
      doctorReport: { overall: "pass" },
      status: { ok: true },
      mailState: {},
      run: healthyRun,
      now: () => FIXED_NOW,
      createArchive,
    });

    const files = result.manifest.files.map((entry) => entry.file);
    for (const expected of [
      "version-inventory.json",
      "doctor.json",
      "status.json",
      "mail-sentinel-summary.json",
      "service-states.json",
      "system-resources.json",
      "clock.json",
      "journal-sovereign-node-api.txt",
    ]) {
      expect(files).toContain(expected);
    }
  });

  it("omits update-status.json when no update status was supplied", async () => {
    const { createArchive } = makeArchiveSpy();
    const result = await generateSupportBundle(workDir, {
      inventory,
      run: healthyRun,
      now: () => FIXED_NOW,
      createArchive,
    });
    expect(result.manifest.files.map((entry) => entry.file)).not.toContain("update-status.json");
  });

  it("gives every manifest entry a purpose and privacy class", async () => {
    const { createArchive } = makeArchiveSpy();
    const result = await generateSupportBundle(workDir, {
      inventory,
      run: healthyRun,
      now: () => FIXED_NOW,
      createArchive,
    });
    for (const entry of result.manifest.files) {
      expect(entry.purpose.length).toBeGreaterThan(0);
      expect(["safe", "technical"]).toContain(entry.privacy);
    }
  });

  it("states the redaction policy in the manifest", async () => {
    const { createArchive } = makeArchiveSpy();
    const result = await generateSupportBundle(workDir, {
      inventory,
      run: healthyRun,
      now: () => FIXED_NOW,
      createArchive,
    });
    expect(result.manifest.redactionPolicy).toContain("No secrets");
    expect(result.manifest.redactionPolicy).toContain("No email subjects");
  });

  it("carries the inventory into the manifest", async () => {
    const { createArchive } = makeArchiveSpy();
    const result = await generateSupportBundle(workDir, {
      inventory,
      run: healthyRun,
      now: () => FIXED_NOW,
      createArchive,
    });
    expect(result.manifest.inventory).toEqual(inventory);
  });
});

describe("generateSupportBundle — integrity", () => {
  it("byte counts and per-file sha256 match the staged content exactly", async () => {
    // Verified against the real staged files, not against the manifest's own
    // numbers — a manifest that agrees only with itself proves nothing.
    const staged: Record<string, Buffer> = {};
    const createArchive = async (stagingDir: string, outputPath: string): Promise<void> => {
      for (const entry of await readdir(stagingDir)) {
        staged[entry] = await readFile(join(stagingDir, entry));
      }
      await writeFile(outputPath, Buffer.from("archive"), { mode: 0o600 });
    };

    const result = await generateSupportBundle(workDir, {
      inventory,
      doctorReport: { overall: "pass" },
      status: { ok: true },
      mailState: {},
      run: healthyRun,
      now: () => FIXED_NOW,
      createArchive,
    });

    for (const entry of result.manifest.files) {
      if (entry.status !== "collected") {
        expect(entry.bytes).toBe(0);
        expect(entry.sha256).toBe("");
        continue;
      }
      const content = staged[entry.file];
      expect(content, `missing staged file ${entry.file}`).toBeDefined();
      expect(entry.bytes).toBe((content as Buffer).byteLength);
      expect(entry.sha256).toBe(
        createHash("sha256")
          .update(content as Buffer)
          .digest("hex"),
      );
    }
  });

  it("archive sha256 and byte count match a recomputation from disk", async () => {
    const { createArchive } = makeArchiveSpy();
    const result = await generateSupportBundle(workDir, {
      inventory,
      run: healthyRun,
      now: () => FIXED_NOW,
      createArchive,
    });

    const bytes = await readFile(result.path);
    expect(result.bytes).toBe(bytes.byteLength);
    expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("writes a manifest.json into the staging directory", async () => {
    let manifestText = "";
    const createArchive = async (stagingDir: string, outputPath: string): Promise<void> => {
      manifestText = await readFile(join(stagingDir, "manifest.json"), "utf8");
      await writeFile(outputPath, Buffer.from("x"), { mode: 0o600 });
    };
    await generateSupportBundle(workDir, {
      inventory,
      run: healthyRun,
      now: () => FIXED_NOW,
      createArchive,
    });
    const parsed = JSON.parse(manifestText);
    expect(parsed.bundleFormatVersion).toBe(BUNDLE_FORMAT_VERSION);
    expect(Array.isArray(parsed.files)).toBe(true);
  });
});

describe("generateSupportBundle — permissions", () => {
  it("creates the archive with mode 0600", async () => {
    const { createArchive } = makeArchiveSpy();
    const result = await generateSupportBundle(workDir, {
      inventory,
      run: healthyRun,
      now: () => FIXED_NOW,
      createArchive,
    });
    const info = await stat(result.path);
    // A bundle is readable diagnostic material; group and other get nothing.
    expect(info.mode & 0o777).toBe(0o600);
  });

  it("creates the staging directory with mode 0700", async () => {
    let stagingMode = 0;
    const createArchive = async (stagingDir: string, outputPath: string): Promise<void> => {
      stagingMode = (await stat(stagingDir)).mode & 0o777;
      await writeFile(outputPath, Buffer.from("x"), { mode: 0o600 });
    };
    await generateSupportBundle(workDir, {
      inventory,
      run: healthyRun,
      now: () => FIXED_NOW,
      createArchive,
    });
    expect(stagingMode).toBe(0o700);
  });

  it("stages every artifact with mode 0600", async () => {
    const modes: number[] = [];
    const createArchive = async (stagingDir: string, outputPath: string): Promise<void> => {
      for (const entry of await readdir(stagingDir)) {
        modes.push((await stat(join(stagingDir, entry))).mode & 0o777);
      }
      await writeFile(outputPath, Buffer.from("x"), { mode: 0o600 });
    };
    await generateSupportBundle(workDir, {
      inventory,
      run: healthyRun,
      now: () => FIXED_NOW,
      createArchive,
    });
    expect(modes.length).toBeGreaterThan(0);
    for (const mode of modes) {
      expect(mode).toBe(0o600);
    }
  });
});

describe("generateSupportBundle — partial results", () => {
  it("marks the bundle incomplete and adds a note when a collector fails", async () => {
    // journalctl fails; everything else succeeds.
    const partialRun: RunCommand = async (file, args, timeout) => {
      if (file === "journalctl") {
        throw new Error("permission denied");
      }
      return healthyRun(file, args, timeout);
    };

    const { createArchive } = makeArchiveSpy();
    const result = await generateSupportBundle(workDir, {
      inventory,
      doctorReport: { overall: "pass" },
      status: { ok: true },
      mailState: {},
      run: partialRun,
      now: () => FIXED_NOW,
      createArchive,
    });

    expect(result.complete).toBe(false);
    expect(result.manifest.complete).toBe(false);
    expect(result.manifest.notes.length).toBeGreaterThan(0);
    expect(result.manifest.notes[0]).toContain("INCOMPLETE");
    // The note must warn against reading an absent section as a healthy one.
    expect(result.manifest.notes[0]).toContain("Do not read an absent section");
  });

  it("records the failing entries with status and reason, and zero bytes", async () => {
    const partialRun: RunCommand = async (file, args, timeout) => {
      if (file === "journalctl") {
        throw new Error("permission denied");
      }
      return healthyRun(file, args, timeout);
    };
    const { createArchive } = makeArchiveSpy();
    const result = await generateSupportBundle(workDir, {
      inventory,
      run: partialRun,
      now: () => FIXED_NOW,
      createArchive,
    });

    const failed = result.manifest.files.filter((entry) => entry.status !== "collected");
    expect(failed.length).toBeGreaterThan(0);
    for (const entry of failed) {
      expect(entry.bytes).toBe(0);
      expect(entry.sha256).toBe("");
      expect(entry.reason ?? entry.status).toBeTruthy();
    }
  });

  it("marks incomplete when the doctor report is unavailable", async () => {
    const { createArchive } = makeArchiveSpy();
    const result = await generateSupportBundle(workDir, {
      inventory,
      status: { ok: true },
      mailState: {},
      run: healthyRun,
      now: () => FIXED_NOW,
      createArchive,
    });
    expect(result.complete).toBe(false);
    const doctor = result.manifest.files.find((entry) => entry.file === "doctor.json");
    expect(doctor?.status).toBe("unavailable");
    expect(doctor?.reason).toBe("doctor report could not be produced");
  });

  it("marks incomplete when status is unavailable", async () => {
    const { createArchive } = makeArchiveSpy();
    const result = await generateSupportBundle(workDir, {
      inventory,
      doctorReport: { overall: "pass" },
      mailState: {},
      run: healthyRun,
      now: () => FIXED_NOW,
      createArchive,
    });
    const status = result.manifest.files.find((entry) => entry.file === "status.json");
    expect(status?.status).toBe("unavailable");
    expect(result.complete).toBe(false);
  });

  it("marks incomplete when the mail state is unreadable", async () => {
    const { createArchive } = makeArchiveSpy();
    const result = await generateSupportBundle(workDir, {
      inventory,
      doctorReport: { overall: "pass" },
      status: { ok: true },
      mailState: undefined,
      run: healthyRun,
      now: () => FIXED_NOW,
      createArchive,
    });
    const mail = result.manifest.files.find((entry) => entry.file === "mail-sentinel-summary.json");
    expect(mail?.status).toBe("unavailable");
    expect(result.complete).toBe(false);
  });

  it("still produces a usable bundle when every command fails", async () => {
    // A bundle documenting total breakage is exactly when a bundle is needed.
    const { createArchive } = makeArchiveSpy();
    const result = await generateSupportBundle(workDir, {
      inventory,
      run: async () => {
        throw new Error("nothing works");
      },
      now: () => FIXED_NOW,
      createArchive,
    });
    expect(result.complete).toBe(false);
    expect(result.path.length).toBeGreaterThan(0);
    await expect(stat(result.path)).resolves.toBeDefined();
  });

  it("leaves notes empty on a complete bundle", async () => {
    const { createArchive } = makeArchiveSpy();
    const result = await generateSupportBundle(workDir, {
      inventory,
      doctorReport: { overall: "pass" },
      status: { ok: true },
      mailState: {},
      run: healthyRun,
      now: () => FIXED_NOW,
      createArchive,
    });
    expect(result.complete).toBe(true);
    expect(result.manifest.notes).toEqual([]);
  });
});

describe("generateSupportBundle — staging cleanup", () => {
  it("removes the staging directory on the success path", async () => {
    const { seen, createArchive } = makeArchiveSpy();
    await generateSupportBundle(workDir, {
      inventory,
      run: healthyRun,
      now: () => FIXED_NOW,
      createArchive,
    });
    expect(seen.stagingDir).toBeDefined();
    await expect(stat(seen.stagingDir as string)).rejects.toThrow();
  });

  it("removes the staging directory when createArchive throws", async () => {
    // Staging holds redacted-but-still-diagnostic content and must not outlive
    // the run, including on the failure path.
    let stagingDir = "";
    const createArchive = async (staging: string): Promise<void> => {
      stagingDir = staging;
      throw new Error("tar exploded");
    };

    await expect(
      generateSupportBundle(workDir, {
        inventory,
        run: healthyRun,
        now: () => FIXED_NOW,
        createArchive,
      }),
    ).rejects.toThrow("tar exploded");

    expect(stagingDir).not.toBe("");
    await expect(stat(stagingDir)).rejects.toThrow();
  });

  /**
   * A payload large enough to trip the total cap.
   *
   * A single huge string cannot do it: `redactValue` truncates every string at
   * MAX_VALUE_LENGTH (8 000), so the oversize has to come from many distinct
   * keys rather than one long value.
   */
  const oversizePayload = (): Record<string, string> => {
    const chunk = "x".repeat(4_000);
    const payload: Record<string, string> = {};
    for (let index = 0; index < Math.ceil(MAX_BUNDLE_BYTES / 4_000) + 50; index += 1) {
      payload[`field${index}`] = chunk;
    }
    return payload;
  };

  it("removes the staging directory when the size cap is exceeded", async () => {
    const staged: string[] = [];
    const createArchive = async (staging: string): Promise<void> => {
      staged.push(staging);
    };
    const before = (await readdir(tmpdir())).filter((entry) =>
      entry.startsWith("sovereign-support-"),
    );

    await expect(
      generateSupportBundle(workDir, {
        inventory,
        doctorReport: oversizePayload(),
        run: healthyRun,
        now: () => FIXED_NOW,
        createArchive,
      }),
    ).rejects.toThrow(/exceeded/u);

    // The cap trips before archiving, so createArchive never runs and the
    // staging directory must still have been cleaned up by the finally block.
    expect(staged).toHaveLength(0);
    const after = (await readdir(tmpdir())).filter((entry) =>
      entry.startsWith("sovereign-support-"),
    );
    expect(after).toEqual(before);
  });

  it("aborts rather than truncating when the size cap is exceeded", async () => {
    await expect(
      generateSupportBundle(workDir, {
        inventory,
        doctorReport: oversizePayload(),
        run: healthyRun,
        now: () => FIXED_NOW,
        createArchive: async () => undefined,
      }),
    ).rejects.toThrow(/aborting rather than truncating/u);
  });

  it("writes no archive when the size cap is exceeded", async () => {
    await expect(
      generateSupportBundle(workDir, {
        inventory,
        doctorReport: oversizePayload(),
        run: healthyRun,
        now: () => FIXED_NOW,
        createArchive: async () => undefined,
      }),
    ).rejects.toThrow();
    expect(await readdir(workDir)).toEqual([]);
  });

  it("does not leave a partial archive behind when generation throws", async () => {
    await expect(
      generateSupportBundle(workDir, {
        inventory,
        run: healthyRun,
        now: () => FIXED_NOW,
        createArchive: async () => {
          throw new Error("tar exploded");
        },
      }),
    ).rejects.toThrow();
    expect(await readdir(workDir)).toEqual([]);
  });
});

describe("validateOutputPath", () => {
  it("accepts a safe generated filename and returns an absolute path", async () => {
    const candidate = join(workDir, "sovereign-ai-node-support-2026-07-26-abc123.tar.gz");
    await expect(validateOutputPath(candidate)).resolves.toBe(candidate);
  });

  it("rejects a path-traversal basename", async () => {
    // `../evil` resolves to a basename of `evil`, which is name-safe; the real
    // protection is that the resolved parent is wherever `..` led. Both the
    // traversal form and a name containing a separator are asserted.
    await expect(validateOutputPath(join(workDir, "../evil/../../etc/shadow"))).rejects.toThrow();
  });

  it("rejects a basename containing a slash after resolution", async () => {
    // A name with an embedded separator can never survive resolve(); assert the
    // guard rejects the unsafe characters it is there to catch.
    for (const unsafe of ["evil name", "evil;name", "evil$(id)", "evil|name", "evil\tname"]) {
      await expect(validateOutputPath(join(workDir, unsafe))).rejects.toThrow(
        /refusing unsafe bundle filename/u,
      );
    }
  });

  it("rejects a name with characters outside the safe set", async () => {
    await expect(validateOutputPath(join(workDir, "bündle.tar.gz"))).rejects.toThrow(
      /refusing unsafe bundle filename/u,
    );
  });

  it("refuses to overwrite an existing file", async () => {
    // The caller may be running as root; a symlink planted at the destination
    // would otherwise redirect a root-owned write.
    const existing = join(workDir, "already-here.tar.gz");
    await writeFile(existing, "content");
    await expect(validateOutputPath(existing)).rejects.toThrow(
      /refusing to overwrite existing path/u,
    );
  });

  it("refuses to overwrite an existing directory", async () => {
    const dir = join(workDir, "a-directory");
    await mkdir(dir);
    await expect(validateOutputPath(dir)).rejects.toThrow(/refusing to overwrite/u);
  });

  it("accepts a path when stat reports the target as absent", async () => {
    const statFn = async (): Promise<never> => {
      throw new Error("ENOENT");
    };
    await expect(validateOutputPath(join(workDir, "fresh.tar.gz"), statFn)).resolves.toContain(
      "fresh.tar.gz",
    );
  });

  it("refuses when the injected stat resolves, indicating the path exists", async () => {
    const statFn = async (): Promise<unknown> => ({ isFile: () => true });
    await expect(validateOutputPath(join(workDir, "x.tar.gz"), statFn)).rejects.toThrow(
      /refusing to overwrite/u,
    );
  });

  it("refuses to overwrite an existing bundle rather than clobbering evidence", async () => {
    const { createArchive } = makeArchiveSpy();
    const random = vi.fn(() => 0.5);
    const name = bundleFileName(FIXED_NOW, generateBundleId(random));
    await writeFile(join(workDir, name), "prior bundle");

    // Force the same id so the collision is deterministic.
    const spy = vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      await expect(
        generateSupportBundle(workDir, {
          inventory,
          run: healthyRun,
          now: () => FIXED_NOW,
          createArchive,
        }),
      ).rejects.toThrow(/refusing to overwrite/u);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("generateBundleId", () => {
  it("produces six lowercase alphanumeric characters", () => {
    expect(generateBundleId()).toMatch(/^[a-z0-9]{6}$/u);
  });

  it("is deterministic with an injected random source", () => {
    expect(generateBundleId(() => 0)).toBe("aaaaaa");
    expect(generateBundleId(() => 0.5)).toBe(generateBundleId(() => 0.5));
  });

  it("maps the top of the range without falling off the alphabet", () => {
    // Math.random() never returns 1, but a hostile injected source might; the
    // `?? "0"` fallback must keep the output well-formed.
    expect(generateBundleId(() => 0.999999)).toMatch(/^[a-z0-9]{6}$/u);
    expect(generateBundleId(() => 1)).toMatch(/^[a-z0-9]{6}$/u);
  });

  it("varies across calls with a real random source", () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateBundleId()));
    // Non-guessable so a filename does not reveal how many incidents a partner
    // has had; collisions across 50 draws would indicate a broken generator.
    expect(ids.size).toBeGreaterThan(40);
  });
});

describe("formatBundleDate", () => {
  it("formats as YYYY-MM-DD in UTC", () => {
    expect(formatBundleDate(new Date("2026-07-26T10:15:30.000Z"))).toBe("2026-07-26");
  });

  it("zero-pads single-digit months and days", () => {
    expect(formatBundleDate(new Date("2026-01-05T00:00:00.000Z"))).toBe("2026-01-05");
  });

  it("uses UTC rather than local time at a day boundary", () => {
    // 23:30 UTC is the next day in some zones; the bundle date must not depend
    // on where the node happens to be.
    expect(formatBundleDate(new Date("2026-07-26T23:30:00.000Z"))).toBe("2026-07-26");
    expect(formatBundleDate(new Date("2026-07-26T00:30:00.000Z"))).toBe("2026-07-26");
  });
});

describe("bundleFileName", () => {
  it("combines prefix, date and id deterministically", () => {
    expect(bundleFileName(FIXED_NOW, "abc123")).toBe(
      "sovereign-ai-node-support-2026-07-26-abc123.tar.gz",
    );
  });

  it("produces a name that passes the safe-name guard", async () => {
    const name = bundleFileName(FIXED_NOW, generateBundleId());
    await expect(validateOutputPath(join(workDir, name))).resolves.toContain(name);
  });
});

describe("cleanupOldBundles", () => {
  const ageFile = async (path: string, days: number): Promise<void> => {
    const when = new Date(FIXED_NOW.getTime() - days * 86_400_000);
    await utimes(path, when, when);
  };

  it("removes only bundles older than the retention window", async () => {
    const old = join(workDir, "sovereign-ai-node-support-2026-01-01-aaaaaa.tar.gz");
    const fresh = join(workDir, "sovereign-ai-node-support-2026-07-25-bbbbbb.tar.gz");
    await writeFile(old, "old");
    await writeFile(fresh, "fresh");
    await ageFile(old, BUNDLE_RETENTION_DAYS + 5);
    await ageFile(fresh, 1);

    const removed = await cleanupOldBundles(workDir, FIXED_NOW);

    expect(removed).toEqual(["sovereign-ai-node-support-2026-01-01-aaaaaa.tar.gz"]);
    await expect(stat(old)).rejects.toThrow();
    await expect(stat(fresh)).resolves.toBeDefined();
  });

  it("leaves files that do not carry the bundle prefix alone", async () => {
    // Cleanup runs in a directory an operator may also use; it must never touch
    // anything it did not create.
    const foreign = join(workDir, "important-backup.tar.gz");
    const alsoForeign = join(workDir, "notes.txt");
    await writeFile(foreign, "keep me");
    await writeFile(alsoForeign, "keep me too");
    await ageFile(foreign, 400);
    await ageFile(alsoForeign, 400);

    const removed = await cleanupOldBundles(workDir, FIXED_NOW);

    expect(removed).toEqual([]);
    await expect(stat(foreign)).resolves.toBeDefined();
    await expect(stat(alsoForeign)).resolves.toBeDefined();
  });

  it("leaves prefixed files with the wrong extension alone", async () => {
    const wrongExt = join(workDir, "sovereign-ai-node-support-2026-01-01-aaaaaa.txt");
    await writeFile(wrongExt, "not an archive");
    await ageFile(wrongExt, 400);
    expect(await cleanupOldBundles(workDir, FIXED_NOW)).toEqual([]);
    await expect(stat(wrongExt)).resolves.toBeDefined();
  });

  it("keeps a bundle exactly at the retention boundary", async () => {
    const boundary = join(workDir, "sovereign-ai-node-support-2026-07-12-cccccc.tar.gz");
    await writeFile(boundary, "boundary");
    await ageFile(boundary, BUNDLE_RETENTION_DAYS);
    expect(await cleanupOldBundles(workDir, FIXED_NOW)).toEqual([]);
  });

  it("honours a custom retention window", async () => {
    const target = join(workDir, "sovereign-ai-node-support-2026-07-20-dddddd.tar.gz");
    await writeFile(target, "x");
    await ageFile(target, 3);
    expect(await cleanupOldBundles(workDir, FIXED_NOW, 1)).toEqual([
      "sovereign-ai-node-support-2026-07-20-dddddd.tar.gz",
    ]);
  });

  it("returns an empty list for a missing directory without throwing", async () => {
    // A cleanup failure must never prevent generating the bundle the operator
    // asked for right now.
    await expect(cleanupOldBundles(join(workDir, "does-not-exist"), FIXED_NOW)).resolves.toEqual(
      [],
    );
  });

  it("returns an empty list for an empty directory", async () => {
    await expect(cleanupOldBundles(workDir, FIXED_NOW)).resolves.toEqual([]);
  });

  it("skips an entry whose stat fails rather than guessing", async () => {
    const dangling = join(workDir, "sovereign-ai-node-support-2026-01-01-eeeeee.tar.gz");
    const { symlink } = await import("node:fs/promises");
    await symlink(join(workDir, "nowhere"), dangling);
    await expect(cleanupOldBundles(workDir, FIXED_NOW)).resolves.toEqual([]);
  });
});

describe("ensureBundleDirectory", () => {
  it("creates the directory with mode 0700", async () => {
    const target = join(workDir, "support-bundles");
    await expect(ensureBundleDirectory(target)).resolves.toBe(target);
    expect((await stat(target)).mode & 0o777).toBe(0o700);
  });

  it("creates nested parents", async () => {
    const target = join(workDir, "a", "b", "support-bundles");
    await ensureBundleDirectory(target);
    await expect(stat(target)).resolves.toBeDefined();
  });

  it("is idempotent and tightens permissions on an existing directory", async () => {
    const target = join(workDir, "loose");
    await mkdir(target, { mode: 0o755 });
    await ensureBundleDirectory(target);
    expect((await stat(target)).mode & 0o777).toBe(0o700);
    await expect(ensureBundleDirectory(target)).resolves.toBe(target);
  });
});

describe("no network access", () => {
  it("the bundle module imports no network capability", async () => {
    // The bundle is written to local disk and never transmitted. Asserted by
    // reading the source rather than by mocking, so adding an import that could
    // upload a bundle fails here regardless of whether a test exercises it.
    const source = await readFile(new URL("./bundle.ts", import.meta.url), "utf8");
    const importedModules = [...source.matchAll(/from\s+"([^"]+)"/gu)].map((match) => match[1]);
    const dynamicImports = [...source.matchAll(/await import\("([^"]+)"\)/gu)].map(
      (match) => match[1],
    );

    for (const specifier of [...importedModules, ...dynamicImports]) {
      expect(specifier).not.toMatch(/^node:(net|http|https|http2|tls|dgram|dns)$/u);
      expect(specifier).not.toMatch(/axios|node-fetch|undici|got|superagent|ws$/u);
    }
  });

  it("the bundle module calls no fetch or network constructor", async () => {
    const source = await readFile(new URL("./bundle.ts", import.meta.url), "utf8");
    // Strip comments so prose about networking does not trip the assertion.
    const code = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
    for (const forbidden of ["fetch(", "XMLHttpRequest", "new WebSocket", "http.request"]) {
      expect(code).not.toContain(forbidden);
    }
  });

  it("the collectors module imports no network capability", async () => {
    const source = await readFile(new URL("./collectors.ts", import.meta.url), "utf8");
    const specifiers = [...source.matchAll(/from\s+"([^"]+)"/gu)].map((match) => match[1]);
    for (const specifier of specifiers) {
      expect(specifier).not.toMatch(/^node:(net|http|https|http2|tls|dgram|dns)$/u);
    }
  });
});

describe("module constants", () => {
  it("caps the total bundle at 8 MiB", () => {
    expect(MAX_BUNDLE_BYTES).toBe(8 * 1024 * 1024);
  });

  it("retains bundles for 14 days", () => {
    expect(BUNDLE_RETENTION_DAYS).toBe(14);
  });

  it("declares a bundle format version", () => {
    expect(BUNDLE_FORMAT_VERSION).toBe(1);
  });
});
