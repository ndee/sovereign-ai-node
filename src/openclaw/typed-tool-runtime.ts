// Runtime of the generated typed-tool OpenClaw plugin. Every exported function
// is serialized into the plugin's runtime.js with `fn.toString()`, so each one
// may only reference its parameters, globals, and the other exported functions
// of this module (by their exported names).

export type TypedToolParamSpec = {
  type: "string" | "boolean";
  description: string;
  enum?: string[] | undefined;
  pattern?: string | undefined;
  maxLength?: number | undefined;
  argv: string[];
};

export type TypedToolConfirmSpec = "always" | { param: string; values: string[] };

export type TypedToolOperationSpec = {
  name: string;
  description: string;
  effect: "read" | "change";
  argv: string[];
  params?: Record<string, TypedToolParamSpec> | undefined;
  required?: string[] | undefined;
  exactlyOneOf?: string[][] | undefined;
  confirm?: TypedToolConfirmSpec | undefined;
  /** Appended to the argv for a side-effect-free preview shown before confirmation. */
  confirmPreviewArgv?: string[] | undefined;
};

export type TypedToolPendingEntry = {
  code: string;
  tool: string;
  workspaceDir: string;
  operation: string;
  params: Record<string, unknown>;
  requester: string;
  accountId?: string;
  summary: string;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "applying" | "applied" | "failed";
  resolvedAt?: number;
};

export type TypedToolPendingStore = {
  version: 1;
  entries: TypedToolPendingEntry[];
};

export type TypedToolConfirmationOutcome =
  | { kind: "reply"; text: string; store: TypedToolPendingStore }
  | { kind: "silent"; store: TypedToolPendingStore }
  | { kind: "commit"; entry: TypedToolPendingEntry; store: TypedToolPendingStore };

type TypedToolContextLike = {
  requesterSenderId?: unknown;
  sessionKey?: unknown;
};

export const TYPED_TOOL_OPENCLAW_PLUGIN_ID = "sovereign-typed-tools";
export const TYPED_TOOL_CONFIRM_COMMAND = "confirm";
export const TYPED_TOOL_INSTANCE_PLACEHOLDER = "<tool-instance-id>";
export const TYPED_TOOL_VALUE_PLACEHOLDER = "{value}";
export const TYPED_TOOL_MAX_LENGTH_LIMIT = 500;

export const typedToolIsRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const typedToolNormalizeUserId = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  const candidate = trimmed.startsWith("matrix:") ? trimmed.slice("matrix:".length) : trimmed;
  return /^@[^:\s]+:\S+$/.test(candidate) ? candidate.toLowerCase() : null;
};

export const typedToolBuildArgv = (input: {
  operation: TypedToolOperationSpec;
  params: unknown;
  toolInstanceId: string;
}): string[] => {
  const operation = input.operation;
  const specs = operation.params ?? {};
  const params = input.params;
  if (!typedToolIsRecord(params)) {
    throw new Error("Expected the tool parameters to be a JSON object");
  }
  for (const key of Object.keys(params)) {
    if (key !== "operation" && !Object.hasOwn(specs, key)) {
      throw new Error(`Parameter '${key}' is not accepted by operation '${operation.name}'`);
    }
  }
  const present = new Set<string>();
  for (const [name, spec] of Object.entries(specs)) {
    const value = params[name];
    if (value === undefined || value === null) {
      continue;
    }
    if (spec.type === "boolean") {
      if (typeof value !== "boolean") {
        throw new Error(`Parameter '${name}' must be true or false`);
      }
      if (value) {
        present.add(name);
      }
      continue;
    }
    if (typeof value !== "string") {
      throw new Error(`Parameter '${name}' must be a string`);
    }
    const limit = Math.min(spec.maxLength ?? 200, 500);
    if (value.length === 0 || value.length > limit) {
      throw new Error(`Parameter '${name}' must be 1 to ${String(limit)} characters long`);
    }
    if (
      Array.from(value).some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)
    ) {
      throw new Error(`Parameter '${name}' must not contain control characters`);
    }
    if (value.startsWith("-")) {
      throw new Error(`Parameter '${name}' must not start with '-'`);
    }
    if (spec.enum !== undefined && !spec.enum.includes(value)) {
      throw new Error(`Parameter '${name}' must be one of: ${spec.enum.join(", ")}`);
    }
    if (spec.pattern !== undefined && !new RegExp(spec.pattern, "u").test(value)) {
      throw new Error(`Parameter '${name}' has an invalid format`);
    }
    present.add(name);
  }
  for (const name of operation.required ?? []) {
    if (!present.has(name)) {
      throw new Error(`Operation '${operation.name}' requires '${name}'`);
    }
  }
  for (const group of operation.exactlyOneOf ?? []) {
    if (group.filter((name) => present.has(name)).length !== 1) {
      throw new Error(`Operation '${operation.name}' needs exactly one of: ${group.join(", ")}`);
    }
  }
  const argv = operation.argv.map((entry) =>
    entry === "<tool-instance-id>" ? input.toolInstanceId : entry,
  );
  for (const [name, spec] of Object.entries(specs)) {
    if (!present.has(name)) {
      continue;
    }
    for (const entry of spec.argv) {
      argv.push(entry === "{value}" ? String(params[name]) : entry);
    }
  }
  return argv;
};

