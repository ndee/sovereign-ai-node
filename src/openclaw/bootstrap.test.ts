import { chmod, mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createLogger } from "../logging/logger.js";
import type { ExecInput, ExecResult, ExecRunner } from "../system/exec.js";
import {
  ShellOpenClawBootstrapper,
  SOVEREIGN_PINNED_OPENCLAW_VERSION,
  SOVEREIGN_PINNED_OPENCLAW_VERSION_ALIAS,
} from "./bootstrap.js";

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
    await writeInstalledPackage(extensionDir, "@matrix-org/matrix-sdk-crypto-nodejs");
    await writeInstalledPackage(extensionDir, "@vector-im/matrix-bot-sdk");
    await mkdir(memoryCoreDir, { recursive: true });
    await chmod(extensionsRoot, 0o777);
    await chmod(extensionDir, 0o777);
    await chmod(memoryCoreDir, 0o777);

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
