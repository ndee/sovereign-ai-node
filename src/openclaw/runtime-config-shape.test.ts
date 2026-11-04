import { describe, expect, it } from "vitest";

import {
  type ListShapeRuntimeConfig,
  listOpenClawConfigAgentIds,
  matrixHomeserverNeedsPrivateNetworkOptIn,
  OPENCLAW_KEYED_SHAPE_EXTRA_DENIED_TOOL_IDS,
  readOpenClawConfigLastTouchedVersion,
  resolveOpenClawRuntimeConfigShape,
  resolveOpenClawRuntimeConfigShapeForVersion,
  toKeyedOpenClawRuntimeConfig,
} from "./runtime-config-shape.js";

describe("resolveOpenClawRuntimeConfigShapeForVersion", () => {
  it.each([
    ["2026.3.13", "list"],
    ["2026.7.99", "list"],
    ["2025.12.1", "list"],
    ["2026.8.35", "keyed"],
    ["v2026.8.0", "keyed"],
    [" 2026.10.2 ", "keyed"],
    ["2027.1.0", "keyed"],
    ["2026.8.35-beta.1", "keyed"],
  ] as const)("maps %s to the %s shape", (version, shape) => {
    expect(resolveOpenClawRuntimeConfigShapeForVersion(version)).toBe(shape);
  });

  it.each([
    undefined,
    null,
    "",
    "0.2.0",
    "pinned-by-sovereign",
    "openclaw",
  ])("has no shape for %s", (version) => {
    expect(resolveOpenClawRuntimeConfigShapeForVersion(version)).toBeNull();
  });
});

describe("resolveOpenClawRuntimeConfigShape", () => {
  it("uses the first candidate that is a version", () => {
    expect(resolveOpenClawRuntimeConfigShape([undefined, "0.2.0", "2026.8.35", "2026.3.13"])).toBe(
      "keyed",
    );
    expect(resolveOpenClawRuntimeConfigShape(["2026.3.13", "2026.8.35"])).toBe("list");
  });

  it("falls back to the list shape without any version", () => {
    expect(resolveOpenClawRuntimeConfigShape([])).toBe("list");
    expect(resolveOpenClawRuntimeConfigShape([null, "unknown"])).toBe("list");
  });
});

describe("readOpenClawConfigLastTouchedVersion", () => {
  it("reads meta.lastTouchedVersion", () => {
    expect(
      readOpenClawConfigLastTouchedVersion({ meta: { lastTouchedVersion: "2026.8.35" } }),
    ).toBe("2026.8.35");
  });

  it.each([
    null,
    undefined,
    {},
    { meta: [] },
    { meta: { lastTouchedVersion: 7 } },
  ])("is undefined for %j", (runtimeJson) => {
    expect(
      readOpenClawConfigLastTouchedVersion(runtimeJson as Record<string, unknown> | null),
    ).toBeUndefined();
  });
});

describe("listOpenClawConfigAgentIds", () => {
  it("reads the 2026.3 agents.list roster", () => {
    expect(
      listOpenClawConfigAgentIds({
        agents: { list: [{ id: "node-operator" }, { id: "mail-sentinel" }, "junk", { id: 3 }] },
      }),
    ).toEqual(["node-operator", "mail-sentinel"]);
  });

  it("reads the 2026.8 agents.entries roster", () => {
    expect(
      listOpenClawConfigAgentIds({
        agents: { ownership: "explicit", entries: { "node-operator": {}, "mail-sentinel": {} } },
      }),
    ).toEqual(["node-operator", "mail-sentinel"]);
  });

  it("merges a half-migrated roster without duplicates", () => {
    expect(
      listOpenClawConfigAgentIds({
        agents: { list: [{ id: "a" }], entries: { a: {}, b: {} } },
      }),
    ).toEqual(["a", "b"]);
  });

  it.each([
    null,
    undefined,
    {},
    { agents: [] },
    { agents: { list: {}, entries: [] } },
  ])("is empty for %j", (runtimeJson) => {
    expect(listOpenClawConfigAgentIds(runtimeJson as Record<string, unknown> | null)).toEqual([]);
  });
});

describe("matrixHomeserverNeedsPrivateNetworkOptIn", () => {
  it.each([
    "http://127.0.0.1:8008",
    "http://matrix.example.org",
    "https://localhost:8448",
    "https://synapse.localhost",
    "https://10.1.2.3",
    "https://172.20.0.5:8448",
    "https://192.168.0.21",
    "https://169.254.1.1",
    "https://100.64.0.1",
    "https://127.0.0.1",
    "https://[::1]:8448",
    "https://[fd00::1]",
    "https://[fc12::1]",
    "https://[fe80::1]",
    "https://[::ffff:192.168.1.1]",
  ])("opts in for %s", (url) => {
    expect(matrixHomeserverNeedsPrivateNetworkOptIn(url)).toBe(true);
  });

  it.each([
    "https://matrix.example.org",
    "https://8.8.8.8",
    "https://172.32.0.1",
    "https://100.128.0.1",
    "https://[2001:db8::1]",
    "https://[::ffff:8.8.8.8]",
    "not a url",
  ])("does not opt in for %s", (url) => {
    expect(matrixHomeserverNeedsPrivateNetworkOptIn(url)).toBe(false);
  });
});

