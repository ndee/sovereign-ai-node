export const buildManagedAgentWorkspaceReadme = (agentId: string): string => [
  `# ${agentId} workspace`,
  "",
  "Provisioned by sovereign-node managed agent commands.",
  "Managed by Sovereign Node installer.",
].join("\n");

export const renderTemplateWorkspaceContent = (input: {
  content: string;
  agentId: string;
  matrixHomeserver: string;
  matrixAlertRoomId: string;
  matrixOperatorUserId: string;
  toolSection: string;
}): string =>
  input.content
    .replaceAll("{{AGENT_ID}}", input.agentId)
    .replaceAll("{{MATRIX_HOMESERVER}}", input.matrixHomeserver)
    .replaceAll("{{MATRIX_ALERT_ROOM_ID}}", input.matrixAlertRoomId)
    .replaceAll("{{MATRIX_OPERATOR_USER_ID}}", input.matrixOperatorUserId)
    .replaceAll("{{TOOL_SECTION}}", input.toolSection);
