import { isIP } from "node:net";

/**
 * The two `openclaw.json5` shapes node renders.
 *
 * - `list`: the 2026.3 shape (`agents.list[]` with a `default: true` marker,
 *   `tools.exec.security/ask`, `llm-task` `config.allowedModels`).
 * - `keyed`: the 2026.8 shape (`agents.entries{}` with explicit ownership,
 *   `tools.exec.mode`, `llm-task` `llm.allowedCompletionModels`).
 *
 * Both runtimes validate the config strictly and refuse to start the gateway
 * on an invalid one, so the shape must follow the OpenClaw that is installed.
 */
export type OpenClawRuntimeConfigShape = "list" | "keyed";

const KEYED_SHAPE_FIRST_RELEASE = { year: 2026, month: 8 } as const;

const parseOpenClawReleaseLine = (
  version: string | null | undefined,
): { year: number; month: number } | null => {
  const match = version?.trim().match(/^v?(\d{4})\.(\d{1,2})\.\d+/);
  if (match?.[1] === undefined || match[2] === undefined) {
    return null;
  }
  return { year: Number(match[1]), month: Number(match[2]) };
};

export const resolveOpenClawRuntimeConfigShapeForVersion = (
  version: string | null | undefined,
): OpenClawRuntimeConfigShape | null => {
  const release = parseOpenClawReleaseLine(version);
  if (release === null) {
    return null;
  }
  return release.year > KEYED_SHAPE_FIRST_RELEASE.year ||
    (release.year === KEYED_SHAPE_FIRST_RELEASE.year &&
      release.month >= KEYED_SHAPE_FIRST_RELEASE.month)
    ? "keyed"
    : "list";
};

/** The shape of the first candidate version that parses, best evidence first. */
export const resolveOpenClawRuntimeConfigShape = (
  candidates: ReadonlyArray<string | null | undefined>,
): OpenClawRuntimeConfigShape => {
  for (const candidate of candidates) {
    const shape = resolveOpenClawRuntimeConfigShapeForVersion(candidate);
    if (shape !== null) {
      return shape;
    }
  }
  return "list";
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The version an OpenClaw CLI recorded when it last wrote the config. */
export const readOpenClawConfigLastTouchedVersion = (
  runtimeJson: Record<string, unknown> | null | undefined,
): string | undefined => {
  const meta = runtimeJson?.meta;
  return isRecord(meta) && typeof meta.lastTouchedVersion === "string"
    ? meta.lastTouchedVersion
    : undefined;
};

/** Agent ids of a rendered config in either shape. */
export const listOpenClawConfigAgentIds = (
  runtimeJson: Record<string, unknown> | null | undefined,
): string[] => {
  const agents = runtimeJson?.agents;
  if (!isRecord(agents)) {
    return [];
  }
  const ids: string[] = [];
  if (Array.isArray(agents.list)) {
    for (const entry of agents.list) {
      if (isRecord(entry) && typeof entry.id === "string") {
        ids.push(entry.id);
      }
    }
  }
  if (isRecord(agents.entries)) {
    ids.push(...Object.keys(agents.entries));
  }
  return Array.from(new Set(ids));
};

const PRIVATE_IPV4_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0a000000, 8],
  [0x7f000000, 8],
  [0xa9fe0000, 16],
  [0xac100000, 12],
  [0xc0a80000, 16],
  [0x64400000, 10],
];

const ipv4ToNumber = (address: string): number =>
  address.split(".").reduce((value, octet) => value * 256 + Number(octet), 0);

