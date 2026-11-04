import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createLogger } from "../logging/logger.js";
import type { ExecInput, ExecResult, ExecRunner } from "../system/exec.js";
import {
  isRetryableExecFailure,
  readOpenClawRuntimeTemplate,
  resolveOpenClawLookupPath,
  resolveOpenClawNpmPrefix,
  resolveOpenClawRuntimeDir,
  resolveOpenClawRuntimeModulesDir,
  resolveOpenClawRuntimePackageRoot,
  resolveOpenClawRuntimeTemplateDir,
  resolveOpenClawSpawnCwd,
  resolveOpenClawSpawnLookupPath,
  resolveRequestedOpenClawVersion,
  ShellOpenClawBootstrapper,
  SOVEREIGN_PINNED_OPENCLAW_VERSION,
  SOVEREIGN_PINNED_OPENCLAW_VERSION_ALIAS,
} from "./bootstrap.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEMPLATE_DIR = join(REPO_ROOT, "deploy", "openclaw-runtime");
const LOCKED_RUNTIMES = [
  { label: "the shipped project", dir: TEMPLATE_DIR, version: SOVEREIGN_PINNED_OPENCLAW_VERSION },
];

type LockEntry = {
  version?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};
const readLock = async (
  dir: string,
): Promise<{ lockfileVersion: number; packages: Record<string, LockEntry> }> =>
  JSON.parse(await readFile(join(dir, "package-lock.json"), "utf8"));
const lockedPackages = (
  lock: { packages: Record<string, LockEntry> },
  name: string,
): Array<[string, LockEntry]> =>
  Object.entries(lock.packages).filter(([path]) => path.endsWith(`node_modules/${name}`));
const PIN = SOVEREIGN_PINNED_OPENCLAW_VERSION;
const INSTALL = {
  version: SOVEREIGN_PINNED_OPENCLAW_VERSION_ALIAS,
  noOnboard: true,
  noPrompt: true,
  skipIfCompatibleInstalled: true,
} as const;

const withUid = async <T>(uid: number, action: () => Promise<T>): Promise<T> => {
  const original = process.getuid;
  Object.defineProperty(process, "getuid", { value: () => uid, configurable: true });
  try {
    return await action();
  } finally {
    Object.defineProperty(process, "getuid", { value: original, configurable: true });
  }
};

const withEnv = async <T>(
  overrides: Record<string, string | undefined>,
  action: () => Promise<T>,
): Promise<T> => {
  const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
  apply(overrides);
  try {
    return await action();
  } finally {
    apply(saved);
  }
};

const ok = (command: string, stdout = "", stderr = ""): ExecResult => ({
  command,
  exitCode: 0,
  stdout,
  stderr,
});

const commandLine = (input: ExecInput): string => [input.command, ...(input.args ?? [])].join(" ");

type FakePackageOptions = {
  version?: string;
  bin?: unknown;
  binMode?: number;
  matrixExtension?: boolean;
};

/** What a real `npm ci` of the locked project leaves behind, reduced to what the bootstrapper reads. */
const writeFakeOpenClawPackage = async (
  packageRoot: string,
  options: FakePackageOptions = {},
): Promise<void> => {
  await mkdir(join(packageRoot, "dist"), { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "openclaw",
      version: options.version ?? PIN,
      ...(options.bin === undefined ? { bin: { openclaw: "openclaw.mjs" } } : { bin: options.bin }),
    }),
    "utf8",
  );
  await writeFile(join(packageRoot, "openclaw.mjs"), "#!/usr/bin/env node\n", "utf8");
  await chmod(join(packageRoot, "openclaw.mjs"), options.binMode ?? 0o755);
  await writeFile(join(packageRoot, "dist", "index.js"), "export {};\n", "utf8");
  if (options.matrixExtension === true) {
    const extensionDir = join(packageRoot, "extensions", "matrix");
    await mkdir(extensionDir, { recursive: true });
    await writeFile(
      join(extensionDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/matrix",
        dependencies: {
          "@matrix-org/matrix-sdk-crypto-nodejs": "^0.4.0",
          "@vector-im/matrix-bot-sdk": "0.8.0-element.3",
          "local-helper": "file:../helper",
        },
      }),
      "utf8",
    );
  }
};

const writeInstalledPackage = async (extensionDir: string, name: string): Promise<void> => {
  const packageDir = join(extensionDir, "node_modules", ...name.split("/"));
  await mkdir(packageDir, { recursive: true });
  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify({ name, main: "index.js" }),
    "utf8",
  );
  await writeFile(join(packageDir, "index.js"), "module.exports = {};\n", "utf8");
};

type WorldOptions = {
  /** The prefix `npm prefix -g` reports; also where a root install links the CLI. */
  globalPrefix?: string;
  prefixResult?: ExecResult;
  ciResult?: ExecResult;
  ciPackage?: FakePackageOptions;
  ciHook?: (stagingDir: string) => Promise<void>;
  repairResult?: ExecResult;
  detect?: (input: ExecInput, linkPath: string) => Promise<ExecResult>;
  commandLocation?: (linkPath: string) => Promise<ExecResult>;
};

/**
 * An exec runner backed by a real temp filesystem: `npm ci` materialises a
 * fake OpenClaw package in the staging dir it is run in, and `openclaw
 * --version` answers only when the prefix's bin link resolves.
 */
const createWorld = (linkDir: () => string, options: WorldOptions = {}) => {
  const calls: ExecInput[] = [];
  const linkPath = () => join(linkDir(), "openclaw");
  const runner: ExecRunner = {
    run: async (input) => {
      calls.push(input);
      const line = commandLine(input);
      if (input.command === "openclaw") {
        if (options.detect !== undefined) {
          return options.detect(input, linkPath());
        }
        if (!existsSync(linkPath())) {
          throw new Error("spawn openclaw ENOENT");
        }
        const packageRoot = dirname(await realpath(linkPath()));
        const { version } = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
        return ok(line, `OpenClaw ${version} (61d171a)`);
      }
      if (input.command === "sh") {
        if (options.commandLocation !== undefined) {
          return options.commandLocation(linkPath());
        }
        return existsSync(linkPath())
          ? ok(line, linkPath())
          : { command: line, exitCode: 1, stdout: "", stderr: "" };
      }
      if (input.command === "npm" && input.args?.[0] === "prefix") {
        return options.prefixResult ?? ok(line, `${options.globalPrefix ?? "/nonexistent"}\n`);
      }
      if (input.command === "npm" && input.args?.[0] === "ci") {
        if (options.ciResult !== undefined) {
          return options.ciResult;
        }
        const stagingDir = String(input.options?.cwd);
        await writeFakeOpenClawPackage(
          join(stagingDir, "node_modules", "openclaw"),
          options.ciPackage,
        );
        await options.ciHook?.(stagingDir);
        return ok(line, "added 333 packages");
      }
      if (input.command === "npm" && input.args?.[0] === "install") {
        if (options.repairResult !== undefined) {
          return options.repairResult;
        }
        const extensionDir = String(input.options?.cwd);
        for (const spec of input.args.slice(4)) {
          await writeInstalledPackage(extensionDir, spec.slice(0, spec.lastIndexOf("@")));
        }
        return ok(line, "repaired");
      }
      throw new Error(`unexpected exec call: ${line}`);
    },
  };
  return { calls, runner, linkPath };
};

