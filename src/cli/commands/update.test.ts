import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppContainer } from "../../app/create-app.js";
import {
  buildInstallerArgs,
  buildInstallerUrl,
  DEFAULT_INSTALL_SH_URL,
  downloadInstallerScript,
  executeUpdateViaInstaller,
  type FetchLike,
  GITHUB_REPO,
  registerUpdateCommand,
  requireRoot,
  resolveLatestReleaseRef,
  runInstallerScript,
  type SpawnerLike,
  writeInstallerTempScript,
} from "./update.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const SHEBANG_BODY = "#!/usr/bin/env bash\necho installer\n";

const mockResponse = (init: { ok?: boolean; status?: number; body?: string }): Response => {
  const ok = init.ok ?? true;
  const status = init.status ?? 200;
  const body = init.body ?? "";
  return {
    ok,
    status,
    text: async () => body,
  } as unknown as Response;
};

const createMockApp = (pending = false) =>
  ({
    installerService: {
      getPendingMigrations: vi.fn(async () => ({
        requestFile: "/etc/sovereign-node/install-request.json",
        pending: pending
          ? [
              {
                id: "mail-sentinel-instances",
                description: "migrate legacy mail-sentinel",
                interactive: true,
              },
            ]
          : [],
      })),
      startInstall: vi.fn(async () => ({
        job: {
          jobId: "job_123",
          state: "pending",
          createdAt: "2026-04-05T00:00:00.000Z",
          steps: [],
        },
      })),
    },
  }) as unknown as AppContainer;

describe("buildInstallerUrl", () => {
  it("returns the default URL when nothing is provided", () => {
    expect(buildInstallerUrl({})).toBe(DEFAULT_INSTALL_SH_URL);
  });

  it("substitutes a custom ref into the template", () => {
    expect(buildInstallerUrl({ ref: "dev" })).toBe(
      "https://raw.githubusercontent.com/ndee/sovereign-ai-node/dev/scripts/install.sh",
    );
  });

  it("prefers --installer-url over --ref", () => {
    expect(buildInstallerUrl({ installerUrl: "https://custom.example.org/x.sh", ref: "dev" })).toBe(
      "https://custom.example.org/x.sh",
    );
  });

  it("prefers the env URL over --installer-url", () => {
    expect(
      buildInstallerUrl({
        installerUrl: "https://custom.example.org/x.sh",
        envUrl: "https://env.example.org/x.sh",
      }),
    ).toBe("https://env.example.org/x.sh");
  });

  it("prefers the env ref over --ref when no URL is provided", () => {
    expect(buildInstallerUrl({ ref: "dev", envRef: "rc" })).toBe(
      "https://raw.githubusercontent.com/ndee/sovereign-ai-node/rc/scripts/install.sh",
    );
  });

  it("uses latestRef when no explicit override is provided", () => {
    expect(buildInstallerUrl({ latestRef: "v2.1.0" })).toBe(
      `https://raw.githubusercontent.com/${GITHUB_REPO}/v2.1.0/scripts/install.sh`,
    );
  });

  it("prefers --ref over latestRef", () => {
    expect(buildInstallerUrl({ ref: "dev", latestRef: "v2.1.0" })).toBe(
      `https://raw.githubusercontent.com/${GITHUB_REPO}/dev/scripts/install.sh`,
    );
  });

  it("prefers envRef over latestRef", () => {
    expect(buildInstallerUrl({ envRef: "rc", latestRef: "v2.1.0" })).toBe(
      `https://raw.githubusercontent.com/${GITHUB_REPO}/rc/scripts/install.sh`,
    );
  });

  it("ignores empty-string overrides", () => {
    expect(buildInstallerUrl({ installerUrl: "", ref: "", envUrl: "", envRef: "" })).toBe(
      DEFAULT_INSTALL_SH_URL,
    );
  });

  it("ignores empty latestRef", () => {
    expect(buildInstallerUrl({ latestRef: "" })).toBe(DEFAULT_INSTALL_SH_URL);
  });
});

