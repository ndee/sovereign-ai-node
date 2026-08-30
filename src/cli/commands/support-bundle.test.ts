import { Command } from "commander";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppContainer } from "../../app/create-app.js";
import { listSanErrorIds, lookupSanError, SAN_ERRORS } from "../../support/codes.js";
import { EXIT_PARTIAL, registerSupportBundleCommand } from "./support-bundle.js";

/**
 * Scope note.
 *
 * The `explain` command is fully covered here: it is synchronous, has no
 * dependencies beyond the code registry, and is the surface a partner reads
 * under stress, so its exit codes and rendering matter.
 *
 * `support-bundle` itself writes to the real `DEFAULT_PATHS.stateDir` and reads
 * the real Mail Sentinel state path — both module-level constants with no
 * injection point — so an end-to-end invocation would touch the host filesystem
 * outside the test's control. What is asserted here is registration, option
 * wiring, and the error path; the generation logic it delegates to is covered
 * directly and thoroughly in `src/support/bundle.test.ts`.
 */

const createMockApp = (): AppContainer =>
  ({
    installerService: {
      getDoctorReport: vi.fn(async () => ({ overall: "pass", checks: [] })),
      getStatus: vi.fn(async () => ({
        version: { provenance: { nodeVersion: "2.3.5" } },
        openclaw: { version: "0.9.1" },
      })),
    },
  }) as unknown as AppContainer;

const buildProgram = (): Command => {
  const program = new Command();
  program.exitOverride();
  registerSupportBundleCommand(program, createMockApp());
  return program;
};

const findCommand = (program: Command, name: string): Command | undefined =>
  program.commands.find((command) => command.name() === name);

let written: string[];
let originalExitCode: typeof process.exitCode;

beforeEach(() => {
  written = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
  originalExitCode = process.exitCode;
});

afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

const output = (): string => written.join("");

describe("registerSupportBundleCommand — registration", () => {
  it("registers both commands", () => {
    const program = buildProgram();
    expect(findCommand(program, "support-bundle")).toBeDefined();
    expect(findCommand(program, "explain")).toBeDefined();
  });

  it("gives support-bundle a --json and --output-dir option", () => {
    const command = findCommand(buildProgram(), "support-bundle");
    const flags = command?.options.map((option) => option.flags) ?? [];
    expect(flags).toContain("--json");
    expect(flags.some((flag) => flag.includes("--output-dir"))).toBe(true);
  });

  it("gives explain an optional code argument and a --json option", () => {
    const command = findCommand(buildProgram(), "explain");
    expect(command?.options.map((option) => option.flags)).toContain("--json");
    // The argument is optional so `explain` with no code can list the registry.
    expect(command?.registeredArguments[0]?.required).toBe(false);
  });

  it("describes both commands for --help", () => {
    const program = buildProgram();
    expect(findCommand(program, "support-bundle")?.description().length).toBeGreaterThan(0);
    expect(findCommand(program, "explain")?.description().length).toBeGreaterThan(0);
  });

  it("exports the partial exit code", () => {
    // A distinct code lets a readiness check fail closed without conflating
    // "could not gather everything" with "the command crashed".
    expect(EXIT_PARTIAL).toBe(2);
  });
});

describe("explain <code> — known codes", () => {
  it("renders a known code in human form", async () => {
    await buildProgram().parseAsync(["node", "test", "explain", "SAN-LLM-001"]);
    const text = output();
    const definition = lookupSanError("SAN-LLM-001");

    expect(text).toContain("SAN-LLM-001");
    expect(text).toContain(definition?.title ?? "");
    expect(text).toContain(definition?.explanation ?? "");
    expect(text).toContain("Likely cause:");
    expect(text).toContain("What you can do:");
    expect(text).toContain("Severity:");
    expect(text).toContain("Retryable:");
    expect(text).toContain("Playbook:");
  });

  it("does not set a failure exit code for a known code", async () => {
    process.exitCode = undefined;
    await buildProgram().parseAsync(["node", "test", "explain", "SAN-MATRIX-003"]);
    expect(process.exitCode).toBeUndefined();
  });

  it("accepts a lowercase code", async () => {
    await buildProgram().parseAsync(["node", "test", "explain", "san-imap-001"]);
    expect(output()).toContain("SAN-IMAP-001");
  });

  it("accepts a code with surrounding whitespace", async () => {
    await buildProgram().parseAsync(["node", "test", "explain", "  SAN-IMAP-002  "]);
    expect(output()).toContain("SAN-IMAP-002");
  });

  it("renders retryable as yes or no rather than a raw boolean", async () => {
    await buildProgram().parseAsync(["node", "test", "explain", "SAN-LLM-001"]);
    expect(output()).toMatch(/Retryable:\s+(yes|no)/u);
    expect(output()).not.toContain("Retryable:     true");
  });

  it("points at a playbook path under docs/supportability", async () => {
    await buildProgram().parseAsync(["node", "test", "explain", "SAN-SYSTEM-002"]);
    expect(output()).toContain("docs/supportability/playbooks/clock-incorrect.md");
  });

  it("renders every registry entry without throwing", async () => {
    for (const entry of SAN_ERRORS) {
      written = [];
      await expect(
        buildProgram().parseAsync(["node", "test", "explain", entry.id]),
      ).resolves.toBeDefined();
      expect(output()).toContain(entry.id);
    }
  });

  it("emits JSON with the definition when --json is passed", async () => {
    await buildProgram().parseAsync(["node", "test", "explain", "SAN-LLM-001", "--json"]);
    const parsed = JSON.parse(output());
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("explain");
    expect(parsed.result.id).toBe("SAN-LLM-001");
    expect(parsed.result.known).toBe(true);
    expect(parsed.result.definition).toMatchObject({ id: "SAN-LLM-001", component: "llm" });
  });

  it("normalizes the id in JSON output", async () => {
    await buildProgram().parseAsync(["node", "test", "explain", " san-llm-001 ", "--json"]);
    expect(JSON.parse(output()).result.id).toBe("SAN-LLM-001");
  });
});