const callsTo = (calls: ExecInput[], command: string, firstArg?: string): ExecInput[] =>
  calls.filter(
    (call) => call.command === command && (firstArg === undefined || call.args?.[0] === firstArg),
  );

const envOf = (call: ExecInput | undefined): Record<string, string> =>
  (call?.options?.env ?? {}) as Record<string, string>;

/** An unprivileged install into a fresh service home, the web installer's path. */
const unprivilegedInstall = async (
  options: WorldOptions = {},
  setup?: (serviceHome: string) => Promise<void>,
) => {
  const serviceHome = await mkdtemp(join(tmpdir(), "openclaw-service-home-"));
  const prefix = join(serviceHome, ".npm-global");
  await setup?.(serviceHome);
  const world = createWorld(() => join(prefix, "bin"), options);
  const bootstrapper = new ShellOpenClawBootstrapper(world.runner, createLogger(), serviceHome);
  return {
    serviceHome,
    prefix,
    runtimeDir: resolveOpenClawRuntimeDir(prefix),
    bootstrapper,
    ...world,
  };
};

describe("the locked OpenClaw runtime project", () => {
  it.each(LOCKED_RUNTIMES)("$label locks exactly OpenClaw $version", async ({ dir, version }) => {
    const template = await readOpenClawRuntimeTemplate(dir);
    expect(template.version).toBe(version);
    const lock = await readLock(dir);
    expect(lock.lockfileVersion).toBe(3);
    expect(lock.packages[""]?.dependencies).toEqual({ openclaw: version });
    expect(lock.packages["node_modules/openclaw"]?.version).toBe(version);
  });

  it("locks the pinned version in the shipped project", async () => {
    expect((await readOpenClawRuntimeTemplate(TEMPLATE_DIR)).version).toBe(PIN);
  });

  it.each(LOCKED_RUNTIMES)("$label forces every zod in the tree to 4.6.6", async ({ dir }) => {
    const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    expect(manifest.overrides).toEqual({ zod: "4.6.6" });
    const zods = lockedPackages(await readLock(dir), "zod");
    expect(zods.length).toBeGreaterThan(0);
    for (const [path, entry] of zods) {
      expect(entry.version, path).toBe("4.6.6");
    }
  });

  // Recorded so a markdown-it override is a visible decision: on 2026.8.35
  // markdown-it is compiled into openclaw's dist and is no longer a package.
  it("has no markdown-it package at runtime", async () => {
    expect(lockedPackages(await readLock(TEMPLATE_DIR), "markdown-it")).toEqual([]);
  });

  it.each(
    LOCKED_RUNTIMES,
  )("$label keeps everything but openclaw's peers inside the openclaw package", async ({ dir }) => {
    const lock = await readLock(dir);
    const peers = Object.keys(lock.packages["node_modules/openclaw"]?.peerDependencies ?? {});
    const outside = Object.keys(lock.packages).filter(
      (path) =>
        path !== "" &&
        path !== "node_modules/openclaw" &&
        !path.startsWith("node_modules/openclaw/") &&
        !peers.some(
          (peer) => path === `node_modules/${peer}` || path.startsWith(`node_modules/${peer}/`),
        ),
    );
    expect(outside).toEqual([]);
  });

  it("names the runtime's node_modules only for the locked runtime's own package", () => {
    expect(
      resolveOpenClawRuntimeModulesDir("/usr/lib/sovereign-openclaw-runtime/node_modules/openclaw"),
    ).toBe("/usr/lib/sovereign-openclaw-runtime/node_modules");
    expect(resolveOpenClawRuntimeModulesDir("/usr/lib/node_modules/openclaw")).toBeNull();
    expect(resolveOpenClawRuntimeModulesDir("/opt/sovereign-openclaw-runtime/openclaw")).toBeNull();
  });

  it("ships the runtime project in the published package", async () => {
    const pkg = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8")) as {
      files: string[];
    };
    expect(pkg.files).toEqual(
      expect.arrayContaining([
        "deploy/openclaw-runtime/package.json",
        "deploy/openclaw-runtime/package-lock.json",
      ]),
    );
  });

  it("finds the template from a bundled dist entry, a dist/lib entry and the source tree", () => {
    const exists = (path: string) => path === "/app/deploy/openclaw-runtime/package-lock.json";
    expect(resolveOpenClawRuntimeTemplateDir("/app/dist", exists)).toBe(
      "/app/deploy/openclaw-runtime",
    );
    expect(resolveOpenClawRuntimeTemplateDir("/app/dist/lib", exists)).toBe(
      "/app/deploy/openclaw-runtime",
    );
    expect(resolveOpenClawRuntimeTemplateDir("/app/src/openclaw", exists)).toBe(
      "/app/deploy/openclaw-runtime",
    );
    expect(resolveOpenClawRuntimeTemplateDir("/elsewhere/a/b", exists)).toBeNull();
    expect(resolveOpenClawRuntimeTemplateDir(join(REPO_ROOT, "src", "openclaw"))).toBe(
      TEMPLATE_DIR,
    );
  });

  it("rejects a template that does not depend on openclaw", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openclaw-template-"));
    await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: {} }), "utf8");
    await writeFile(join(dir, "package-lock.json"), "{}", "utf8");
    await expect(readOpenClawRuntimeTemplate(dir)).rejects.toThrow("does not depend on openclaw");
  });

  it("keeps the runtime in its own project dir below the prefix's lib, never at the prefix", () => {
    expect(resolveOpenClawRuntimeDir("/usr")).toBe("/usr/lib/sovereign-openclaw-runtime");
    expect(resolveOpenClawRuntimePackageRoot("/usr/lib/sovereign-openclaw-runtime")).toBe(
      "/usr/lib/sovereign-openclaw-runtime/node_modules/openclaw",
    );
  });
});

