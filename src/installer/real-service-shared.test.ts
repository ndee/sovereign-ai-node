import { describe, expect, it } from "vitest";

import {
  isCoreAgentBindingBestEffortSkippable,
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
