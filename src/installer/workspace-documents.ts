export type NodeOperatorWorkspaceContext = {
  alertRoomId: string;
  homeserverUrl: string;
};

export const buildNodeOperatorWorkspaceDocuments = (
  context: NodeOperatorWorkspaceContext,
): {
  readme: string;
  agents: string;
  tools: string;
  skill: string;
} => ({
  readme: [
    "# Node Operator workspace",
    "",
    "Provisioned by sovereign-node install flow.",
    "Managed by Sovereign Node installer.",
    "",
    "This agent is intended for conversational node operations in Matrix.",
  ].join("\n"),
  agents: [
    "# Node Operator",
    "",
    "You are the `node-operator` bot for Sovereign Node.",
    "",
    "Primary responsibilities:",
    "- Keep the node healthy and operational",
    "- Diagnose runtime problems quickly",
    "- Create, update, and delete managed agents on operator request",
    "",
    "Execution policy:",
    "- Use `/usr/local/bin/sovereign-node` via the OpenClaw `exec` tool for all node operations",
    "- Prefer read-only diagnostics before changing state",
    "- Ask for explicit confirmation before destructive actions",
    "- Keep command output summaries short and actionable",
    "- Never reveal secrets unless explicitly requested by the operator",
    "",
    "Preferred command flow:",
    "1. `/usr/local/bin/sovereign-node status --json`",
    "2. `/usr/local/bin/sovereign-node doctor --json`",
    "3. If requested: `/usr/local/bin/sovereign-node agents <subcommand> ... --json`",
    "",
    `Context: matrix room ${context.alertRoomId}`,
    `Context: homeserver ${context.homeserverUrl}`,
  ].join("\n"),
  tools: [
    "# Tooling",
    "",
    "Run these commands with the OpenClaw `exec` tool:",
    "- `/usr/local/bin/sovereign-node status --json`",
    "- `/usr/local/bin/sovereign-node doctor --json`",
    "- `/usr/local/bin/sovereign-node agents list --json`",
    "- `/usr/local/bin/sovereign-node agents create <id> --workspace <dir> --json`",
    "- `/usr/local/bin/sovereign-node agents update <id> --workspace <dir> --json`",
    "- `/usr/local/bin/sovereign-node agents delete <id> --json`",
    "- `/usr/local/bin/sovereign-node test-alert --json`",
    "",
    "If a command fails, include the exact error and propose the minimal next fix.",
  ].join("\n"),
  skill: [
    "# node-operator-core",
    "",
    "Use this skill whenever a user asks to operate or repair Sovereign Node.",
    "",
    "Checklist:",
    "1. Inspect health first (`status`, `doctor`)",
    "2. Confirm intended action",
    "3. Execute one atomic CLI command",
    "4. Report result + next step",
    "",
    "Agent CRUD mapping:",
    "- Create: `/usr/local/bin/sovereign-node agents create ...`",
    "- Read/List: `/usr/local/bin/sovereign-node agents list --json`",
    "- Update: `/usr/local/bin/sovereign-node agents update ...`",
    "- Delete: `/usr/local/bin/sovereign-node agents delete ...`",
  ].join("\n"),
});

export const buildManagedAgentWorkspaceReadme = (agentId: string): string => [
  `# ${agentId} workspace`,
  "",
  "Provisioned by sovereign-node managed agent commands.",
  "Managed by Sovereign Node installer.",
].join("\n");

export const buildMailSentinelWorkspaceReadme = (): string => [
  "# Mail Sentinel workspace",
  "",
  "Provisioned by sovereign-node install flow.",
  "Managed by Sovereign Node installer.",
].join("\n");

export const renderTemplateWorkspaceContent = (input: {
  content: string;
  agentId: string;
  matrixHomeserver: string;
  matrixAlertRoomId: string;
  toolSection: string;
}): string =>
  input.content
    .replaceAll("{{AGENT_ID}}", input.agentId)
    .replaceAll("{{MATRIX_HOMESERVER}}", input.matrixHomeserver)
    .replaceAll("{{MATRIX_ALERT_ROOM_ID}}", input.matrixAlertRoomId)
    .replaceAll("{{TOOL_SECTION}}", input.toolSection);