const listShapeConfig = (): ListShapeRuntimeConfig => ({
  meta: { lastTouchedVersion: "2026.3.13", lastTouchedAt: "2026-11-01T00:00:00.000Z" },
  gateway: { mode: "local", bind: "loopback" },
  plugins: {
    allow: ["matrix", "llm-task", "lobster"],
    load: { paths: ["/x/extensions/sovereign-typed-tool"] },
    entries: {
      matrix: { enabled: true },
      lobster: { enabled: true },
      "llm-task": {
        enabled: true,
        config: {
          defaultProvider: "openrouter",
          defaultModel: "qwen/qwen3.5-9b",
          allowedModels: ["openrouter/qwen/qwen3.5-9b"],
          timeoutMs: 30_000,
        },
      },
    },
  },
  bindings: [
    { agentId: "mail-sentinel", match: { channel: "matrix", accountId: "mail-sentinel" } },
  ],
  channels: {
    matrix: {
      enabled: true,
      threadReplies: "always",
      accounts: {
        "mail-sentinel": {
          homeserver: "http://127.0.0.1:8008",
          userId: "@mail-sentinel:example.org",
          groups: {
            "*": { enabled: true, allow: true, users: [] },
            "!muted:example.org": { enabled: true, allow: false, users: [] },
          },
        },
        public: { homeserver: "https://matrix.example.org", userId: "@bot:example.org" },
      },
    },
  },
  agents: {
    defaults: {
      model: "openrouter/qwen/qwen3.5-9b",
      workspace: "/x/llm-task-workspace",
      models: {
        "openrouter/qwen/qwen3.5-9b": { params: {} },
        "openrouter/qwen/qwen-2.5-32b-instruct": { params: {} },
      },
    },
    list: [
      {
        id: "node-operator",
        workspace: "/x/node-operator",
        default: true,
        tools: { deny: ["exec", "process", "lobster", "browser", "web_fetch", "web_search"] },
      },
      {
        id: "mail-sentinel",
        workspace: "/x/mail-sentinel",
        model: "openrouter/qwen/qwen-2.5-32b-instruct",
        tools: {
          allow: ["exec", "llm-task", "session_status"],
          deny: ["process", "browser", "web_fetch", "web_search"],
          exec: { host: "gateway", security: "allowlist", ask: "off" },
        },
      },
      {
        id: "mail-sentinel-scan",
        workspace: "/x/llm-task-workspace",
        tools: { allow: ["llm-task", "session_status"], deny: ["group:runtime", "group:web"] },
      },
    ],
  },
  tools: {
    deny: ["lobster"],
    elevated: { enabled: false },
    fs: { workspaceOnly: true },
  },
  browser: { enabled: false },
  discovery: { mdns: { mode: "off" } },
  cron: { enabled: true },
});