describe("ShellOpenClawBootstrapper installs from the locked runtime project", () => {
  it("installs into the service home's prefix when unprivileged and links the CLI there", async () => {
    await withUid(1001, async () => {
      const { bootstrapper, calls, prefix, runtimeDir, serviceHome, linkPath } =
        await unprivilegedInstall();

      const info = await bootstrapper.ensureInstalled(INSTALL);

      expect(info).toEqual({
        binaryPath: "openclaw",
        version: PIN,
        installMethod: "locked_project",
        reinstalled: true,
      });
      // No unpinned upstream installer and no global install anywhere.
      expect(calls.some((call) => call.command === "bash" || call.command === "curl")).toBe(false);
      expect(calls.some((call) => call.args?.includes("-g") && call.args[0] === "install")).toBe(
        false,
      );
      // An unprivileged install knows its prefix and never asks npm for the global one.
      expect(callsTo(calls, "npm", "prefix")).toHaveLength(0);

      const [ciCall] = callsTo(calls, "npm", "ci");
      expect(ciCall?.args).toEqual(["ci", "--omit=dev", "--no-audit", "--no-fund"]);
      expect(ciCall?.options?.cwd).toBe(`${runtimeDir}.staging`);
      expect(envOf(ciCall)).toMatchObject({
        CI: "1",
        HOME: serviceHome,
        NPM_CONFIG_CACHE: join(serviceHome, ".npm"),
      });
      expect(envOf(ciCall).PATH?.startsWith(`${join(prefix, "bin")}:`)).toBe(true);

      expect(await readFile(join(runtimeDir, "package.json"), "utf8")).toBe(
        await readFile(join(TEMPLATE_DIR, "package.json"), "utf8"),
      );
      expect(await readFile(join(runtimeDir, "package-lock.json"), "utf8")).toBe(
        await readFile(join(TEMPLATE_DIR, "package-lock.json"), "utf8"),
      );
      expect(await readlink(linkPath())).toBe(
        join(resolveOpenClawRuntimePackageRoot(runtimeDir), "openclaw.mjs"),
      );
      expect(existsSync(`${runtimeDir}.staging`)).toBe(false);
      expect(existsSync(`${runtimeDir}.previous`)).toBe(false);
    });
  });

  it("installs a root install into npm's global prefix with the ambient HOME and PATH", async () => {
    const globalPrefix = await mkdtemp(join(tmpdir(), "openclaw-global-prefix-"));
    const world = createWorld(() => join(globalPrefix, "bin"), { globalPrefix });
    const bootstrapper = new ShellOpenClawBootstrapper(world.runner, createLogger(), "/var/lib/sn");

    await withEnv({ HOME: "/root", NPM_CONFIG_CACHE: undefined }, () =>
      withUid(0, () => bootstrapper.ensureInstalled(INSTALL)),
    );

    const [prefixCall] = callsTo(world.calls, "npm", "prefix");
    expect(prefixCall?.args).toEqual(["prefix", "-g"]);
    // Root traverses anything, so no spawn pins a cwd except the staged npm ci.
    expect(prefixCall?.options?.cwd).toBeUndefined();
    const [ciCall] = callsTo(world.calls, "npm", "ci");
    expect(ciCall?.options?.cwd).toBe(`${resolveOpenClawRuntimeDir(globalPrefix)}.staging`);
    expect(envOf(ciCall)).toEqual({ CI: "1", HOME: "/root", NPM_CONFIG_CACHE: "/root/.npm" });
    expect(await realpath(world.linkPath())).toBe(
      await realpath(
        join(
          resolveOpenClawRuntimePackageRoot(resolveOpenClawRuntimeDir(globalPrefix)),
          "openclaw.mjs",
        ),
      ),
    );
  });

  it("repairs bundled extension dependencies of a root install with the ambient HOME", async () => {
    const globalPrefix = await mkdtemp(join(tmpdir(), "openclaw-global-prefix-"));
    const world = createWorld(() => join(globalPrefix, "bin"), {
      globalPrefix,
      ciPackage: { matrixExtension: true },
    });
    const bootstrapper = new ShellOpenClawBootstrapper(world.runner, createLogger(), "/var/lib/sn");

    await withUid(0, () => bootstrapper.ensureInstalled({ version: PIN }));

    const [repair] = callsTo(world.calls, "npm", "install");
    expect(envOf(repair)).toEqual({ CI: "1" });
  });

  it("asks npm for its prefix when an unprivileged install has no home at all", async () => {
    const globalPrefix = await mkdtemp(join(tmpdir(), "openclaw-user-prefix-"));
    const world = createWorld(() => join(globalPrefix, "bin"), { globalPrefix });
    const bootstrapper = new ShellOpenClawBootstrapper(world.runner, createLogger());

    await withEnv({ HOME: undefined }, () =>
      withUid(1001, () => bootstrapper.ensureInstalled(INSTALL)),
    );

    const [prefixCall] = callsTo(world.calls, "npm", "prefix");
    expect(prefixCall?.options?.cwd).toBe("/");
    expect(envOf(callsTo(world.calls, "npm", "ci")[0]).HOME).toBe("/root");
    expect(existsSync(join(resolveOpenClawRuntimeDir(globalPrefix), "package-lock.json"))).toBe(
      true,
    );
  });

  it("honours an explicit npm cache and falls back to /root when no HOME is set", async () => {
    const globalPrefix = await mkdtemp(join(tmpdir(), "openclaw-global-prefix-"));
    const world = createWorld(() => join(globalPrefix, "bin"), { globalPrefix });
    const bootstrapper = new ShellOpenClawBootstrapper(world.runner, createLogger());

    await withEnv({ HOME: undefined, NPM_CONFIG_CACHE: "/var/cache/npm" }, () =>
      withUid(0, () => bootstrapper.ensureInstalled(INSTALL)),
    );

    expect(envOf(callsTo(world.calls, "npm", "ci")[0])).toMatchObject({
      HOME: "/root",
      NPM_CONFIG_CACHE: "/var/cache/npm",
    });
  });

  it("fails clearly when npm cannot report its global prefix", async () => {
    const world = createWorld(() => "/nonexistent", {
      prefixResult: { command: "npm prefix -g", exitCode: 1, stdout: "", stderr: "npm broke" },
    });
    const bootstrapper = new ShellOpenClawBootstrapper(world.runner, createLogger());

    await expect(withUid(0, () => bootstrapper.ensureInstalled(INSTALL))).rejects.toMatchObject({
      code: "OPENCLAW_INSTALL_FAILED",
      message: "Could not resolve the npm global prefix for the OpenClaw install",
      retryable: true,
      details: { exitCode: 1, stderr: "npm broke" },
    });
    expect(callsTo(world.calls, "npm", "ci")).toHaveLength(0);
  });

  it("treats an empty global prefix as unresolvable", async () => {
    const world = createWorld(() => "/nonexistent", { prefixResult: ok("npm prefix -g", " \n") });
    const bootstrapper = new ShellOpenClawBootstrapper(world.runner, createLogger());

    await expect(withUid(0, () => bootstrapper.ensureInstalled(INSTALL))).rejects.toMatchObject({
      code: "OPENCLAW_INSTALL_FAILED",
      message: "Could not resolve the npm global prefix for the OpenClaw install",
    });
  });

  it("refuses to install when the build carries no runtime project", async () => {
    const world = createWorld(() => "/nonexistent");
    const bootstrapper = new ShellOpenClawBootstrapper(
      world.runner,
      createLogger(),
      undefined,
      null,
    );

    await expect(bootstrapper.ensureInstalled(INSTALL)).rejects.toMatchObject({
      code: "OPENCLAW_INSTALL_FAILED",
      message: "The locked OpenClaw runtime project is missing or unreadable in this build",
      retryable: false,
      details: {
        templateDir: null,
        error: "no deploy/openclaw-runtime directory next to this build",
      },
    });
    expect(world.calls).toHaveLength(0);
  });

  it("reports an unreadable runtime project with its location", async () => {
    const templateDir = join(await mkdtemp(join(tmpdir(), "openclaw-template-")), "missing");
    const world = createWorld(() => "/nonexistent");
    const bootstrapper = new ShellOpenClawBootstrapper(
      world.runner,
      createLogger(),
      undefined,
      templateDir,
    );

    await expect(bootstrapper.ensureInstalled(INSTALL)).rejects.toMatchObject({
      code: "OPENCLAW_INSTALL_FAILED",
      retryable: false,
      details: { templateDir, error: expect.stringContaining("ENOENT") },
    });
  });

  it("installs the locked version when a request still names another one", async () => {
    await withUid(1001, async () => {
      const { bootstrapper, calls } = await unprivilegedInstall();

      const info = await bootstrapper.ensureInstalled({ ...INSTALL, version: "2026.1.1" });

      expect(info.version).toBe(PIN);
      expect(callsTo(calls, "npm", "ci")).toHaveLength(1);
    });
  });

  it("resolves the pinned-by-sovereign alias and an empty version to the pin", () => {
    expect(resolveRequestedOpenClawVersion(SOVEREIGN_PINNED_OPENCLAW_VERSION_ALIAS)).toBe(PIN);
    expect(resolveRequestedOpenClawVersion("  ")).toBe(PIN);
    expect(resolveRequestedOpenClawVersion(undefined)).toBe(PIN);
    expect(resolveRequestedOpenClawVersion("2026.1.1")).toBe("2026.1.1");
  });
});

