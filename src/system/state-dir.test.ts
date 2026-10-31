import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DEV_STATE_FALLBACK_ENV,
  devStateFallbackDir,
  runningUserName,
  SOVEREIGN_DEV_STATE_DIR_NAME,
  stateDirUnwritableError,
} from "./state-dir.js";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

describe("devStateFallbackDir", () => {
  it("is disabled unless the explicit dev flag is set", () => {
    expect(devStateFallbackDir("secrets", {}, "/checkout")).toBeNull();
  });

  it.each(["0", "true", "yes", ""])("treats %j as not opted in", (value) => {
    expect(devStateFallbackDir("secrets", { [DEV_STATE_FALLBACK_ENV]: value }, "/checkout")).toBe(
      null,
    );
  });

  it("returns a cwd-relative dev dir when the flag is 1", () => {
    expect(devStateFallbackDir("secrets", { [DEV_STATE_FALLBACK_ENV]: "1" }, "/checkout")).toBe(
      resolve("/checkout", SOVEREIGN_DEV_STATE_DIR_NAME, "secrets"),
    );
  });

  it("reads the real environment and working directory by default", () => {
    const previous = process.env[DEV_STATE_FALLBACK_ENV];
    process.env[DEV_STATE_FALLBACK_ENV] = "1";
    try {
      expect(devStateFallbackDir("install-jobs")).toBe(
        resolve(process.cwd(), SOVEREIGN_DEV_STATE_DIR_NAME, "install-jobs"),
      );
    } finally {
      if (previous === undefined) {
        delete process.env[DEV_STATE_FALLBACK_ENV];
      } else {
        process.env[DEV_STATE_FALLBACK_ENV] = previous;
      }
    }
  });
});

describe("stateDirUnwritableError", () => {
  const cause = Object.assign(new Error("EACCES: permission denied, mkdir '/var/lib/x'"), {
    code: "EACCES",
  });

  it("names the path, the required owner and mode, the fix, and the cause", () => {
    const error = stateDirUnwritableError({
      code: "MATRIX_STATE_DIR_UNWRITABLE",
      label: "Bundled Matrix state directory",
      dir: "/var/lib/sovereign-node/bundled-matrix",
      mode: 0o750,
      owner: "sovereign-node",
      cause,
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("MATRIX_STATE_DIR_UNWRITABLE");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain(
      "Bundled Matrix state directory /var/lib/sovereign-node/bundled-matrix is not writable",
    );
    expect(error.message).toContain('"sovereign-node"');
    expect(error.message).toContain("mode 0750");
    expect(error.message).toContain(
      "sudo mkdir -p /var/lib/sovereign-node/bundled-matrix && sudo chown sovereign-node: /var/lib/sovereign-node/bundled-matrix && sudo chmod 0750 /var/lib/sovereign-node/bundled-matrix",
    );
    expect(error.message).toContain("EACCES: permission denied, mkdir '/var/lib/x'");
    expect(error.details).toEqual({
      dir: "/var/lib/sovereign-node/bundled-matrix",
      requiredOwner: "sovereign-node",
      requiredMode: "0750",
      suggestedFix:
        "sudo mkdir -p /var/lib/sovereign-node/bundled-matrix && sudo chown sovereign-node: /var/lib/sovereign-node/bundled-matrix && sudo chmod 0750 /var/lib/sovereign-node/bundled-matrix",
      cause: "EACCES: permission denied, mkdir '/var/lib/x'",
      causeCode: "EACCES",
    });
  });

  it("still gives a usable fix when the running user cannot be resolved", () => {
    const error = stateDirUnwritableError({
      code: "SECRETS_DIR_UNWRITABLE",
      label: "Secrets directory",
      dir: "/etc/sovereign-node/secrets",
      mode: 0o700,
      owner: null,
      cause: "boom",
    });

    expect(error.message).toContain("the user this service runs as");
    expect(error.message).toContain("sudo chown <service-user>: /etc/sovereign-node/secrets");
    expect(error.details.requiredOwner).toBe("<service-user>");
    expect(error.details.cause).toBe("boom");
    expect(error.details.causeCode).toBeUndefined();
  });

  it("resolves the running user when no owner is passed", () => {
    const error = stateDirUnwritableError({
      code: "INSTALL_JOBS_DIR_UNWRITABLE",
      label: "Install jobs directory",
      dir: "/var/lib/sovereign-node/install-jobs",
      mode: 0o700,
      cause,
    });

    expect(error.details.requiredOwner).toBe(runningUserName() ?? "<service-user>");
  });
});

describe("runningUserName", () => {
  it("returns the username of the process", () => {
    expect(runningUserName(() => ({ username: "sovereign-node" }))).toBe("sovereign-node");
  });

  it("returns null when the uid has no passwd entry", () => {
    expect(
      runningUserName(() => {
        throw new Error("ENOENT: no such file or directory, uv_os_get_passwd");
      }),
    ).toBeNull();
  });
});

describe("dev state fallback flag stays out of production code", () => {
  const listFiles = async (dir: string): Promise<string[]> => {
    const entries = await readdir(join(repoRoot, dir), { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name));
  };

  it("is only defined by the state-dir module and only set by the dev package scripts", async () => {
    const files = [...(await listFiles("src")), ...(await listFiles("scripts"))].filter(
      (file) =>
        !/\.test\.(ts|mjs)$/.test(file) && !file.endsWith(join("src", "system", "state-dir.ts")),
    );
    const offenders: string[] = [];
    for (const file of files) {
      if ((await readFile(file, "utf8")).includes(DEV_STATE_FALLBACK_ENV)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);

    const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const setters = Object.entries(pkg.scripts)
      .filter(([, command]) => command.includes(DEV_STATE_FALLBACK_ENV))
      .map(([name]) => name)
      .sort();
    expect(setters).toEqual(["dev:api", "dev:cli"]);
  });
});
