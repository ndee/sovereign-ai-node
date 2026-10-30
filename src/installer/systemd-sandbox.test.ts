import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildBotServiceSandboxPaths,
  buildGatewaySandboxPaths,
  MATRIX_CRYPTO_RUNTIME_PACKAGE_DIR,
  npmPrefixFromBinDir,
  renderSystemdSandboxDirectives,
  withProgramRealPaths,
} from "./systemd-sandbox.js";

// Path -> what realpath() returns for it (null: it cannot be resolved). A path
// that is not listed resolves to itself.
const hostRealPaths = vi.hoisted(() => new Map<string, string | null>());

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    realpath: async (path: string) => {
      const resolved = hostRealPaths.has(path) ? hostRealPaths.get(path) : path;
      if (resolved === null || resolved === undefined) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      }
      return resolved;
    },
  };
});

afterEach(() => {
  hostRealPaths.clear();
});

const directiveNames = (lines: string[]): string[] =>
  lines.map((line) => line.slice(0, line.indexOf("=")));

describe("renderSystemdSandboxDirectives", () => {
  // The full directive contract. A change here changes what every sandboxed
  // unit may do on a device, so it must be deliberate.
  it("renders every sandbox directive in a fixed order", () => {
    expect(
      renderSystemdSandboxDirectives({
        readWritePaths: ["/var/lib/sovereign-node"],
        readOnlyPaths: ["/var/lib/sovereign-node/.npm-global"],
        execPaths: ["/usr/bin/node"],
      }),
    ).toEqual([
      "NoNewPrivileges=yes",
      "ProtectSystem=strict",
      "ProtectHome=yes",
      "PrivateTmp=yes",
      "PrivateDevices=yes",
      "ProtectKernelTunables=yes",
      "ProtectKernelModules=yes",
      "ProtectKernelLogs=yes",
      "ProtectControlGroups=yes",
      "RestrictNamespaces=yes",
      "RestrictSUIDSGID=yes",
      "LockPersonality=yes",
      "CapabilityBoundingSet=",
      "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK",
      "ReadWritePaths=-/var/lib/sovereign-node",
      "ReadOnlyPaths=-/var/lib/sovereign-node/.npm-global",
      "InaccessiblePaths=-/run/docker.sock -/run/containerd/containerd.sock",
      "NoExecPaths=/ -/usr/lib/cargo",
      "ExecPaths=-/usr/lib -/usr/lib64 -/lib -/lib64 -/usr/bin/node",
    ]);
  });

  it("never enables MemoryDenyWriteExecute, which breaks the V8 JIT", () => {
    const lines = renderSystemdSandboxDirectives({
      readWritePaths: ["/var/lib/x"],
      readOnlyPaths: [],
      execPaths: [],
    });
    expect(directiveNames(lines)).not.toContain("MemoryDenyWriteExecute");
  });

  it("omits ReadOnlyPaths when there is nothing to pin read-only", () => {
    const lines = renderSystemdSandboxDirectives({
      readWritePaths: ["/var/lib/x"],
      readOnlyPaths: ["", "relative/path"],
      execPaths: [],
    });
    expect(directiveNames(lines)).not.toContain("ReadOnlyPaths");
  });

  // systemd keeps one mode per path, the most restrictive, so a read-only
  // duplicate would make an executable or writable path lose that access.
  it("drops a read-only entry that repeats a writable or executable path", () => {
    const lines = renderSystemdSandboxDirectives({
      readWritePaths: ["/srv/state"],
      readOnlyPaths: ["/srv/state/", "/opt/tool", "/srv/pinned"],
      execPaths: ["/opt/tool"],
    });
    expect(lines).toContain("ReadOnlyPaths=-/srv/pinned");
    expect(lines).toContain("ReadWritePaths=-/srv/state");
    expect(lines).toContain("ExecPaths=-/usr/lib -/usr/lib64 -/lib -/lib64 -/opt/tool");
  });

  it("normalizes, de-duplicates and drops empty or relative paths, keeping first-seen order", () => {
    const lines = renderSystemdSandboxDirectives({
      readWritePaths: ["/var/lib/b/", " /var/lib/a ", "/var/lib/b", "", "rel", "/var/lib/./a"],
      readOnlyPaths: [],
      execPaths: ["/usr/lib/", "/opt//tool"],
    });
    expect(lines).toContain("ReadWritePaths=-/var/lib/b -/var/lib/a");
    expect(lines).toContain("ExecPaths=-/usr/lib -/usr/lib64 -/lib -/lib64 -/opt/tool");
  });

  it("quotes paths with whitespace, quotes or backslashes and doubles specifier percent signs", () => {
    const lines = renderSystemdSandboxDirectives({
      readWritePaths: ["/srv/my work", '/srv/a"b', "/srv/back\\slash", "/srv/100%"],
      readOnlyPaths: [],
      execPaths: [],
    });
    expect(lines).toContain(
      'ReadWritePaths="-/srv/my work" "-/srv/a\\"b" "-/srv/back\\\\slash" -/srv/100%%',
    );
  });

  it.each([
    ["/home/operator/workspace", "readWritePaths"],
    ["/root/.npm-global", "readOnlyPaths"],
    ["/run/user/1000/bin/tool", "execPaths"],
    ["/home", "readWritePaths"],
  ] as const)("gives a read-only home view when %s is needed (%s)", (path, list) => {
    const paths = { readWritePaths: ["/var/lib/x"], readOnlyPaths: [], execPaths: [] };
    const lines = renderSystemdSandboxDirectives({ ...paths, [list]: [...paths[list], path] });
    expect(lines).toContain("ProtectHome=read-only");
  });

  it("keeps home directories hidden for paths that only share a prefix", () => {
    const lines = renderSystemdSandboxDirectives({
      readWritePaths: ["/homestead/data", "/rooted"],
      readOnlyPaths: [],
      execPaths: [],
    });
    expect(lines).toContain("ProtectHome=yes");
  });
});

