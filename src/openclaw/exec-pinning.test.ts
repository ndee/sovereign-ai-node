import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createDefaultExecPinningEnvironment,
  describeExecWrapperInvocation,
  isPathWritableByServiceUser,
  MANAGED_EXEC_WRAPPER_ROOT,
  parseExecApprovalsSnapshot,
  planExecApprovalsReconciliation,
  planExecWrapper,
  resolveServiceUserIdentity,
} from "./exec-pinning.js";

const execFileAsync = promisify(execFile);

const runId = async (args: string[]): Promise<string | null> => {
  try {
    return (await execFileAsync("id", args)).stdout.trim();
  } catch {
    return null;
  }
};

let tempRoot = "";

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "exec-pinning-test-"));
});

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("planExecWrapper", () => {
  it("ignores commands without an absolute executable", () => {
    expect(
      planExecWrapper({ wrapperRoot: "/w", agentId: "a", command: "status --json" }),
    ).toBeNull();
    expect(planExecWrapper({ wrapperRoot: "/w", agentId: "a", command: "" })).toBeNull();
  });

  it("names the wrapper after the fixed tokens and the command hash", () => {
    const plan = planExecWrapper({
      wrapperRoot: "/w",
      agentId: "node-operator",
      command: "/usr/local/bin/sovereign-node agents create <id> --workspace <dir> --json",
    });
    expect(plan?.path).toMatch(/^\/w\/node-operator\/agents-create-workspace-json-[0-9a-f]{8}$/);
    expect(plan?.executable).toBe("/usr/local/bin/sovereign-node");
    expect(plan?.placeholders).toEqual(["<id>", "<dir>"]);
    expect(plan === null ? "" : describeExecWrapperInvocation(plan)).toBe(
      `${plan?.path} <id> <dir>`,
    );
    expect(
      planExecWrapper({ wrapperRoot: "/w", agentId: "a", command: "/bin/x <only>" })?.path,
    ).toMatch(/^\/w\/a\/command-[0-9a-f]{8}$/);
  });

  it("runs exactly the planned argv and only the declared arguments", async () => {
    const executable = join(tempRoot, "print-argv's.js");
    await writeFile(
      executable,
      "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
      "utf8",
    );
    await chmod(executable, 0o755);
    const plan = planExecWrapper({
      wrapperRoot: tempRoot,
      agentId: "agent",
      command: `${executable} feedback --id <id> --label it's --json`,
    });
    if (plan === null) {
      throw new Error("expected a wrapper plan");
    }
    await mkdir(join(tempRoot, "agent"), { recursive: true });
    await writeFile(plan.path, plan.content, { mode: 0o755 });

    const ok = await execFileAsync("/bin/sh", [plan.path, "a b; echo pwned $(id)"]);
    expect(JSON.parse(ok.stdout)).toEqual([
      "feedback",
      "--id",
      "a b; echo pwned $(id)",
      "--label",
      "it's",
      "--json",
    ]);
    await expect(execFileAsync("/bin/sh", [plan.path])).rejects.toMatchObject({ code: 64 });
    await expect(execFileAsync("/bin/sh", [plan.path, "a", "b"])).rejects.toMatchObject({
      code: 64,
    });
    await expect(execFileAsync("/bin/sh", [plan.path, "--json"])).rejects.toMatchObject({
      code: 64,
    });
  });
});

