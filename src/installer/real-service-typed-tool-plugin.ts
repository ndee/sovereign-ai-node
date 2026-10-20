import {
  TYPED_TOOL_CONFIRM_COMMAND,
  TYPED_TOOL_OPENCLAW_PLUGIN_ID,
  type TypedToolOperationSpec,
  typedToolBuildArgv,
  typedToolBuildEnv,
  typedToolCompleteConfirmation,
  typedToolDescribeChange,
  typedToolGenerateCode,
  typedToolIsOperator,
  typedToolIsRecord,
  typedToolNeedsConfirmation,
  typedToolNormalizeUserId,
  typedToolPruneStore,
  typedToolReadStore,
  typedToolResolveConfirmation,
  typedToolResolveRequester,
  typedToolSummarizeOutput,
} from "../openclaw/typed-tool-runtime.js";

export type TypedToolPluginBinding = {
  workspaceDir: string;
  toolInstanceId: string;
  script: string;
  cwd: string;
};

export type TypedToolPluginTool = {
  name: string;
  description: string;
  operations: TypedToolOperationSpec[];
  bindings: TypedToolPluginBinding[];
};

export type TypedToolPluginConfig = {
  runtimeConfigPath: string;
  stateDir: string;
  operatorUserIds: string[];
  confirmTtlMs: number;
  commandTimeoutMs: number;
  tools: TypedToolPluginTool[];
};

export const TYPED_TOOL_CONFIRM_TTL_MS = 15 * 60 * 1000;
export const TYPED_TOOL_COMMAND_TIMEOUT_MS = 120_000;

export const renderTypedToolPluginManifest = (): string =>
  JSON.stringify(
    {
      id: TYPED_TOOL_OPENCLAW_PLUGIN_ID,
      configSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    },
    null,
    2,
  );

