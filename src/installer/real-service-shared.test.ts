import { describe, expect, it } from "vitest";

import {
  isCoreAgentBindingBestEffortSkippable,
  isGatewayUserSystemdUnavailableError,
  parseInstallProvenance,
  parseRuntimeConfigDocument,
} from "./real-service-shared.js";

describe("isCoreAgentBindingBestEffortSkippable", () => {
  it("treats legacy command gaps as skippable for managed agents", () => {
    const error = {
      code: "MANAGED_AGENT_REGISTER_FAILED",
      message: "OpenClaw node-operator-matrix-bind registration commands failed",
      retryable: true,
      details: {
        failures: [
          {
            stderr: 'unknown command "plugins enable"',
            stdout: "",
          },
        ],
      },
    };

    expect(isCoreAgentBindingBestEffortSkippable(error)).toBe(true);
  });

  it("keeps matrix plugin load failures fatal for managed agents", () => {
    const error = {
      code: "MANAGED_AGENT_REGISTER_FAILED",
      message: "OpenClaw node-operator-matrix-bind registration commands failed",
      retryable: true,
      details: {
        failures: [
          {
            stderr:
              "[plugins] matrix failed to load from /usr/lib/node_modules/openclaw/extensions/matrix/index.ts: Error: Cannot find module '/usr/lib/node_modules/openclaw/dist/plugin-sdk/index.js/keyed-async-queue'\nUnknown channel \"matrix\".",
            stdout: "",
          },
        ],
      },
    };

    expect(isCoreAgentBindingBestEffortSkippable(error)).toBe(false);
  });

  it("keeps unrelated managed agent failures non-skippable", () => {
    const error = {
      code: "MANAGED_AGENT_REGISTER_FAILED",
      message: "OpenClaw node-operator-matrix-bind registration commands failed",
      retryable: true,
      details: {
        failures: [
          {
            stderr: "permission denied",
            stdout: "",
          },
        ],
      },
    };

    expect(isCoreAgentBindingBestEffortSkippable(error)).toBe(false);
  });
});

describe("parseInstallProvenance", () => {
  const validProvenance = {
    nodeRepoUrl: "https://github.com/ndee/sovereign-ai-node",
    nodeRef: "main",
    nodeCommitSha: "abc123def456",
    botsRepoUrl: "https://github.com/ndee/sovereign-ai-bots",
    botsRef: "main",
    botsCommitSha: "789xyz000111",
    installedAt: "2026-03-27T10:00:00Z",
    installSource: "git-clone",
  };

  it("parses a valid provenance JSON", () => {
    const result = parseInstallProvenance(JSON.stringify(validProvenance));
    expect(result).not.toBeNull();
    if (result === null) {
      throw new Error("expected valid provenance result");
    }
    expect(result.nodeCommitSha).toBe("abc123def456");
    expect(result.installSource).toBe("git-clone");
    expect(result.installedAt).toBe("2026-03-27T10:00:00Z");
  });

  it("returns null for empty input", () => {
    expect(parseInstallProvenance("")).toBeNull();
    expect(parseInstallProvenance("  ")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseInstallProvenance("{broken")).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    expect(parseInstallProvenance(JSON.stringify({ nodeRepoUrl: "x" }))).toBeNull();
  });

  it("returns null for invalid installSource value", () => {
    expect(
      parseInstallProvenance(
        JSON.stringify({ ...validProvenance, installSource: "unknown-source" }),
      ),
    ).toBeNull();
  });

  it("parses local-copy provenance with unknown SHA", () => {
    const localCopy = {
      ...validProvenance,
      nodeRepoUrl: "local-copy",
      nodeRef: "unknown",
      nodeCommitSha: "unknown",
      botsRepoUrl: "local-copy",
      botsRef: "unknown",
      botsCommitSha: "unknown",
      installSource: "local-copy",
    };
    const result = parseInstallProvenance(JSON.stringify(localCopy));
    expect(result).not.toBeNull();
    if (result === null) {
      throw new Error("expected local-copy provenance result");
    }
    expect(result.installSource).toBe("local-copy");
    expect(result.nodeRepoUrl).toBe("local-copy");
  });

  it("accepts curl-installer as installSource", () => {
    const curlInstall = { ...validProvenance, installSource: "curl-installer" };
    const result = parseInstallProvenance(JSON.stringify(curlInstall));
    expect(result).not.toBeNull();
    if (result === null) {
      throw new Error("expected curl-installer provenance result");
    }
    expect(result.installSource).toBe("curl-installer");
  });

  it("returns null for non-object values", () => {
    expect(parseInstallProvenance(JSON.stringify([1, 2, 3]))).toBeNull();
    expect(parseInstallProvenance(JSON.stringify("string"))).toBeNull();
    expect(parseInstallProvenance(JSON.stringify(42))).toBeNull();
    expect(parseInstallProvenance(JSON.stringify(null))).toBeNull();
  });
});