describe("ShellOpenClawBootstrapper keeps reruns idempotent", () => {
  it("skips the install when the locked runtime in place is current", async () => {
    await withUid(1001, async () => {
      const { bootstrapper, calls } = await unprivilegedInstall();
      await bootstrapper.ensureInstalled(INSTALL);
      calls.length = 0;

      const info = await bootstrapper.ensureInstalled(INSTALL);
      // Skipping is the default when the request does not say.
      const byDefault = await bootstrapper.ensureInstalled({ version: PIN });

      expect(byDefault.reinstalled).toBe(false);
      expect(info).toEqual({
        binaryPath: "openclaw",
        version: PIN,
        installMethod: "locked_project",
        reinstalled: false,
      });
      expect(callsTo(calls, "npm", "ci")).toHaveLength(0);
    });
  });

  it("reinstalls on request even when the runtime is current", async () => {
    await withUid(1001, async () => {
      const { bootstrapper, calls } = await unprivilegedInstall();
      await bootstrapper.ensureInstalled(INSTALL);

      const forced = await bootstrapper.ensureInstalled({ ...INSTALL, forceReinstall: true });
      const unskipped = await bootstrapper.ensureInstalled({
        ...INSTALL,
        skipIfCompatibleInstalled: false,
      });

      expect(forced.reinstalled).toBe(true);
      expect(unskipped.reinstalled).toBe(true);
      expect(callsTo(calls, "npm", "ci")).toHaveLength(3);
    });
  });

  it("replaces a CLI of the pinned version that was installed globally, without the lock", async () => {
    await withUid(1001, async () => {
      const { bootstrapper, calls, prefix, runtimeDir, linkPath } = await unprivilegedInstall(
        {},
        async (serviceHome) => {
          const globalRoot = join(serviceHome, ".npm-global", "lib", "node_modules", "openclaw");
          await writeFakeOpenClawPackage(globalRoot);
          await mkdir(join(serviceHome, ".npm-global", "bin"), { recursive: true });
          await symlink(
            join(globalRoot, "openclaw.mjs"),
            join(serviceHome, ".npm-global", "bin", "openclaw"),
          );
        },
      );

      const info = await bootstrapper.ensureInstalled(INSTALL);

      expect(info.reinstalled).toBe(true);
      expect(callsTo(calls, "npm", "ci")).toHaveLength(1);
      expect(await readlink(linkPath())).toBe(
        join(resolveOpenClawRuntimePackageRoot(runtimeDir), "openclaw.mjs"),
      );
      expect(prefix).toBe(dirname(dirname(linkPath())));
    });
  });

  it("upgrades an earlier OpenClaw whose version differs from the pin", async () => {
    await withUid(1001, async () => {
      const { bootstrapper, calls } = await unprivilegedInstall({
        detect: async (_input, linkPath) =>
          existsSync(join(dirname(linkPath), "..", "lib", "sovereign-openclaw-runtime"))
            ? ok("openclaw --version", `OpenClaw ${PIN}`)
            : ok("openclaw --version", "OpenClaw 2026.2.1 (abc)"),
      });

      const info = await bootstrapper.ensureInstalled(INSTALL);

      expect(info).toMatchObject({ version: PIN, reinstalled: true });
      expect(callsTo(calls, "npm", "ci")).toHaveLength(1);
    });
  });

  it.each([
    [
      "the manifest changed",
      async (runtimeDir: string) => writeFile(join(runtimeDir, "package.json"), "{}", "utf8"),
    ],
    [
      "the lockfile changed",
      async (runtimeDir: string) => writeFile(join(runtimeDir, "package-lock.json"), "{}", "utf8"),
    ],
    [
      "the installed package reports no version",
      async (runtimeDir: string) =>
        writeFile(
          join(resolveOpenClawRuntimePackageRoot(runtimeDir), "package.json"),
          JSON.stringify({ name: "openclaw", bin: "openclaw.mjs" }),
          "utf8",
        ),
    ],
    [
      "the installed package is another version",
      async (runtimeDir: string) =>
        writeFile(
          join(resolveOpenClawRuntimePackageRoot(runtimeDir), "package.json"),
          JSON.stringify({ name: "openclaw", version: "2026.8.1", bin: "openclaw.mjs" }),
          "utf8",
        ),
    ],
    [
      "the runtime project is gone",
      async (runtimeDir: string) => rm(runtimeDir, { recursive: true }),
    ],
  ])("reinstalls when %s", async (_label, mutate) => {
    await withUid(1001, async () => {
      const { bootstrapper, calls, runtimeDir } = await unprivilegedInstall({
        detect: async () => ok("openclaw --version", `OpenClaw ${PIN}`),
      });
      await bootstrapper.ensureInstalled(INSTALL);
      await mutate(runtimeDir);
      calls.length = 0;

      const info = await bootstrapper.ensureInstalled(INSTALL);

      expect(info.reinstalled).toBe(true);
      expect(callsTo(calls, "npm", "ci")).toHaveLength(1);
    });
  });

  it("reinstalls when the prefix's openclaw no longer points into the runtime", async () => {
    await withUid(1001, async () => {
      const { bootstrapper, calls, linkPath, serviceHome } = await unprivilegedInstall();
      await bootstrapper.ensureInstalled(INSTALL);
      const stray = join(serviceHome, "stray");
      await writeFakeOpenClawPackage(stray);
      await rm(linkPath());
      await symlink(join(stray, "openclaw.mjs"), linkPath());
      calls.length = 0;

      expect((await bootstrapper.ensureInstalled(INSTALL)).reinstalled).toBe(true);
      expect(callsTo(calls, "npm", "ci")).toHaveLength(1);
    });
  });

  it("swaps a reinstall in and drops the previous runtime", async () => {
    await withUid(1001, async () => {
      const { bootstrapper, runtimeDir } = await unprivilegedInstall();
      await bootstrapper.ensureInstalled(INSTALL);
      await writeFile(join(runtimeDir, "left-over"), "old", "utf8");
      await mkdir(`${runtimeDir}.staging`, { recursive: true });
      await writeFile(join(`${runtimeDir}.staging`, "half-done"), "x", "utf8");

      await bootstrapper.ensureInstalled({ ...INSTALL, forceReinstall: true });

      expect(existsSync(join(runtimeDir, "left-over"))).toBe(false);
      expect(existsSync(`${runtimeDir}.staging`)).toBe(false);
      expect(existsSync(`${runtimeDir}.previous`)).toBe(false);
    });
  });
});

