import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SovereignPaths } from "../config/paths.js";
import { createLogger } from "../logging/logger.js";
import type { OpenClawBootstrapper } from "../openclaw/bootstrap.js";
import type { ImapTester } from "../system/imap.js";
import type { BundledMatrixProvisioner } from "../system/matrix.js";
import type { HostPreflightChecker } from "../system/preflight.js";
import { RealInstallerService } from "./real-service.js";
import type { FetchLike } from "./real-service-shared.js";

// Minimal no-op collaborators: the readiness method only touches the runtime
// config on disk and fetchImpl, so the rest can be inert stubs.
const noopDeps = {
  openclawBootstrapper: {
    detectInstalled: async () => null,
    ensureInstalled: async () => ({
      binaryPath: "/usr/local/bin/openclaw",
      version: "pinned-by-sovereign",
      installMethod: "install_sh" as const,
    }),
  } as unknown as OpenClawBootstrapper,
  openclawGatewayServiceManager: {
    install: async () => {},
    start: async () => {},
    restart: async () => {},
  },
  preflightChecker: {
    run: async () => ({
      mode: "bundled_matrix",
      overall: "pass",
      checks: [],
      recommendedActions: [],
    }),
  } as unknown as HostPreflightChecker,
  imapTester: {
    test: async () => ({ ok: true, host: "h", port: 993, tls: true, auth: "ok" as const }),
  } as unknown as ImapTester,
  matrixProvisioner: {
    provision: async () => {
      throw new Error("not used");
    },
  } as unknown as BundledMatrixProvisioner,
};

type ConfigOverrides = {
  publicBaseUrl?: string;
  accessMode?: "direct" | "relay";
  relay?: {
    type: "http" | "https";
    hostname?: string;
    withDns01?: boolean;
  };
};

const writeRuntimeConfig = async (
  configPath: string,
  overrides: ConfigOverrides,
): Promise<void> => {
  const publicBaseUrl = overrides.publicBaseUrl ?? "https://node.relay.example.com";
  const config: Record<string, unknown> = {
    matrix: {
      accessMode: overrides.accessMode ?? "direct",
      publicBaseUrl,
      adminBaseUrl: "http://127.0.0.1:8008",
      homeserverDomain: "node.relay.example.com",
      operator: { userId: "@operator:node.relay.example.com" },
      bot: {
        userId: "@bot:node.relay.example.com",
        accessTokenSecretRef: "file:/tmp/bot.token",
      },
      alertRoom: { roomId: "!room:node.relay.example.com", roomName: "Alerts" },
    },
  };
  if (overrides.relay) {
    config.relay = {
      enabled: true,
      controlUrl: "https://relay.example.com",
      hostname: overrides.relay.hostname ?? "node.relay.example.com",
      publicBaseUrl,
      serviceName: "sovereign-matrix-relay-tunnel.service",
      configPath: "/etc/sovereign-node/relay/frpc.toml",
      connected: true,
      tunnel: {
        serverAddr: "relay.example.com",
        serverPort: 7000,
        tokenSecretRef: "file:/tmp/relay.token",
        proxyName: "node",
        type: overrides.relay.type,
        localIp: "127.0.0.1",
        localPort: overrides.relay.type === "https" ? 18443 : 18080,
      },
      ...(overrides.relay.withDns01
        ? {
            dns01: {
              provider: "desec",
              apiBase: "https://desec.io/api/v1",
              zone: "relay.example.com",
              subname: "_acme-challenge.node",
            },
          }
        : {}),
    };
  }
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
};

