import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SovereignPaths } from "../config/paths.js";
import { createLogger } from "../logging/logger.js";
import { MANAGED_EXEC_WRAPPER_ROOT, planExecWrapper } from "../openclaw/exec-pinning.js";
import type { ExecInput, ExecResult } from "../system/exec.js";
import { RealInstallerService } from "./real-service.js";
import type { RuntimeConfig } from "./real-service-shared.js";
import { renderSystemGatewayMatrixWaitCommand } from "./real-service-utils.js";

// What a system program resolves to on the simulated host; a program that is
// not listed resolves to itself, as with GNU coreutils.
const hostProgramLinks = vi.hoisted(() => new Map<string, string>());

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    // System programs resolve through the fixture, so the rendered units do
    // not depend on which coreutils the machine running the tests has.
    realpath: async (path: string) =>
      /^\/(usr|bin)\//.test(path) ? (hostProgramLinks.get(path) ?? path) : actual.realpath(path),
  };
});

afterEach(() => {
  hostProgramLinks.clear();
});

type Internals = {
  ensureSystemGatewayServiceFallback(config: RuntimeConfig): Promise<{ ready: boolean }>;
  listGatewaySandboxAgentPrograms(
    config: RuntimeConfig,
    searchPath: string,
    nodeCommand: string,
  ): Promise<string[]>;
  listAgentExecAllowlistCommands(
    config: RuntimeConfig,
    toolInstanceIds: string[],
  ): Promise<string[]>;
  agentBindsTypedTool(config: RuntimeConfig, toolInstanceIds: string[]): Promise<boolean>;
  resolveTypedToolSandboxPrograms(nodeCommand: string): Promise<string[]>;
  renderSystemdServiceResource(
    context: {
      serviceNpmBinDir?: string;
      agent: { workspace: string };
      sandboxPrograms: readonly string[];
    },
    resource: Record<string, unknown>,
  ): string;
  resolveBotServiceSandboxPrograms(
    serviceNpmBinDir: string,
    systemSearchPath?: string,
  ): Promise<string[]>;
};

const sectionLines = (unit: string, from: string, to: string): string[] =>
  unit.slice(unit.indexOf(from), unit.indexOf(to)).trim().split("\n");

const sandboxLines = (unit: string): string[] => {
  const lines = sectionLines(unit, "[Service]", "[Install]");
  return lines.slice(lines.indexOf("NoNewPrivileges=yes"));
};

