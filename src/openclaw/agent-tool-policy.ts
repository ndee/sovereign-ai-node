// Core tool ids of the OpenClaw runtimes node renders for: 2026.3, then the
// ids 2026.8 adds. A plugin tool must not take one of these names on either.
// On its runtime, each one sits in one of the core groups below.
// Plugin tools are never part of these groups.
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
  "ask_user",
  "create_goal",
  "get_goal",
  "progress_card",
  "skill_workshop",
  "update_goal",
  "automations",
  "heartbeat_respond",
  "image_generate",
  "music_generate",
  "video_generate",
  "view_image",
  "computer",
  "mobile_ui",
  "code_execution",
  "secrets",
  "agents_wait",
  "conversations_list",
  "conversations_send",
  "conversations_turn",
  "dismiss_task",
  "github_identity_status",
  "github_publish",
  "sessions_search",
  "sessions",
  "suggest_task",
  "dashboard",
  "portal",
  "screen",
  "show_widget",
  "terminal",
  "x_search",
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