const isPrivateOrLoopbackAddress = (address: string): boolean => {
  if (isIP(address) === 4) {
    const value = ipv4ToNumber(address);
    return PRIVATE_IPV4_RANGES.some(([base, bits]) => {
      const size = 2 ** (32 - bits);
      return Math.floor(value / size) === Math.floor(base / size);
    });
  }
  const normalized = address.toLowerCase();
  // URL parsing writes an IPv4-mapped address in hex (::ffff:c0a8:101).
  const mapped = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped?.[1] !== undefined && mapped[2] !== undefined) {
    const high = Number.parseInt(mapped[1], 16);
    const low = Number.parseInt(mapped[2], 16);
    return isPrivateOrLoopbackAddress([high >> 8, high & 0xff, low >> 8, low & 0xff].join("."));
  }
  return (
    normalized === "::1" ||
    /^f[cd][0-9a-f]{0,2}:/.test(normalized) ||
    /^fe[89ab][0-9a-f]?:/.test(normalized)
  );
};

/**
 * Whether the 2026.8 Matrix plugin needs `network.dangerouslyAllowPrivateNetwork`
 * to reach this homeserver. Its client refuses private and loopback targets
 * without the opt-in, and a plain-http homeserver is accepted only when it is
 * private, so an http URL always needs it.
 */
export const matrixHomeserverNeedsPrivateNetworkOptIn = (homeserver: string): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(homeserver);
  } catch {
    return false;
  }
  const hostname = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (parsed.protocol === "http:") {
    return true;
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return true;
  }
  return isIP(hostname) !== 0 && isPrivateOrLoopbackAddress(hostname);
};

// Core tools that 2026.8 adds and that node denies for the same reasons it
// denies exec, process, browser and the web tools.
export const OPENCLAW_KEYED_SHAPE_EXTRA_DENIED_TOOL_IDS = [
  "code_execution",
  "terminal",
  "x_search",
] as const;

type ListShapeAgentTools = {
  allow?: string[];
  deny: string[];
  exec?: { host: string; security: string; ask: string };
};

type ListShapeAgent = {
  id: string;
  workspace: string;
  default?: boolean;
  model?: string;
  tools: ListShapeAgentTools;
};

export type ListShapeRuntimeConfig = {
  meta?: Record<string, unknown>;
  plugins: {
    allow: string[];
    entries: Record<string, unknown>;
    load?: { paths: string[] };
  };
  bindings?: Array<{ agentId: string; match: { channel: string; accountId?: string } }>;
  channels: {
    matrix: {
      accounts?: Record<string, { homeserver: string } & Record<string, unknown>>;
    } & Record<string, unknown>;
  };
  agents: {
    defaults: { models: Record<string, unknown> } & Record<string, unknown>;
    list: ListShapeAgent[];
  };
  tools: { deny: string[] } & Record<string, unknown>;
} & Record<string, unknown>;

const keyedAgentTools = (tools: ListShapeAgentTools): Record<string, unknown> => {
  const { exec, ...rest } = tools;
  if (exec === undefined) {
    return rest;
  }
  // The only exec policy node renders is allowlist with no prompt; 2026.8
  // folds security/ask into one mode and rewrites the old pair on doctor.
  return { ...rest, exec: { host: exec.host, mode: "allowlist" } };
};

// 2026.8 accepts only these meta keys; the 2026.3 `lastTouchedAt` makes the
// whole config invalid.
const keyedMeta = (meta: Record<string, unknown> | undefined): Record<string, unknown> => ({
  ...(typeof meta?.lastTouchedVersion === "string"
    ? { lastTouchedVersion: meta.lastTouchedVersion }
    : {}),
  // The rendered modelPolicy already is the allowlist that the legacy default
  // model map implied, so the one-time migration is done.
  migrations: { modelPolicyAllowlist: true },
});

const keyedLlmTaskEntry = (entry: unknown): unknown => {
  if (!isRecord(entry) || !isRecord(entry.config)) {
    return entry;
  }
  const { allowedModels, ...config } = entry.config;
  return {
    ...entry,
    config,
    llm: {
      // llm-task passes its configured defaultModel as an explicit model, and
      // 2026.8 refuses an explicit model unless the plugin may override it.
      allowModelOverride: true,
      allowAuthProfileOverride: false,
      ...(Array.isArray(allowedModels) ? { allowedCompletionModels: allowedModels } : {}),
    },
  };
};