describe("sovereign-openclaw-gateway unit sandbox", () => {
  let tempRoot: string;
  let serviceHome: string;
  let npmPrefix: string;
  let packageRoot: string;
  let globalRoot: string;
  let toolBin: string;
  let unitPath: string;
  let paths: SovereignPaths;
  const priorEnv = {
    PATH: process.env.PATH,
    SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH: process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH,
    SOVEREIGN_NODE_OPENCLAW_GLOBAL_ROOT: process.env.SOVEREIGN_NODE_OPENCLAW_GLOBAL_ROOT,
  };

  beforeEach(async () => {
    // realpath: the unit lists resolved package roots, and tmpdir() may be a symlink.
    tempRoot = await realpath(await mkdtemp(join(tmpdir(), "sovereign-sandbox-test-")));
    // mkdtemp creates 0700; the gateway only takes a node every user can reach.
    await chmod(tempRoot, 0o755);
    serviceHome = join(tempRoot, "svc-home");
    npmPrefix = join(serviceHome, ".npm-global");
    packageRoot = join(npmPrefix, "lib", "node_modules", "openclaw");
    globalRoot = join(tempRoot, "global");
    toolBin = join(tempRoot, "bin");
    unitPath = join(tempRoot, "systemd", "sovereign-openclaw-gateway.service");
    paths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "state"),
      logsDir: join(tempRoot, "log"),
      installJobsDir: join(tempRoot, "state", "install-jobs"),
      openclawServiceHome: join(tempRoot, "state", "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "state", "backups"),
    };
    process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH = unitPath;
    process.env.SOVEREIGN_NODE_OPENCLAW_GLOBAL_ROOT = globalRoot;
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    vi.restoreAllMocks();
    await rm(tempRoot, { recursive: true, force: true });
  });

  const makeService = (
    options: { systemSearchPath?: string; calls?: string[] } = {},
  ): RealInstallerService => {
    const service = new RealInstallerService(createLogger(), paths, {
      fetchImpl: async () => new Response("", { status: 200 }),
      execRunner: {
        run: async ({ command, args }: ExecInput): Promise<ExecResult> => {
          const serialized = [command, ...(args ?? [])].join(" ");
          options.calls?.push(serialized);
          return {
            command: serialized,
            exitCode: 0,
            stdout:
              serialized === "getent passwd sovereign-node"
                ? `sovereign-node:x:999:999::${serviceHome}:/usr/sbin/nologin\n`
                : "",
            stderr: "",
          };
        },
      },
    } as unknown as ConstructorParameters<typeof RealInstallerService>[2]);
    (service as unknown as { serviceProgramSearchPath: string }).serviceProgramSearchPath =
      options.systemSearchPath ?? toolBin;
    return service;
  };

  const runtimeConfig = (adminBaseUrl: string, agents?: unknown[]): RuntimeConfig =>
    ({
      matrix: { adminBaseUrl },
      openclaw: {
        serviceUser: "sovereign-node",
        serviceGroup: "sovereign-node",
        gatewayEnvPath: join(paths.openclawServiceHome, "gateway.env"),
      },
      ...(agents === undefined ? {} : { openclawProfile: { agents } }),
    }) as unknown as RuntimeConfig;

  const render = async (service: RealInstallerService, config: RuntimeConfig): Promise<string> => {
    const outcome = await (service as unknown as Internals).ensureSystemGatewayServiceFallback(
      config,
    );
    expect(outcome.ready).toBe(true);
    return readFile(unitPath, "utf8");
  };

  const installTools = async (): Promise<void> => {
    await mkdir(toolBin, { recursive: true });
    for (const program of ["node", "bash"]) {
      await writeFile(join(toolBin, program), "#!/bin/sh\n", { mode: 0o755 });
    }
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, "openclaw.mjs"), "#!/usr/bin/env node\n", { mode: 0o755 });
    await mkdir(join(npmPrefix, "bin"), { recursive: true });
    await symlink(join(packageRoot, "openclaw.mjs"), join(npmPrefix, "bin", "openclaw"));
  };

  it("confines the gateway to its state, workspaces and the programs it is known to start", async () => {
    await installTools();
    const workspace = join(tempRoot, "workspaces", "mail-sentinel");
    const unit = await render(
      makeService(),
      runtimeConfig("https://matrix.example.org", [{ id: "mail-sentinel", workspace }]),
    );
    const crypto = "extensions/matrix/node_modules/@matrix-org/matrix-sdk-crypto-nodejs";
    expect(sandboxLines(unit)).toEqual([
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
      [
        "ReadWritePaths=",
        `-${paths.stateDir}`,
        ` -${paths.openclawServiceHome}`,
        ` -${join(paths.openclawServiceHome, "tmp")}`,
        ` -${workspace}`,
        ` -${join(packageRoot, crypto)}`,
        ` -${join(globalRoot, "openclaw", crypto)}`,
      ].join(""),
      `ReadOnlyPaths=-${npmPrefix}`,
      "InaccessiblePaths=-/run/docker.sock -/run/containerd/containerd.sock",
      "NoExecPaths=/ -/usr/lib/cargo",
      [
        "ExecPaths=-/usr/lib -/usr/lib64 -/lib -/lib64",
        ` -${join(toolBin, "node")}`,
        " -/usr/bin/env",
        ` -${join(toolBin, "bash")}`,
        " -/usr/local/bin/sovereign-tool",
        ` -${join(npmPrefix, "bin")}`,
        ` -${join(npmPrefix, "lib")}`,
        ` -${packageRoot}`,
        ` -${join(globalRoot, "openclaw")}`,
      ].join(""),
    ]);
    // The sandbox sits in [Service], ahead of the install section.
    expect(sectionLines(unit, "[Service]", "[Install]")).toContain("Restart=always");
  });

  it("allow-lists the file each program resolves to on a host with Rust coreutils", async () => {
    await installTools();
    // A program on the system path may itself be a link into another tree.
    const coreutils = join(tempRoot, "cargo", "bin", "coreutils");
    await mkdir(coreutils, { recursive: true });
    await rm(join(toolBin, "bash"));
    await writeFile(join(coreutils, "bash"), "#!/bin/sh\n", { mode: 0o755 });
    await symlink(join(coreutils, "bash"), join(toolBin, "bash"));
    hostProgramLinks.set("/usr/bin/env", "/usr/lib/cargo/bin/coreutils/env");

    const unit = await render(makeService(), runtimeConfig("http://127.0.0.1:8008"));

    expect(unit).toMatch(/^NoExecPaths=\/ -\/usr\/lib\/cargo$/m);
    expect(unit.match(/^ExecPaths=(.*)$/m)?.[1]?.split(" ")).toEqual([
      "-/usr/lib",
      "-/usr/lib64",
      "-/lib",
      "-/lib64",
      `-${join(toolBin, "node")}`,
      "-/usr/bin/env",
      "-/usr/lib/cargo/bin/coreutils/env",
      `-${join(toolBin, "bash")}`,
      `-${join(coreutils, "bash")}`,
      "-/usr/local/bin/sovereign-tool",
      `-${join(npmPrefix, "bin")}`,
      `-${join(npmPrefix, "lib")}`,
      `-${packageRoot}`,
      `-${join(globalRoot, "openclaw")}`,
    ]);
  });

  it("falls back to the distribution paths for programs missing from the system path", async () => {
    await mkdir(toolBin, { recursive: true });
    await writeFile(join(toolBin, "node"), "#!/bin/sh\n", { mode: 0o755 });
    const unit = await render(makeService(), runtimeConfig("http://127.0.0.1:8008"));
    const execPaths = unit.match(/^ExecPaths=(.*)$/m)?.[1]?.split(" ") ?? [];
    expect(execPaths).toEqual([
      "-/usr/lib",
      "-/usr/lib64",
      "-/lib",
      "-/lib64",
      `-${join(toolBin, "node")}`,
      "-/usr/bin/env",
      "-/usr/bin/bash",
      "-/usr/local/bin/sovereign-tool",
      `-${join(npmPrefix, "bin")}`,
      `-${join(npmPrefix, "lib")}`,
      `-${join(globalRoot, "openclaw")}`,
      `-${packageRoot}`,
    ]);
    expect(unit).toContain(`\nExecStartPre=${join(toolBin, "node")} -e "`);
  });

  it("keeps the installer's own PATH and node out of the unit", async () => {
    await installTools();
    // A version-manager or CI tool-cache node sits first on the caller's PATH,
    // inside a directory only the installing user can enter.
    const callerDir = join(tempRoot, "caller-home");
    const callerBin = join(callerDir, "toolcache", "node", "bin");
    await mkdir(callerBin, { recursive: true });
    for (const program of ["node", "bash", "sh", "openclaw"]) {
      await writeFile(join(callerBin, program), "#!/bin/sh\n", { mode: 0o755 });
    }
    await chmod(callerDir, 0o700);
    process.env.PATH = `${callerBin}:/usr/bin:/bin`;

    const unit = await render(makeService(), runtimeConfig("http://127.0.0.1:8008"));

    expect(unit).toContain(`\nEnvironment=PATH=${join(npmPrefix, "bin")}:${toolBin}\n`);
    expect(unit).toContain(`\nExecStartPre=${join(toolBin, "node")} -e "`);
    expect(unit).toContain(`\nExecStart=${join(npmPrefix, "bin", "openclaw")} gateway run`);
    expect(unit).not.toContain(callerDir);
  });

  it("starts the OpenClaw that a root install left in the installing npm's global prefix", async () => {
    await mkdir(toolBin, { recursive: true });
    await writeFile(join(toolBin, "node"), "#!/bin/sh\n", { mode: 0o755 });
    const npmGlobalPrefix = join(tempRoot, "toolcache", "node", "x64");
    const globalPackage = join(npmGlobalPrefix, "lib", "node_modules", "openclaw");
    await mkdir(globalPackage, { recursive: true });
    await writeFile(join(globalPackage, "openclaw.mjs"), "#!/usr/bin/env node\n", { mode: 0o755 });
    await mkdir(join(npmGlobalPrefix, "bin"));
    await symlink(join(globalPackage, "openclaw.mjs"), join(npmGlobalPrefix, "bin", "openclaw"));
    process.env.SOVEREIGN_NODE_OPENCLAW_GLOBAL_ROOT = join(npmGlobalPrefix, "lib", "node_modules");

    const unit = await render(makeService(), runtimeConfig("http://127.0.0.1:8008"));

    expect(unit).toContain(`\nExecStart=${join(npmGlobalPrefix, "bin", "openclaw")} gateway run`);
    expect(unit).toContain(`\nEnvironment=PATH=${join(npmPrefix, "bin")}:${toolBin}\n`);
    expect(unit).toContain(`\nExecStartPre=${join(toolBin, "node")} -e "`);
    expect(unit).toMatch(new RegExp(`^ExecPaths=.* -${globalPackage}( |$)`, "m"));
  });

  it("refuses to install the unit when no system node exists", async () => {
    await installTools();
    const systemBin = join(tempRoot, "system-bin");
    await mkdir(systemBin);
    const calls: string[] = [];
    const service = makeService({ systemSearchPath: systemBin, calls });

    await expect(
      (service as unknown as Internals).ensureSystemGatewayServiceFallback(
        runtimeConfig("http://127.0.0.1:8008"),
      ),
    ).rejects.toMatchObject({
      code: "OPENCLAW_GATEWAY_NODE_UNAVAILABLE",
      retryable: false,
      message: `The OpenClaw gateway runs as sovereign-node, but no node executable was found on the system search path ${systemBin}; install a system-wide Node.js runtime`,
      details: { searchPath: systemBin, serviceUser: "sovereign-node", problems: [] },
    });
    expect(calls.filter((call) => call.includes("systemctl"))).toEqual([]);
    await expect(access(unitPath)).rejects.toThrow();
  });

  it("refuses to install the unit when the system node is private to another user", async () => {
    await installTools();
    const privateDir = join(tempRoot, "private");
    await mkdir(join(privateDir, "bin"), { recursive: true });
    await writeFile(join(privateDir, "bin", "node"), "#!/bin/sh\n", { mode: 0o755 });
    await chmod(privateDir, 0o700);
    const systemBin = join(tempRoot, "system-bin");
    await mkdir(systemBin);
    await symlink(join(privateDir, "bin", "node"), join(systemBin, "node"));
    const calls: string[] = [];
    const service = makeService({ systemSearchPath: systemBin, calls });

    await expect(
      (service as unknown as Internals).ensureSystemGatewayServiceFallback(
        runtimeConfig("http://127.0.0.1:8008"),
      ),
    ).rejects.toMatchObject({
      code: "OPENCLAW_GATEWAY_NODE_UNAVAILABLE",
      message: `The OpenClaw gateway runs as sovereign-node, but no node on the system search path ${systemBin} is usable: ${join(systemBin, "node")} (resolves to ${join(privateDir, "bin", "node")}) is not executable by the service user: ${privateDir} (mode 0700) lacks the execute bit for other users`,
    });
    expect(calls.filter((call) => call.includes("systemctl"))).toEqual([]);
    await expect(access(unitPath)).rejects.toThrow();
  });

  it("lets agents start their exec wrappers through the shell only when they have one", async () => {
    const service = makeService();
    const internals = service as unknown as Internals;
    const command = "/usr/local/bin/sovereign-tool node-operator status --instance {id}";
    vi.spyOn(internals, "listAgentExecAllowlistCommands").mockImplementation(
      async (_config, toolInstanceIds) =>
        toolInstanceIds.flatMap((id) =>
          id === "node-operator" ? [command] : id === "relative" ? ["bin/relative.js"] : [],
        ),
    );
    vi.spyOn(internals, "agentBindsTypedTool").mockResolvedValue(false);
    await installTools();
    await writeFile(join(toolBin, "sh"), "#!/bin/sh\n", { mode: 0o755 });
    const node = join(toolBin, "node");

    expect(
      await internals.listGatewaySandboxAgentPrograms(runtimeConfig("x"), toolBin, node),
    ).toEqual([]);
    expect(
      await internals.listGatewaySandboxAgentPrograms(
        runtimeConfig("x", [
          { id: "plain", workspace: "/w" },
          { id: "relative", workspace: "/r", toolInstanceIds: ["relative"] },
        ]),
        toolBin,
        node,
      ),
    ).toEqual([]);
    const wrapper = planExecWrapper({
      wrapperRoot: MANAGED_EXEC_WRAPPER_ROOT,
      agentId: "node-operator",
      command,
    });
    const withExec = runtimeConfig("x", [
      { id: "plain", workspace: "/w" },
      { id: "node-operator", workspace: "/n", toolInstanceIds: ["node-operator"] },
    ]);
    // The wrapper runs under its `#!/bin/sh` line and execs the command itself.
    expect(await internals.listGatewaySandboxAgentPrograms(withExec, toolBin, node)).toEqual([
      join(toolBin, "sh"),
      "/bin/sh",
      wrapper?.path,
      "/usr/local/bin/sovereign-tool",
    ]);
    expect(await internals.listGatewaySandboxAgentPrograms(withExec, "", node)).toEqual([
      "/bin/sh",
      "/bin/sh",
      wrapper?.path,
      "/usr/local/bin/sovereign-tool",
    ]);

    // The shell the wrapper names is a link to the shell that actually runs.
    hostProgramLinks.set("/bin/sh", "/usr/bin/dash");
    const execPaths =
      (await render(service, withExec)).match(/^ExecPaths=(.*)$/m)?.[1]?.split(" ") ?? [];
    expect(execPaths).toContain(`-${join(toolBin, "sh")}`);
    expect(execPaths).toContain("-/bin/sh");
    expect(execPaths).toContain("-/usr/bin/dash");
    expect(execPaths).toContain(`-${wrapper?.path}`);
  });

  it("lets a typed tool start its CLI with the gateway's node binary", async () => {
    const service = makeService();
    const internals = service as unknown as Internals;
    vi.spyOn(internals, "listAgentExecAllowlistCommands").mockResolvedValue([]);
    vi.spyOn(internals, "agentBindsTypedTool").mockImplementation(
      async (_config, toolInstanceIds) => toolInstanceIds.includes("mail-sentinel-core"),
    );
    await installTools();
    // The typed tool spawns `process.execPath`, which is the node binary with
    // symlinks resolved, so a node on PATH that is a symlink adds its target.
    const nodeDist = join(tempRoot, "node-dist", "bin");
    await mkdir(nodeDist, { recursive: true });
    await rm(join(toolBin, "node"));
    await writeFile(join(nodeDist, "node"), "#!/bin/sh\n", { mode: 0o755 });
    await symlink(join(nodeDist, "node"), join(toolBin, "node"));
    const typed = runtimeConfig("x", [
      { id: "plain", workspace: "/w" },
      { id: "mail-sentinel", workspace: "/m", toolInstanceIds: ["mail-sentinel-core"] },
    ]);

    expect(
      await internals.listGatewaySandboxAgentPrograms(
        runtimeConfig("x", [{ id: "plain", workspace: "/w", toolInstanceIds: ["other"] }]),
        toolBin,
        join(toolBin, "node"),
      ),
    ).toEqual([]);
    expect(
      await internals.listGatewaySandboxAgentPrograms(typed, toolBin, join(toolBin, "node")),
    ).toEqual([join(toolBin, "node"), join(nodeDist, "node")]);
    expect(await internals.resolveTypedToolSandboxPrograms(join(tempRoot, "missing-node"))).toEqual(
      [join(tempRoot, "missing-node")],
    );

    const unit = await render(service, typed);
    const execPaths = unit.match(/^ExecPaths=(.*)$/m)?.[1]?.split(" ") ?? [];
    expect(execPaths).toContain(`-${join(toolBin, "node")}`);
    expect(execPaths).toContain(`-${join(nodeDist, "node")}`);
    // The CLI script itself is only read by node: it lives in the OpenClaw
    // home, which stays readable, and is never added to the exec set.
    expect(unit).toMatch(new RegExp(`^ReadWritePaths=.* -${paths.openclawServiceHome}( |$)`, "m"));
    expect(execPaths.some((path) => path.startsWith(`-${paths.openclawServiceHome}`))).toBe(false);
  });
});

