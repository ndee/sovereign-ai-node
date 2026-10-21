// Core tool ids and groups of the pinned OpenClaw runtime (2026.3.13). Plugin
// tools are never part of these groups.
export const OPENCLAW_CORE_TOOL_IDS = [
  "read",
  "write",
  "edit",
  "apply_patch",
  "exec",
  "process",
  "web_search",
  "web_fetch",
  "memory_search",
  "memory_get",
  "sessions_list",
  "sessions_history",
  "sessions_send",
  "sessions_spawn",
  "sessions_yield",
  "subagents",
  "session_status",
  "browser",
  "canvas",
  "message",
  "cron",
  "gateway",
  "nodes",
  "agents_list",
  "image",
  "tts",
] as const;

export const OPENCLAW_CORE_TOOL_GROUP_IDS = [
  "group:fs",
  "group:runtime",
  "group:web",
  "group:memory",
  "group:sessions",
  "group:ui",
  "group:messaging",
  "group:automation",
  "group:nodes",
  "group:agents",
  "group:media",
] as const;

export const OPENCLAW_SESSION_STATUS_TOOL_ID = "session_status";

const CORE_TOOL_ID_SET: ReadonlySet<string> = new Set(OPENCLAW_CORE_TOOL_IDS);

export const isOpenClawCoreToolId = (toolId: string): boolean =>
  CORE_TOOL_ID_SET.has(toolId.trim().toLowerCase());

export type OpenClawClosedToolPolicy = {
  allow: string[];
  deny: string[];
};

/**
 * Tool policy for an agent that may use only the named plugin tools.
 *
 * OpenClaw ignores an allow list that names no core tool and then offers every
 * core tool, so the allow list carries `session_status` as a core anchor. Every
 * core tool group, which includes that anchor, is denied, and deny wins over
 * allow, so the effective tool set is exactly the named plugin tools.
 */
export const buildOpenClawClosedToolPolicy = (
  pluginToolNames: string[],
): OpenClawClosedToolPolicy => ({
  allow: [
    ...Array.from(new Set(pluginToolNames.filter((name) => !isOpenClawCoreToolId(name)))),
    OPENCLAW_SESSION_STATUS_TOOL_ID,
  ],
  deny: [...OPENCLAW_CORE_TOOL_GROUP_IDS],
});

export const resolveOpenClawScanAgentId = (agentId: string): string => `${agentId}-scan`;