describe("withProgramRealPaths", () => {
  it("keeps the program list as it is on a host with GNU coreutils", async () => {
    expect(await withProgramRealPaths(["/usr/bin/node", "/usr/bin/env", "/usr/bin/cat"])).toEqual([
      "/usr/bin/node",
      "/usr/bin/env",
      "/usr/bin/cat",
    ]);
  });

  it("adds the file each program resolves to on a host with Rust coreutils", async () => {
    hostRealPaths.set("/usr/bin/env", "/usr/lib/cargo/bin/coreutils/env");
    hostRealPaths.set("/usr/bin/cat", "/usr/lib/cargo/bin/coreutils/cat");
    expect(await withProgramRealPaths(["/usr/bin/node", "/usr/bin/env", "/usr/bin/cat"])).toEqual([
      "/usr/bin/node",
      "/usr/bin/env",
      "/usr/lib/cargo/bin/coreutils/env",
      "/usr/bin/cat",
      "/usr/lib/cargo/bin/coreutils/cat",
    ]);
  });

  it("lists each path once, in the order it is first seen", async () => {
    hostRealPaths.set("/bin/sh", "/usr/bin/dash");
    hostRealPaths.set("/usr/bin/sh", "/usr/bin/dash");
    expect(
      await withProgramRealPaths(["/bin/sh", "/usr/bin/sh", "/usr/bin/dash", "/bin/sh"]),
    ).toEqual(["/bin/sh", "/usr/bin/dash", "/usr/bin/sh"]);
  });

  it("keeps a program it cannot resolve as given", async () => {
    hostRealPaths.set("/usr/local/bin/sovereign-tool", null);
    expect(await withProgramRealPaths(["/usr/local/bin/sovereign-tool", "/usr/bin/node"])).toEqual([
      "/usr/local/bin/sovereign-tool",
      "/usr/bin/node",
    ]);
  });

  // The Rust coreutils directory sits inside the library grant, so it is only
  // closed again by the deeper NoExecPaths entry; each program the unit runs
  // is re-opened by its own, deeper still, ExecPaths entry.
  it("lets a unit run the coreutils programs it names and no others", async () => {
    hostRealPaths.set("/usr/bin/cat", "/usr/lib/cargo/bin/coreutils/cat");
    const lines = renderSystemdSandboxDirectives({
      readWritePaths: ["/var/lib/x"],
      readOnlyPaths: [],
      execPaths: await withProgramRealPaths(["/usr/bin/cat"]),
    });
    expect(lines).toContain("NoExecPaths=/ -/usr/lib/cargo");
    expect(lines).toContain(
      "ExecPaths=-/usr/lib -/usr/lib64 -/lib -/lib64 -/usr/bin/cat -/usr/lib/cargo/bin/coreutils/cat",
    );
  });
});