describe("bot service unit sandbox", () => {
  const workspace = "/var/lib/sovereign-node/mail-sentinel/workspace";
  const npmBin = "/var/lib/sovereign-node/.npm-global/bin";
  const service = (): Internals =>
    new RealInstallerService(
      createLogger(),
      {
        configPath: "/etc/sovereign-node/sovereign-node.json5",
        secretsDir: "/etc/sovereign-node/secrets",
        stateDir: "/var/lib/sovereign-node",
        logsDir: "/var/log/sovereign-node",
        installJobsDir: "/var/lib/sovereign-node/install-jobs",
        openclawServiceHome: "/var/lib/sovereign-node/openclaw-home",
        provenancePath: "/var/lib/sovereign-node/install-provenance.json",
        backupsDir: "/var/lib/sovereign-node/backups",
      },
      {} as unknown as ConstructorParameters<typeof RealInstallerService>[2],
    ) as unknown as Internals;

  const scanResource = (workingDirectory?: string) => ({
    id: "scan-service",
    kind: "systemdService",
    spec: {
      name: "sovereign-mail-sentinel-scan.service",
      description: "Sovereign Mail Sentinel Scan mail-sentinel",
      after: [],
      wants: [],
      type: "oneshot",
      ...(workingDirectory === undefined ? {} : { workingDirectory }),
      environment: {},
      execStart: ["/usr/bin/env", "node", `${workspace}/bin/mail-sentinel.js`, "scan"],
      wantedBy: [],
      desiredState: { enabled: false, active: false },
    },
  });

  it("sandboxes the mail-sentinel scan unit to its state, workspace and known programs", () => {
    const programs = [
      "/usr/bin/node",
      "/usr/bin/env",
      "/usr/bin/bash",
      "/usr/local/bin/sovereign-tool",
      "/usr/bin/cat",
    ];
    const unit = service().renderSystemdServiceResource(
      { serviceNpmBinDir: npmBin, agent: { workspace }, sandboxPrograms: programs },
      scanResource(workspace),
    );
    expect(sectionLines(unit, "[Service]", "[Install]")).toEqual([
      "[Service]",
      "Type=oneshot",
      `WorkingDirectory=${workspace}`,
      `ExecStart=/usr/bin/env node ${workspace}/bin/mail-sentinel.js scan`,
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
      `ReadWritePaths=-/var/lib/sovereign-node -/var/lib/sovereign-node/openclaw-home -${workspace}`,
      "ReadOnlyPaths=-/var/lib/sovereign-node/.npm-global",
      "InaccessiblePaths=-/run/docker.sock -/run/containerd/containerd.sock",
      "NoExecPaths=/ -/usr/lib/cargo",
      [
        "ExecPaths=-/usr/lib -/usr/lib64 -/lib -/lib64",
        " -/usr/bin/node -/usr/bin/env -/usr/bin/bash -/usr/local/bin/sovereign-tool -/usr/bin/cat",
        " -/var/lib/sovereign-node/.npm-global/bin -/var/lib/sovereign-node/.npm-global/lib",
      ].join(""),
    ]);
  });

  it("lets the scan unit start the Mail Sentinel CLI that the typed tool also runs", async () => {
    const internals = service();
    const binDir = await mkdtemp(join(tmpdir(), "sovereign-sandbox-scan-cli-"));
    try {
      await writeFile(join(binDir, "node"), "#!/bin/sh\n", { mode: 0o755 });
      const unit = internals.renderSystemdServiceResource(
        {
          serviceNpmBinDir: binDir,
          agent: { workspace },
          sandboxPrograms: await internals.resolveBotServiceSandboxPrograms(binDir, ""),
        },
        scanResource(workspace),
      );
      const execPaths = unit.match(/^ExecPaths=(.*)$/m)?.[1]?.split(" ") ?? [];
      // ExecStart goes through env to the node on the unit PATH, and the CLI's
      // status reads start the sovereign-tool CLI.
      expect(unit).toContain(`ExecStart=/usr/bin/env node ${workspace}/bin/mail-sentinel.js scan`);
      expect(execPaths).toEqual(
        expect.arrayContaining([
          "-/usr/bin/env",
          `-${join(binDir, "node")}`,
          "-/usr/local/bin/sovereign-tool",
        ]),
      );
    } finally {
      await rm(binDir, { recursive: true, force: true });
    }
  });

  it("needs no working directory to sandbox a unit", () => {
    const unit = service().renderSystemdServiceResource(
      { agent: { workspace }, sandboxPrograms: [] },
      scanResource(),
    );
    expect(unit).not.toContain("WorkingDirectory=");
    expect(unit).toContain(
      `ReadWritePaths=-/var/lib/sovereign-node -/var/lib/sovereign-node/openclaw-home -${workspace}\n`,
    );
  });

  it("also makes a working directory outside the agent workspace writable", () => {
    const unit = service().renderSystemdServiceResource(
      { agent: { workspace }, sandboxPrograms: ["/usr/bin/node"] },
      scanResource("/srv/scan"),
    );
    expect(unit).toContain(
      `ReadWritePaths=-/var/lib/sovereign-node -/var/lib/sovereign-node/openclaw-home -${workspace} -/srv/scan\n`,
    );
    expect(unit).not.toContain("ReadOnlyPaths=");
    expect(unit).toContain("ExecPaths=-/usr/lib -/usr/lib64 -/lib -/lib64 -/usr/bin/node\n");
  });

  it("resolves the scan unit's programs from the service npm prefix and the system PATH", async () => {
    const internals = service();
    const binDir = await realpath(await mkdtemp(join(tmpdir(), "sovereign-sandbox-programs-")));
    try {
      expect(await internals.resolveBotServiceSandboxPrograms(join(binDir, "missing"), "")).toEqual(
        [
          "/usr/bin/node",
          "/usr/bin/env",
          "/usr/bin/bash",
          "/usr/local/bin/sovereign-tool",
          "/usr/bin/cat",
        ],
      );
      for (const program of ["node", "bash", "cat"]) {
        await writeFile(join(binDir, program), "#!/bin/sh\n", { mode: 0o755 });
      }
      expect(await internals.resolveBotServiceSandboxPrograms(binDir)).toEqual([
        join(binDir, "node"),
        "/usr/bin/env",
        join(binDir, "bash"),
        "/usr/local/bin/sovereign-tool",
        join(binDir, "cat"),
      ]);
    } finally {
      await rm(binDir, { recursive: true, force: true });
    }
  });

  it("adds the file each scan unit program resolves to on a host with Rust coreutils", async () => {
    const internals = service();
    const binDir = await realpath(await mkdtemp(join(tmpdir(), "sovereign-sandbox-uutils-")));
    try {
      hostProgramLinks.set("/usr/bin/env", "/usr/lib/cargo/bin/coreutils/env");
      hostProgramLinks.set("/usr/bin/cat", "/usr/lib/cargo/bin/coreutils/cat");
      expect(await internals.resolveBotServiceSandboxPrograms(join(binDir, "missing"), "")).toEqual(
        [
          "/usr/bin/node",
          "/usr/bin/env",
          "/usr/lib/cargo/bin/coreutils/env",
          "/usr/bin/bash",
          "/usr/local/bin/sovereign-tool",
          "/usr/bin/cat",
          "/usr/lib/cargo/bin/coreutils/cat",
        ],
      );
      // lobster finds cat on the unit PATH, where it may be a link as well.
      const coreutils = join(binDir, "cargo", "bin", "coreutils");
      await mkdir(coreutils, { recursive: true });
      await writeFile(join(coreutils, "cat"), "#!/bin/sh\n", { mode: 0o755 });
      await symlink(join(coreutils, "cat"), join(binDir, "cat"));
      await writeFile(join(binDir, "node"), "#!/bin/sh\n", { mode: 0o755 });
      expect(await internals.resolveBotServiceSandboxPrograms(binDir, "")).toEqual([
        join(binDir, "node"),
        "/usr/bin/env",
        "/usr/lib/cargo/bin/coreutils/env",
        "/usr/bin/bash",
        "/usr/local/bin/sovereign-tool",
        join(binDir, "cat"),
        join(coreutils, "cat"),
      ]);
    } finally {
      await rm(binDir, { recursive: true, force: true });
    }
  });
});