describe("isPathWritableByServiceUser", () => {
  const identity = { uid: 1000, gids: [1000, 50] };
  const probe = (
    entries: Record<string, { uid: number; gid: number; mode: number } | Error>,
    resolved?: Record<string, string>,
  ) => ({
    statPath: async (path: string) => {
      const entry = entries[path];
      if (entry === undefined) {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      if (entry instanceof Error) {
        throw entry;
      }
      return entry;
    },
    resolvePath: async (path: string) => {
      const target = resolved?.[path];
      if (target === undefined) {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      return target;
    },
  });
  const rootDir = { uid: 0, gid: 0, mode: 0o40755 };
  const rootFile = { uid: 0, gid: 0, mode: 0o100755 };

  it("accepts a root-owned file in root-owned directories", async () => {
    const fs = probe(
      { "/": rootDir, "/usr": rootDir, "/usr/bin": rootDir, "/usr/bin/tool": rootFile },
      { "/usr/bin/tool": "/usr/bin/tool" },
    );
    expect(await isPathWritableByServiceUser("/usr/bin/tool", identity, fs)).toBe(false);
  });

  it.each([
    ["owned by the service user", { uid: 1000, gid: 0, mode: 0o100555 }],
    ["world-writable", { uid: 0, gid: 0, mode: 0o100757 }],
    ["group-writable for a service group", { uid: 0, gid: 50, mode: 0o100775 }],
  ])("refuses a file %s", async (_label, file) => {
    const fs = probe({ "/": rootDir, "/opt": rootDir, "/opt/tool": file });
    expect(await isPathWritableByServiceUser("/opt/tool", identity, fs)).toBe(true);
  });

  it("ignores group write for groups the user is not in", async () => {
    const fs = probe(
      { "/": rootDir, "/opt": rootDir, "/opt/tool": { uid: 0, gid: 7, mode: 0o100775 } },
      { "/opt/tool": "/opt/tool" },
    );
    expect(await isPathWritableByServiceUser("/opt/tool", identity, fs)).toBe(false);
  });

  it("refuses a file under a directory the service user owns", async () => {
    const fs = probe({
      "/": rootDir,
      "/home/svc": { uid: 1000, gid: 1000, mode: 0o40700 },
      "/home/svc/x": rootFile,
    });
    expect(await isPathWritableByServiceUser("/home/svc/x", identity, fs)).toBe(true);
  });

  it("judges a missing path by its nearest existing ancestor", async () => {
    expect(await isPathWritableByServiceUser("/nope/tool", identity, probe({ "/": rootDir }))).toBe(
      false,
    );
    expect(
      await isPathWritableByServiceUser(
        "/tmp/tool",
        identity,
        probe({ "/": rootDir, "/tmp": { uid: 0, gid: 0, mode: 0o41777 } }),
      ),
    ).toBe(true);
  });

  it("refuses paths it cannot inspect", async () => {
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    expect(
      await isPathWritableByServiceUser("/x", identity, probe({ "/": rootDir, "/x": denied })),
    ).toBe(true);
    expect(
      await isPathWritableByServiceUser("/x", identity, {
        statPath: probe({ "/": rootDir, "/x": rootFile }).statPath,
        resolvePath: async () => {
          throw denied;
        },
      }),
    ).toBe(true);
  });

  it("ignores the mode bits of a symlink itself", async () => {
    const fs = probe(
      {
        "/": rootDir,
        "/bin": { uid: 0, gid: 0, mode: 0o120777 },
        "/usr": rootDir,
        "/usr/bin": rootDir,
        "/usr/bin/sh": rootFile,
      },
      { "/bin/sh": "/usr/bin/sh" },
    );
    expect(await isPathWritableByServiceUser("/bin/sh", identity, fs)).toBe(false);
  });

  it("checks the target of a symlink", async () => {
    const fs = probe(
      {
        "/": rootDir,
        "/usr": rootDir,
        "/usr/bin": rootDir,
        "/usr/bin/link": rootFile,
        "/home": rootDir,
        "/home/svc": { uid: 1000, gid: 1000, mode: 0o40755 },
        "/home/svc/real": rootFile,
      },
      { "/usr/bin/link": "/home/svc/real" },
    );
    expect(await isPathWritableByServiceUser("/usr/bin/link", identity, fs)).toBe(true);
  });

  it("uses the real filesystem by default", async () => {
    const file = join(tempRoot, "real-file");
    await writeFile(file, "x");
    const link = join(tempRoot, "real-link");
    await symlink(file, link);
    const self = await resolveServiceUserIdentity(String(process.getuid?.() ?? 0), runId);
    expect(self).not.toBeNull();
    if (self !== null) {
      expect(await isPathWritableByServiceUser(link, self)).toBe(true);
    }
    expect(await isPathWritableByServiceUser("/bin/sh", { uid: 65_534, gids: [65_534] })).toBe(
      false,
    );
  });
});

describe("resolveServiceUserIdentity", () => {
  it("parses id output", async () => {
    const answers: Record<string, string | null> = { "-u svc": "1001", "-G svc": "1001 50 x" };
    expect(
      await resolveServiceUserIdentity("svc", async (args) => answers[args.join(" ")] ?? null),
    ).toEqual({
      uid: 1001,
      gids: [1001, 50],
    });
  });

  it("returns null when the user cannot be resolved", async () => {
    expect(await resolveServiceUserIdentity("svc", async () => null)).toBeNull();
    expect(
      await resolveServiceUserIdentity("svc", async (args) => (args[0] === "-u" ? "abc" : "1")),
    ).toBeNull();
    expect(await resolveServiceUserIdentity("sovereign-node-no-such-user-xyz", runId)).toBeNull();
  });
});

describe("createDefaultExecPinningEnvironment", () => {
  it("probes the real host", async () => {
    const env = createDefaultExecPinningEnvironment(runId);
    expect(env.wrapperRoot).toBe(MANAGED_EXEC_WRAPPER_ROOT);
    expect(env.runningAsRoot()).toBe(process.getuid?.() === 0);
    const getuid = process.getuid;
    try {
      Object.assign(process, { getuid: undefined });
      expect(env.runningAsRoot()).toBe(false);
      Object.assign(process, { getuid: () => 0 });
      expect(env.runningAsRoot()).toBe(true);
    } finally {
      Object.assign(process, { getuid });
    }
    const self = await env.resolveServiceUser(String(process.getuid?.() ?? 0));
    expect(self?.uid).toBe(process.getuid?.());
    expect(await env.isPathWritable("/bin/sh", { uid: 65_534, gids: [] })).toBe(false);
    const file = join(tempRoot, "chown-target");
    await writeFile(file, "x");
    if (process.getuid?.() === 0) {
      await expect(env.chownToRoot(file)).resolves.toBeUndefined();
    } else {
      await expect(env.chownToRoot(file)).rejects.toMatchObject({ code: "EPERM" });
    }
  });
});

describe("parseExecApprovalsSnapshot", () => {
  it("collects patterns per agent from a CLI snapshot with noise around it", () => {
    const stdout = `doctor note\n${JSON.stringify({
      path: "/x",
      file: {
        version: 1,
        agents: {
          "*": { allowlist: [{ pattern: " /usr/bin/uname " }] },
          "mail-sentinel": {
            allowlist: [
              "/ws/bin/mail-sentinel.js",
              { pattern: "/ws/bin/mail-sentinel.js" },
              { id: "x" },
              3,
            ],
          },
          empty: { allowlist: [{ pattern: " " }] },
          none: { security: "allowlist" },
          broken: "x",
        },
      },
    })}\ntrailer`;
    expect(parseExecApprovalsSnapshot(stdout)).toEqual({
      "*": ["/usr/bin/uname"],
      "mail-sentinel": ["/ws/bin/mail-sentinel.js"],
    });
  });

  it("treats a snapshot without agents as empty and garbage as unreadable", () => {
    expect(parseExecApprovalsSnapshot('{"exists":false}')).toEqual({});
    expect(parseExecApprovalsSnapshot('{"file":{"agents":[]}}')).toEqual({});
    expect(parseExecApprovalsSnapshot("ok")).toBeNull();
    expect(parseExecApprovalsSnapshot("} {")).toBeNull();
    expect(parseExecApprovalsSnapshot("{not json}")).toBeNull();
  });
});

describe("planExecApprovalsReconciliation", () => {
  it("removes everything unexpected and adds what is missing", () => {
    expect(
      planExecApprovalsReconciliation(
        { "*": ["/usr/bin/uname"], ms: ["/ws/bin/ms.js"], op: ["/w/op/status", "/w/op/old"] },
        { op: ["/w/op/status", "/w/op/new", "/w/op/new"], fresh: ["/w/fresh/a"] },
      ),
    ).toEqual({
      remove: [
        { agent: "*", pattern: "/usr/bin/uname" },
        { agent: "ms", pattern: "/ws/bin/ms.js" },
        { agent: "op", pattern: "/w/op/old" },
      ],
      add: [
        { agent: "op", pattern: "/w/op/new" },
        { agent: "fresh", pattern: "/w/fresh/a" },
      ],
    });
  });
});