describe("resolveLatestReleaseRef", () => {
  it("returns tag_name from a successful API response", async () => {
    const fetchFn = vi.fn<FetchLike>(async () =>
      mockResponse({ body: JSON.stringify({ tag_name: "v2.1.0" }) }),
    );
    const ref = await resolveLatestReleaseRef(fetchFn);
    expect(ref).toBe("v2.1.0");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("returns null on non-ok response", async () => {
    const fetchFn = vi.fn<FetchLike>(async () => mockResponse({ ok: false, status: 404 }));
    const ref = await resolveLatestReleaseRef(fetchFn);
    expect(ref).toBeNull();
  });

  it("returns null when tag_name is missing", async () => {
    const fetchFn = vi.fn<FetchLike>(async () => mockResponse({ body: JSON.stringify({}) }));
    const ref = await resolveLatestReleaseRef(fetchFn);
    expect(ref).toBeNull();
  });

  it("returns null on network error", async () => {
    const fetchFn = vi.fn<FetchLike>(async () => {
      throw new Error("network error");
    });
    const ref = await resolveLatestReleaseRef(fetchFn);
    expect(ref).toBeNull();
  });
});

describe("buildInstallerArgs", () => {
  it("always starts with --update --non-interactive", () => {
    expect(buildInstallerArgs({})).toEqual(["--update", "--non-interactive"]);
  });

  it("appends --request-file when provided", () => {
    expect(buildInstallerArgs({ requestFile: "/etc/foo.json" })).toEqual([
      "--update",
      "--non-interactive",
      "--request-file",
      "/etc/foo.json",
    ]);
  });

  it("ignores an empty request-file string", () => {
    expect(buildInstallerArgs({ requestFile: "" })).toEqual(["--update", "--non-interactive"]);
  });
});

describe("requireRoot", () => {
  it("passes when uid is 0", () => {
    expect(() => requireRoot(() => 0)).not.toThrow();
  });

  it("throws a structured error when uid is non-zero", () => {
    let captured: unknown;
    try {
      requireRoot(() => 1000);
    } catch (error) {
      captured = error;
    }
    expect(captured).toMatchObject({
      code: "UPDATE_REQUIRES_ROOT",
      message: expect.stringContaining("must run as root"),
      retryable: false,
    });
  });

  it("uses a default getuid implementation when none is provided", () => {
    // process.getuid returns 0 for root and a positive int otherwise; we can't
    // control the test runner's uid, so just assert that calling without args
    // does not throw a TypeError (the defaulting logic itself executes).
    const actualUid = typeof process.getuid === "function" ? process.getuid() : 0;
    if (actualUid === 0) {
      expect(() => requireRoot()).not.toThrow();
    } else {
      expect(() => requireRoot()).toThrow();
    }
  });
});

describe("downloadInstallerScript", () => {
  it("returns the body on a 200 response with a shebang", async () => {
    const fetchFn = vi.fn<FetchLike>(async () => mockResponse({ body: SHEBANG_BODY }));
    const body = await downloadInstallerScript("https://example.org/install.sh", fetchFn);
    expect(body).toBe(SHEBANG_BODY);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe("https://example.org/install.sh");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("throws when the response is not ok", async () => {
    const fetchFn = vi.fn<FetchLike>(async () =>
      mockResponse({ ok: false, status: 404, body: "" }),
    );
    await expect(
      downloadInstallerScript("https://example.org/install.sh", fetchFn),
    ).rejects.toMatchObject({
      code: "UPDATE_INSTALLER_DOWNLOAD_FAILED",
      details: { status: 404 },
    });
  });

  it("throws when the body does not start with a shebang", async () => {
    const fetchFn = vi.fn<FetchLike>(async () =>
      mockResponse({ body: "<html>not a script</html>" }),
    );
    await expect(
      downloadInstallerScript("https://example.org/install.sh", fetchFn),
    ).rejects.toMatchObject({
      code: "UPDATE_INSTALLER_BODY_INVALID",
    });
  });

  it("rejects non-HTTPS URLs before calling fetch", async () => {
    const fetchFn = vi.fn<FetchLike>();
    await expect(
      downloadInstallerScript("http://example.org/install.sh", fetchFn),
    ).rejects.toMatchObject({
      code: "UPDATE_INSTALLER_URL_INSECURE",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("writeInstallerTempScript", () => {
  it("writes the body to a tempdir with mode 0700", async () => {
    const result = await writeInstallerTempScript(SHEBANG_BODY);
    tempRoots.push(result.dir);
    const info = await stat(result.path);
    expect(info.mode & 0o777).toBe(0o700);
    expect(result.path.endsWith("/install.sh")).toBe(true);
    // round-trip: read via fs to confirm content
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(result.path, "utf8")).toBe(SHEBANG_BODY);
  });
});

describe("runInstallerScript", () => {
  const stubScript = "/tmp/does-not-matter/install.sh";

  it("calls bash with the script and args and returns the exit code", () => {
    const spawnFn = vi.fn<SpawnerLike>(() => ({ status: 0 }));
    const code = runInstallerScript(stubScript, ["--update", "--non-interactive"], spawnFn);
    expect(code).toBe(0);
    expect(spawnFn).toHaveBeenCalledWith("bash", [stubScript, "--update", "--non-interactive"], {
      stdio: "inherit",
    });
  });

  it("propagates non-zero exit codes", () => {
    const spawnFn = vi.fn<SpawnerLike>(() => ({ status: 2 }));
    expect(runInstallerScript(stubScript, [], spawnFn)).toBe(2);
  });

  it("maps a null status (signal kill) to exit 1", () => {
    const spawnFn = vi.fn<SpawnerLike>(() => ({ status: null, signal: "SIGTERM" }));
    expect(runInstallerScript(stubScript, [], spawnFn)).toBe(1);
  });

  it("throws a structured error when spawn itself fails", () => {
    const spawnFn = vi.fn<SpawnerLike>(() => ({ status: null, error: new Error("bash missing") }));
    expect(() => runInstallerScript(stubScript, [], spawnFn)).toThrow(
      expect.objectContaining({ code: "UPDATE_INSTALLER_SPAWN_FAILED" }),
    );
  });
});

describe("executeUpdateViaInstaller", () => {
  const happyFetch: FetchLike = async () => mockResponse({ body: SHEBANG_BODY });
  const noResolve = async () => null;

  it("downloads, writes, runs, and cleans up on success", async () => {
    const spawnFn = vi.fn<SpawnerLike>(() => ({ status: 0 }));
    let observedDir: string | undefined;
    const wrappedSpawn: SpawnerLike = (file, args, options) => {
      observedDir = (args[0] as string).replace(/\/install\.sh$/, "");
      return spawnFn(file, args, options);
    };
    const result = await executeUpdateViaInstaller(
      { requestFile: "/etc/foo.json" },
      { fetchFn: happyFetch, spawnFn: wrappedSpawn, env: {}, resolveLatestRef: noResolve },
    );
    expect(result.installerUrl).toBe(DEFAULT_INSTALL_SH_URL);
    expect(result.exitCode).toBe(0);
    // temp dir is gone
    expect(observedDir).toBeDefined();
    await expect(stat(observedDir as string)).rejects.toMatchObject({ code: "ENOENT" });
    // spawn args include the forwarded --request-file
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [, spawnArgs] = spawnFn.mock.calls[0] ?? [];
    expect(spawnArgs).toEqual(
      expect.arrayContaining(["--update", "--non-interactive", "--request-file", "/etc/foo.json"]),
    );
  });

  it("cleans up the temp dir when the installer returns a non-zero code", async () => {
    let observedDir: string | undefined;
    const spawnFn: SpawnerLike = (_file, args) => {
      observedDir = (args[0] as string).replace(/\/install\.sh$/, "");
      return { status: 3 };
    };
    const result = await executeUpdateViaInstaller(
      {},
      { fetchFn: happyFetch, spawnFn, env: {}, resolveLatestRef: noResolve },
    );
    expect(result.exitCode).toBe(3);
    expect(observedDir).toBeDefined();
    await expect(stat(observedDir as string)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("propagates download errors without leaving a temp dir", async () => {
    const fetchFn: FetchLike = async () => mockResponse({ ok: false, status: 500 });
    const spawnFn = vi.fn<SpawnerLike>(() => ({ status: 0 }));
    await expect(
      executeUpdateViaInstaller({}, { fetchFn, spawnFn, env: {}, resolveLatestRef: noResolve }),
    ).rejects.toMatchObject({ code: "UPDATE_INSTALLER_DOWNLOAD_FAILED" });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("honors SOVEREIGN_NODE_INSTALL_SH_URL from env", async () => {
    const calls: string[] = [];
    const fetchFn: FetchLike = async (url) => {
      calls.push(url as string);
      return mockResponse({ body: SHEBANG_BODY });
    };
    const spawnFn: SpawnerLike = () => ({ status: 0 });
    const envUrl = "https://env.example.org/install.sh";
    const result = await executeUpdateViaInstaller(
      {},
      { fetchFn, spawnFn, env: { SOVEREIGN_NODE_INSTALL_SH_URL: envUrl } },
    );
    expect(calls).toEqual([envUrl]);
    expect(result.installerUrl).toBe(envUrl);
  });

  it("honors SOVEREIGN_NODE_REF from env when no URL is set", async () => {
    const calls: string[] = [];
    const fetchFn: FetchLike = async (url) => {
      calls.push(url as string);
      return mockResponse({ body: SHEBANG_BODY });
    };
    const spawnFn: SpawnerLike = () => ({ status: 0 });
    const result = await executeUpdateViaInstaller(
      {},
      { fetchFn, spawnFn, env: { SOVEREIGN_NODE_REF: "rc" } },
    );
    expect(calls).toEqual([
      "https://raw.githubusercontent.com/ndee/sovereign-ai-node/rc/scripts/install.sh",
    ]);
    expect(result.installerUrl).toBe(
      "https://raw.githubusercontent.com/ndee/sovereign-ai-node/rc/scripts/install.sh",
    );
  });

  it("uses the latest release tag when no explicit ref is provided", async () => {
    const calls: string[] = [];
    const fetchFn: FetchLike = async (url) => {
      calls.push(url as string);
      return mockResponse({ body: SHEBANG_BODY });
    };
    const spawnFn: SpawnerLike = () => ({ status: 0 });
    const result = await executeUpdateViaInstaller(
      {},
      { fetchFn, spawnFn, env: {}, resolveLatestRef: async () => "v2.1.0" },
    );
    expect(result.installerUrl).toBe(
      `https://raw.githubusercontent.com/${GITHUB_REPO}/v2.1.0/scripts/install.sh`,
    );
  });

  it("skips release resolution when --ref is provided", async () => {
    const resolveFn = vi.fn(async () => "v2.1.0");
    const fetchFn: FetchLike = async () => mockResponse({ body: SHEBANG_BODY });
    const spawnFn: SpawnerLike = () => ({ status: 0 });
    await executeUpdateViaInstaller(
      { ref: "dev" },
      { fetchFn, spawnFn, env: {}, resolveLatestRef: resolveFn },
    );
    expect(resolveFn).not.toHaveBeenCalled();
  });

  it("uses process.env by default when deps.env is omitted", async () => {
    const originalUrl = process.env.SOVEREIGN_NODE_INSTALL_SH_URL;
    const originalRef = process.env.SOVEREIGN_NODE_REF;
    process.env.SOVEREIGN_NODE_INSTALL_SH_URL = "https://default-env.example.org/install.sh";
    delete process.env.SOVEREIGN_NODE_REF;
    try {
      const calls: string[] = [];
      const fetchFn: FetchLike = async (url) => {
        calls.push(url as string);
        return mockResponse({ body: SHEBANG_BODY });
      };
      const spawnFn: SpawnerLike = () => ({ status: 0 });
      const result = await executeUpdateViaInstaller(
        {},
        { fetchFn, spawnFn, resolveLatestRef: noResolve },
      );
      expect(result.installerUrl).toBe("https://default-env.example.org/install.sh");
      expect(calls).toEqual(["https://default-env.example.org/install.sh"]);
    } finally {
      if (originalUrl === undefined) {
        delete process.env.SOVEREIGN_NODE_INSTALL_SH_URL;
      } else {
        process.env.SOVEREIGN_NODE_INSTALL_SH_URL = originalUrl;
      }
      if (originalRef !== undefined) {
        process.env.SOVEREIGN_NODE_REF = originalRef;
      }
    }
  });
});

describe("registerUpdateCommand", () => {
  const stubUid = (uid: number): (() => void) => {
    const original = process.getuid;
    Object.defineProperty(process, "getuid", {
      configurable: true,
      value: () => uid,
    });
    return () => {
      if (original === undefined) {
        delete (process as { getuid?: () => number }).getuid;
      } else {
        Object.defineProperty(process, "getuid", {
          configurable: true,
          value: original,
        });
      }
    };
  };

  it("blocks update when pending migrations exist", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-update-command-test-"));
    tempRoots.push(tempRoot);
    const requestPath = join(tempRoot, "install-request.json");
    await writeFile(
      requestPath,
      JSON.stringify({
        mode: "bundled_matrix",
        openrouter: { secretRef: "env:OPENROUTER_API_KEY" },
        matrix: {
          homeserverDomain: "matrix.example.org",
          publicBaseUrl: "https://matrix.example.org",
        },
        operator: { username: "operator" },
      }),
      "utf8",
    );

    const program = new Command();
    program.exitOverride();
    const app = createMockApp(true);
    registerUpdateCommand(program, app);

    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const restoreUid = stubUid(0);
    const originalExitCode = process.exitCode;
    try {
      await program.parseAsync(["node", "test", "update", "--request-file", requestPath]);
      expect(app.installerService.getPendingMigrations).toHaveBeenCalled();
      expect(app.installerService.startInstall).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      const stderrCalls = stderrWrite.mock.calls.flat().join("");
      expect(stderrCalls).toContain("migrate");
    } finally {
      process.exitCode = originalExitCode;
      restoreUid();
      stderrWrite.mockRestore();
    }
  });

  it("fails fast with UPDATE_REQUIRES_ROOT before touching migrations when uid is non-zero", async () => {
    const program = new Command();
    program.exitOverride();
    const app = createMockApp(false);
    registerUpdateCommand(program, app);

    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const restoreUid = stubUid(1000);
    const originalExitCode = process.exitCode;
    try {
      await program.parseAsync(["node", "test", "update"]);
      expect(app.installerService.getPendingMigrations).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      const stderrCalls = stderrWrite.mock.calls.flat().join("");
      expect(stderrCalls).toContain("must run as root");
      expect(stderrCalls).not.toContain("Failed to read the saved install request file");
    } finally {
      process.exitCode = originalExitCode;
      restoreUid();
      stderrWrite.mockRestore();
    }
  });

  it("runs the installer and reports success when root and no pending migrations", async () => {
    const program = new Command();
    program.exitOverride();
    const app = createMockApp(false);
    const executeUpdate = vi.fn(async () => ({
      installerUrl: "https://example.org/install.sh",
      exitCode: 0,
    }));
    registerUpdateCommand(program, app, {
      executeUpdate,
      getuid: () => 0,
    });

    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const originalExitCode = process.exitCode;
    try {
      await program.parseAsync([
        "node",
        "test",
        "update",
        "--installer-url",
        "https://example.org/install.sh",
        "--request-file",
        "/etc/sovereign-node/install-request.json",
        "--ref",
        "main",
        "--json",
      ]);
      expect(app.installerService.getPendingMigrations).toHaveBeenCalled();
      expect(executeUpdate).toHaveBeenCalledWith({
        requestFile: "/etc/sovereign-node/install-request.json",
        ref: "main",
        installerUrl: "https://example.org/install.sh",
      });
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = originalExitCode;
      stdoutWrite.mockRestore();
    }
  });

  it("forwards installer non-zero exit code as the process exit code", async () => {
    const program = new Command();
    program.exitOverride();
    const app = createMockApp(false);
    const executeUpdate = vi.fn(async () => ({
      installerUrl: DEFAULT_INSTALL_SH_URL,
      exitCode: 7,
    }));
    registerUpdateCommand(program, app, {
      executeUpdate,
      getuid: () => 0,
    });

    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const originalExitCode = process.exitCode;
    try {
      await program.parseAsync(["node", "test", "update"]);
      expect(process.exitCode).toBe(7);
    } finally {
      process.exitCode = originalExitCode;
      stdoutWrite.mockRestore();
    }
  });
});