describe("renderSystemGatewayMatrixWaitCommand", () => {
  it("polls the homeserver from node, escaping what systemd would expand", () => {
    const command = renderSystemGatewayMatrixWaitCommand({
      nodeCommand: "/usr/bin/node",
      adminBaseUrl: "http://127.0.0.1:8008/it's%20here/",
      attempts: 120,
      delaySeconds: 2,
      timeoutSeconds: 5,
    });
    expect(command).toBe(
      [
        '/usr/bin/node -e "(async()=>{for(let i=0;i<120;i++){',
        "try{const r=await fetch('http://127.0.0.1:8008/_matrix/client/versions',",
        "{signal:AbortSignal.timeout(5000)});if(r.status<400)process.exit(0)}catch{}",
        'await new Promise((d)=>setTimeout(d,2000))}process.exit(1)})()"',
      ].join(""),
    );
    const quoted = renderSystemGatewayMatrixWaitCommand({
      nodeCommand: "/usr/bin/node",
      adminBaseUrl: "http://localhost:8008",
      attempts: 1,
      delaySeconds: 1,
      timeoutSeconds: 1,
    });
    expect(quoted).not.toMatch(/\$|\\/);
  });

  it("keeps quotes and percent signs from the base URL inert", () => {
    // An absolute versions path replaces any base path, so exercise the
    // escaping through the host part instead.
    const command = renderSystemGatewayMatrixWaitCommand({
      nodeCommand: "/usr/bin/node",
      adminBaseUrl: "http://user'%41@localhost:8008",
      attempts: 1,
      delaySeconds: 1,
      timeoutSeconds: 1,
    });
    expect(command).toContain("fetch('http://user%%27%%41@localhost:8008/_matrix/client/versions'");
  });
});