describe("getMatrixOnboardingReadiness", () => {
  let tempRoot: string;
  let paths: SovereignPaths;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "onboarding-ready-"));
    paths = {
      configPath: join(tempRoot, "sovereign-node.json"),
      secretsDir: join(tempRoot, "secrets"),
      stateDir: join(tempRoot, "state"),
      logsDir: join(tempRoot, "logs"),
      installJobsDir: join(tempRoot, "jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const buildService = (fetchImpl: FetchLike): RealInstallerService => {
    const service = new RealInstallerService(createLogger(), paths, { ...noopDeps, fetchImpl });
    // Shrink the per-attempt probe timeout so the not-reachable paths (which hit
    // the timeout against non-listening/non-routable hosts) don't add seconds.
    (
      service as unknown as { onboardingReadinessProbeTimeoutMs: number }
    ).onboardingReadinessProbeTimeoutMs = 50;
    return service;
  };

  it("returns config-not-found (not an error) when no config is written yet", async () => {
    const service = buildService(async () => new Response("", { status: 200 }));
    const result = await service.getMatrixOnboardingReadiness();
    expect(result).toMatchObject({
      ready: false,
      url: "",
      mode: "direct",
      reason: "config-not-found",
    });
  });

  it("reports onboarding-unavailable for a plaintext (non-https, non-relay) install", async () => {
    await writeRuntimeConfig(paths.configPath, {
      accessMode: "direct",
      publicBaseUrl: "http://node.local.test",
    });
    // http:// + direct is below the https/relay bar, so the page is not exposed.
    const service = buildService(async () => new Response("", { status: 200 }));
    const result = await service.getMatrixOnboardingReadiness();
    expect(result).toMatchObject({ ready: false, reason: "onboarding-unavailable" });
  });

  it("is ready when the public onboarding URL returns 200 (relay passthrough)", async () => {
    await writeRuntimeConfig(paths.configPath, {
      accessMode: "relay",
      relay: { type: "https", withDns01: true },
    });
    let requested = "";
    const service = buildService(async (input) => {
      requested = input;
      return new Response("<html>onboard</html>", { status: 200 });
    });
    const result = await service.getMatrixOnboardingReadiness();
    expect(result.ready).toBe(true);
    expect(result.mode).toBe("relay-passthrough");
    expect(result.reason).toBe("public-200");
    expect(requested).toBe("https://node.relay.example.com/onboard");
  });

  it("is not ready when the public URL returns a non-200 (legacy relay)", async () => {
    await writeRuntimeConfig(paths.configPath, {
      accessMode: "relay",
      relay: { type: "http" },
    });
    const service = buildService(async () => new Response("nope", { status: 503 }));
    const result = await service.getMatrixOnboardingReadiness();
    expect(result.ready).toBe(false);
    expect(result.mode).toBe("relay");
    expect(result.status).toBe(503);
  });

  it("never throws when the public GET errors; reports not-ready", async () => {
    await writeRuntimeConfig(paths.configPath, {
      accessMode: "direct",
      publicBaseUrl: "https://node.public.example.com",
    });
    const service = buildService(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await service.getMatrixOnboardingReadiness();
    expect(result.ready).toBe(false);
    expect(result.mode).toBe("direct");
  });

  it("reports not-ready (no local fallback) when a passthrough GET fails", async () => {
    // The readiness probe is a single public GET — it must NOT fall back to a
    // local TLS probe (that only proves the local terminator is up, not that the
    // public cert is valid, and the smoke-window loop could block for minutes).
    // A transient failure simply reports not-ready; the polling client retries.
    await writeRuntimeConfig(paths.configPath, {
      accessMode: "relay",
      relay: { type: "https", withDns01: true },
    });
    let probedLocal = false;
    const service = buildService(async () => {
      throw new TypeError("fetch failed");
    });
    (
      service as unknown as { probeRelayPassthroughTls: () => Promise<{ ok: boolean }> }
    ).probeRelayPassthroughTls = async () => {
      probedLocal = true;
      return { ok: true };
    };
    const result = await service.getMatrixOnboardingReadiness();
    expect(result.ready).toBe(false);
    expect(result.mode).toBe("relay-passthrough");
    expect(probedLocal).toBe(false);
  });

  it("treats a private/LAN host as internal mode", async () => {
    // Loopback host + a port with no listener refuses the connection fast, so we
    // exercise the internal-mode classification without waiting out the probe
    // timeout. The internal probe uses node:https directly (self-signed
    // tolerant), not fetchImpl — so a 200-returning fetchImpl must NOT decide it.
    await writeRuntimeConfig(paths.configPath, {
      accessMode: "direct",
      publicBaseUrl: "https://127.0.0.1:1",
    });
    const service = buildService(async () => new Response("", { status: 200 }));
    const result = await service.getMatrixOnboardingReadiness();
    expect(result.mode).toBe("internal");
    expect(result.ready).toBe(false);
  });

  it("treats an IPv6 ULA host as internal mode", async () => {
    await writeRuntimeConfig(paths.configPath, {
      accessMode: "direct",
      publicBaseUrl: "https://[fd00::1]:1",
    });
    const service = buildService(async () => new Response("", { status: 200 }));
    const result = await service.getMatrixOnboardingReadiness();
    expect(result.mode).toBe("internal");
  });

  it("does not throw on a malformed publicBaseUrl; reports not-ready", async () => {
    // A partially-written config can hold a non-URL publicBaseUrl. Classifying
    // the mode must not throw (which would surface as a 500 / non-zero CLI exit);
    // it should fall through to direct and report not-ready.
    await writeRuntimeConfig(paths.configPath, {
      accessMode: "direct",
      publicBaseUrl: "https://valid.example.com",
    });
    // Re-write with a broken URL after the schema-valid write above.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      paths.configPath,
      JSON.stringify({
        matrix: {
          accessMode: "direct",
          publicBaseUrl: "not a url",
          adminBaseUrl: "http://127.0.0.1:8008",
          homeserverDomain: "node.example.com",
          operator: { userId: "@operator:node.example.com" },
          bot: { userId: "@bot:node.example.com", accessTokenSecretRef: "file:/tmp/b.token" },
          alertRoom: { roomId: "!r:node.example.com", roomName: "Alerts" },
        },
      }),
      "utf8",
    );
    const service = buildService(async () => new Response("", { status: 200 }));
    const result = await service.getMatrixOnboardingReadiness();
    expect(result.ready).toBe(false);
    // "not a url" is parsed by assertMatrixOnboardingAvailable, which rejects a
    // non-https/non-relay base — so this surfaces as onboarding-unavailable, not
    // a thrown error.
    expect(result.reason).toBe("onboarding-unavailable");
  });
});