describe("ShellOpenClawBootstrapper never breaks the runtime in place on a failed install", () => {
  it("leaves the current runtime untouched and cleans up when npm ci fails", async () => {
    await withUid(1001, async () => {
      let failCi = false;
      const ciFailure: ExecResult = {
        command: "npm ci --omit=dev --no-audit --no-fund",
        exitCode: 1,
        stdout: "partial",
        stderr: "ETARGET registry error",
      };
      const { bootstrapper, runtimeDir, linkPath } = await unprivilegedInstall({
        ciHook: async () => {
          if (failCi) {
            throw new Error("not reached");
          }
        },
      });
      await bootstrapper.ensureInstalled(INSTALL);
      const linkBefore = await readlink(linkPath());
      failCi = true;
      const failing = new ShellOpenClawBootstrapper(
        createWorld(() => dirname(linkPath()), { ciResult: ciFailure }).runner,
        createLogger(),
        dirname(dirname(dirname(runtimeDir))),
      );

      await expect(failing.ensureInstalled({ ...INSTALL, forceReinstall: true })).rejects.toEqual({
        code: "OPENCLAW_INSTALL_FAILED",
        message: "OpenClaw locked runtime install (npm ci) exited with a non-zero status",
        retryable: true,
        details: {
          command: ciFailure.command,
          exitCode: 1,
          runtimeDir,
          stderr: "ETARGET registry error",
          stdout: "partial",
        },
      });
      expect(existsSync(`${runtimeDir}.staging`)).toBe(false);
      expect(await readlink(linkPath())).toBe(linkBefore);
      expect(existsSync(join(resolveOpenClawRuntimePackageRoot(runtimeDir), "package.json"))).toBe(
        true,
      );
    });
  });

  it("marks an npm ci that never started as not retryable, with its cause", async () => {
    await withUid(1001, async () => {
      const { bootstrapper } = await unprivilegedInstall({
        ciResult: {
          command: "npm ci",
          exitCode: 127,
          stdout: "",
          stderr: "spawn npm EACCES",
          failureReason: "spawn_failed",
          errorCode: "EACCES",
        },
      });

      await expect(bootstrapper.ensureInstalled(INSTALL)).rejects.toMatchObject({
        retryable: false,
        details: { failureReason: "spawn_failed", errorCode: "EACCES" },
      });
    });
  });

  it("fails when the installed package declares no openclaw bin", async () => {
    await withUid(1001, async () => {
      const { bootstrapper } = await unprivilegedInstall({ ciPackage: { bin: {} } });

      await expect(bootstrapper.ensureInstalled(INSTALL)).rejects.toMatchObject({
        code: "OPENCLAW_INSTALL_FAILED",
        message: "The installed OpenClaw package declares no openclaw bin entry",
        retryable: false,
      });
    });
  });

  it("accepts a string bin entry and makes the CLI executable for everyone", async () => {
    await withUid(1001, async () => {
      const { bootstrapper, runtimeDir, linkPath } = await unprivilegedInstall({
        ciPackage: { bin: "openclaw.mjs", binMode: 0o600 },
      });

      await bootstrapper.ensureInstalled(INSTALL);

      const target = join(resolveOpenClawRuntimePackageRoot(runtimeDir), "openclaw.mjs");
      expect(await readlink(linkPath())).toBe(target);
      expect((await stat(target)).mode & 0o555).toBe(0o555);
    });
  });

  it("opens up a tree written under a restrictive umask so the service user can read it", async () => {
    await withUid(1001, async () => {
      const { bootstrapper, runtimeDir } = await unprivilegedInstall({
        ciHook: async (stagingDir) => {
          const packageRoot = join(stagingDir, "node_modules", "openclaw");
          await chmod(join(packageRoot, "dist", "index.js"), 0o600);
          await chmod(join(packageRoot, "dist"), 0o700);
          await chmod(join(stagingDir, "node_modules"), 0o700);
        },
      });

      await bootstrapper.ensureInstalled(INSTALL);

      expect((await stat(join(runtimeDir, "node_modules"))).mode & 0o005).toBe(0o005);
      const packageRoot = resolveOpenClawRuntimePackageRoot(runtimeDir);
      expect((await stat(join(packageRoot, "dist"))).mode & 0o005).toBe(0o005);
      expect((await stat(join(packageRoot, "dist", "index.js"))).mode & 0o004).toBe(0o004);
    });
  });

  it.each([
    "extensions",
    "dist/extensions",
  ])("hardens world-writable bundled extension directories in %s/", async (relative) => {
    const segments = relative.split("/");
    await withUid(1001, async () => {
      const { bootstrapper, runtimeDir } = await unprivilegedInstall({
        ciHook: async (stagingDir) => {
          const extensions = join(stagingDir, "node_modules", "openclaw", ...segments);
          await mkdir(join(extensions, "memory-core"), { recursive: true });
          await writeFile(join(extensions, "memory-core", "index.ts"), "export {};\n", "utf8");
          await chmod(join(extensions, "memory-core", "index.ts"), 0o666);
          await chmod(join(extensions, "memory-core"), 0o777);
          await chmod(extensions, 0o777);
        },
      });

      await bootstrapper.ensureInstalled(INSTALL);

      const extensions = join(resolveOpenClawRuntimePackageRoot(runtimeDir), ...segments);
      expect((await stat(extensions)).mode & 0o022).toBe(0);
      expect((await stat(join(extensions, "memory-core"))).mode & 0o022).toBe(0);
      expect((await stat(join(extensions, "memory-core", "index.ts"))).mode & 0o022).toBe(0);
    });
  });
});

