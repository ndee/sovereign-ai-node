type SessionBranchEntryLike = {
  type?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
  };
};

type SessionRegistryEntryLike = {
  sessionId?: unknown;
  origin?: {
    from?: unknown;
  };
};

type GuardedJsonStateToolContextLike = {
  workspaceDir?: unknown;
  requesterSenderId?: unknown;
  sessionKey?: unknown;
};

export const GUARDED_JSON_STATE_OPENCLAW_PLUGIN_ID = "guarded-json-state";
export const GUARDED_JSON_STATE_OPENCLAW_TOOL_NAME = "guarded_json_state";

export const isGuardedJsonStateRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const normalizeGuardedJsonStateMatrixActorUserId = (value: string): string | null => {
  const trimmed = value.trim();
  const candidate = trimmed.startsWith("matrix:") ? trimmed.slice("matrix:".length) : trimmed;
  return /^@[^:\s]+:[^\s]+$/.test(candidate) ? candidate : null;
};

export const extractGuardedJsonStateActorFromDirectSessionKey = (sessionKey: string): string | null => {
  if (!/(^|:)(session:)?agent:[^:\s]+:matrix:direct:@[^:\s]+:[^\s]+$/.test(sessionKey)) {
    return null;
  }
  const marker = ":matrix:direct:";
  const markerIndex = sessionKey.lastIndexOf(marker);
  if (markerIndex < 0) {
    return null;
  }
  return normalizeGuardedJsonStateMatrixActorUserId(
    sessionKey.slice(markerIndex + marker.length),
  );
};

export const resolveGuardedJsonStateWorkspaceDir = (workspaceDir: unknown): string => {
  if (typeof workspaceDir !== "string" || workspaceDir.trim().length === 0) {
    throw new Error("OpenClaw tool context did not expose a workspaceDir");
  }
  return workspaceDir.trim();
};

const extractJsonCodeBlocks = (text: string): string[] => {
  const matches = text.matchAll(/```json\s*([\s\S]*?)```/gi);
  return Array.from(matches, (match) => match[1]?.trim() ?? "").filter((value) => value.length > 0);
};

export const extractGuardedJsonStateActorFromConversationInfoText = (text: string): string | null => {
  for (const block of extractJsonCodeBlocks(text)) {
    try {
      const parsed = JSON.parse(block);
      if (!isGuardedJsonStateRecord(parsed)) {
        continue;
      }
      const senderId = typeof parsed.sender_id === "string" ? parsed.sender_id : undefined;
      const sender = typeof parsed.sender === "string" ? parsed.sender : undefined;
      const normalizedSenderId =
        senderId === undefined ? null : normalizeGuardedJsonStateMatrixActorUserId(senderId);
      const normalizedSender =
        sender === undefined ? null : normalizeGuardedJsonStateMatrixActorUserId(sender);
      if (
        normalizedSenderId !== null
        && normalizedSender !== null
        && normalizedSenderId !== normalizedSender
      ) {
        throw new Error("Conversation metadata exposed conflicting Matrix senders");
      }
      if (normalizedSenderId !== null) {
        return normalizedSenderId;
      }
      if (normalizedSender !== null) {
        return normalizedSender;
      }
    } catch (error) {
      if (
        error instanceof Error
        && error.message === "Conversation metadata exposed conflicting Matrix senders"
      ) {
        throw error;
      }
    }
  }
  return null;
};

export const extractGuardedJsonStateActorFromUserContent = (content: unknown): string | null => {
  if (typeof content === "string") {
    return extractGuardedJsonStateActorFromConversationInfoText(content);
  }
  if (!Array.isArray(content)) {
    return null;
  }
  for (const block of content) {
    if (!isGuardedJsonStateRecord(block) || block.type !== "text" || typeof block.text !== "string") {
      continue;
    }
    const actor = extractGuardedJsonStateActorFromConversationInfoText(block.text);
    if (actor !== null) {
      return actor;
    }
  }
  return null;
};