describe("explain <code> — unknown codes", () => {
  it("sets exit code 1 for an unknown code", async () => {
    process.exitCode = undefined;
    await buildProgram().parseAsync(["node", "test", "explain", "SAN-NOPE-999"]);
    expect(process.exitCode).toBe(1);
  });

  it("says so plainly and lists the known codes", async () => {
    await buildProgram().parseAsync(["node", "test", "explain", "SAN-NOPE-999"]);
    const text = output();
    expect(text).toContain("Unknown error code: SAN-NOPE-999");
    expect(text).toContain("Known codes:");
    for (const id of listSanErrorIds()) {
      expect(text).toContain(id);
    }
  });

  it("does not throw for junk input", async () => {
    for (const junk of ["../../etc/passwd", "%%%", "1", ""]) {
      process.exitCode = undefined;
      written = [];
      await expect(
        buildProgram().parseAsync(["node", "test", "explain", junk]),
      ).resolves.toBeDefined();
    }
  });

  it("reports known:false in JSON without a definition", async () => {
    process.exitCode = undefined;
    await buildProgram().parseAsync(["node", "test", "explain", "SAN-NOPE-999", "--json"]);
    const parsed = JSON.parse(output());
    expect(parsed.result.known).toBe(false);
    expect(parsed.result.definition).toBeUndefined();
  });

  it("does not set a failure exit code in JSON mode", async () => {
    // JSON consumers read `known`; the envelope stays ok:true so a parse-based
    // caller is not forced to branch on the process exit code.
    process.exitCode = undefined;
    await buildProgram().parseAsync(["node", "test", "explain", "SAN-NOPE-999", "--json"]);
    expect(process.exitCode).toBeUndefined();
  });
});

describe("explain with no argument", () => {
  it("lists every known id", async () => {
    await buildProgram().parseAsync(["node", "test", "explain"]);
    const text = output();
    expect(text).toContain("Known error codes:");
    for (const id of listSanErrorIds()) {
      expect(text).toContain(id);
    }
  });

  it("lists ids in sorted order", async () => {
    await buildProgram().parseAsync(["node", "test", "explain"]);
    const text = output();
    const positions = listSanErrorIds().map((id) => text.indexOf(id));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("does not set a failure exit code", async () => {
    process.exitCode = undefined;
    await buildProgram().parseAsync(["node", "test", "explain"]);
    expect(process.exitCode).toBeUndefined();
  });

  it("emits the id list as JSON when --json is passed", async () => {
    await buildProgram().parseAsync(["node", "test", "explain", "--json"]);
    const parsed = JSON.parse(output());
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("explain");
    expect(parsed.result.ids).toEqual(listSanErrorIds());
  });
});

describe("explain output hygiene", () => {
  it("never emits an email address for any code", async () => {
    // Every surface renders from the registry; a stray address here would reach
    // every partner's terminal and every bundle.
    for (const entry of SAN_ERRORS) {
      written = [];
      await buildProgram().parseAsync(["node", "test", "explain", entry.id]);
      expect(output()).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u);
    }
  });

  it("does not print the scaffold placeholder that writeCliSuccess would emit", async () => {
    // These commands exist to be read by a person under stress, so they render
    // their own human output rather than the shared scaffold string.
    await buildProgram().parseAsync(["node", "test", "explain", "SAN-LLM-001"]);
    expect(output()).not.toContain("scaffold response generated");
  });
});

describe("support-bundle — error path", () => {
  /**
   * Force `ensureBundleDirectory` to fail deterministically by pointing the
   * output directory *inside a regular file*, which yields ENOTDIR on every
   * platform. This exercises the command's catch block without invoking the
   * collectors, which would shell out to the real systemctl/journalctl.
   */
  const unwritableDir = async (): Promise<{ path: string; cleanup: () => Promise<void> }> => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const base = await mkdtemp(join(tmpdir(), "sb-cli-"));
    const file = join(base, "not-a-directory");
    await writeFile(file, "regular file");
    return {
      path: join(file, "bundles"),
      cleanup: () => rm(base, { recursive: true, force: true }),
    };
  };

  it("sets exit code 1 and reports the failure when generation throws", async () => {
    process.exitCode = undefined;
    const { path, cleanup } = await unwritableDir();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await buildProgram().parseAsync(["node", "test", "support-bundle", "--output-dir", path]);
      expect(process.exitCode).toBe(1);
    } finally {
      stderr.mockRestore();
      await cleanup();
    }
  });

  it("reports the failure as JSON when --json is passed", async () => {
    process.exitCode = undefined;
    const { path, cleanup } = await unwritableDir();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await buildProgram().parseAsync([
        "node",
        "test",
        "support-bundle",
        "--json",
        "--output-dir",
        path,
      ]);
      expect(process.exitCode).toBe(1);
    } finally {
      stderr.mockRestore();
      await cleanup();
    }
  });

  it("never throws out of the action handler", async () => {
    // A support command that crashes with an unhandled rejection is the worst
    // possible behaviour: the partner gets a stack trace instead of a bundle.
    process.exitCode = undefined;
    const { path, cleanup } = await unwritableDir();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await expect(
        buildProgram().parseAsync(["node", "test", "support-bundle", "--output-dir", path]),
      ).resolves.toBeDefined();
    } finally {
      stderr.mockRestore();
      await cleanup();
    }
  });
});