export const typedToolNeedsConfirmation = (
  operation: TypedToolOperationSpec,
  params: Record<string, unknown>,
): boolean => {
  const confirm = operation.confirm;
  if (confirm === undefined) {
    return false;
  }
  if (confirm === "always") {
    return true;
  }
  const value = params[confirm.param];
  return typeof value === "string" && confirm.values.includes(value);
};

export const typedToolDescribeChange = (
  operation: TypedToolOperationSpec,
  params: Record<string, unknown>,
): string => {
  const parts = [operation.name];
  for (const [name, spec] of Object.entries(operation.params ?? {})) {
    const value = params[name];
    if (spec.type === "boolean") {
      if (value === true) {
        parts.push(name);
      }
      continue;
    }
    if (typeof value === "string") {
      parts.push(`${name}=${JSON.stringify(value)}`);
    }
  }
  return parts.join(" ");
};

export const typedToolResolveRequester = (toolContext: TypedToolContextLike): string => {
  const requester = typedToolNormalizeUserId(toolContext.requesterSenderId);
  if (requester === null) {
    throw new Error("This turn was not started by a Matrix user, so changes are refused");
  }
  const sessionKey = typeof toolContext.sessionKey === "string" ? toolContext.sessionKey : "";
  const marker = ":matrix:direct:";
  const markerIndex = sessionKey.lastIndexOf(marker);
  if (markerIndex >= 0) {
    const sessionActor = typedToolNormalizeUserId(sessionKey.slice(markerIndex + marker.length));
    if (sessionActor !== null && sessionActor !== requester) {
      throw new Error(
        "The requester does not match the direct-message session, so changes are refused",
      );
    }
  }
  return requester;
};

export const typedToolIsOperator = (userId: string, operatorUserIds: unknown): boolean =>
  Array.isArray(operatorUserIds) &&
  operatorUserIds.some((entry) => typedToolNormalizeUserId(entry) === userId);

export const typedToolBuildEnv = (
  processEnv: Record<string, string | undefined>,
  runtimeConfigPath: string,
): Record<string, string> => {
  const env: Record<string, string> = {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: "C.UTF-8",
    SOVEREIGN_NODE_CONFIG: runtimeConfigPath,
  };
  for (const key of ["HOME", "TMPDIR"]) {
    const value = processEnv[key];
    if (typeof value === "string" && value.length > 0) {
      env[key] = value;
    }
  }
  return env;
};

export const typedToolReadStore = (raw: string | undefined): TypedToolPendingStore => {
  if (raw === undefined) {
    return { version: 1, entries: [] };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typedToolIsRecord(parsed) && Array.isArray(parsed.entries)) {
      return {
        version: 1,
        entries: parsed.entries.filter(
          (entry: unknown): entry is TypedToolPendingEntry =>
            typedToolIsRecord(entry) &&
            typeof entry.code === "string" &&
            typeof entry.expiresAt === "number",
        ),
      };
    }
  } catch {
    // A damaged store only loses pending changes; it must never block a turn.
  }
  return { version: 1, entries: [] };
};

