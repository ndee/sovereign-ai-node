import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logging/logger.js";
import type { ExecInput, ExecResult, ExecRunner } from "./exec.js";
import {
  BUNDLED_MATRIX_DIR_MODE,
  hardenDirectory,
  hardenFile,
  resolveBundledMatrixOwner,
  SYNAPSE_IMAGE_DEFAULT_GID,
  SYNAPSE_IMAGE_DEFAULT_UID,
} from "./matrix-file-modes.js";

const makeLogger = (): Logger & { warn: ReturnType<typeof vi.fn> } =>
  ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  }) as unknown as Logger & { warn: ReturnType<typeof vi.fn> };

const makeIdRunner = (
  answers: Record<string, { exitCode: number; stdout: string }>,
): ExecRunner & { calls: ExecInput[] } => {
  const calls: ExecInput[] = [];
  return {
    calls,
    run: async (input): Promise<ExecResult> => {
      calls.push(input);
      const key = (input.args ?? []).join(" ");
      const answer = answers[key] ?? { exitCode: 1, stdout: "" };
      return {
        command: [input.command, ...(input.args ?? [])].join(" "),
        exitCode: answer.exitCode,
        stdout: answer.stdout,
        stderr: "",
      };
    },
  };
};

describe("resolveBundledMatrixOwner", () => {
  it("uses the current process identity when not running as root", async () => {
    const execRunner = makeIdRunner({});
    const owner = await resolveBundledMatrixOwner({
      execRunner,
      logger: makeLogger(),
      getuid: () => 1234,
      getgid: () => 5678,
    });
    expect(owner).toEqual({ uid: 1234, gid: 5678 });
    expect(execRunner.calls).toHaveLength(0);
  });

  it("falls back to the real process identity when no getters are injected", async () => {
    const owner = await resolveBundledMatrixOwner({
      execRunner: makeIdRunner({}),
      logger: makeLogger(),
    });
    expect(owner).toEqual({
      uid: process.getuid?.() ?? 0,
      gid: process.getgid?.() ?? 0,
    });
  });

  it("treats a platform without getuid/getgid as root and resolves the service user", async () => {
    const originalGetuid = process.getuid;
    const originalGetgid = process.getgid;
    Reflect.set(process, "getuid", undefined);
    Reflect.set(process, "getgid", undefined);
    vi.stubEnv("SOVEREIGN_NODE_SERVICE_USER", "svc-from-env");
    try {
      const execRunner = makeIdRunner({
        "-u svc-from-env": { exitCode: 0, stdout: "1500" },
        "-g svc-from-env": { exitCode: 0, stdout: "1501" },
      });
      const owner = await resolveBundledMatrixOwner({ execRunner, logger: makeLogger() });
      expect(owner).toEqual({ uid: 1500, gid: 1501 });
    } finally {
      Reflect.set(process, "getuid", originalGetuid);
      Reflect.set(process, "getgid", originalGetgid);
      vi.unstubAllEnvs();
    }
  });

  it("uses gid 0 when only getgid is unavailable and the process is unprivileged", async () => {
    const originalGetgid = process.getgid;
    Reflect.set(process, "getgid", undefined);
    try {
      const owner = await resolveBundledMatrixOwner({
        execRunner: makeIdRunner({}),
        logger: makeLogger(),
        getuid: () => 77,
      });
      expect(owner).toEqual({ uid: 77, gid: 0 });
    } finally {
      Reflect.set(process, "getgid", originalGetgid);
    }
  });

  it("resolves the configured service user via id when running as root", async () => {
    const execRunner = makeIdRunner({
      "-u svc": { exitCode: 0, stdout: "4242\n" },
      "-g svc": { exitCode: 0, stdout: "4343\n" },
    });
    const owner = await resolveBundledMatrixOwner({
      execRunner,
      logger: makeLogger(),
      env: { SOVEREIGN_NODE_SERVICE_USER: " svc " },
      getuid: () => 0,
    });
    expect(owner).toEqual({ uid: 4242, gid: 4343 });
    expect(execRunner.calls.map((call) => call.command)).toEqual(["id", "id"]);
  });

  it("defaults to the sovereign-node service user when none is configured", async () => {
    const execRunner = makeIdRunner({
      "-u sovereign-node": { exitCode: 0, stdout: "999" },
      "-g sovereign-node": { exitCode: 0, stdout: "998" },
    });
    const owner = await resolveBundledMatrixOwner({
      execRunner,
      logger: makeLogger(),
      env: { SOVEREIGN_NODE_SERVICE_USER: "" },
      getuid: () => 0,
    });
    expect(owner).toEqual({ uid: 999, gid: 998 });
  });

  it("falls back to the Synapse image default when the service user is unknown", async () => {
    const logger = makeLogger();
    const owner = await resolveBundledMatrixOwner({
      execRunner: makeIdRunner({}),
      logger,
      env: {},
      getuid: () => 0,
    });
    expect(owner).toEqual({ uid: SYNAPSE_IMAGE_DEFAULT_UID, gid: SYNAPSE_IMAGE_DEFAULT_GID });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("falls back when id prints something that is not a number", async () => {
    const logger = makeLogger();
    const owner = await resolveBundledMatrixOwner({
      execRunner: makeIdRunner({
        "-u sovereign-node": { exitCode: 0, stdout: "not-a-uid" },
        "-g sovereign-node": { exitCode: 0, stdout: "12" },
      }),
      logger,
      env: {},
      getuid: () => 0,
    });
    expect(owner).toEqual({ uid: 991, gid: 991 });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("never hands the containers uid 0 even if the service user resolves to root", async () => {
    const logger = makeLogger();
    const owner = await resolveBundledMatrixOwner({
      execRunner: makeIdRunner({
        "-u root": { exitCode: 0, stdout: "0" },
        "-g root": { exitCode: 0, stdout: "0" },
      }),
      logger,
      env: { SOVEREIGN_NODE_SERVICE_USER: "root" },
      getuid: () => 0,
    });
    expect(owner).toEqual({ uid: 991, gid: 991 });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe("hardenFile", () => {
  it("applies the requested mode and ignores missing files", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "matrix-file-modes-"));
    try {
      const file = join(tempRoot, "secret");
      await writeFile(file, "x", { mode: 0o644 });
      await hardenFile(file, 0o600, { uid: 1, gid: 1 });
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      await expect(
        hardenFile(join(tempRoot, "missing"), 0o600, { uid: 1, gid: 1 }),
      ).resolves.toBeUndefined();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("chowns to the owner when running as root and propagates other errors", async () => {
    const chmodImpl = vi.fn(async () => undefined);
    const chownImpl = vi.fn(async () => undefined);
    await hardenFile(
      "/p",
      0o640,
      { uid: 7, gid: 8 },
      { chmod: chmodImpl, chown: chownImpl, getuid: () => 0 },
    );
    expect(chmodImpl).toHaveBeenCalledWith("/p", 0o640);
    expect(chownImpl).toHaveBeenCalledWith("/p", 7, 8);

    const eperm = Object.assign(new Error("eperm"), { code: "EPERM" });
    await expect(
      hardenFile(
        "/p",
        0o640,
        { uid: 7, gid: 8 },
        {
          chmod: vi.fn(async () => {
            throw eperm;
          }),
        },
      ),
    ).rejects.toBe(eperm);
    await expect(
      hardenFile(
        "/p",
        0o640,
        { uid: 7, gid: 8 },
        {
          chmod: vi.fn(async () => {
            throw new Error("plain");
          }),
        },
      ),
    ).rejects.toThrow("plain");
  });
});

describe("hardenDirectory", () => {
  it("sets 0750 on the directory without recursing into it", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "matrix-file-modes-"));
    try {
      const dir = join(tempRoot, "data");
      const child = join(dir, "child");
      await mkdir(child, { recursive: true });
      await writeFile(join(child, "f"), "x");
      await hardenDirectory(dir, { uid: 1, gid: 1 });
      expect((await stat(dir)).mode & 0o777).toBe(BUNDLED_MATRIX_DIR_MODE);
      // The child keeps whatever mode mkdir gave it: data contents are the
      // containers' business.
      expect((await stat(child)).mode & 0o777).toBe(0o777 & ~(process.umask() | 0));
      await expect(
        hardenDirectory(join(tempRoot, "missing"), { uid: 1, gid: 1 }),
      ).resolves.toBeUndefined();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("chowns when root, tolerates container-owned directories and rethrows the rest", async () => {
    const chownImpl = vi.fn(async () => undefined);
    await hardenDirectory(
      "/d",
      { uid: 7, gid: 8 },
      { chmod: vi.fn(async () => undefined), chown: chownImpl, getuid: () => 0 },
    );
    expect(chownImpl).toHaveBeenCalledWith("/d", 7, 8);

    for (const code of ["EPERM", "EACCES"]) {
      const logger = makeLogger();
      const err = Object.assign(new Error(code), { code });
      await expect(
        hardenDirectory(
          "/d",
          { uid: 7, gid: 8 },
          {
            chmod: vi.fn(async () => {
              throw err;
            }),
            logger,
          },
        ),
      ).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledTimes(1);
    }
    const eperm = Object.assign(new Error("eperm"), { code: "EPERM" });
    await expect(
      hardenDirectory(
        "/d",
        { uid: 7, gid: 8 },
        {
          chmod: vi.fn(async () => {
            throw eperm;
          }),
        },
      ),
    ).resolves.toBeUndefined();
    const eio = Object.assign(new Error("eio"), { code: "EIO" });
    await expect(
      hardenDirectory(
        "/d",
        { uid: 7, gid: 8 },
        {
          chmod: vi.fn(async () => {
            throw eio;
          }),
        },
      ),
    ).rejects.toBe(eio);
  });
});