export const extractLatestGuardedJsonStateActorFromBranch = (
  branchEntries: SessionBranchEntryLike[],
): string | null => {
  for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
    const entry = branchEntries[index];
    if (
      !isGuardedJsonStateRecord(entry)
      || entry.type !== "message"
      || !isGuardedJsonStateRecord(entry.message)
    ) {
      continue;
    }
    if (entry.message.role !== "user") {
      continue;
    }
    const actor = extractGuardedJsonStateActorFromUserContent(entry.message.content);
    if (actor !== null) {
      return actor;
    }
  }
  return null;
};

export const resolveGuardedJsonStateSessionContext = (input: {
  sessionId: string;
  sessionsRegistry: unknown;
  branchEntries: SessionBranchEntryLike[];
}): {
  sessionKey: string;
  originFrom?: string;
  actor: string;
} => {
  if (!isGuardedJsonStateRecord(input.sessionsRegistry)) {
    throw new Error("OpenClaw session registry is not a JSON object");
  }

  let matchedSessionKey: string | null = null;
  let matchedSession: SessionRegistryEntryLike | null = null;
  for (const [sessionKey, entry] of Object.entries(input.sessionsRegistry)) {
    if (!isGuardedJsonStateRecord(entry)) {
      continue;
    }
    if (entry.sessionId !== input.sessionId) {
      continue;
    }
    matchedSessionKey = sessionKey;
    matchedSession = entry;
    break;
  }

  if (matchedSessionKey === null || matchedSession === null) {
    throw new Error(`Could not resolve the active OpenClaw session '${input.sessionId}'`);
  }

  const sessionKeyActor = extractGuardedJsonStateActorFromDirectSessionKey(matchedSessionKey);
  const branchActor = extractLatestGuardedJsonStateActorFromBranch(input.branchEntries);
  if (sessionKeyActor !== null && branchActor !== null && sessionKeyActor !== branchActor) {
    throw new Error("Current Matrix sender mismatch between session registry and latest user message");
  }

  const actor = branchActor ?? sessionKeyActor;
  if (actor === null) {
    throw new Error("Could not resolve the current Matrix sender from the active OpenClaw session");
  }

  const origin = isGuardedJsonStateRecord(matchedSession.origin) ? matchedSession.origin : null;
  const originFrom = typeof origin?.from === "string" ? origin.from : undefined;
  return {
    sessionKey: matchedSessionKey,
    ...(originFrom === undefined ? {} : { originFrom }),
    actor,
  };
};

export const resolveGuardedJsonStateToolContext = (
  input: GuardedJsonStateToolContextLike,
): {
  workspaceDir: string;
  actor: string;
  sessionKey?: string;
  originFrom?: string;
} => {
  const workspaceDir = resolveGuardedJsonStateWorkspaceDir(input.workspaceDir);
  const requesterSenderId = typeof input.requesterSenderId === "string"
    ? normalizeGuardedJsonStateMatrixActorUserId(input.requesterSenderId)
    : null;
  const sessionKey = typeof input.sessionKey === "string" && input.sessionKey.trim().length > 0
    ? input.sessionKey.trim()
    : undefined;
  const sessionKeyActor = sessionKey === undefined
    ? null
    : extractGuardedJsonStateActorFromDirectSessionKey(sessionKey);

  if (
    requesterSenderId !== null
    && sessionKeyActor !== null
    && requesterSenderId !== sessionKeyActor
  ) {
    throw new Error("Current Matrix sender mismatch between tool context sender and session key");
  }

  const actor = requesterSenderId ?? sessionKeyActor;
  if (actor === null) {
    throw new Error("Could not resolve the current Matrix sender from the active OpenClaw tool context");
  }

  return {
    workspaceDir,
    actor,
    ...(sessionKey === undefined ? {} : { sessionKey }),
    ...(requesterSenderId === null ? {} : { originFrom: requesterSenderId }),
  };
};