export const renderTypedToolPluginConfig = (config: TypedToolPluginConfig): string =>
  JSON.stringify(
    {
      ...config,
      operatorUserIds: Array.from(new Set(config.operatorUserIds)).sort(),
      tools: [...config.tools]
        .map((tool) => ({
          ...tool,
          bindings: [...tool.bindings].sort((left, right) =>
            left.workspaceDir.localeCompare(right.workspaceDir),
          ),
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    },
    null,
    2,
  );

export const renderTypedToolPluginRuntime = (): string => {
  const exports = [
    ["typedToolIsRecord", typedToolIsRecord],
    ["typedToolNormalizeUserId", typedToolNormalizeUserId],
    ["typedToolBuildArgv", typedToolBuildArgv],
    ["typedToolNeedsConfirmation", typedToolNeedsConfirmation],
    ["typedToolDescribeChange", typedToolDescribeChange],
    ["typedToolResolveRequester", typedToolResolveRequester],
    ["typedToolIsOperator", typedToolIsOperator],
    ["typedToolBuildEnv", typedToolBuildEnv],
    ["typedToolReadStore", typedToolReadStore],
    ["typedToolPruneStore", typedToolPruneStore],
    ["typedToolGenerateCode", typedToolGenerateCode],
    ["typedToolResolveConfirmation", typedToolResolveConfirmation],
    ["typedToolCompleteConfirmation", typedToolCompleteConfirmation],
    ["typedToolSummarizeOutput", typedToolSummarizeOutput],
  ] as const;
  return `${exports.map(([name, fn]) => `export const ${name} = ${fn.toString()};`).join("\n\n")}\n`;
};

// The plugin never starts a shell: each call runs the gateway's own node binary
// with the node-chosen script and an argv array built from the declared
// operation, and changes are refused unless the operator started the turn.
export const renderTypedToolPluginIndex = (): string => `import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  typedToolBuildArgv,
  typedToolBuildEnv,
  typedToolCompleteConfirmation,
  typedToolDescribeChange,
  typedToolGenerateCode,
  typedToolIsOperator,
  typedToolNeedsConfirmation,
  typedToolPruneStore,
  typedToolReadStore,
  typedToolResolveConfirmation,
  typedToolResolveRequester,
  typedToolSummarizeOutput,
} from "./runtime.js";

const CONFIRM_COMMAND = ${JSON.stringify(TYPED_TOOL_CONFIRM_COMMAND)};
const config = JSON.parse(readFileSync(new URL("./plugin-config.json", import.meta.url), "utf8"));
const storePath = join(config.stateDir, "pending.json");

const readStore = async () => {
  try {
    return typedToolReadStore(await readFile(storePath, "utf8"));
  } catch {
    return typedToolReadStore(undefined);
  }
};

const writeStore = async (store) => {
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const tempPath = storePath + "." + String(process.pid) + "." + String(Date.now()) + ".tmp";
  await writeFile(tempPath, JSON.stringify(store, null, 2) + "\\n", { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, storePath);
};

const runCommand = async (binding, argv) =>
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [binding.script, ...argv], {
      cwd: binding.cwd,
      env: typedToolBuildEnv(process.env, config.runtimeConfigPath),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), config.commandTimeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: 127, stdout, stderr: stderr.length > 0 ? stderr : String(error?.message ?? error) });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode: typeof exitCode === "number" ? exitCode : 1, stdout, stderr });
    });
  });

const textResult = (status, text, extra) => ({
  content: [{ type: "text", text }],
  details: { status, ...(extra ?? {}) },
});

const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

const buildParameters = (tool) => {
  const properties = {
    operation: {
      type: "string",
      enum: tool.operations.map((operation) => operation.name),
      description: "Operation to run",
    },
  };
  for (const operation of tool.operations) {
    for (const [name, spec] of Object.entries(operation.params ?? {})) {
      if (properties[name] === undefined) {
        properties[name] = { type: spec.type, description: spec.description };
      }
    }
  }
  return { type: "object", additionalProperties: false, required: ["operation"], properties };
};

const describeTool = (tool) =>
  [
    tool.description,
    "Operations:",
    ...tool.operations.map((operation) => {
      const params = Object.keys(operation.params ?? {});
      return "- " + operation.name + (params.length === 0 ? "" : " (" + params.join(", ") + ")") + ": " + operation.description;
    }),
  ].join("\\n");

const createTool = (tool, binding, toolContext) => ({
  name: tool.name,
  label: tool.name,
  description: describeTool(tool),
  parameters: buildParameters(tool),
  async execute(_toolCallId, params) {
    const operation = tool.operations.find((candidate) => candidate.name === params?.operation);
    if (operation === undefined) {
      return textResult("failed", "Unknown operation '" + String(params?.operation ?? "") + "'.");
    }
    let argv;
    try {
      argv = typedToolBuildArgv({ operation, params, toolInstanceId: binding.toolInstanceId });
    } catch (error) {
      return textResult("failed", errorMessage(error), { operation: operation.name });
    }
    let requester;
    if (operation.effect === "change") {
      try {
        requester = typedToolResolveRequester(toolContext ?? {});
      } catch (error) {
        return textResult("refused", errorMessage(error) + ". Nothing was changed.", { operation: operation.name });
      }
      if (!typedToolIsOperator(requester, config.operatorUserIds)) {
        return textResult("refused", "Changes are accepted only from the operator. Nothing was changed.", {
          operation: operation.name,
          requester,
        });
      }
      if (typedToolNeedsConfirmation(operation, params)) {
        let preview;
        if (Array.isArray(operation.confirmPreviewArgv)) {
          const previewResult = await runCommand(binding, [...argv, ...operation.confirmPreviewArgv]);
          const previewText = previewResult.stdout.trim() || previewResult.stderr.trim();
          if (previewResult.exitCode !== 0) {
            return textResult("failed", previewText || tool.name + " exited with code " + String(previewResult.exitCode), {
              operation: operation.name,
              exitCode: previewResult.exitCode,
              requester,
            });
          }
          preview = previewText.slice(0, 4000);
        }
        const now = Date.now();
        const store = typedToolPruneStore(await readStore(), now);
        let code = typedToolGenerateCode(randomBytes(6));
        while (store.entries.some((entry) => entry.code === code)) {
          code = typedToolGenerateCode(randomBytes(6));
        }
        const declared = Object.fromEntries(
          Object.keys(operation.params ?? {})
            .filter((name) => params[name] !== undefined && params[name] !== null)
            .map((name) => [name, params[name]]),
        );
        const summary = typedToolDescribeChange(operation, params);
        const accountId = typeof toolContext?.agentAccountId === "string" ? toolContext.agentAccountId : undefined;
        await writeStore({
          version: 1,
          entries: [
            ...store.entries,
            {
              code,
              tool: tool.name,
              workspaceDir: binding.workspaceDir,
              operation: operation.name,
              params: declared,
              requester,
              ...(accountId === undefined ? {} : { accountId }),
              summary,
              createdAt: now,
              expiresAt: now + config.confirmTtlMs,
              status: "pending",
            },
          ],
        });
        const minutes = Math.round(config.confirmTtlMs / 60000);
        return textResult(
          "confirmation-required",
          JSON.stringify(
            {
              ok: true,
              confirmationRequired: true,
              code,
              change: summary,
              ...(preview === undefined ? {} : { preview }),
              expiresInMinutes: minutes,
              note: "Nothing has changed yet. To apply this change, the operator sends: /" + CONFIRM_COMMAND + " " + code,
            },
            null,
            2,
          ),
          { operation: operation.name, requester, code },
        );
      }
    }
    const result = await runCommand(binding, argv);
    const text = result.stdout.trim() || result.stderr.trim() || tool.name + " exited with code " + String(result.exitCode);
    return textResult(result.exitCode === 0 ? "completed" : "failed", text, {
      operation: operation.name,
      exitCode: result.exitCode,
      ...(requester === undefined ? {} : { requester }),
    });
  },
});

const confirmPendingChange = async (ctx) => {
  const now = Date.now();
  const outcome = typedToolResolveConfirmation({
    store: typedToolPruneStore(await readStore(), now),
    args: ctx?.args,
    senderId: ctx?.senderId,
    accountId: ctx?.accountId,
    operatorUserIds: config.operatorUserIds,
    nowMs: now,
  });
  await writeStore(outcome.store);
  if (outcome.kind === "silent") {
    return {};
  }
  if (outcome.kind === "reply") {
    return { text: outcome.text };
  }
  const entry = outcome.entry;
  const tool = config.tools.find((candidate) => candidate.name === entry.tool);
  const binding = tool?.bindings.find((candidate) => candidate.workspaceDir === entry.workspaceDir);
  const operation = tool?.operations.find((candidate) => candidate.name === entry.operation);
  let argv;
  try {
    if (tool === undefined || binding === undefined || operation === undefined) {
      throw new Error("the tool for this change is no longer configured");
    }
    argv = typedToolBuildArgv({
      operation,
      params: { ...entry.params, operation: entry.operation },
      toolInstanceId: binding.toolInstanceId,
    });
  } catch (error) {
    await writeStore(typedToolCompleteConfirmation(await readStore(), entry.code, "failed"));
    return { text: "Change " + entry.code + " could not be applied: " + errorMessage(error) + ". Nothing was changed." };
  }
  const result = await runCommand(binding, argv);
  const status = result.exitCode === 0 ? "applied" : "failed";
  await writeStore(typedToolCompleteConfirmation(await readStore(), entry.code, status));
  const output = typedToolSummarizeOutput(result.stdout, result.stderr, result.exitCode);
  return {
    text:
      status === "applied"
        ? "Change " + entry.code + " applied (" + entry.summary + "). " + output
        : "Change " + entry.code + " failed (" + entry.summary + "): " + output,
  };
};

export default function (api) {
  for (const tool of config.tools) {
    api.registerTool(
      (toolContext) => {
        const workspaceDir = typeof toolContext?.workspaceDir === "string" ? toolContext.workspaceDir.trim() : "";
        const binding = tool.bindings.find((candidate) => candidate.workspaceDir === workspaceDir);
        return binding === undefined ? null : createTool(tool, binding, toolContext);
      },
      { name: tool.name, optional: true },
    );
  }
  api.registerCommand({
    name: CONFIRM_COMMAND,
    description: "Apply a change that a bot recorded for operator confirmation: /" + CONFIRM_COMMAND + " <code>",
    acceptsArgs: true,
    requireAuth: true,
    handler: confirmPendingChange,
  });
}
`;