describe("parseRuntimeConfigDocument avatarSha256 round-trip", () => {
  const baseDocument = {
    matrix: {
      accessMode: "direct",
      homeserverDomain: "matrix.example.org",
      federationEnabled: false,
      publicBaseUrl: "https://matrix.example.org",
      adminBaseUrl: "https://matrix.example.org",
      operator: { userId: "@op:matrix.example.org" },
      bot: {
        userId: "@bot:matrix.example.org",
        accessTokenSecretRef: "file:/etc/sovereign-node/secrets/bot-token",
      },
      alertRoom: { roomId: "!abc:matrix.example.org", roomName: "Sovereign Alerts" },
    },
    openclawProfile: {
      agents: [
        {
          id: "mail-sentinel",
          workspace: "/var/lib/sovereign-node/mail-sentinel/workspace",
          matrix: {
            localpart: "mail-sentinel",
            userId: "@mail-sentinel:matrix.example.org",
            accessTokenSecretRef: "file:/etc/sovereign-node/secrets/agent-token",
          },
        },
      ],
    },
  };

  it("preserves avatarSha256 on matrix.bot, matrix.alertRoom, and each agent", () => {
    const document = JSON.parse(JSON.stringify(baseDocument));
    document.matrix.bot.avatarSha256 = "a".repeat(64);
    document.matrix.alertRoom.avatarSha256 = "b".repeat(64);
    document.openclawProfile.agents[0].matrix.avatarSha256 = "c".repeat(64);
    const result = parseRuntimeConfigDocument(JSON.stringify(document));
    expect(result).not.toBeNull();
    if (result === null) throw new Error("unexpected null");
    expect(result.matrix.bot.avatarSha256).toBe("a".repeat(64));
    expect(result.matrix.alertRoom.avatarSha256).toBe("b".repeat(64));
    expect(result.openclawProfile.agents[0]?.matrix?.avatarSha256).toBe("c".repeat(64));
  });

  it("omits avatarSha256 when absent, empty, or the wrong type", () => {
    const document = JSON.parse(JSON.stringify(baseDocument));
    document.matrix.bot.avatarSha256 = "";
    document.matrix.alertRoom.avatarSha256 = 42;
    document.openclawProfile.agents[0].matrix.avatarSha256 = null;
    const result = parseRuntimeConfigDocument(JSON.stringify(document));
    expect(result).not.toBeNull();
    if (result === null) throw new Error("unexpected null");
    expect(result.matrix.bot.avatarSha256).toBeUndefined();
    expect(result.matrix.alertRoom.avatarSha256).toBeUndefined();
    expect(result.openclawProfile.agents[0]?.matrix?.avatarSha256).toBeUndefined();
  });
});

