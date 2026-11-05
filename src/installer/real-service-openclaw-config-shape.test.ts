import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SovereignPaths } from "../config/paths.js";
import { createLogger } from "../logging/logger.js";
import type { ExecInput, ExecResult } from "../system/exec.js";
import type { GatewayReadinessOutcome } from "./gateway-readiness.js";
import { RealInstallerService } from "./real-service.js";
import type { RuntimeConfig } from "./real-service-shared.js";

vi.mock("../system/service-node.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../system/service-node.js")>()),
  resolveServiceNode: async () => ({ ok: true, path: "/usr/bin/node" }),
}));

const GATEWAY_URL = "http://127.0.0.1:18789/";

type Internals = {
  gatewayReadinessClock: { now: () => number; sleep: (ms: number) => Promise<void> };
  writeOpenClawRuntimeArtifacts(config: RuntimeConfig): Promise<void>;
  ensureSystemGatewayServiceFallback(config: RuntimeConfig): Promise<GatewayReadinessOutcome>;
};

type RenderedConfig = {
  meta?: Record<string, unknown>;
  gateway?: { mode?: string; bind?: string; auth?: Record<string, unknown> };
  agents?: {
    list?: Array<{ id: string; default?: boolean }>;
    entries?: Record<string, { tools?: { deny?: string[] } }>;
    ownership?: string;
  };
  tools?: { deny?: string[]; web?: { search?: { enabled?: boolean; provider?: string } } };
};

/**
 * What an OpenClaw 2026.8 gateway does with the rendered files on its first
 * start, reduced to the two ways that start fails:
 * - a 2026.3-only key makes the strict config invalid and blocks the start;
 * - with no web-search provider chosen and search not turned off, every search
 *   plugin whose credential is in the environment counts as configured; the
 *   missing one is installed at startup, that install cannot take the
 *   plugin's capability consent, the gateway exits 1 and systemd restarts it
 *   into the same attempt.
 */
const startOpenClaw2026_8Gateway = (
  config: RenderedConfig,
  env: Record<string, string>,
): { ready: boolean; pluginInstallAttempts: string[] } => {
  if (config.agents?.list !== undefined || config.meta?.lastTouchedAt !== undefined) {
    return { ready: false, pluginInstallAttempts: [] };
  }
  const search = config.tools?.web?.search;
  const searchConfigured =
    search?.enabled !== false &&
    search?.provider === undefined &&
    (env.PERPLEXITY_API_KEY !== undefined || env.OPENROUTER_API_KEY !== undefined);
  return searchConfigured
    ? { ready: false, pluginInstallAttempts: ["perplexity"] }
    : { ready: true, pluginInstallAttempts: [] };
};

