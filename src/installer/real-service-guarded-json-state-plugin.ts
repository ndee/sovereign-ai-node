import {
  extractGuardedJsonStateActorFromConversationInfoText,
  extractGuardedJsonStateActorFromDirectSessionKey,
  extractGuardedJsonStateActorFromUserContent,
  extractLatestGuardedJsonStateActorFromBranch,
  GUARDED_JSON_STATE_OPENCLAW_PLUGIN_ID,
  GUARDED_JSON_STATE_OPENCLAW_TOOL_NAME,
  isGuardedJsonStateRecord,
  normalizeGuardedJsonStateMatrixActorUserId,
  resolveGuardedJsonStateSessionContext,
  resolveGuardedJsonStateToolContext,
  resolveGuardedJsonStateWorkspaceDir,
} from "../openclaw/guarded-json-state-context.js";

export const renderGuardedJsonStateWorkspacePluginManifest = (): string =>
  JSON.stringify(
    {
      id: GUARDED_JSON_STATE_OPENCLAW_PLUGIN_ID,
      configSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    },
    null,
    2,
  );

export const renderGuardedJsonStateWorkspacePluginConfig = (input: {
  executablePath: string;
  runtimeConfigPath: string;
  workspaceBindings: Record<string, string[]>;
}): string =>
  JSON.stringify(
    {
      executablePath: input.executablePath,
      runtimeConfigPath: input.runtimeConfigPath,
      workspaceBindings: Object.fromEntries(
        Object.entries(input.workspaceBindings)
          .map(
            ([workspace, toolInstanceIds]) => [workspace, dedupeStrings(toolInstanceIds)] as const,
          )
          .sort(([left], [right]) => left.localeCompare(right)),
      ),
    },
    null,
    2,
  );

export const renderGuardedJsonStateWorkspacePluginRuntime = (): string => {
  const exports = [
    ["isGuardedJsonStateRecord", isGuardedJsonStateRecord],
    ["normalizeGuardedJsonStateMatrixActorUserId", normalizeGuardedJsonStateMatrixActorUserId],
    [
      "extractGuardedJsonStateActorFromDirectSessionKey",
      extractGuardedJsonStateActorFromDirectSessionKey,
    ],
    ["resolveGuardedJsonStateWorkspaceDir", resolveGuardedJsonStateWorkspaceDir],
    [
      "extractGuardedJsonStateActorFromConversationInfoText",
      extractGuardedJsonStateActorFromConversationInfoText,
    ],
    ["extractGuardedJsonStateActorFromUserContent", extractGuardedJsonStateActorFromUserContent],
    ["extractLatestGuardedJsonStateActorFromBranch", extractLatestGuardedJsonStateActorFromBranch],
    ["resolveGuardedJsonStateSessionContext", resolveGuardedJsonStateSessionContext],
    ["resolveGuardedJsonStateToolContext", resolveGuardedJsonStateToolContext],
  ] as const;
  return `${exports.map(([name, fn]) => `export const ${name} = ${fn.toString()};`).join("\n\n")}\n`;
};