describe("parseRuntimeConfigDocument relay passthrough", () => {
  const relayBase = (extra: Record<string, unknown>) => ({
    matrix: {
      accessMode: "relay",
      homeserverDomain: "node-abc.relay.example.com",
      federationEnabled: false,
      publicBaseUrl: "https://node-abc.relay.example.com",
      adminBaseUrl: "http://127.0.0.1:8008",
      operator: { userId: "@op:node-abc.relay.example.com" },
      bot: {
        userId: "@bot:node-abc.relay.example.com",
        accessTokenSecretRef: "file:/etc/sovereign-node/secrets/bot-token",
      },
      alertRoom: { roomId: "!abc:node-abc.relay.example.com", roomName: "Sovereign Alerts" },
    },
    openclawProfile: { agents: [] },
    relay: {
      enabled: true,
      controlUrl: "https://relay.example.com",
      hostname: "node-abc.relay.example.com",
      publicBaseUrl: "https://node-abc.relay.example.com",
      connected: false,
      serviceName: "sovereign-matrix-relay-tunnel.service",
      configPath: "/var/lib/sovereign-node/relay/frpc.toml",
      tunnel: {
        serverAddr: "relay.example.com",
        serverPort: 7000,
        tokenSecretRef: "file:/etc/sovereign-node/secrets/relay-tunnel-token",
        proxyName: "relay-node-abc",
        ...extra,
      },
    },
  });

  it("parses https tunnel type + dns01 and defaults localPort to the TLS port", () => {
    const document = relayBase({ type: "https" }) as Record<string, unknown>;
    (document.relay as Record<string, unknown>).dns01 = {
      provider: "desec",
      apiBase: "https://desec.io/api/v1",
      zone: "_acme-challenge.relay.example.com",
      subname: "node-abc",
      acmeEmail: "ops@example.com",
      tokenSecretRef: "file:/etc/sovereign-node/secrets/relay-desec-token",
    };
    const result = parseRuntimeConfigDocument(JSON.stringify(document));
    expect(result).not.toBeNull();
    if (result === null) throw new Error("unexpected null");
    expect(result.relay?.tunnel.type).toBe("https");
    expect(result.relay?.tunnel.localPort).toBe(18443);
    expect(result.relay?.dns01?.provider).toBe("desec");
    expect(result.relay?.dns01?.tokenSecretRef).toBe(
      "file:/etc/sovereign-node/secrets/relay-desec-token",
    );
  });

  it("defaults to http tunnel type + edge port for a legacy relay config (no type/dns01)", () => {
    const result = parseRuntimeConfigDocument(JSON.stringify(relayBase({})));
    expect(result).not.toBeNull();
    if (result === null) throw new Error("unexpected null");
    expect(result.relay?.tunnel.type).toBe("http");
    expect(result.relay?.tunnel.localPort).toBe(18080);
    expect(result.relay?.dns01).toBeUndefined();
  });

  it("drops a dns01 block that is missing its token secret ref", () => {
    const document = relayBase({ type: "https" }) as Record<string, unknown>;
    (document.relay as Record<string, unknown>).dns01 = {
      provider: "desec",
      apiBase: "https://desec.io/api/v1",
      zone: "_acme-challenge.relay.example.com",
      subname: "node-abc",
    };
    const result = parseRuntimeConfigDocument(JSON.stringify(document));
    expect(result).not.toBeNull();
    if (result === null) throw new Error("unexpected null");
    expect(result.relay?.dns01).toBeUndefined();
  });
});

describe("isGatewayUserSystemdUnavailableError", () => {
  it("treats a system-scope bus permission denial as systemd-unavailable", () => {
    const error = {
      code: "OPENCLAW_GATEWAY_INSTALL_FAILED",
      message: "OpenClaw gateway command exited with non-zero status",
      details: {
        stdout: "No gateway token found. Auto-generated one and saving to config.",
        stderr:
          "Gateway install failed: Error: systemctl daemon-reload failed: " +
          "Failed to connect to system scope bus via machine transport: Permission denied\n" +
          "Reload daemon failed: Transport endpoint is not connected",
      },
    };

    expect(isGatewayUserSystemdUnavailableError(error)).toBe(true);
  });

  it("still treats the user-bus absence as systemd-unavailable", () => {
    const error = {
      code: "OPENCLAW_GATEWAY_START_FAILED",
      details: {
        stderr: "systemctl --user unavailable: Failed to connect to bus: No medium found",
      },
    };

    expect(isGatewayUserSystemdUnavailableError(error)).toBe(true);
  });

  it("does not classify a system-bus failure that is not a gateway command failure", () => {
    const error = {
      code: "SMOKE_CHECKS_FAILED",
      details: {
        stderr: "Failed to connect to system scope bus via machine transport: Permission denied",
      },
    };

    expect(isGatewayUserSystemdUnavailableError(error)).toBe(false);
  });

  it("does not classify an unrelated gateway failure as systemd-unavailable", () => {
    const error = {
      code: "OPENCLAW_GATEWAY_INSTALL_FAILED",
      details: {
        stderr: "Gateway install failed: relay enrollment rejected the node token",
      },
    };

    expect(isGatewayUserSystemdUnavailableError(error)).toBe(false);
  });
});