describe("ShellOpenClawBootstrapper repairs bundled extension dependencies in the runtime", () => {
  it("installs missing matrix extension dependencies as the service user", async () => {
    await withUid(1001, async () => {
      const { bootstrapper, calls, runtimeDir, serviceHome, prefix } = await unprivilegedInstall({
        ciPackage: { matrixExtension: true },
      });

      await bootstrapper.ensureInstalled(INSTALL);

      const extensionDir = join(
        resolveOpenClawRuntimePackageRoot(runtimeDir),
        "extensions",
        "matrix",
      );
      const [repair] = callsTo(calls, "npm", "install");
      expect(repair).toMatchObject({
        args: [
          "install",
          "--omit=dev",
          "--no-package-lock",
          "--no-save",
          "@matrix-org/matrix-sdk-crypto-nodejs@^0.4.0",
          "@vector-im/matrix-bot-sdk@0.8.0-element.3",
        ],
        options: { cwd: extensionDir, timeout: 300000 },
      });
      expect(envOf(repair)).toMatchObject({
        CI: "1",
        HOME: serviceHome,
        NPM_CONFIG_CACHE: join(serviceHome, ".npm"),
      });
      expect(envOf(repair).PATH?.startsWith(join(prefix, "bin"))).toBe(true);
    });
  });

  it("repairs on a rerun that keeps the runtime as it is", async () => {
    await withUid(1001, async () => {
      const { bootstrapper, calls, runtimeDir } = await unprivilegedInstall();
      await bootstrapper.ensureInstalled(INSTALL);
      await writeFakeOpenClawPackage(resolveOpenClawRuntimePackageRoot(runtimeDir), {
        matrixExtension: true,
      });
      calls.length = 0;

      const info = await bootstrapper.ensureInstalled(INSTALL);

      expect(info.reinstalled).toBe(false);
      expect(callsTo(calls, "npm", "ci")).toHaveLength(0);
      expect(callsTo(calls, "npm", "install")).toHaveLength(1);
    });
  });

  it("fails when the dependency repair exits non-zero", async () => {
    await withUid(1001, async () => {
      const { bootstrapper } = await unprivilegedInstall({
        ciPackage: { matrixExtension: true },
        repairResult: {
          command: "npm install",
          exitCode: 1,
          stdout: "",
          stderr: "registry failure",
        },
      });

      await expect(bootstrapper.ensureInstalled(INSTALL)).rejects.toMatchObject({
        code: "OPENCLAW_INSTALL_FAILED",
        message: "Bundled OpenClaw matrix extension dependency repair failed",
        details: { exitCode: 1, stderr: "registry failure" },
      });
    });
  });

  it("fails when the repair succeeds but the dependencies are still missing", async () => {
    await withUid(1001, async () => {
      const { bootstrapper } = await unprivilegedInstall({
        ciPackage: { matrixExtension: true },
        repairResult: ok("npm install", "nothing"),
      });

      await expect(bootstrapper.ensureInstalled(INSTALL)).rejects.toMatchObject({
        code: "OPENCLAW_INSTALL_FAILED",
        message: "Bundled OpenClaw matrix extension dependencies are still missing after repair",
        details: {
          extension: "@openclaw/matrix",
          missingDependencies: [
            "@matrix-org/matrix-sdk-crypto-nodejs",
            "@vector-im/matrix-bot-sdk",
          ],
        },
      });
    });
  });

  it("skips the repair when the runtime ships no bundled matrix extension", async () => {
    await withUid(1001, async () => {
      const { bootstrapper, calls } = await unprivilegedInstall();

      await bootstrapper.ensureInstalled(INSTALL);

      expect(callsTo(calls, "npm", "install")).toHaveLength(0);
    });
  });
});