const OPENROUTER_PLUGIN_ID = "openrouter";

/**
 * Turn the 2026.3-shaped runtime config into the shape 2026.8 accepts as is,
 * so the first `openclaw doctor` on a fresh install has nothing to migrate.
 */
export const toKeyedOpenClawRuntimeConfig = (
  payload: ListShapeRuntimeConfig,
  options: { scanAgentIds: ReadonlySet<string> },
): Record<string, unknown> => {
  const { list, defaults } = payload.agents;
  const defaultAgentId = list.find((agent) => agent.default === true)?.id ?? list[0]?.id;
  const entries = Object.fromEntries(
    list.map(({ id, default: _default, tools, ...agent }) => [
      id,
      {
        ...agent,
        // Scan agents have an empty workspace and a closed tool set; bundled
        // skills would only add prompt text to every scan run.
        ...(options.scanAgentIds.has(id) ? { skills: [] } : {}),
        tools: keyedAgentTools(tools),
      },
    ]),
  );

  // An explicit roster has no default agent: unbound Matrix traffic and the
  // gateway's ambient work need a named owner, which the legacy default was.
  const bindings = [...(payload.bindings ?? [])];
  if (
    defaultAgentId !== undefined &&
    !bindings.some(
      (binding) => binding.match.channel === "matrix" && binding.match.accountId === "*",
    )
  ) {
    bindings.push({ agentId: defaultAgentId, match: { channel: "matrix", accountId: "*" } });
  }

  const accounts =
    payload.channels.matrix.accounts === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(payload.channels.matrix.accounts).map(([accountId, account]) => [
            accountId,
            matrixHomeserverNeedsPrivateNetworkOptIn(account.homeserver)
              ? { ...account, network: { dangerouslyAllowPrivateNetwork: true } }
              : account,
          ]),
        );

  const pluginEntries: Record<string, unknown> = {
    ...payload.plugins.entries,
    [OPENROUTER_PLUGIN_ID]: { enabled: true },
  };
  if (pluginEntries["llm-task"] !== undefined) {
    pluginEntries["llm-task"] = keyedLlmTaskEntry(pluginEntries["llm-task"]);
  }
  const pluginAllow =
    payload.plugins.allow.length === 0 || payload.plugins.allow.includes(OPENROUTER_PLUGIN_ID)
      ? payload.plugins.allow
      : [...payload.plugins.allow, OPENROUTER_PLUGIN_ID];

  const { meta: _meta, agents: _agents, bindings: _bindings, ...rest } = payload;
  return {
    meta: keyedMeta(payload.meta),
    ...rest,
    plugins: {
      ...payload.plugins,
      allow: pluginAllow,
      entries: pluginEntries,
    },
    ...(bindings.length === 0 ? {} : { bindings }),
    channels: {
      ...payload.channels,
      matrix: {
        ...payload.channels.matrix,
        ...(accounts === undefined ? {} : { accounts }),
      },
    },
    agents: {
      ownership: "explicit",
      defaults: {
        ...defaults,
        // The legacy default model map doubled as the model allowlist.
        modelPolicy: { allow: Object.keys(defaults.models) },
        // 2026.8 runs a full agent turn every 30 minutes by default.
        heartbeat: { every: "0m" },
        ...(defaultAgentId === undefined ? {} : { systemAgent: { agentId: defaultAgentId } }),
      },
      entries,
    },
    tools: {
      ...payload.tools,
      deny: Array.from(
        new Set([...payload.tools.deny, ...OPENCLAW_KEYED_SHAPE_EXTRA_DENIED_TOOL_IDS]),
      ),
    },
    skills: {
      workshop: { autonomous: { mode: "off" } },
    },
    memory: {
      search: { enabled: false },
    },
    update: {
      checkOnStart: false,
    },
  };
};
