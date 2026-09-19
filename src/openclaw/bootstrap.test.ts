import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createLogger } from "../logging/logger.js";
import type { ExecInput, ExecResult, ExecRunner } from "../system/exec.js";
import {
  isRetryableExecFailure,
  resolveOpenClawLookupPath,
  resolveOpenClawNpmPrefix,
  resolveOpenClawSpawnCwd,
  resolveOpenClawSpawnLookupPath,
  resolveRequestedOpenClawVersion,
  ShellOpenClawBootstrapper,
  SOVEREIGN_PINNED_OPENCLAW_VERSION,
  SOVEREIGN_PINNED_OPENCLAW_VERSION_ALIAS,
} from "./bootstrap.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const writeBundledMatrixExtensionPackage = async (globalRoot: string): Promise<string> => {
  const openclawRoot = join(globalRoot, "openclaw");
  const extensionDir = join(openclawRoot, "extensions", "matrix");
  await mkdir(extensionDir, { recursive: true });
  await writeFile(join(openclawRoot, "package.json"), '{ "name": "openclaw" }\n', "utf8");
  await writeFile(
    join(extensionDir, "package.json"),
    JSON.stringify(
      {
        name: "@openclaw/matrix",
        dependencies: {
          "@matrix-org/matrix-sdk-crypto-nodejs": "^0.4.0",
          "@vector-im/matrix-bot-sdk": "0.8.0-element.3",
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  return extensionDir;
};

const writeInstalledPackage = async (extensionDir: string, name: string): Promise<void> => {
  const packageDir = join(extensionDir, "node_modules", ...name.split("/"));
  await mkdir(packageDir, { recursive: true });
  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify(
      {
        name,
        main: "index.js",
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(join(packageDir, "index.js"), "module.exports = {};\n", "utf8");
};

describe("ShellOpenClawBootstrapper", () => {
  it("hardens bundled extension directories so OpenClaw does not reject them as world-writable", async () => {
    const globalRoot = await mkdtemp(join(tmpdir(), "openclaw-bootstrap-"));
    const extensionDir = await writeBundledMatrixExtensionPackage(globalRoot);
    const extensionsRoot = join(globalRoot, "openclaw", "extensions");
    const memoryCoreDir = join(extensionsRoot, "memory-core");
    const memoryCoreIndexPath = join(memoryCoreDir, "index.ts");
    await writeInstalledPackage(extensionDir, "@matrix-org/matrix-sdk-crypto-nodejs");
    await writeInstalledPackage(extensionDir, "@vector-im/matrix-bot-sdk");
    await mkdir(memoryCoreDir, { recursive: true });
    await writeFile(memoryCoreIndexPath, "export {};\n", "utf8");
    await chmod(extensionsRoot, 0o777);
    await chmod(extensionDir, 0o777);
    await chmod(memoryCoreDir, 0o777);
    await chmod(memoryCoreIndexPath, 0o666);

    const execRunner: ExecRunner = {
      run: async (input): Promise<ExecResult> => {
        if (input.command === "npm" && input.args?.[0] === "root") {
          return {
            command: [input.command, ...(input.args ?? [])].join(" "),
            exitCode: 0,
            stdout: globalRoot,
            stderr: "",
          };
        }
        return {
          command: [input.command, ...(input.args ?? [])].join(" "),
          exitCode: 0,
          stdout: SOVEREIGN_PINNED_OPENCLAW_VERSION,
          stderr: "",
        };
      },
    };

    const bootstrapper = new ShellOpenClawBootstrapper(execRunner, createLogger());
    await bootstrapper.ensureInstalled({
      version: SOVEREIGN_PINNED_OPENCLAW_VERSION_ALIAS,
      noOnboard: true,
      noPrompt: true,
      skipIfCompatibleInstalled: true,
    });

    expect((await stat(extensionsRoot)).mode & 0o022).toBe(0);
    expect((await stat(extensionDir)).mode & 0o022).toBe(0);
    expect((await stat(memoryCoreDir)).mode & 0o022).toBe(0);
    expect((await stat(memoryCoreIndexPath)).mode & 0o022).toBe(0);
  });

  it("opens up the OpenClaw package tree so the unprivileged service user can read it", async () => {
    // Reproduces the Raspberry Pi OS Bookworm scenario where the third-party
    // openclaw install.sh ran under a restrictive umask (0o077), leaving the
    // package tree at 0o700 root:root with 0o600 files. Node then hits
    // MODULE_NOT_FOUND when the service user tries to import any sibling.
    const globalRoot = await mkdtemp(join(tmpdir(), "openclaw-bootstrap-"));
    const openclawRoot = join(globalRoot, "openclaw");
    const distDir = join(openclawRoot, "dist");
    const distFile = join(distDir, "openclaw.js");
    const binFile = join(openclawRoot, "openclaw.mjs");
    const extensionsRoot = join(openclawRoot, "extensions");
    await mkdir(distDir, { recursive: true });
    await mkdir(extensionsRoot, { recursive: true });
    await writeFile(join(openclawRoot, "package.json"), '{ "name": "openclaw" }\n', "utf8");
    await writeFile(distFile, "export {};\n", "utf8");
    await writeFile(binFile, "#!/usr/bin/env node\n", "utf8");

    // Simulate the broken-umask install: 0o700 dirs, 0o600 files, executable
    // entrypoint at 0o700.
    await chmod(openclawRoot, 0o700);
    await chmod(distDir, 0o700);
    await chmod(extensionsRoot, 0o700);
    await chmod(distFile, 0o600);
    await chmod(binFile, 0o700);

    const execRunner: ExecRunner = {
      run: async (input): Promise<ExecResult> => {
        if (input.command === "npm" && input.args?.[0] === "root") {
          return {
            command: [input.command, ...(input.args ?? [])].join(" "),
            exitCode: 0,
            stdout: globalRoot,
            stderr: "",
          };
        }
        return {
          command: [input.command, ...(input.args ?? [])].join(" "),
          exitCode: 0,
          stdout: SOVEREIGN_PINNED_OPENCLAW_VERSION,
          stderr: "",
        };
      },
    };

    const bootstrapper = new ShellOpenClawBootstrapper(execRunner, createLogger());
    await bootstrapper.ensureInstalled({
      version: SOVEREIGN_PINNED_OPENCLAW_VERSION_ALIAS,
      noOnboard: true,
      noPrompt: true,
      skipIfCompatibleInstalled: true,
    });

    // Directories must be traversable by everyone.
    expect((await stat(openclawRoot)).mode & 0o005).toBe(0o005);
    expect((await stat(distDir)).mode & 0o005).toBe(0o005);
    // Plain files must be readable by everyone.
    expect((await stat(distFile)).mode & 0o004).toBe(0o004);
    // Executable files keep their executable bit AND become world-readable.
    const binMode = (await stat(binFile)).mode & 0o777;
    expect(binMode & 0o004).toBe(0o004);
    expect(binMode & 0o001).toBe(0o001);
  });

  it("resolves pinned-by-sovereign to the concrete pinned version during install", async () => {
    const globalRoot = await mkdtemp(join(tmpdir(), "openclaw-bootstrap-"));
    const extensionDir = await writeBundledMatrixExtensionPackage(globalRoot);
    const calls: ExecInput[] = [];
    const results: ExecResult[] = [
      {
        command: "openclaw --version",
        exitCode: 1,
        stdout: "",
        stderr: "not installed",
      },
      {
        command: "bash -lc <install>",
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      },
      {
        command: "openclaw --version",
        exitCode: 0,
        stdout: SOVEREIGN_PINNED_OPENCLAW_VERSION,
        stderr: "",
      },
      {
        command: "npm root -g",
        exitCode: 0,
        stdout: globalRoot,
        stderr: "",
      },
    ];

    const execRunner: ExecRunner = {
      run: async (input): Promise<ExecResult> => {
        calls.push(input);
        if (input.command === "npm" && input.args?.[0] === "install") {
          await writeInstalledPackage(extensionDir, "@matrix-org/matrix-sdk-crypto-nodejs");
          await writeInstalledPackage(extensionDir, "@vector-im/matrix-bot-sdk");
          return {
            command: [input.command, ...(input.args ?? [])].join(" "),
            exitCode: 0,
            stdout: "repaired",
            stderr: "",
          };
        }
        const next = results.shift();
        if (next === undefined) {
          throw new Error("unexpected exec call");
        }
        return next;
      },
    };

    const bootstrapper = new ShellOpenClawBootstrapper(execRunner, createLogger());
    const result = await bootstrapper.ensureInstalled({
      version: SOVEREIGN_PINNED_OPENCLAW_VERSION_ALIAS,
      noOnboard: true,
      noPrompt: true,
      skipIfCompatibleInstalled: true,
    });

    expect(result.version).toBe(SOVEREIGN_PINNED_OPENCLAW_VERSION);
    expect(calls[1]?.command).toBe("bash");
    expect(calls[1]?.args?.[1]).toContain("install.sh");
    expect(calls[1]?.args?.[1]).toContain(`'${SOVEREIGN_PINNED_OPENCLAW_VERSION}'`);
    expect(calls[1]?.args?.[1]).toContain("NPM_CONFIG_CACHE");
    expect(calls[3]).toMatchObject({
      command: "npm",
      args: ["root", "-g"],
    });
    expect(calls[4]).toMatchObject({
      command: "npm",
      args: [
        "install",
        "--omit=dev",
        "--no-package-lock",
        "--no-save",
        "@matrix-org/matrix-sdk-crypto-nodejs@^0.4.0",
        "@vector-im/matrix-bot-sdk@0.8.0-element.3",
      ],
      options: {
        cwd: extensionDir,
        timeout: 300000,
        env: {
          CI: "1",
        },
      },
    });
  });

  it("skips reinstall when installed OpenClaw already matches the concrete Sovereign pin", async () => {
    const globalRoot = await mkdtemp(join(tmpdir(), "openclaw-bootstrap-"));
    const extensionDir = await writeBundledMatrixExtensionPackage(globalRoot);
    await writeInstalledPackage(extensionDir, "@matrix-org/matrix-sdk-crypto-nodejs");
    await writeInstalledPackage(extensionDir, "@vector-im/matrix-bot-sdk");
    const calls: ExecInput[] = [];
    const execRunner: ExecRunner = {
      run: async (input): Promise<ExecResult> => {
        calls.push(input);
        if (input.command === "npm" && input.args?.[0] === "root") {
          return {
            command: [input.command, ...(input.args ?? [])].join(" "),
            exitCode: 0,
            stdout: globalRoot,
            stderr: "",
          };
        }
        return {
          command: [input.command, ...(input.args ?? [])].join(" "),
          exitCode: 0,
          stdout: SOVEREIGN_PINNED_OPENCLAW_VERSION,
          stderr: "",
        };
      },
    };

    const bootstrapper = new ShellOpenClawBootstrapper(execRunner, createLogger());
    const result = await bootstrapper.ensureInstalled({
      version: SOVEREIGN_PINNED_OPENCLAW_VERSION_ALIAS,
      noOnboard: true,
      noPrompt: true,
      skipIfCompatibleInstalled: true,
    });

    expect(result.version).toBe(SOVEREIGN_PINNED_OPENCLAW_VERSION);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      command: "openclaw",
      args: ["--version"],
      options: {
        timeout: 20000,
        env: {
          CI: "1",
        },
      },
    });
    expect(calls[1]).toMatchObject({
      command: "npm",
      args: ["root", "-g"],
    });
  });

  it("reinstalls when the detected OpenClaw version does not match the concrete Sovereign pin", async () => {
    const globalRoot = await mkdtemp(join(tmpdir(), "openclaw-bootstrap-"));
    const extensionDir = await writeBundledMatrixExtensionPackage(globalRoot);
    const calls: ExecInput[] = [];
    const results: ExecResult[] = [
      {
        command: "openclaw --version",
        exitCode: 0,
        stdout: "2026.3.2",
        stderr: "",
      },
      {
        command: "bash -lc <install>",
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      },
      {
        command: "openclaw --version",
        exitCode: 0,
        stdout: SOVEREIGN_PINNED_OPENCLAW_VERSION,
        stderr: "",
      },
      {
        command: "npm root -g",
        exitCode: 0,
        stdout: globalRoot,
        stderr: "",
      },
    ];

    const execRunner: ExecRunner = {
      run: async (input): Promise<ExecResult> => {
        calls.push(input);
        if (input.command === "npm" && input.args?.[0] === "install") {
          await writeInstalledPackage(extensionDir, "@matrix-org/matrix-sdk-crypto-nodejs");
          await writeInstalledPackage(extensionDir, "@vector-im/matrix-bot-sdk");
          return {
            command: [input.command, ...(input.args ?? [])].join(" "),
            exitCode: 0,
            stdout: "repaired",
            stderr: "",
          };
        }
        const next = results.shift();
        if (next === undefined) {
          throw new Error("unexpected exec call");
        }
        return next;
      },
    };

    const bootstrapper = new ShellOpenClawBootstrapper(execRunner, createLogger());
    const result = await bootstrapper.ensureInstalled({
      version: SOVEREIGN_PINNED_OPENCLAW_VERSION_ALIAS,
      noOnboard: true,
      noPrompt: true,
      skipIfCompatibleInstalled: true,
    });

    expect(result.version).toBe(SOVEREIGN_PINNED_OPENCLAW_VERSION);
    expect(calls).toHaveLength(5);
    expect(calls[1]?.args?.[1]).toContain(`'${SOVEREIGN_PINNED_OPENCLAW_VERSION}'`);
  });

  it("falls back to direct npm install when install.sh fails", async () => {
    const globalRoot = await mkdtemp(join(tmpdir(), "openclaw-bootstrap-"));
    const extensionDir = await writeBundledMatrixExtensionPackage(globalRoot);
    const calls: ExecInput[] = [];
    const results: ExecResult[] = [
      {
        command: "openclaw --version",
        exitCode: 1,
        stdout: "",
        stderr: "not installed",
      },
      {
        command: "bash -lc <install>",
        exitCode: 1,
        stdout: "failed",
        stderr: "boom",
      },
      {
        command: "openclaw --version",
        exitCode: 0,
        stdout: SOVEREIGN_PINNED_OPENCLAW_VERSION,
        stderr: "",
      },
      {
        command: "npm root -g",
        exitCode: 0,
        stdout: globalRoot,
        stderr: "",
      },
    ];

    const execRunner: ExecRunner = {
      run: async (input): Promise<ExecResult> => {
        calls.push(input);
        if (input.command === "npm" && input.args?.[0] === "install" && input.args?.[1] === "-g") {
          if (String(input.args?.[2]).startsWith("openclaw@")) {
            await writeInstalledPackage(extensionDir, "@matrix-org/matrix-sdk-crypto-nodejs");
            await writeInstalledPackage(extensionDir, "@vector-im/matrix-bot-sdk");
            return {
              command: [input.command, ...(input.args ?? [])].join(" "),
              exitCode: 0,
              stdout: "installed",
              stderr: "",
            };
          }
        }
        if (input.command === "npm" && input.args?.[0] === "install") {
          await writeInstalledPackage(extensionDir, "@matrix-org/matrix-sdk-crypto-nodejs");
          await writeInstalledPackage(extensionDir, "@vector-im/matrix-bot-sdk");
          return {
            command: [input.command, ...(input.args ?? [])].join(" "),
            exitCode: 0,
            stdout: "repaired",
            stderr: "",
          };
        }
        const next = results.shift();
        if (next === undefined) {
          throw new Error("unexpected exec call");
        }
        return next;
      },
    };

    const bootstrapper = new ShellOpenClawBootstrapper(execRunner, createLogger());
    const result = await bootstrapper.ensureInstalled({
      version: SOVEREIGN_PINNED_OPENCLAW_VERSION_ALIAS,
      noOnboard: true,
      noPrompt: true,
      skipIfCompatibleInstalled: true,
    });

    expect(result.version).toBe(SOVEREIGN_PINNED_OPENCLAW_VERSION);
    expect(result.installMethod).toBe("npm_fallback");
    expect(calls[2]).toMatchObject({
      command: "npm",
      args: ["install", "-g", `openclaw@${SOVEREIGN_PINNED_OPENCLAW_VERSION}`],
    });
  });

  it("repairs missing bundled matrix extension dependencies when a compatible install already exists", async () => {
    const globalRoot = await mkdtemp(join(tmpdir(), "openclaw-bootstrap-"));
    const extensionDir = await writeBundledMatrixExtensionPackage(globalRoot);
    const calls: ExecInput[] = [];

    const execRunner: ExecRunner = {
      run: async (input): Promise<ExecResult> => {
        calls.push(input);
        if (input.command === "openclaw") {
          return {
            command: "openclaw --version",
            exitCode: 0,
            stdout: SOVEREIGN_PINNED_OPENCLAW_VERSION,
            stderr: "",
          };
        }
        if (input.command === "npm" && input.args?.[0] === "root") {
          return {
            command: "npm root -g",
            exitCode: 0,
            stdout: globalRoot,
            stderr: "",
          };
        }
        if (input.command === "npm" && input.args?.[0] === "install") {
          await writeInstalledPackage(extensionDir, "@matrix-org/matrix-sdk-crypto-nodejs");
          await writeInstalledPackage(extensionDir, "@vector-im/matrix-bot-sdk");
          return {
            command: [input.command, ...(input.args ?? [])].join(" "),
            exitCode: 0,
            stdout: "repaired",
            stderr: "",
          };
        }
        throw new Error(`unexpected exec call: ${input.command}`);
      },
    };

    const bootstrapper = new ShellOpenClawBootstrapper(execRunner, createLogger());
    const result = await bootstrapper.ensureInstalled({
      version: SOVEREIGN_PINNED_OPENCLAW_VERSION_ALIAS,
      noOnboard: true,
      noPrompt: true,
      skipIfCompatibleInstalled: true,
    });

    expect(result.version).toBe(SOVEREIGN_PINNED_OPENCLAW_VERSION);
    expect(calls).toHaveLength(3);
    expect(calls[2]).toMatchObject({
      command: "npm",
      args: [
        "install",
        "--omit=dev",
        "--no-package-lock",
        "--no-save",
        "@matrix-org/matrix-sdk-crypto-nodejs@^0.4.0",
        "@vector-im/matrix-bot-sdk@0.8.0-element.3",
      ],
      options: {
        cwd: extensionDir,
      },
    });
  });

  it("fails early when bundled matrix dependency repair exits non-zero", async () => {
    const globalRoot = await mkdtemp(join(tmpdir(), "openclaw-bootstrap-"));
    await writeBundledMatrixExtensionPackage(globalRoot);
    const calls: ExecInput[] = [];

    const execRunner: ExecRunner = {
      run: async (input): Promise<ExecResult> => {
        calls.push(input);
        if (input.command === "openclaw") {
          return {
            command: "openclaw --version",
            exitCode: 0,
            stdout: SOVEREIGN_PINNED_OPENCLAW_VERSION,
            stderr: "",
          };
        }
        if (input.command === "npm" && input.args?.[0] === "root") {
          return {
            command: "npm root -g",
            exitCode: 0,
            stdout: globalRoot,
            stderr: "",
          };
        }
        if (input.command === "npm" && input.args?.[0] === "install") {
          return {
            command: [input.command, ...(input.args ?? [])].join(" "),
            exitCode: 1,
            stdout: "",
            stderr: "registry failure",
          };
        }
        throw new Error(`unexpected exec call: ${input.command}`);
      },
    };

    const bootstrapper = new ShellOpenClawBootstrapper(execRunner, createLogger());
    await expect(
      bootstrapper.ensureInstalled({
        version: SOVEREIGN_PINNED_OPENCLAW_VERSION_ALIAS,
        noOnboard: true,
        noPrompt: true,
        skipIfCompatibleInstalled: true,
      }),
    ).rejects.toMatchObject({
      code: "OPENCLAW_INSTALL_FAILED",
      message: "Bundled OpenClaw matrix extension dependency repair failed",
    });
    expect(calls).toHaveLength(3);
  });

  it("does not treat empty --version output as installed", async () => {
    const calls: ExecInput[] = [];
    const execRunner: ExecRunner = {
      run: async (input): Promise<ExecResult> => {
        calls.push(input);
        if (input.command === "openclaw") {
          return {
            command: "openclaw --version",
            exitCode: 0,
            stdout: "",
            stderr: "",
          };
        }
        return {
          command: [input.command, ...(input.args ?? [])].join(" "),
          exitCode: 0,
          stdout: "ok",
          stderr: "",
        };
      },
    };

    const bootstrapper = new ShellOpenClawBootstrapper(execRunner, createLogger());
    await expect(
      bootstrapper.ensureInstalled({
        version: SOVEREIGN_PINNED_OPENCLAW_VERSION_ALIAS,
        noOnboard: true,
        noPrompt: true,
        skipIfCompatibleInstalled: true,
      }),
    ).rejects.toMatchObject({
      code: "OPENCLAW_INSTALL_FAILED",
    });
    expect(calls.some((call) => call.command === "bash")).toBe(true);
  });

  it("treats missing openclaw binary during detection as not installed", async () => {
    const calls: ExecInput[] = [];
    const execRunner: ExecRunner = {
      run: async (input): Promise<ExecResult> => {
        calls.push(input);
        if (input.command === "openclaw") {
          throw new Error("spawn openclaw ENOENT");
        }
        return {
          command: [input.command, ...(input.args ?? [])].join(" "),
          exitCode: 0,
          stdout: "ok",
          stderr: "",
        };
      },
    };

    const bootstrapper = new ShellOpenClawBootstrapper(execRunner, createLogger());
    await expect(
      bootstrapper.ensureInstalled({
        version: SOVEREIGN_PINNED_OPENCLAW_VERSION_ALIAS,
        noOnboard: true,
        noPrompt: true,
        skipIfCompatibleInstalled: true,
      }),
    ).rejects.toMatchObject({
      code: "OPENCLAW_INSTALL_FAILED",
    });
    expect(calls.some((call) => call.command === "bash")).toBe(true);
  });
});

// Regression coverage for the EACCES install failure: the API service runs
// unprivileged (deploy/systemd/sovereign-node-api.service, User=__SERVICE_USER__),
// so an OpenClaw `npm install -g` that leaves npm's default prefix alone targets
// the root-owned /usr/lib/node_modules and fails with
// "EACCES: permission denied, mkdir '/usr/lib/node_modules/openclaw'".
describe("openclaw install prefix under an unprivileged service user", () => {
  const withUid = async (uid: number, action: () => Promise<void>): Promise<void> => {
    const original = process.getuid;
    Object.defineProperty(process, "getuid", {
      value: () => uid,
      configurable: true,
    });
    try {
      await action();
    } finally {
      Object.defineProperty(process, "getuid", {
        value: original,
        configurable: true,
      });
    }
  };

  const runInstall = async (serviceHome?: string): Promise<ExecInput[]> => {
    const calls: ExecInput[] = [];
    const execRunner: ExecRunner = {
      run: async (input): Promise<ExecResult> => {
        calls.push(input);
        if (input.command === "openclaw") {
          // Not installed on the first probe; installed after the install step.
          const installed = calls.some(
            (call) => call.command === "bash" || call.args?.[0] === "install",
          );
          return {
            command: "openclaw --version",
            exitCode: installed ? 0 : 1,
            stdout: installed ? SOVEREIGN_PINNED_OPENCLAW_VERSION : "",
            stderr: "",
          };
        }
        return {
          command: [input.command, ...(input.args ?? [])].join(" "),
          exitCode: 0,
          stdout: "",
          stderr: "",
        };
      },
    };

    const bootstrapper = new ShellOpenClawBootstrapper(
      execRunner,
      createLogger(),
      ...(serviceHome === undefined ? [] : [serviceHome]),
    );
    await bootstrapper.ensureInstalled({
      version: SOVEREIGN_PINNED_OPENCLAW_VERSION_ALIAS,
      noOnboard: true,
      noPrompt: true,
      skipIfCompatibleInstalled: true,
    });
    return calls;
  };

  it("resolves a writable prefix inside the service home when not root", () => {
    const original = process.getuid;
    Object.defineProperty(process, "getuid", { value: () => 1001, configurable: true });
    try {
      expect(resolveOpenClawNpmPrefix("/var/lib/sovereign-node")).toBe(
        "/var/lib/sovereign-node/.npm-global",
      );
    } finally {
      Object.defineProperty(process, "getuid", { value: original, configurable: true });
    }
  });

  it("leaves npm's default prefix alone when running as root", () => {
    const original = process.getuid;
    Object.defineProperty(process, "getuid", { value: () => 0, configurable: true });
    try {
      expect(resolveOpenClawNpmPrefix("/var/lib/sovereign-node")).toBeUndefined();
    } finally {
      Object.defineProperty(process, "getuid", { value: original, configurable: true });
    }
  });

  it("falls back to undefined when no home can be resolved", () => {
    const originalUid = process.getuid;
    const originalHome = process.env.HOME;
    Object.defineProperty(process, "getuid", { value: () => 1001, configurable: true });
    delete process.env.HOME;
    try {
      expect(resolveOpenClawNpmPrefix(undefined)).toBeUndefined();
      expect(resolveOpenClawNpmPrefix("   ")).toBeUndefined();
    } finally {
      Object.defineProperty(process, "getuid", { value: originalUid, configurable: true });
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  it("never targets the root-owned system prefix from an unprivileged install", async () => {
    await withUid(1001, async () => {
      const calls = await runInstall("/var/lib/sovereign-node");
      const expectedPrefix = "/var/lib/sovereign-node/.npm-global";

      // install.sh path: the generated script must pin the prefix before it
      // pipes into the upstream installer, which shells out to `npm install -g`.
      const bashCall = calls.find((call) => call.command === "bash");
      expect(bashCall?.args?.[1]).toContain(`export npm_config_prefix='${expectedPrefix}'`);

      // `npm root -g` must resolve against the same prefix, or the post-install
      // extension repair silently inspects the wrong tree.
      const rootCall = calls.find((call) => call.command === "npm" && call.args?.[0] === "root");
      expect(
        (rootCall?.options?.env as Record<string, string> | undefined)?.npm_config_prefix,
      ).toBe(expectedPrefix);
    });
  });

  it("pins the direct npm fallback to the writable prefix when unprivileged", async () => {
    await withUid(1001, async () => {
      const calls: ExecInput[] = [];
      const execRunner: ExecRunner = {
        run: async (input): Promise<ExecResult> => {
          calls.push(input);
          if (input.command === "openclaw") {
            const installed = calls.some(
              (call) => call.command === "npm" && call.args?.[0] === "install",
            );
            return {
              command: "openclaw --version",
              exitCode: installed ? 0 : 1,
              stdout: installed ? SOVEREIGN_PINNED_OPENCLAW_VERSION : "",
              stderr: "",
            };
          }
          if (input.command === "bash") {
            // Force the direct-npm fallback path.
            return { command: "bash", exitCode: 1, stdout: "", stderr: "install.sh failed" };
          }
          return {
            command: [input.command, ...(input.args ?? [])].join(" "),
            exitCode: 0,
            stdout: "",
            stderr: "",
          };
        },
      };

      const bootstrapper = new ShellOpenClawBootstrapper(
        execRunner,
        createLogger(),
        "/var/lib/sovereign-node",
      );
      await bootstrapper.ensureInstalled({
        version: SOVEREIGN_PINNED_OPENCLAW_VERSION_ALIAS,
        noOnboard: true,
        noPrompt: true,
        skipIfCompatibleInstalled: true,
      });

      const installCall = calls.find(
        (call) => call.command === "npm" && call.args?.[0] === "install" && call.args?.[1] === "-g",
      );
      expect(
        (installCall?.options?.env as Record<string, string> | undefined)?.npm_config_prefix,
      ).toBe("/var/lib/sovereign-node/.npm-global");
    });
  });

  it("keeps the root install on npm's default prefix", async () => {
    await withUid(0, async () => {
      const calls = await runInstall("/var/lib/sovereign-node");
      const bashCall = calls.find((call) => call.command === "bash");
      expect(bashCall?.args?.[1]).not.toContain("npm_config_prefix");
    });
  });
});

describe("deploy/install-request.example.json openclaw version", () => {
  it("resolves to the currently pinned OpenClaw version without drift", async () => {
    const examplePath = join(REPO_ROOT, "deploy", "install-request.example.json");
    const example = JSON.parse(await readFile(examplePath, "utf8")) as {
      openclaw?: { version?: string };
    };

    const requestedVersion = example.openclaw?.version;
    expect(requestedVersion).toBeTruthy();
    expect(resolveRequestedOpenClawVersion(requestedVersion)).toBe(
      SOVEREIGN_PINNED_OPENCLAW_VERSION,
    );
  });
});

// Regression coverage for the release-blocking detection failure: the upstream
// install.sh publishes the `openclaw` bin link inside the npm prefix
// (`<serviceHome>/.npm-global/bin/openclaw`, verified on a dev VM), but the
// `export PATH=...` that makes it resolvable lives only inside the
// `bash -lc` install subshell. A detection that inherits just the parent PATH
// gets ENOENT, so install.sh exits 0 and the CLI is still "not detected".
describe("openclaw detection resolves the npm prefix the install targeted", () => {
  const withUid = async (uid: number, action: () => Promise<void>): Promise<void> => {
    const original = process.getuid;
    Object.defineProperty(process, "getuid", {
      configurable: true,
      value: () => uid,
    });
    try {
      await action();
    } finally {
      Object.defineProperty(process, "getuid", {
        configurable: true,
        value: original,
      });
    }
  };

  const SERVICE_HOME = "/var/lib/sovereign-node";
  const PREFIX_BIN = join(SERVICE_HOME, ".npm-global", "bin");
  // A PATH that does NOT contain the prefix bin dir, mirroring the systemd
  // default the installer process actually inherits.
  const PARENT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin";

  /**
   * An exec runner where `openclaw` exists ONLY under the prefix bin dir:
   * it resolves when PATH contains PREFIX_BIN and throws ENOENT otherwise,
   * exactly like the real filesystem after a successful install.
   */
  const createPrefixOnlyRunner = (calls: ExecInput[]): ExecRunner => ({
    run: async (input): Promise<ExecResult> => {
      calls.push(input);
      const env = (input.options?.env ?? {}) as Record<string, string>;
      const effectivePath = env.PATH ?? PARENT_PATH;
      const resolvable = effectivePath.split(":").includes(PREFIX_BIN);
      if (input.command === "openclaw") {
        if (!resolvable) {
          throw new Error("spawn openclaw ENOENT");
        }
        return {
          command: "openclaw --version",
          exitCode: 0,
          stdout: `OpenClaw ${SOVEREIGN_PINNED_OPENCLAW_VERSION} (61d171a)`,
          stderr: "",
        };
      }
      if (input.command === "sh") {
        return {
          command: "sh -c command -v openclaw",
          exitCode: resolvable ? 0 : 1,
          stdout: resolvable ? join(PREFIX_BIN, "openclaw") : "",
          stderr: "",
        };
      }
      if (input.command === "npm" && input.args?.[0] === "root") {
        return {
          command: "npm root -g",
          exitCode: 0,
          stdout: join(SERVICE_HOME, ".npm-global", "lib", "node_modules"),
          stderr: "",
        };
      }
      // install.sh itself succeeds — this is the exit-0 branch.
      return {
        command: [input.command, ...(input.args ?? [])].join(" "),
        exitCode: 0,
        stdout: "OpenClaw installed successfully",
        stderr: "",
      };
    },
  });

  it("detects the CLI that install.sh published into the service npm prefix", async () => {
    await withUid(1001, async () => {
      const calls: ExecInput[] = [];
      const bootstrapper = new ShellOpenClawBootstrapper(
        createPrefixOnlyRunner(calls),
        createLogger(),
        SERVICE_HOME,
      );

      const info = await bootstrapper.ensureInstalled({
        version: SOVEREIGN_PINNED_OPENCLAW_VERSION_ALIAS,
        noOnboard: true,
        noPrompt: true,
        forceReinstall: true,
      });

      expect(info.version).toBe(SOVEREIGN_PINNED_OPENCLAW_VERSION);
      expect(info.installMethod).toBe("install_sh");

      const detectCall = calls.find((call) => call.command === "openclaw");
      const detectPath = (detectCall?.options?.env as Record<string, string> | undefined)?.PATH;
      expect(detectPath?.split(":")).toContain(PREFIX_BIN);
    });
  });

  it("attaches the failure evidence when detection still cannot find the CLI", async () => {
    await withUid(1001, async () => {
      const execRunner: ExecRunner = {
        run: async (input): Promise<ExecResult> => {
          if (input.command === "openclaw") {
            throw new Error("spawn openclaw ENOENT");
          }
          if (input.command === "sh") {
            return {
              command: "sh -c command -v openclaw",
              exitCode: 1,
              stdout: "",
              stderr: "",
            };
          }
          return {
            command: [input.command, ...(input.args ?? [])].join(" "),
            exitCode: 0,
            stdout: "installer said success",
            stderr: "installer warnings",
          };
        },
      };

      const bootstrapper = new ShellOpenClawBootstrapper(execRunner, createLogger(), SERVICE_HOME);

      await expect(
        bootstrapper.ensureInstalled({
          version: SOVEREIGN_PINNED_OPENCLAW_VERSION_ALIAS,
          noOnboard: true,
          noPrompt: true,
          forceReinstall: true,
        }),
      ).rejects.toMatchObject({
        code: "OPENCLAW_INSTALL_FAILED",
        details: {
          detectionOutcome: "spawn_failed",
          npmPrefix: join(SERVICE_HOME, ".npm-global"),
          commandLocation: null,
          installStdout: "installer said success",
          installStderr: "installer warnings",
        },
      });
    });
  });

  it("reports a non-zero detect exit distinctly from a missing binary", async () => {
    await withUid(1001, async () => {
      const execRunner: ExecRunner = {
        run: async (input): Promise<ExecResult> => {
          if (input.command === "openclaw") {
            return {
              command: "openclaw --version",
              exitCode: 3,
              stdout: "",
              stderr: "cannot load module",
            };
          }
          if (input.command === "sh") {
            return {
              command: "sh -c command -v openclaw",
              exitCode: 0,
              stdout: join(PREFIX_BIN, "openclaw"),
              stderr: "",
            };
          }
          return {
            command: [input.command, ...(input.args ?? [])].join(" "),
            exitCode: 0,
            stdout: "",
            stderr: "",
          };
        },
      };

      const bootstrapper = new ShellOpenClawBootstrapper(execRunner, createLogger(), SERVICE_HOME);

      await expect(
        bootstrapper.ensureInstalled({
          version: SOVEREIGN_PINNED_OPENCLAW_VERSION_ALIAS,
          noOnboard: true,
          noPrompt: true,
          forceReinstall: true,
        }),
      ).rejects.toMatchObject({
        code: "OPENCLAW_INSTALL_FAILED",
        details: {
          detectionOutcome: "non_zero_exit",
          detectExitCode: 3,
          detectStderr: "cannot load module",
          commandLocation: join(PREFIX_BIN, "openclaw"),
        },
      });
    });
  });

  it("reports unparsable version output distinctly", async () => {
    await withUid(1001, async () => {
      const execRunner: ExecRunner = {
        run: async (input): Promise<ExecResult> => {
          if (input.command === "openclaw") {
            return {
              command: "openclaw --version",
              exitCode: 0,
              stdout: "   ",
              stderr: "",
            };
          }
          if (input.command === "sh") {
            return {
              command: "sh -c command -v openclaw",
              exitCode: 0,
              stdout: join(PREFIX_BIN, "openclaw"),
              stderr: "",
            };
          }
          return {
            command: [input.command, ...(input.args ?? [])].join(" "),
            exitCode: 0,
            stdout: "",
            stderr: "",
          };
        },
      };

      const bootstrapper = new ShellOpenClawBootstrapper(execRunner, createLogger(), SERVICE_HOME);

      await expect(
        bootstrapper.ensureInstalled({
          version: SOVEREIGN_PINNED_OPENCLAW_VERSION_ALIAS,
          noOnboard: true,
          noPrompt: true,
          forceReinstall: true,
        }),
      ).rejects.toMatchObject({
        code: "OPENCLAW_INSTALL_FAILED",
        details: {
          detectionOutcome: "unparsable_version",
        },
      });
    });
  });

  // Regression: the exec runner reports a failed spawn as exitCode 127 with a
  // spawn_failed reason, never as a throw and never as exit 0. With the old
  // `exitCode ?? 0` coercion this arrived as "exit 0, no output" and was
  // misfiled as unparsable_version — a CLI that never ran looked like a CLI
  // that ran and printed nothing.
  it("classifies a non-throwing ENOENT spawn failure as spawn_failed, not unparsable_version", async () => {
    await withUid(1001, async () => {
      const execRunner: ExecRunner = {
        run: async (input): Promise<ExecResult> => {
          if (input.command === "openclaw") {
            // Exactly what ExecaExecRunner returns for an ENOENT.
            return {
              command: "openclaw --version",
              exitCode: 127,
              stdout: "",
              stderr: "Command failed with ENOENT: openclaw --version",
              failureReason: "spawn_failed",
            };
          }
          if (input.command === "sh") {
            // `command -v` really does exit 127 when the CLI is absent.
            return {
              command: "sh -c command -v openclaw",
              exitCode: 127,
              stdout: "",
              stderr: "",
            };
          }
          return {
            command: [input.command, ...(input.args ?? [])].join(" "),
            exitCode: 0,
            stdout: "",
            stderr: "",
          };
        },
      };

      const bootstrapper = new ShellOpenClawBootstrapper(execRunner, createLogger(), SERVICE_HOME);

      await expect(
        bootstrapper.ensureInstalled({
          version: SOVEREIGN_PINNED_OPENCLAW_VERSION_ALIAS,
          noOnboard: true,
          noPrompt: true,
          forceReinstall: true,
        }),
      ).rejects.toMatchObject({
        code: "OPENCLAW_INSTALL_FAILED",
        details: {
          detectionOutcome: "spawn_failed",
          detectFailureReason: "spawn_failed",
          detectExitCode: 127,
          // The binary is genuinely absent, so there is nothing to describe.
          commandLocation: null,
          resolvedBinary: null,
        },
      });
    });
  });

  it("describes the resolved binary when the CLI runs but prints no version", async () => {
    await withUid(1001, async () => {
      const binDir = await mkdtemp(join(tmpdir(), "openclaw-bin-"));
      const binaryPath = join(binDir, "openclaw");
      await writeFile(binaryPath, "#!/usr/bin/env node\nconsole.log('nothing useful');\n", "utf8");

      const execRunner: ExecRunner = {
        run: async (input): Promise<ExecResult> => {
          if (input.command === "openclaw") {
            return { command: "openclaw --version", exitCode: 0, stdout: "   ", stderr: "" };
          }
          if (input.command === "sh") {
            return {
              command: "sh -c command -v openclaw",
              exitCode: 0,
              stdout: binaryPath,
              stderr: "",
            };
          }
          return {
            command: [input.command, ...(input.args ?? [])].join(" "),
            exitCode: 0,
            stdout: "",
            stderr: "",
          };
        },
      };

      const bootstrapper = new ShellOpenClawBootstrapper(execRunner, createLogger(), SERVICE_HOME);

      await expect(
        bootstrapper.ensureInstalled({
          version: SOVEREIGN_PINNED_OPENCLAW_VERSION_ALIAS,
          noOnboard: true,
          noPrompt: true,
          forceReinstall: true,
        }),
      ).rejects.toMatchObject({
        code: "OPENCLAW_INSTALL_FAILED",
        details: {
          detectionOutcome: "unparsable_version",
          resolvedBinary: {
            path: binaryPath,
            size: 51,
            firstLine: "#!/usr/bin/env node",
          },
        },
      });
    });
  });

  it("records the symlink target and reports a read failure instead of throwing", async () => {
    await withUid(1001, async () => {
      const binDir = await mkdtemp(join(tmpdir(), "openclaw-link-"));
      const realBinary = join(binDir, "openclaw.mjs");
      const linkPath = join(binDir, "openclaw");
      await writeFile(realBinary, "#!/usr/bin/env node\n", "utf8");
      await symlink(realBinary, linkPath);

      const missingPath = join(binDir, "gone");
      let resolvedTo = linkPath;
      const execRunner: ExecRunner = {
        run: async (input): Promise<ExecResult> => {
          if (input.command === "openclaw") {
            return { command: "openclaw --version", exitCode: 0, stdout: "", stderr: "" };
          }
          if (input.command === "sh") {
            return {
              command: "sh -c command -v openclaw",
              exitCode: 0,
              stdout: resolvedTo,
              stderr: "",
            };
          }
          return {
            command: [input.command, ...(input.args ?? [])].join(" "),
            exitCode: 0,
            stdout: "",
            stderr: "",
          };
        },
      };

      const bootstrapper = new ShellOpenClawBootstrapper(execRunner, createLogger(), SERVICE_HOME);
      const install = {
        version: SOVEREIGN_PINNED_OPENCLAW_VERSION_ALIAS,
        noOnboard: true,
        noPrompt: true,
        forceReinstall: true,
      } as const;

      await expect(bootstrapper.ensureInstalled(install)).rejects.toMatchObject({
        details: {
          resolvedBinary: {
            path: linkPath,
            symlinkTarget: realBinary,
            firstLine: "#!/usr/bin/env node",
          },
        },
      });

      // A path that cannot be stat'd is reported, not thrown.
      resolvedTo = missingPath;
      await expect(bootstrapper.ensureInstalled(install)).rejects.toMatchObject({
        details: {
          resolvedBinary: { path: missingPath, error: expect.stringContaining("ENOENT") },
        },
      });
    });
  });

  it("leaves the inherited PATH untouched for a root install", async () => {
    expect(resolveOpenClawLookupPath(undefined, PARENT_PATH)).toBe(PARENT_PATH);
  });

  it("carries the evidence when the npm fallback path also fails detection", async () => {
    await withUid(1001, async () => {
      const execRunner: ExecRunner = {
        run: async (input): Promise<ExecResult> => {
          if (input.command === "openclaw") {
            throw new Error("spawn openclaw ENOENT");
          }
          if (input.command === "bash") {
            // install.sh fails, forcing the direct npm fallback branch.
            return {
              command: "bash -lc <install>",
              exitCode: 1,
              stdout: "install stdout",
              stderr: "install stderr",
            };
          }
          if (input.command === "sh") {
            // `command -v` itself blows up, exercising the catch path.
            throw new Error("spawn sh ENOENT");
          }
          return {
            command: [input.command, ...(input.args ?? [])].join(" "),
            exitCode: 0,
            stdout: "",
            stderr: "",
          };
        },
      };

      const bootstrapper = new ShellOpenClawBootstrapper(execRunner, createLogger(), SERVICE_HOME);

      await expect(
        bootstrapper.ensureInstalled({
          version: SOVEREIGN_PINNED_OPENCLAW_VERSION_ALIAS,
          noOnboard: true,
          noPrompt: true,
          forceReinstall: true,
        }),
      ).rejects.toMatchObject({
        code: "OPENCLAW_INSTALL_FAILED",
        message: "OpenClaw install fallback completed but the openclaw CLI was not detected",
        details: {
          detectionOutcome: "spawn_failed",
          // `command -v` threw, so the location is reported as unknown
          // rather than crashing the error path.
          commandLocation: null,
          installStdout: "install stdout",
          installStderr: "install stderr",
        },
      });
    });
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
});

/**
 * Regression coverage for `spawn npm EACCES`.
 *
 * A child inherits the parent's cwd and the kernel resolves it for the CHILD's
 * credentials. The install path runs as root, which traverses a 0700 directory
 * regardless, so it never noticed. The same step re-entered unprivileged (the
 * CLI invoked via `runuser -u <service-user>` from a root shell, cwd /root)
 * cannot traverse it and every spawn is refused before the binary is consulted.
 *
 * These assertions pin the CONTEXT difference, not just the fix: root must keep
 * inheriting (no behaviour change for the curl installer) while the
 * unprivileged re-entry must pin a traversable cwd on every spawn.
 */
describe("openclaw spawn cwd across install and reconfigure contexts", () => {
  const SERVICE_HOME = "/var/lib/sovereign-node";

  const withUid = async (uid: number, action: () => Promise<void>): Promise<void> => {
    const original = process.getuid;
    Object.defineProperty(process, "getuid", { value: () => uid, configurable: true });
    try {
      await action();
    } finally {
      Object.defineProperty(process, "getuid", { value: original, configurable: true });
    }
  };

  const collectCalls = async (serviceHome?: string): Promise<ExecInput[]> => {
    const calls: ExecInput[] = [];
    const execRunner: ExecRunner = {
      run: async (input): Promise<ExecResult> => {
        calls.push(input);
        if (input.command === "openclaw") {
          const installed = calls.some(
            (call) => call.command === "bash" || call.args?.[0] === "install",
          );
          return {
            command: "openclaw --version",
            exitCode: installed ? 0 : 1,
            stdout: installed ? SOVEREIGN_PINNED_OPENCLAW_VERSION : "",
            stderr: "",
          };
        }
        return {
          command: [input.command, ...(input.args ?? [])].join(" "),
          exitCode: 0,
          stdout: "",
          stderr: "",
        };
      },
    };
    const bootstrapper = new ShellOpenClawBootstrapper(
      execRunner,
      createLogger(),
      ...(serviceHome === undefined ? [] : [serviceHome]),
    );
    await bootstrapper.ensureInstalled({
      version: SOVEREIGN_PINNED_OPENCLAW_VERSION_ALIAS,
      noOnboard: true,
      noPrompt: true,
      skipIfCompatibleInstalled: true,
    });
    return calls;
  };

  it("pins a traversable cwd for an unprivileged service user", () => {
    const original = process.getuid;
    Object.defineProperty(process, "getuid", { value: () => 1001, configurable: true });
    try {
      expect(resolveOpenClawSpawnCwd(SERVICE_HOME)).toBe(SERVICE_HOME);
    } finally {
      Object.defineProperty(process, "getuid", { value: original, configurable: true });
    }
  });

  it("leaves the inherited cwd alone when running as root", () => {
    const original = process.getuid;
    Object.defineProperty(process, "getuid", { value: () => 0, configurable: true });
    try {
      expect(resolveOpenClawSpawnCwd(SERVICE_HOME)).toBeUndefined();
    } finally {
      Object.defineProperty(process, "getuid", { value: original, configurable: true });
    }
  });

  it("falls back to a world-traversable cwd when no home is known", () => {
    const originalUid = process.getuid;
    const originalHome = process.env.HOME;
    Object.defineProperty(process, "getuid", { value: () => 1001, configurable: true });
    delete process.env.HOME;
    try {
      expect(resolveOpenClawSpawnCwd(undefined)).toBe("/");
      expect(resolveOpenClawSpawnCwd("   ")).toBe("/");
    } finally {
      Object.defineProperty(process, "getuid", { value: originalUid, configurable: true });
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  it("prefers $HOME over the bare root fallback when no service home is given", () => {
    const originalUid = process.getuid;
    const originalHome = process.env.HOME;
    Object.defineProperty(process, "getuid", { value: () => 1001, configurable: true });
    process.env.HOME = SERVICE_HOME;
    try {
      expect(resolveOpenClawSpawnCwd(undefined)).toBe(SERVICE_HOME);
    } finally {
      Object.defineProperty(process, "getuid", { value: originalUid, configurable: true });
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  it("never inherits an untraversable cwd on any spawn when unprivileged", async () => {
    await withUid(1001, async () => {
      const calls = await collectCalls(SERVICE_HOME);

      // Every spawn must name a cwd. A single one that inherits is enough to
      // reproduce the EACCES, so assert across the whole set rather than
      // spot-checking the npm install that happened to fail first.
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.options?.cwd, `${call.command} inherited its cwd`).toBeDefined();
      }

      // The detection probe is the one that runs on the reconfigure re-entry
      // even when OpenClaw is already installed, so it must be covered too.
      const detectCall = calls.find((call) => call.command === "openclaw");
      expect(detectCall?.options?.cwd).toBe(SERVICE_HOME);
    });
  });

  it("keeps the root install path inheriting its cwd", async () => {
    await withUid(0, async () => {
      const calls = await collectCalls(SERVICE_HOME);

      // Root traverses 0700 regardless; pinning a cwd here would be an
      // unnecessary behaviour change for the curl installer.
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        if (call.args?.[0] === "install" && call.args?.[1] === "--omit=dev") {
          // The bundled-extension repair legitimately pins the extension dir.
          continue;
        }
        expect(call.options?.cwd, `${call.command} should inherit as root`).toBeUndefined();
      }
    });
  });

  describe("resolveOpenClawSpawnLookupPath", () => {
    const withUid = (uid: number, run: () => void): void => {
      const priorGetuid = process.getuid;
      Object.defineProperty(process, "getuid", { configurable: true, value: () => uid });
      try {
        run();
      } finally {
        Object.defineProperty(process, "getuid", { configurable: true, value: priorGetuid });
      }
    };

    it("returns undefined as root so the spawn just inherits the ambient PATH", () => {
      // A root install keeps npm's default prefix, so there is nothing to
      // prepend and setting PATH would only duplicate what is inherited.
      withUid(0, () => {
        expect(resolveOpenClawSpawnLookupPath("/var/lib/sovereign-node")).toBeUndefined();
      });
    });

    it("prepends the service npm prefix bin dir when unprivileged", () => {
      withUid(1000, () => {
        const resolved = resolveOpenClawSpawnLookupPath("/var/lib/sovereign-node");
        // This is exactly where an unprivileged install puts the bin link.
        expect(resolved).toContain("/var/lib/sovereign-node/.npm-global/bin");
        expect(resolved?.startsWith("/var/lib/sovereign-node/.npm-global/bin:")).toBe(true);
      });
    });

    it("returns undefined when the prefix bin dir is already on PATH", () => {
      const priorPath = process.env.PATH;
      const binDir = "/var/lib/sovereign-node/.npm-global/bin";
      process.env.PATH = `${binDir}:/usr/bin`;
      try {
        withUid(1000, () => {
          // Nothing to add: the spawn would receive a byte-identical PATH.
          expect(resolveOpenClawSpawnLookupPath("/var/lib/sovereign-node")).toBeUndefined();
        });
      } finally {
        if (priorPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = priorPath;
        }
      }
    });
  });

  it("treats a failed spawn as non-retryable and everything else as retryable", () => {
    // A spawn that never started will not start on a retry: the cwd is
    // untraversable or the binary is unexecutable, and neither heals with time.
    expect(isRetryableExecFailure("spawn_failed")).toBe(false);
    expect(isRetryableExecFailure("timed_out")).toBe(true);
    expect(isRetryableExecFailure("signal")).toBe(true);
    expect(isRetryableExecFailure(undefined)).toBe(true);
  });

  it("reports a spawn failure as non-retryable with a machine-readable cause", async () => {
    const execRunner: ExecRunner = {
      run: async (input): Promise<ExecResult> => {
        if (input.command === "openclaw") {
          return { command: "openclaw --version", exitCode: 1, stdout: "", stderr: "" };
        }
        if (input.command === "npm" && input.args?.[0] === "install") {
          // Exactly what execa reports when the cwd is untraversable.
          return {
            command: "npm install -g openclaw",
            exitCode: 127,
            stdout: "",
            stderr: "Command failed with EACCES: npm install -g 'openclaw'\nspawn npm EACCES",
            failureReason: "spawn_failed",
            errorCode: "EACCES",
          };
        }
        if (input.command === "bash") {
          return { command: "bash", exitCode: 1, stdout: "", stderr: "install.sh unavailable" };
        }
        return {
          command: [input.command, ...(input.args ?? [])].join(" "),
          exitCode: 0,
          stdout: "",
          stderr: "",
        };
      },
    };
    const bootstrapper = new ShellOpenClawBootstrapper(execRunner, createLogger(), SERVICE_HOME);

    const failure = await bootstrapper
      .ensureInstalled({
        version: SOVEREIGN_PINNED_OPENCLAW_VERSION_ALIAS,
        noOnboard: true,
        noPrompt: true,
        skipIfCompatibleInstalled: true,
      })
      .then(
        () => null,
        (error: unknown) => error as { retryable?: boolean; details?: Record<string, unknown> },
      );

    expect(failure).not.toBeNull();
    // Retrying a deterministic spawn failure burns a whole release cycle to
    // relearn the same thing.
    expect(failure?.retryable).toBe(false);
    expect(failure?.details?.failureReason).toBe("spawn_failed");
    expect(failure?.details?.errorCode).toBe("EACCES");
  });
});