export const typedToolPruneStore = (
  store: TypedToolPendingStore,
  nowMs: number,
): TypedToolPendingStore => ({
  version: 1,
  entries: store.entries
    .filter((entry) => entry.expiresAt + 24 * 60 * 60 * 1000 > nowMs)
    .slice(-50),
});

export const typedToolGenerateCode = (bytes: Uint8Array): string => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let index = 0; index < 6; index += 1) {
    code += alphabet[(bytes[index] ?? 0) % alphabet.length];
  }
  return code;
};

export const typedToolResolveConfirmation = (input: {
  store: TypedToolPendingStore;
  args: unknown;
  senderId: unknown;
  accountId: unknown;
  operatorUserIds: unknown;
  nowMs: number;
}): TypedToolConfirmationOutcome => {
  const store = input.store;
  const code = typeof input.args === "string" ? input.args.trim().toUpperCase() : "";
  if (!/^[A-Z2-9]{6}$/.test(code)) {
    return { kind: "reply", text: "Usage: /confirm <code>", store };
  }
  const entry = store.entries.find((candidate) => candidate.code === code);
  if (entry === undefined) {
    return {
      kind: "reply",
      text: `No pending change matches ${code}. Nothing was changed.`,
      store,
    };
  }
  // Every bot account in the room receives the command; only the account that
  // recorded the change answers it.
  if (
    typeof entry.accountId === "string" &&
    typeof input.accountId === "string" &&
    entry.accountId !== input.accountId
  ) {
    return { kind: "silent", store };
  }
  const sender = typedToolNormalizeUserId(input.senderId);
  if (sender === null || !typedToolIsOperator(sender, input.operatorUserIds)) {
    return {
      kind: "reply",
      text: "Only the operator can confirm changes. Nothing was changed.",
      store,
    };
  }
  if (entry.status !== "pending") {
    return { kind: "reply", text: `Change ${code} was already handled.`, store };
  }
  if (entry.expiresAt <= input.nowMs) {
    return {
      kind: "reply",
      text: `Change ${code} expired. Nothing was changed; ask again to start over.`,
      store: { version: 1, entries: store.entries.filter((candidate) => candidate !== entry) },
    };
  }
  if (entry.requester !== sender) {
    return {
      kind: "reply",
      text: `Change ${code} was requested by another user and can only be confirmed by that user. Nothing was changed.`,
      store,
    };
  }
  const applying: TypedToolPendingEntry = { ...entry, status: "applying", resolvedAt: input.nowMs };
  return {
    kind: "commit",
    entry: applying,
    store: {
      version: 1,
      entries: store.entries.map((candidate) => (candidate === entry ? applying : candidate)),
    },
  };
};

export const typedToolCompleteConfirmation = (
  store: TypedToolPendingStore,
  code: string,
  status: "applied" | "failed",
): TypedToolPendingStore => ({
  version: 1,
  entries: store.entries.map((entry) => (entry.code === code ? { ...entry, status } : entry)),
});

export const typedToolSummarizeOutput = (
  stdout: string,
  stderr: string,
  exitCode: number,
): string => {
  const text = stdout.trim();
  try {
    const parsed: unknown = JSON.parse(text);
    if (typedToolIsRecord(parsed)) {
      if (typeof parsed.note === "string" && parsed.note.length > 0) {
        return parsed.note;
      }
      if (typedToolIsRecord(parsed.error) && typeof parsed.error.message === "string") {
        return parsed.error.message;
      }
    }
  } catch {
    // Not JSON: fall through to the raw text.
  }
  const raw = text.length > 0 ? text : stderr.trim();
  return raw.length > 0 ? raw.slice(0, 500) : `Command exited with code ${String(exitCode)}`;
};