describe("openclaw detection after the locked install", () => {
  it("detects the CLI through the service prefix's bin dir, which the inherited PATH lacks", async () => {
    await withUid(1001, async () => {
      const { bootstrapper, calls, prefix } = await withEnv(
        { PATH: "/usr/local/bin:/usr/bin" },
        () => unprivilegedInstall(),
      );

      await withEnv({ PATH: "/usr/local/bin:/usr/bin" }, () =>
        bootstrapper.ensureInstalled(INSTALL),
      );

      for (const call of callsTo(calls, "openclaw")) {
        expect(envOf(call).PATH?.split(":")).toContain(join(prefix, "bin"));
      }
    });
  });

  it("warns but succeeds when the openclaw on the lookup PATH reports another version", async () => {
    await withUid(1001, async () => {
      const { bootstrapper } = await unprivilegedInstall({
        detect: async (_input, linkPath) =>
          existsSync(linkPath)
            ? ok("openclaw --version", "OpenClaw 2026.9.1")
            : { command: "openclaw --version", exitCode: 1, stdout: "", stderr: "" },
      });

      const info = await bootstrapper.ensureInstalled(INSTALL);

      expect(info).toMatchObject({ version: "2026.9.1", reinstalled: true });
    });
  });

  it("attaches the evidence when the CLI is still not found after the install", async () => {
    await withUid(1001, async () => {
      const { bootstrapper, prefix, runtimeDir } = await unprivilegedInstall({
        detect: async () => {
          throw new Error("spawn openclaw ENOENT");
        },
        commandLocation: async () => ({ command: "sh", exitCode: 1, stdout: "", stderr: "" }),
      });

      await expect(bootstrapper.ensureInstalled(INSTALL)).rejects.toMatchObject({
        code: "OPENCLAW_INSTALL_FAILED",
        message: "OpenClaw locked runtime install completed but the openclaw CLI was not detected",
        retryable: true,
        details: {
          runtimeDir,
          detectionOutcome: "spawn_failed",
          detectError: "spawn openclaw ENOENT",
          npmPrefix: prefix,
          commandLocation: null,
          resolvedBinary: null,
          installStdout: "added 333 packages",
          installStderr: "",
        },
      });
    });
  });

  it("reports a non-zero detect exit distinctly from a missing binary", async () => {
    await withUid(1001, async () => {
      const { bootstrapper, linkPath } = await unprivilegedInstall({
        detect: async () => ({
          command: "openclaw --version",
          exitCode: 3,
          stdout: "",
          stderr: "cannot load module",
        }),
      });

      await expect(bootstrapper.ensureInstalled(INSTALL)).rejects.toMatchObject({
        details: {
          detectionOutcome: "non_zero_exit",
          detectExitCode: 3,
          detectStderr: "cannot load module",
          commandLocation: linkPath(),
          resolvedBinary: { path: linkPath(), firstLine: "#!/usr/bin/env node" },
        },
      });
    });
  });

  // The exec runner reports a failed spawn as exit 127 with a spawn_failed
  // reason, never as a throw and never as exit 0; it must not be misfiled as
  // unparsable_version.
  it("classifies a non-throwing ENOENT spawn failure as spawn_failed", async () => {
    await withUid(1001, async () => {
      const { bootstrapper } = await unprivilegedInstall({
        detect: async () => ({
          command: "openclaw --version",
          exitCode: 127,
          stdout: "",
          stderr: "Command failed with ENOENT: openclaw --version",
          failureReason: "spawn_failed",
        }),
        commandLocation: async () => ({ command: "sh", exitCode: 127, stdout: "", stderr: "" }),
      });

      await expect(bootstrapper.ensureInstalled(INSTALL)).rejects.toMatchObject({
        details: {
          detectionOutcome: "spawn_failed",
          detectFailureReason: "spawn_failed",
          detectExitCode: 127,
          commandLocation: null,
          resolvedBinary: null,
        },
      });
    });
  });

  it("reports unparsable version output and describes the resolved binary", async () => {
    await withUid(1001, async () => {
      const binDir = await mkdtemp(join(tmpdir(), "openclaw-bin-"));
      const binaryPath = join(binDir, "openclaw");
      await writeFile(binaryPath, "#!/usr/bin/env node\nconsole.log('nothing useful');\n", "utf8");
      const { bootstrapper } = await unprivilegedInstall({
        detect: async () => ok("openclaw --version", "   "),
        commandLocation: async () => ok("sh", `${binaryPath}\n`),
      });

      await expect(bootstrapper.ensureInstalled(INSTALL)).rejects.toMatchObject({
        details: {
          detectionOutcome: "unparsable_version",
          resolvedBinary: { path: binaryPath, size: 51, firstLine: "#!/usr/bin/env node" },
        },
      });
    });
  });

  it("records the symlink target and reports an unreadable binary instead of throwing", async () => {
    await withUid(1001, async () => {
      let resolvedTo = "";
      const { bootstrapper, linkPath, runtimeDir } = await unprivilegedInstall({
        detect: async () => ok("openclaw --version", ""),
        commandLocation: async (link) => ok("sh", resolvedTo || link),
      });

      await expect(bootstrapper.ensureInstalled(INSTALL)).rejects.toMatchObject({
        details: {
          resolvedBinary: {
            path: linkPath(),
            symlinkTarget: join(resolveOpenClawRuntimePackageRoot(runtimeDir), "openclaw.mjs"),
            firstLine: "#!/usr/bin/env node",
          },
        },
      });

      resolvedTo = join(dirname(linkPath()), "gone");
      await expect(bootstrapper.ensureInstalled(INSTALL)).rejects.toMatchObject({
        details: {
          resolvedBinary: { path: resolvedTo, error: expect.stringContaining("ENOENT") },
        },
      });
      expect((await lstat(linkPath())).isSymbolicLink()).toBe(true);
    });
  });

  it("reports the location as unknown when `command -v` itself cannot run", async () => {
    await withUid(1001, async () => {
      const { bootstrapper } = await unprivilegedInstall({
        detect: async () => {
          throw "not an Error";
        },
        commandLocation: async () => {
          throw new Error("spawn sh ENOENT");
        },
      });

      await expect(bootstrapper.ensureInstalled(INSTALL)).rejects.toMatchObject({
        details: {
          detectionOutcome: "spawn_failed",
          detectError: "not an Error",
          commandLocation: null,
        },
      });
    });
  });

  it("treats a `command -v` that prints nothing as no location", async () => {
    await withUid(1001, async () => {
      const { bootstrapper } = await unprivilegedInstall({
        detect: async () => ok("openclaw --version", ""),
        commandLocation: async () => ok("sh", "  "),
      });

      await expect(bootstrapper.ensureInstalled(INSTALL)).rejects.toMatchObject({
        details: { commandLocation: null, resolvedBinary: null },
      });
    });
  });
});

describe("detectInstalled", () => {
  it("parses the version token out of the CLI banner", async () => {
    const world = createWorld(() => "/nonexistent", {
      detect: async () => ok("openclaw --version", `OpenClaw ${PIN} (61d171a)`),
    });
    const bootstrapper = new ShellOpenClawBootstrapper(world.runner, createLogger());

    expect(await bootstrapper.detectInstalled()).toEqual({ binaryPath: "openclaw", version: PIN });
  });

  it("returns null for empty output and for a missing binary", async () => {
    const empty = new ShellOpenClawBootstrapper(
      createWorld(() => "/nonexistent", { detect: async () => ok("openclaw --version", "") })
        .runner,
      createLogger(),
    );
    const missing = new ShellOpenClawBootstrapper(
      createWorld(() => "/nonexistent").runner,
      createLogger(),
    );

    expect(await empty.detectInstalled()).toBeNull();
    expect(await missing.detectInstalled()).toBeNull();
  });

  it("keeps the first token when the output carries no semver", async () => {
    const world = createWorld(() => "/nonexistent", {
      detect: async () => ok("openclaw --version", "nightly build"),
    });
    const bootstrapper = new ShellOpenClawBootstrapper(world.runner, createLogger());

    expect(await bootstrapper.detectInstalled()).toEqual({
      binaryPath: "openclaw",
      version: "nightly",
    });
  });
});