export const renderGuardedJsonStateWorkspacePluginIndex =
  (): string => `import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

import {
  resolveGuardedJsonStateToolContext,
  resolveGuardedJsonStateWorkspaceDir,
} from "./runtime.js";

const TOOL_NAME = ${JSON.stringify(GUARDED_JSON_STATE_OPENCLAW_TOOL_NAME)};
const ACTIONS = ["show", "list", "upsert-self", "delete-self"];

let cachedConfig;
const loadConfig = async () => {
  if (cachedConfig !== undefined) {
    return cachedConfig;
  }
  cachedConfig = JSON.parse(await readFile(new URL("./plugin-config.json", import.meta.url), "utf8"));
  return cachedConfig;
};

const runCommand = async (command, args) =>
  await new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      resolve({
        exitCode: 127,
        stdout,
        stderr: stderr.length > 0 ? stderr : String(error?.message ?? error),
      });
    });
    child.on("close", (exitCode) => {
      resolve({
        exitCode: typeof exitCode === "number" ? exitCode : 1,
        stdout,
        stderr,
      });
    });
  });

const readJsonText = (value) => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length === 0 ? undefined : trimmed;
};

const requireString = (value, label) => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(\`Expected \${label}\`);
  }
  return value.trim();
};

const normalizeInput = (value) => {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected input to be a JSON object");
  }
  return value;
};

const buildCommandArgs = (params, config, sessionContext) => {
  const args = ["json-state", params.action, "--instance", requireString(params.instance, "instance")];
  if (typeof config.runtimeConfigPath === "string" && config.runtimeConfigPath.length > 0) {
    args.push("--config-path", config.runtimeConfigPath);
  }
  if (params.action === "show") {
    args.push("--json");
    return args;
  }
  args.push("--entity", requireString(params.entity, "entity"));
  if (params.action === "list") {
    args.push("--json");
    return args;
  }
  if (sessionContext === undefined) {
    throw new Error("Missing current Matrix session context for mutation");
  }
  if (typeof sessionContext.sessionKey === "string" && sessionContext.sessionKey.length > 0) {
    args.push("--session-key", sessionContext.sessionKey);
  }
  if (typeof sessionContext.originFrom === "string" && sessionContext.originFrom.length > 0) {
    args.push("--origin-from", sessionContext.originFrom);
  }
  if (params.action === "delete-self") {
    args.push("--id", requireString(params.id, "id"), "--json");
    return args;
  }
  const input = normalizeInput(params.input);
  args.push("--input-json", JSON.stringify(input ?? {}), "--json");
  return args;
};

const parseCommandOutput = (stdout) => {
  const text = readJsonText(stdout);
  if (text === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export default function (api) {
  api.registerTool(
    (toolContext) => ({
      name: TOOL_NAME,
      label: TOOL_NAME,
      description: "Read and mutate guarded JSON state for this agent's bound tool instances. Matrix actor resolution is derived from the active OpenClaw session.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["instance", "action"],
        properties: {
          instance: {
            type: "string",
            description: "Bound guarded state tool instance id",
          },
          action: {
            type: "string",
            enum: ACTIONS,
            description: "State operation to perform",
          },
          entity: {
            type: "string",
            description: "Entity id for list or mutation calls",
          },
          id: {
            type: "string",
            description: "Record id for delete-self",
          },
          input: {
            type: "object",
            additionalProperties: true,
            description: "Mutation payload for upsert-self",
          },
        },
      },
      async execute(_toolCallId, params) {
        const config = await loadConfig();
        const workspaceDir = resolveGuardedJsonStateWorkspaceDir(toolContext?.workspaceDir);
        const allowedInstanceIds = Array.isArray(config.workspaceBindings?.[workspaceDir])
          ? config.workspaceBindings[workspaceDir]
          : [];
        if (!allowedInstanceIds.includes(params.instance)) {
          return {
            content: [{ type: "text", text: \`Instance '\${String(params.instance ?? "")}' is not bound to this agent.\` }],
            details: {
              status: "failed",
              exitCode: 2,
              command: TOOL_NAME,
            },
          };
        }

        let sessionContext;
        if (params.action === "upsert-self" || params.action === "delete-self") {
          sessionContext = resolveGuardedJsonStateToolContext(toolContext ?? {});
        }

        const args = buildCommandArgs(params, config, sessionContext);
        const result = await runCommand(config.executablePath, args);
        const parsed = parseCommandOutput(result.stdout);
        const text =
          readJsonText(result.stdout)
          ?? readJsonText(result.stderr)
          ?? TOOL_NAME + " exited with code " + String(result.exitCode);
        return {
          content: [{ type: "text", text }],
          details: {
            status: result.exitCode === 0 ? "completed" : "failed",
            exitCode: result.exitCode,
            command: [config.executablePath, ...args].join(" "),
            ...(sessionContext === undefined
              ? {}
              : {
                  actor: sessionContext.actor,
                  ...(typeof sessionContext.sessionKey === "string"
                    ? { sessionKey: sessionContext.sessionKey }
                    : {}),
                  ...(typeof sessionContext.originFrom === "string"
                    ? { originFrom: sessionContext.originFrom }
                    : {}),
                }),
            ...(parsed === undefined ? {} : { parsed }),
          },
        };
      },
    }),
    { optional: true },
  );
}
`;

const dedupeStrings = (values: string[]): string[] => Array.from(new Set(values));