describe("npmPrefixFromBinDir", () => {
  it("returns the prefix that owns a bin directory", () => {
    expect(npmPrefixFromBinDir("/var/lib/sovereign-node/.npm-global/bin")).toBe(
      "/var/lib/sovereign-node/.npm-global",
    );
    expect(npmPrefixFromBinDir("/usr/bin/")).toBe("/usr");
  });
});

describe("buildGatewaySandboxPaths", () => {
  it("makes state, workspaces and the Matrix crypto runtime writable and pins the npm prefix read-only", () => {
    const paths = buildGatewaySandboxPaths({
      stateDir: "/var/lib/sovereign-node",
      openclawServiceHome: "/var/lib/sovereign-node/openclaw-home",
      tempDir: "/var/lib/sovereign-node/openclaw-home/tmp",
      agentWorkspaces: ["/srv/workspaces/mail-sentinel"],
      serviceNpmPrefix: "/var/lib/sovereign-node/.npm-global",
      openclawPackageRoots: ["/usr/lib/node_modules/openclaw"],
      programs: ["/usr/bin/node", "/usr/bin/env"],
    });
    expect(paths).toEqual({
      readWritePaths: [
        "/var/lib/sovereign-node",
        "/var/lib/sovereign-node/openclaw-home",
        "/var/lib/sovereign-node/openclaw-home/tmp",
        "/srv/workspaces/mail-sentinel",
        `/usr/lib/node_modules/openclaw/${MATRIX_CRYPTO_RUNTIME_PACKAGE_DIR}`,
      ],
      readOnlyPaths: ["/var/lib/sovereign-node/.npm-global"],
      execPaths: [
        "/usr/bin/node",
        "/usr/bin/env",
        "/var/lib/sovereign-node/.npm-global/bin",
        "/var/lib/sovereign-node/.npm-global/lib",
        "/usr/lib/node_modules/openclaw",
      ],
    });
    expect(MATRIX_CRYPTO_RUNTIME_PACKAGE_DIR).toBe(
      "extensions/matrix/node_modules/@matrix-org/matrix-sdk-crypto-nodejs",
    );
  });
});

describe("buildBotServiceSandboxPaths", () => {
  it("makes state, the OpenClaw home and the workspaces writable and pins the npm prefix", () => {
    expect(
      buildBotServiceSandboxPaths({
        stateDir: "/var/lib/sovereign-node",
        openclawServiceHome: "/var/lib/sovereign-node/openclaw-home",
        workspaces: ["/var/lib/sovereign-node/mail-sentinel/workspace"],
        serviceNpmPrefix: "/var/lib/sovereign-node/.npm-global",
        programs: ["/usr/bin/node"],
      }),
    ).toEqual({
      readWritePaths: [
        "/var/lib/sovereign-node",
        "/var/lib/sovereign-node/openclaw-home",
        "/var/lib/sovereign-node/mail-sentinel/workspace",
      ],
      readOnlyPaths: ["/var/lib/sovereign-node/.npm-global"],
      execPaths: [
        "/usr/bin/node",
        "/var/lib/sovereign-node/.npm-global/bin",
        "/var/lib/sovereign-node/.npm-global/lib",
      ],
    });
  });

  it("leaves out the npm prefix when it is unknown", () => {
    expect(
      buildBotServiceSandboxPaths({
        stateDir: "/var/lib/sovereign-node",
        openclawServiceHome: "/var/lib/sovereign-node/openclaw-home",
        workspaces: [],
        programs: ["/usr/bin/node"],
      }),
    ).toEqual({
      readWritePaths: ["/var/lib/sovereign-node", "/var/lib/sovereign-node/openclaw-home"],
      readOnlyPaths: [],
      execPaths: ["/usr/bin/node"],
    });
  });
});