describe("deploy/install-request.example.json openclaw version", () => {
  it("resolves to the currently pinned OpenClaw version without drift", async () => {
    const example = JSON.parse(
      await readFile(join(REPO_ROOT, "deploy", "install-request.example.json"), "utf8"),
    ) as { openclaw?: { version?: string } };

    expect(example.openclaw?.version).toBeTruthy();
    expect(resolveRequestedOpenClawVersion(example.openclaw?.version)).toBe(PIN);
  });
});

describe("openclaw npm prefix and lookup PATH", () => {
  const SERVICE_HOME = "/var/lib/sovereign-node";
  const PREFIX_BIN = join(SERVICE_HOME, ".npm-global", "bin");
  const PARENT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin";

  it("resolves a writable prefix inside the service home when not root", async () => {
    await withUid(1001, async () => {
      expect(resolveOpenClawNpmPrefix(SERVICE_HOME)).toBe(join(SERVICE_HOME, ".npm-global"));
    });
  });

  it("leaves npm's default prefix alone when running as root", async () => {
    await withUid(0, async () => {
      expect(resolveOpenClawNpmPrefix(SERVICE_HOME)).toBeUndefined();
    });
  });

  it("falls back to $HOME, then to undefined, when no service home is given", async () => {
    await withUid(1001, async () => {
      await withEnv({ HOME: "/home/svc" }, async () => {
        expect(resolveOpenClawNpmPrefix("  ")).toBe("/home/svc/.npm-global");
      });
      await withEnv({ HOME: undefined }, async () => {
        expect(resolveOpenClawNpmPrefix(undefined)).toBeUndefined();
      });
    });
  });

  it("leaves the inherited PATH untouched for a root install", () => {
    expect(resolveOpenClawLookupPath(undefined, PARENT_PATH)).toBe(PARENT_PATH);
  });

  it("prepends the prefix bin dir exactly once", () => {
    const withPrefix = resolveOpenClawLookupPath(join(SERVICE_HOME, ".npm-global"), PARENT_PATH);
    expect(withPrefix).toBe(`${PREFIX_BIN}:${PARENT_PATH}`);
    expect(resolveOpenClawLookupPath(join(SERVICE_HOME, ".npm-global"), withPrefix)).toBe(
      withPrefix,
    );
  });

  it("falls back to the bare prefix bin dir when the base PATH is empty", () => {
    expect(resolveOpenClawLookupPath(join(SERVICE_HOME, ".npm-global"), "")).toBe(PREFIX_BIN);
  });

  it("defaults the base PATH to the current process PATH", () => {
    const resolved = resolveOpenClawLookupPath(join(SERVICE_HOME, ".npm-global"));
    expect(resolved?.startsWith(`${PREFIX_BIN}:`)).toBe(true);
    expect(resolved?.endsWith(process.env.PATH ?? "")).toBe(true);
  });

  describe("resolveOpenClawSpawnLookupPath", () => {
    it("returns undefined as root so the spawn just inherits the ambient PATH", async () => {
      await withUid(0, async () => {
        expect(resolveOpenClawSpawnLookupPath(SERVICE_HOME)).toBeUndefined();
      });
    });

    it("prepends the service npm prefix bin dir when unprivileged", async () => {
      await withUid(1000, async () => {
        expect(resolveOpenClawSpawnLookupPath(SERVICE_HOME)?.startsWith(`${PREFIX_BIN}:`)).toBe(
          true,
        );
      });
    });

    it("returns undefined when the prefix bin dir is already on PATH", async () => {
      await withEnv({ PATH: `${PREFIX_BIN}:/usr/bin` }, () =>
        withUid(1000, async () => {
          expect(resolveOpenClawSpawnLookupPath(SERVICE_HOME)).toBeUndefined();
        }),
      );
    });
  });
});

/**
 * A child inherits the parent's cwd and the kernel resolves it for the
 * child's credentials. Root traverses a 0700 directory regardless; the same
 * step re-entered unprivileged (cwd /root) is refused before the binary is
 * consulted, so every unprivileged spawn must name a traversable cwd.
 */
describe("openclaw spawn cwd across install and reconfigure contexts", () => {
  const SERVICE_HOME = "/var/lib/sovereign-node";

  it("pins a traversable cwd for an unprivileged service user", async () => {
    await withUid(1001, async () => {
      expect(resolveOpenClawSpawnCwd(SERVICE_HOME)).toBe(SERVICE_HOME);
    });
  });

  it("leaves the inherited cwd alone when running as root", async () => {
    await withUid(0, async () => {
      expect(resolveOpenClawSpawnCwd(SERVICE_HOME)).toBeUndefined();
    });
  });

  it("falls back to a world-traversable cwd when no home is known", async () => {
    await withUid(1001, () =>
      withEnv({ HOME: undefined }, async () => {
        expect(resolveOpenClawSpawnCwd(undefined)).toBe("/");
        expect(resolveOpenClawSpawnCwd("   ")).toBe("/");
      }),
    );
  });

  it("prefers $HOME over the bare root fallback when no service home is given", async () => {
    await withUid(1001, () =>
      withEnv({ HOME: SERVICE_HOME }, async () => {
        expect(resolveOpenClawSpawnCwd(undefined)).toBe(SERVICE_HOME);
      }),
    );
  });

  it("names a cwd on every spawn of an unprivileged install", async () => {
    await withUid(1001, async () => {
      const { bootstrapper, calls, serviceHome, runtimeDir } = await unprivilegedInstall({
        ciPackage: { matrixExtension: true },
      });

      await bootstrapper.ensureInstalled(INSTALL);

      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.options?.cwd, `${call.command} inherited its cwd`).toBeDefined();
      }
      expect(callsTo(calls, "openclaw")[0]?.options?.cwd).toBe(serviceHome);
      expect(callsTo(calls, "npm", "ci")[0]?.options?.cwd).toBe(`${runtimeDir}.staging`);
    });
  });

  it("treats a failed spawn as non-retryable and everything else as retryable", () => {
    expect(isRetryableExecFailure("spawn_failed")).toBe(false);
    expect(isRetryableExecFailure("timed_out")).toBe(true);
    expect(isRetryableExecFailure("signal")).toBe(true);
    expect(isRetryableExecFailure(undefined)).toBe(true);
  });
});