describe("OpenClaw config shape follows the installed OpenClaw", () => {
  let tempRoot: string;
  let paths: SovereignPaths;
  let clock: number;
  let execCalls: string[];
  let priorUnitPath: string | undefined;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-openclaw-shape-"));
    paths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };
    clock = 0;
    execCalls = [];
    priorUnitPath = process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH;
    process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH = join(tempRoot, "gateway.service");
    await mkdir(join(tempRoot, "secrets"), { recursive: true });
    await writeFile(join(tempRoot, "secrets", "openrouter"), "sk-or-test\n", "utf8");
    await writeFile(join(tempRoot, "secrets", "matrix-token"), "syt-test\n", "utf8");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (priorUnitPath === undefined) {
      delete process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH;
    } else {
      process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH = priorUnitPath;
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  const runtimeConfig = (): RuntimeConfig => {
    const openclawHome = paths.openclawServiceHome;
    return {
      openrouter: {
        model: "qwen/qwen3.5-9b",
        apiKeySecretRef: `file:${join(tempRoot, "secrets", "openrouter")}`,
        privacy: { zdr: true, dataCollection: "deny", allowFallbacks: false },
      },
      openclaw: {
        managedInstallation: true,
        installMethod: "install_sh",
        requestedVersion: "pinned-by-sovereign",
        openclawHome,
        runtimeConfigPath: join(openclawHome, ".openclaw", "openclaw.json5"),
        runtimeProfilePath: join(openclawHome, ".openclaw", "sovereign-profile.json"),
        gatewayEnvPath: join(openclawHome, "gateway.env"),
      },
      openclawProfile: {
        plugins: { allow: ["matrix"] },
        agents: [
          {
            id: "node-operator",
            workspace: join(paths.stateDir, "node-operator", "workspace"),
            default: true,
          },
        ],
        crons: [],
      },
      imap: {
        status: "pending",
        protocol: "imap",
        host: "imap.example.org",
        port: 993,
        tls: true,
        username: "operator@example.org",
        mailbox: "INBOX",
        secretRef: "file:/dev/null",
      },
      bots: { config: {}, instances: [] },
      matrix: {
        accessMode: "direct",
        homeserverDomain: "matrix.example.org",
        federationEnabled: false,
        publicBaseUrl: "https://matrix.example.org",
        adminBaseUrl: "http://127.0.0.1:8008",
        operator: { userId: "@operator:matrix.example.org" },
        bot: {
          localpart: "sovereign-bot",
          userId: "@sovereign-bot:matrix.example.org",
          accessTokenSecretRef: `file:${join(tempRoot, "secrets", "matrix-token")}`,
        },
        alertRoom: { roomId: "!alerts:matrix.example.org", roomName: "Alerts" },
      },
      templates: { installed: [] },
      sovereignTools: { instances: [] },
    } as unknown as RuntimeConfig;
  };

  const makeService = (input: {
    installedVersion: string | null;
    gateway?: () => Promise<{ ready: boolean }>;
    logger?: ReturnType<typeof createLogger>;
  }) => {
    const service = new RealInstallerService(input.logger ?? createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () =>
          input.installedVersion === null
            ? null
            : { binaryPath: "/usr/bin/openclaw", version: input.installedVersion },
        ensureInstalled: async () => {
          throw new Error("not used");
        },
      },
      openclawGatewayServiceManager: {
        install: async () => {},
        start: async () => {},
        restart: async () => {},
      },
      execRunner: {
        run: async (call: ExecInput): Promise<ExecResult> => {
          const serialized = [call.command, ...(call.args ?? [])].join(" ");
          execCalls.push(serialized);
          return { command: serialized, exitCode: 0, stdout: "", stderr: "" };
        },
      },
      fetchImpl: async (url: string) => {
        if (url === GATEWAY_URL && input.gateway !== undefined) {
          if (!(await input.gateway()).ready) {
            throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
          }
        }
        return new Response("not found", { status: 404 });
      },
    } as unknown as ConstructorParameters<typeof RealInstallerService>[2]);
    const internals = service as unknown as Internals;
    internals.gatewayReadinessClock = {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    };
    return internals;
  };

  const readRendered = async (config: RuntimeConfig): Promise<RenderedConfig> =>
    JSON.parse(await readFile(config.openclaw.runtimeConfigPath, "utf8")) as RenderedConfig;

  const readGatewayEnv = async (config: RuntimeConfig): Promise<Record<string, string>> =>
    Object.fromEntries(
      (await readFile(config.openclaw.gatewayEnvPath, "utf8"))
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );

  it("keeps the 2026.3 shape while 2026.3 is installed", async () => {
    const config = runtimeConfig();
    await makeService({ installedVersion: "2026.3.13" }).writeOpenClawRuntimeArtifacts(config);

    const rendered = await readRendered(config);
    expect(rendered.agents?.list).toEqual([expect.objectContaining({ id: "node-operator" })]);
    expect(rendered.agents?.entries).toBeUndefined();
    // The 2026.3 render is unchanged: no 2026.8-only settings leak into it.
    expect(rendered.tools?.web).toBeUndefined();
    expect(rendered.agents?.ownership).toBeUndefined();
  });

  it("renders the 2026.8 shape when 2026.8 is installed", async () => {
    const config = runtimeConfig();
    await makeService({ installedVersion: "2026.8.35" }).writeOpenClawRuntimeArtifacts(config);

    const rendered = await readRendered(config);
    expect(rendered.agents?.list).toBeUndefined();
    expect(rendered.agents?.ownership).toBe("explicit");
    expect(Object.keys(rendered.agents?.entries ?? {})).toEqual(["node-operator"]);
  });

  it("uses the version that last wrote the config when the CLI cannot be run", async () => {
    const config = runtimeConfig();
    await mkdir(join(paths.openclawServiceHome, ".openclaw"), { recursive: true });
    await writeFile(
      config.openclaw.runtimeConfigPath,
      JSON.stringify({ meta: { lastTouchedVersion: "2026.8.35", lastTouchedAt: "x" } }),
      "utf8",
    );
    await makeService({ installedVersion: null }).writeOpenClawRuntimeArtifacts(config);

    const rendered = await readRendered(config);
    expect(rendered.agents?.ownership).toBe("explicit");
    expect(rendered.meta).toEqual({
      lastTouchedVersion: "2026.8.35",
      migrations: { modelPolicyAllowlist: true },
    });
  });

  it("falls back to the requested version without a CLI or an earlier config", async () => {
    const config = runtimeConfig();
    config.openclaw.requestedVersion = "2026.8.35";
    await makeService({ installedVersion: null }).writeOpenClawRuntimeArtifacts(config);

    expect((await readRendered(config)).agents?.ownership).toBe("explicit");
  });

  it("starts a 2026.8 gateway after the upgrade with OPENROUTER_API_KEY in its environment", async () => {
    const config = runtimeConfig();
    const attempts: string[] = [];
    let starts = 0;
    const service = makeService({
      installedVersion: "2026.8.35",
      gateway: async () => {
        starts += 1;
        const result = startOpenClaw2026_8Gateway(
          await readRendered(config),
          await readGatewayEnv(config),
        );
        attempts.push(...result.pluginInstallAttempts);
        return result;
      },
    });

    await service.writeOpenClawRuntimeArtifacts(config);
    const env = await readGatewayEnv(config);
    expect(env.OPENROUTER_API_KEY).toBe("sk-or-test");

    const outcome = await service.ensureSystemGatewayServiceFallback(config);

    expect(outcome).toMatchObject({ unitStarted: true, ready: true, waitedMs: 0 });
    expect(starts).toBe(1);
    expect(attempts).toEqual([]);
    expect(execCalls.filter((call) => call.includes("plugins install"))).toEqual([]);

    // Turning search off removes nothing: no node agent may call web_search.
    const rendered = await readRendered(config);
    expect(rendered.tools?.deny).toContain("web_search");
    for (const entry of Object.values(rendered.agents?.entries ?? {})) {
      expect(entry.tools?.deny).toEqual(expect.arrayContaining(["web_search"]));
    }

    // The unit lets the gateway load native addons of plugins 2026.8 installs
    // into its own state dir.
    const unit = await readFile(join(tempRoot, "gateway.service"), "utf8");
    expect(unit).toMatch(
      new RegExp(`^ExecPaths=.*${join(paths.openclawServiceHome, ".openclaw", "npm")}`, "m"),
    );
  });

  it("models the restart loop the render prevents", async () => {
    const config = runtimeConfig();
    const attempts: string[] = [];
    const service = makeService({
      installedVersion: "2026.8.35",
      gateway: async () => {
        const rendered = await readRendered(config);
        const { web: _web, ...tools } = rendered.tools ?? {};
        const result = startOpenClaw2026_8Gateway(
          { ...rendered, tools },
          await readGatewayEnv(config),
        );
        attempts.push(...result.pluginInstallAttempts);
        return result;
      },
    });
    await service.writeOpenClawRuntimeArtifacts(config);

    const outcome = await service.ensureSystemGatewayServiceFallback(config);

    expect(outcome.ready).toBe(false);
    expect(new Set(attempts)).toEqual(new Set(["perplexity"]));
    expect(attempts.length).toBeGreaterThan(1);
  });

  it("does not let a 2026.3 gateway unit execute from the OpenClaw state dir", async () => {
    const config = runtimeConfig();
    const service = makeService({
      installedVersion: "2026.3.13",
      gateway: async () => ({ ready: true }),
    });
    await service.writeOpenClawRuntimeArtifacts(config);

    await service.ensureSystemGatewayServiceFallback(config);

    const unit = await readFile(join(tempRoot, "gateway.service"), "utf8");
    expect(unit).not.toContain(join(paths.openclawServiceHome, ".openclaw", "npm"));
  });

  describe("gateway auth", () => {
    const writeExisting = async (config: RuntimeConfig, payload: Record<string, unknown>) => {
      await mkdir(join(paths.openclawServiceHome, ".openclaw"), { recursive: true });
      await writeFile(config.openclaw.runtimeConfigPath, JSON.stringify(payload), "utf8");
    };

    it.each([
      "2026.3.13",
      "2026.8.35",
    ])("renders a generated gateway token on a fresh %s install and keeps it on re-render", async (installedVersion) => {
      const config = runtimeConfig();
      const service = makeService({ installedVersion });
      await service.writeOpenClawRuntimeArtifacts(config);

      const first = await readRendered(config);
      expect(first.gateway).toEqual({
        mode: "local",
        bind: "loopback",
        auth: { mode: "token", token: expect.stringMatching(/^[0-9a-f]{64}$/) },
      });

      await service.writeOpenClawRuntimeArtifacts(config);
      expect((await readRendered(config)).gateway?.auth).toEqual(first.gateway?.auth);
    });

    it("keeps the token the gateway persisted itself across re-renders and an OpenClaw upgrade", async () => {
      const config = runtimeConfig();
      const persisted = { mode: "token", token: "c".repeat(48) };
      await writeExisting(config, {
        meta: { lastTouchedVersion: "2026.3.13" },
        gateway: { mode: "local", bind: "loopback", auth: persisted },
      });

      await makeService({ installedVersion: "2026.3.13" }).writeOpenClawRuntimeArtifacts(config);
      expect((await readRendered(config)).gateway?.auth).toEqual(persisted);

      await makeService({ installedVersion: "2026.8.35" }).writeOpenClawRuntimeArtifacts(config);
      const rendered = await readRendered(config);
      expect(rendered.agents?.ownership).toBe("explicit");
      expect(rendered.gateway?.auth).toEqual(persisted);
    });

    it("keeps a token secret reference instead of replacing it with a literal", async () => {
      const config = runtimeConfig();
      const auth = { mode: "token", token: { source: "env", provider: "default", id: "GW" } };
      await writeExisting(config, { gateway: { mode: "local", auth } });

      await makeService({ installedVersion: "2026.8.35" }).writeOpenClawRuntimeArtifacts(config);

      expect((await readRendered(config)).gateway?.auth).toEqual(auth);
    });

    it("fills in a token when the existing auth block has none", async () => {
      const config = runtimeConfig();
      await writeExisting(config, { gateway: { mode: "local", auth: { mode: "token" } } });

      await makeService({ installedVersion: "2026.8.35" }).writeOpenClawRuntimeArtifacts(config);

      expect((await readRendered(config)).gateway?.auth).toEqual({
        mode: "token",
        token: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
    });

    it("keeps the token only in the owner-only runtime config, never in a log or the gateway env", async () => {
      const config = runtimeConfig();
      const logLines: string[] = [];
      const logger = pino({ level: "trace" }, { write: (line: string) => logLines.push(line) });
      await makeService({
        installedVersion: "2026.8.35",
        logger: logger as unknown as ReturnType<typeof createLogger>,
      }).writeOpenClawRuntimeArtifacts(config);

      const token = (await readRendered(config)).gateway?.auth?.token;
      expect(typeof token).toBe("string");
      expect((await stat(config.openclaw.runtimeConfigPath)).mode & 0o777).toBe(0o600);
      expect(await readFile(config.openclaw.gatewayEnvPath, "utf8")).not.toContain(token);
      expect(await readFile(config.openclaw.runtimeProfilePath, "utf8")).not.toContain(token);
      expect(logLines.join("\n")).not.toContain(token);
    });
  });

  it("refuses the 2026.3 shape on a 2026.8 gateway", () => {
    expect(
      startOpenClaw2026_8Gateway(
        { agents: { list: [{ id: "node-operator", default: true }] } },
        {},
      ),
    ).toEqual({ ready: false, pluginInstallAttempts: [] });
  });
});