describe("toKeyedOpenClawRuntimeConfig", () => {
  it("renders the 2026.8 shape that needs no doctor migration", () => {
    const keyed = toKeyedOpenClawRuntimeConfig(listShapeConfig(), {
      scanAgentIds: new Set(["mail-sentinel-scan"]),
    });

    expect(keyed).toEqual({
      meta: { lastTouchedVersion: "2026.3.13", migrations: { modelPolicyAllowlist: true } },
      gateway: { mode: "local", bind: "loopback" },
      plugins: {
        allow: ["matrix", "llm-task", "lobster", "openrouter"],
        load: { paths: ["/x/extensions/sovereign-typed-tool"] },
        entries: {
          matrix: { enabled: true },
          lobster: { enabled: true },
          openrouter: { enabled: true },
          "llm-task": {
            enabled: true,
            config: {
              defaultProvider: "openrouter",
              defaultModel: "qwen/qwen3.5-9b",
              timeoutMs: 30_000,
            },
            llm: {
              allowModelOverride: true,
              allowAuthProfileOverride: false,
              allowedCompletionModels: ["openrouter/qwen/qwen3.5-9b"],
            },
          },
        },
      },
      bindings: [
        { agentId: "mail-sentinel", match: { channel: "matrix", accountId: "mail-sentinel" } },
        { agentId: "node-operator", match: { channel: "matrix", accountId: "*" } },
      ],
      channels: {
        matrix: {
          enabled: true,
          threadReplies: "always",
          accounts: {
            "mail-sentinel": {
              homeserver: "http://127.0.0.1:8008",
              userId: "@mail-sentinel:example.org",
              groups: {
                "*": { enabled: true, users: [] },
                "!muted:example.org": { enabled: false, users: [] },
              },
              network: { dangerouslyAllowPrivateNetwork: true },
            },
            public: { homeserver: "https://matrix.example.org", userId: "@bot:example.org" },
          },
        },
      },
      agents: {
        ownership: "explicit",
        defaults: {
          model: "openrouter/qwen/qwen3.5-9b",
          workspace: "/x/llm-task-workspace",
          models: {
            "openrouter/qwen/qwen3.5-9b": { params: {} },
            "openrouter/qwen/qwen-2.5-32b-instruct": { params: {} },
          },
          modelPolicy: {
            allow: ["openrouter/qwen/qwen3.5-9b", "openrouter/qwen/qwen-2.5-32b-instruct"],
          },
          heartbeat: { every: "0m" },
          systemAgent: { agentId: "node-operator" },
        },
        entries: {
          "node-operator": {
            workspace: "/x/node-operator",
            tools: { deny: ["exec", "process", "lobster", "browser", "web_fetch", "web_search"] },
          },
          "mail-sentinel": {
            workspace: "/x/mail-sentinel",
            model: "openrouter/qwen/qwen-2.5-32b-instruct",
            tools: {
              allow: ["exec", "llm-task", "session_status"],
              deny: ["process", "browser", "web_fetch", "web_search"],
              exec: { host: "gateway", mode: "allowlist" },
            },
          },
          "mail-sentinel-scan": {
            workspace: "/x/llm-task-workspace",
            skills: [],
            tools: {
              allow: ["llm-task", "session_status"],
              deny: ["group:runtime", "group:web"],
            },
          },
        },
      },
      tools: {
        deny: ["lobster", ...OPENCLAW_KEYED_SHAPE_EXTRA_DENIED_TOOL_IDS],
        elevated: { enabled: false },
        fs: { workspaceOnly: true },
        web: { search: { enabled: false } },
      },
      browser: { enabled: false },
      discovery: { mdns: { mode: "off" } },
      cron: { enabled: true },
      skills: { workshop: { autonomous: { mode: "off" } } },
      memory: { search: { enabled: false } },
      update: { checkOnStart: false },
    });
  });

  it("keeps an explicit default-agent binding and adds no meta version it does not know", () => {
    const config = listShapeConfig();
    delete config.meta;
    config.bindings = [{ agentId: "mail-sentinel", match: { channel: "matrix", accountId: "*" } }];
    config.plugins.allow = ["openrouter"];
    config.agents.list = config.agents.list.map(({ default: _default, ...agent }) => agent);

    const keyed = toKeyedOpenClawRuntimeConfig(config, { scanAgentIds: new Set() }) as {
      meta: unknown;
      bindings: unknown;
      plugins: { allow: unknown };
      agents: { defaults: { systemAgent: unknown } };
    };

    expect(keyed.meta).toEqual({ migrations: { modelPolicyAllowlist: true } });
    expect(keyed.bindings).toEqual([
      { agentId: "mail-sentinel", match: { channel: "matrix", accountId: "*" } },
    ]);
    expect(keyed.plugins.allow).toEqual(["openrouter"]);
    // Without a default marker the first agent owns ambient work.
    expect(keyed.agents.defaults.systemAgent).toEqual({ agentId: "node-operator" });
  });

  it("leaves an open plugin allowlist open and handles an empty roster", () => {
    const config = listShapeConfig();
    config.plugins.allow = [];
    config.plugins.entries = { "llm-task": { enabled: true } };
    delete config.bindings;
    delete config.channels.matrix.accounts;
    config.agents.list = [];

    const keyed = toKeyedOpenClawRuntimeConfig(config, { scanAgentIds: new Set() }) as Record<
      string,
      unknown
    > & {
      plugins: { allow: unknown; entries: unknown };
      channels: { matrix: Record<string, unknown> };
      agents: { defaults: Record<string, unknown>; entries: unknown };
    };

    expect(keyed.plugins.allow).toEqual([]);
    expect(keyed.plugins.entries).toEqual({
      "llm-task": { enabled: true },
      openrouter: { enabled: true },
    });
    expect(keyed.bindings).toBeUndefined();
    expect(keyed.channels.matrix).toEqual({ enabled: true, threadReplies: "always" });
    expect(keyed.agents.entries).toEqual({});
    expect(keyed.agents.defaults.systemAgent).toBeUndefined();
  });

  it("leaves room maps and entries it cannot read as they are", () => {
    const config = listShapeConfig();
    config.channels.matrix.accounts = {
      a: { homeserver: "https://matrix.example.org", groups: "bogus" },
      b: { homeserver: "https://matrix.example.org", groups: { "*": true } },
    };

    const keyed = toKeyedOpenClawRuntimeConfig(config, { scanAgentIds: new Set() }) as {
      channels: { matrix: { accounts: unknown } };
    };

    expect(keyed.channels.matrix.accounts).toEqual({
      a: { homeserver: "https://matrix.example.org", groups: "bogus" },
      b: { homeserver: "https://matrix.example.org", groups: { "*": true } },
    });
  });

  it("drops a non-list allowedModels and keeps a config-less llm-task entry", () => {
    const config = listShapeConfig();
    config.plugins.entries["llm-task"] = { enabled: true, config: { allowedModels: "bogus" } };

    const keyed = toKeyedOpenClawRuntimeConfig(config, { scanAgentIds: new Set() }) as {
      plugins: { entries: Record<string, unknown> };
    };

    expect(keyed.plugins.entries["llm-task"]).toEqual({
      enabled: true,
      config: {},
      llm: { allowModelOverride: true, allowAuthProfileOverride: false },
    });
  });
});
