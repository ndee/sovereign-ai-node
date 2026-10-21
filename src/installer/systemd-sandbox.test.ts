import { describe, expect, it } from "vitest";

import {
  buildBotServiceSandboxPaths,
  buildGatewaySandboxPaths,
  MATRIX_CRYPTO_RUNTIME_PACKAGE_DIR,
  npmPrefixFromBinDir,
  renderSystemdSandboxDirectives,
} from "./systemd-sandbox.js";

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
      "NoExecPaths=/",
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
