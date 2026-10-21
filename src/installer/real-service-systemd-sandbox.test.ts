import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SovereignPaths } from "../config/paths.js";
import { createLogger } from "../logging/logger.js";
import type { ExecInput, ExecResult } from "../system/exec.js";
import { RealInstallerService } from "./real-service.js";
import type { RuntimeConfig } from "./real-service-shared.js";
import { renderSystemGatewayMatrixWaitCommand } from "./real-service-utils.js";

type Internals = {
  ensureSystemGatewayServiceFallback(config: RuntimeConfig): Promise<{ ready: boolean }>;
  listGatewaySandboxAgentPrograms(config: RuntimeConfig, searchPath: string): Promise<string[]>;
  listAgentExecAllowlistPatterns(
    config: RuntimeConfig,
    toolInstanceIds: string[],
  ): Promise<string[]>;
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

  const makeService = (): RealInstallerService =>
    new RealInstallerService(createLogger(), paths, {
      fetchImpl: async () => new Response("", { status: 200 }),
      execRunner: {
        run: async ({ command, args }: ExecInput): Promise<ExecResult> => {
          const serialized = [command, ...(args ?? [])].join(" ");
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
    process.env.PATH = toolBin;
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
      "NoExecPaths=/",
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

  it("falls back to the distribution paths when nothing resolves on the unit PATH", async () => {
    process.env.PATH = "";
    const unit = await render(makeService(), runtimeConfig("http://127.0.0.1:8008"));
    const execPaths = unit.match(/^ExecPaths=(.*)$/m)?.[1]?.split(" ") ?? [];
    expect(execPaths).toEqual([
      "-/usr/lib",
      "-/usr/lib64",
      "-/lib",
      "-/lib64",
      "-/usr/bin/node",
      "-/usr/bin/env",
      "-/usr/bin/bash",
      "-/usr/local/bin/sovereign-tool",
      `-${join(npmPrefix, "bin")}`,
      `-${join(npmPrefix, "lib")}`,
      `-${join(globalRoot, "openclaw")}`,
      `-${packageRoot}`,
    ]);
    expect(unit).toMatch(/^ExecStartPre=\/usr\/bin\/node -e "/m);
  });

  it("lets agents start their exec allowlist through the shell only when they have one", async () => {
    const service = makeService();
    const internals = service as unknown as Internals;
    vi.spyOn(internals, "listAgentExecAllowlistPatterns").mockImplementation(
      async (_config, toolInstanceIds) =>
        toolInstanceIds.map((id) => `/var/lib/sovereign-node/${id}/workspace/bin/${id}.js`),
    );
    await installTools();
    await writeFile(join(toolBin, "sh"), "#!/bin/sh\n", { mode: 0o755 });

    expect(await internals.listGatewaySandboxAgentPrograms(runtimeConfig("x"), toolBin)).toEqual(
      [],
    );
    expect(
      await internals.listGatewaySandboxAgentPrograms(
        runtimeConfig("x", [{ id: "plain", workspace: "/w" }]),
        toolBin,
      ),
    ).toEqual([]);
    const withExec = runtimeConfig("x", [
      { id: "plain", workspace: "/w" },
      { id: "mail-sentinel", workspace: "/m", toolInstanceIds: ["mail-sentinel"] },
    ]);
    expect(await internals.listGatewaySandboxAgentPrograms(withExec, toolBin)).toEqual([
      join(toolBin, "sh"),
      "/var/lib/sovereign-node/mail-sentinel/workspace/bin/mail-sentinel.js",
    ]);
    expect(await internals.listGatewaySandboxAgentPrograms(withExec, "")).toEqual([
      "/bin/sh",
      "/var/lib/sovereign-node/mail-sentinel/workspace/bin/mail-sentinel.js",
    ]);

    process.env.PATH = toolBin;
    const execPaths =
      (await render(service, withExec)).match(/^ExecPaths=(.*)$/m)?.[1]?.split(" ") ?? [];
    expect(execPaths).toContain(`-${join(toolBin, "sh")}`);
    expect(execPaths).toContain(
      "-/var/lib/sovereign-node/mail-sentinel/workspace/bin/mail-sentinel.js",
    );
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
      "NoExecPaths=/",
      [
        "ExecPaths=-/usr/lib -/usr/lib64 -/lib -/lib64",
        " -/usr/bin/node -/usr/bin/env -/usr/bin/bash -/usr/local/bin/sovereign-tool -/usr/bin/cat",
        " -/var/lib/sovereign-node/.npm-global/bin -/var/lib/sovereign-node/.npm-global/lib",
      ].join(""),
    ]);
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
    const binDir = await mkdtemp(join(tmpdir(), "sovereign-sandbox-programs-"));
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
