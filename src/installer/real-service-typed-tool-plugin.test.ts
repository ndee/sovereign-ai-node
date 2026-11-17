import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TypedToolOperationSpec } from "../openclaw/typed-tool-runtime.js";
import {
  assignTypedToolSlashCommands,
  renderTypedToolPluginConfig,
  renderTypedToolPluginIndex,
  renderTypedToolPluginManifest,
  renderTypedToolPluginRuntime,
  TYPED_TOOL_CHAT_UNAVAILABLE_REWRITES,
  type TypedToolPluginConfig,
} from "./real-service-typed-tool-plugin.js";

// Copied byte for byte from openclaw@2026.8.35 dist/user-copy-l0XnFuNV.js.
const OPENCLAW_MODEL_UNAVAILABLE_COPY =
  "⚠️ The configured model is unavailable from the provider — it may have been renamed, retired, or is not offered on this account. This needs a config update (agents.defaults.model); retrying or starting a new session won't fix it.";
const OPENCLAW_PROVIDER_INTERNAL_COPY =
  "⚠️ The model provider returned a temporary internal error before replying. Try again in a moment, or switch to another model if it keeps happening.";
const OPENCLAW_GENERIC_FAILURE_COPY =
  "⚠️ Something went wrong while processing your request. Please try again, or use /new to start a fresh session.";

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
};
type RegisteredTool = {
  name: string;
  description: string;
  parameters: { properties: Record<string, unknown>; required: string[] };
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<ToolResult>;
};
type ToolFactory = (context: Record<string, unknown>) => RegisteredTool | null;
type CommandDefinition = {
  name: string;
  description: string;
  acceptsArgs: boolean;
  requireAuth: boolean;
  handler: (ctx: Record<string, unknown>) => Promise<{ text?: string }>;
};

type ReplyPayloadHook = (
  event: { payload: Record<string, unknown> },
  ctx: Record<string, unknown>,
) => { payload?: Record<string, unknown> } | undefined;

const OPERATOR = "@operator:example.org";

const OPERATIONS: TypedToolOperationSpec[] = [
  {
    name: "show",
    description: "Show something",
    effect: "read",
    argv: ["show", "--instance", "<tool-instance-id>", "--json"],
    params: { name: { type: "string", description: "Name", argv: ["--name", "{value}"] } },
  },
  {
    name: "raise",
    description: "Raise alerting",
    effect: "change",
    argv: ["raise", "--instance", "<tool-instance-id>", "--json"],
  },
  {
    name: "lower",
    description: "Lower alerting",
    effect: "change",
    argv: ["lower", "--instance", "<tool-instance-id>", "--json"],
    params: {
      mode: {
        type: "string",
        description: "Mode",
        enum: ["ok", "fail"],
        argv: ["--mode", "{value}"],
      },
    },
    confirm: "always",
  },
  {
    name: "tune",
    description: "Lower alerting with a preview",
    effect: "change",
    argv: ["tune", "--instance", "<tool-instance-id>", "--json"],
    params: {
      mode: {
        type: "string",
        description: "Mode",
        enum: ["ok", "fail"],
        argv: ["--mode", "{value}"],
      },
    },
    confirm: "always",
    confirmPreviewArgv: ["--dry-run"],
  },
  {
    name: "slow",
    description: "Never finishes",
    effect: "read",
    argv: ["slow"],
  },
];

// Records every call in the working directory and answers like the bot CLI.
const FAKE_CLI = `import { appendFileSync } from "node:fs";
const argv = process.argv.slice(2);
appendFileSync("calls.log", JSON.stringify(argv) + "\\n");
if (argv[0] === "slow") {
  setTimeout(() => {}, 60_000);
} else if (argv.includes("--dry-run") && !argv.includes("fail")) {
  process.stdout.write(JSON.stringify({ ok: true, dryRun: true, ruleSummary: "domain example.com -> max-zone amber" }));
} else if (argv.includes("fail")) {
  process.stdout.write(JSON.stringify({ ok: false, error: { message: "refused by cli" } }));
  process.exitCode = 3;
} else {
  process.stdout.write(JSON.stringify({ ok: true, note: "Done.", argv, env: process.env, cwd: process.cwd() }));
}
`;

const INFO_OPERATIONS: TypedToolOperationSpec[] = [
  {
    name: "version",
    description: "Report the running build",
    effect: "read",
    argv: ["version", "--json"],
    slashCommand: "version",
  },
  {
    name: "broken",
    description: "Always fails",
    effect: "read",
    argv: ["fail"],
    slashCommand: "broken",
  },
  {
    name: "strict",
    description: "Needs a parameter",
    effect: "read",
    argv: ["strict"],
    params: { query: { type: "string", description: "Query", argv: ["--query", "{value}"] } },
    required: ["query"],
  },
];

let tempRoot = "";
let workspace = "";
let pluginDir = "";
let stateDir = "";
const tools = new Map<string, { factory: ToolFactory; options: Record<string, unknown> }>();
const commands: CommandDefinition[] = [];
const hooks: Array<{ name: string; handler: ReplyPayloadHook }> = [];
const plainCommands: CommandDefinition[] = [];

const toolFor = (context: Record<string, unknown>): RegisteredTool => {
  const tool = tools.get("demo_tool")?.factory({ workspaceDir: ` ${workspace} `, ...context });
  if (tool === null || tool === undefined) {
    throw new Error("expected the demo tool to be bound");
  }
  return tool;
};

const command = (name: string): CommandDefinition => {
  const found = commands.find((candidate) => candidate.name === name);
  if (found === undefined) {
    throw new Error(`command ${name} missing`);
  }
  return found;
};

const confirm = async (ctx: Record<string, unknown>): Promise<{ text?: string }> =>
  await command("confirm").handler(ctx);

const rewriteReply = (payload: Record<string, unknown>) => {
  const hook = hooks[0];
  if (hook === undefined) {
    throw new Error("reply hook missing");
  }
  return hook.handler({ payload }, { channelId: "matrix" });
};

// The plugin imports ./runtime.js; load it as ESM under vitest.
const loadPlugin = async (
  dir: string,
  config: TypedToolPluginConfig,
  api: Record<string, unknown>,
): Promise<void> => {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "openclaw.plugin.json"),
    renderTypedToolPluginManifest(config.tools.map((tool) => tool.name)),
    "utf8",
  );
  await writeFile(join(dir, "plugin-config.json"), renderTypedToolPluginConfig(config), "utf8");
  await writeFile(join(dir, "runtime.mjs"), renderTypedToolPluginRuntime(), "utf8");
  await writeFile(
    join(dir, "index.mjs"),
    renderTypedToolPluginIndex().replace('"./runtime.js"', '"./runtime.mjs"'),
    "utf8",
  );
  const plugin = (await import(pathToFileURL(join(dir, "index.mjs")).href)) as {
    default: (api: unknown) => void;
  };
  plugin.default(api);
};

const calls = async (): Promise<string[][]> =>
  (await readFile(join(workspace, "calls.log"), "utf8").catch(() => ""))
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as string[]);

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "typed-tool-plugin-test-"));
  workspace = join(tempRoot, "workspace");
  pluginDir = join(tempRoot, "extension");
  stateDir = join(tempRoot, "state");
  await mkdir(workspace, { recursive: true });
  await mkdir(join(pluginDir, "bin"), { recursive: true });
  const script = join(pluginDir, "bin", "fake-cli.mjs");
  await writeFile(script, FAKE_CLI, "utf8");
  const config: TypedToolPluginConfig = {
    runtimeConfigPath: "/etc/sovereign-node/sovereign-node.json5",
    stateDir,
    operatorUserIds: [OPERATOR, OPERATOR],
    confirmTtlMs: 15 * 60 * 1000,
    commandTimeoutMs: 1_000,
    replyPayloadRewrites: [...TYPED_TOOL_CHAT_UNAVAILABLE_REWRITES],
    tools: [
      {
        name: "demo_tool",
        description: "Demo",
        operations: OPERATIONS,
        bindings: [
          { workspaceDir: workspace, toolInstanceId: "demo-core", script, cwd: workspace },
          {
            workspaceDir: join(tempRoot, "gone"),
            toolInstanceId: "gone-core",
            script,
            cwd: join(tempRoot, "gone"),
          },
        ],
      },
      {
        name: "another_tool",
        description: "Another",
        operations: [OPERATIONS[0] as TypedToolOperationSpec],
        bindings: [],
      },
      {
        name: "info_tool",
        description: "Info",
        operations: INFO_OPERATIONS,
        // A config written by hand, not by node: one entry names a missing
        // operation and one an operation with parameters.
        slashCommands: {
          version: "version",
          broken: "broken",
          strict: "strict",
          orphan: "missing",
        },
        bindings: [
          {
            workspaceDir: workspace,
            toolInstanceId: "info-core",
            script,
            cwd: workspace,
            accountId: "info-bot",
          },
          {
            workspaceDir: join(tempRoot, "gone"),
            toolInstanceId: "gone-info",
            script,
            cwd: join(tempRoot, "gone"),
            accountId: "gone-bot",
          },
        ],
      },
    ],
  };
  await loadPlugin(pluginDir, config, {
    registerTool: (factory: ToolFactory, options: Record<string, unknown>) => {
      tools.set(String(options.name), { factory, options });
    },
    registerCommand: (definition: CommandDefinition) => {
      commands.push(definition);
    },
    on: (name: string, handler: ReplyPayloadHook) => {
      hooks.push({ name, handler });
    },
  });
  // A 2026.3 gateway has no reply hook: the plugin must not ask for one.
  await loadPlugin(
    join(tempRoot, "plain-extension"),
    {
      ...config,
      replyPayloadRewrites: undefined,
      tools: config.tools.map(({ slashCommands: _slashCommands, ...tool }) => tool),
    },
    {
      registerTool: () => undefined,
      registerCommand: (definition: CommandDefinition) => {
        plainCommands.push(definition);
      },
    },
  );
});

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("typed tool plugin rendering", () => {
  // OpenClaw 2026.8 loads a plugin's tool runtime only for the tools its
  // manifest declares, and a registerTool name outside the list is refused.
  it("declares exactly the tools the plugin registers and loads it on startup", async () => {
    const manifest = JSON.parse(
      await readFile(join(pluginDir, "openclaw.plugin.json"), "utf8"),
    ) as { activation?: { onStartup?: boolean }; contracts?: { tools?: string[] } };
    expect(manifest.contracts?.tools).toEqual(Array.from(tools.keys()).sort());
    expect(manifest.activation?.onStartup).toBe(true);
  });

  it("renders a manifest without plugin config and a sorted, deduplicated config", () => {
    expect(
      JSON.parse(renderTypedToolPluginManifest(["zeta_tool", "alpha_tool", "zeta_tool"])),
    ).toEqual({
      id: "sovereign-typed-tools",
      activation: { onStartup: true },
      contracts: { tools: ["alpha_tool", "zeta_tool"] },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    });
    const rendered = JSON.parse(
      renderTypedToolPluginConfig({
        runtimeConfigPath: "/c",
        stateDir: "/s",
        operatorUserIds: ["@b:x", "@a:x", "@b:x"],
        confirmTtlMs: 1,
        commandTimeoutMs: 2,
        tools: [
          {
            name: "z_tool",
            description: "z",
            operations: [],
            bindings: [
              { workspaceDir: "/w2", toolInstanceId: "b", script: "/s", cwd: "/w2" },
              { workspaceDir: "/w1", toolInstanceId: "a", script: "/s", cwd: "/w1" },
            ],
          },
          { name: "a_tool", description: "a", operations: [], bindings: [] },
        ],
      }),
    ) as TypedToolPluginConfig;
    expect(rendered.operatorUserIds).toEqual(["@a:x", "@b:x"]);
    expect(rendered.tools.map((tool) => tool.name)).toEqual(["a_tool", "z_tool"]);
    expect(rendered.tools[1]?.bindings.map((binding) => binding.workspaceDir)).toEqual([
      "/w1",
      "/w2",
    ]);
  });

  it("registers optional tools by name and a confirm command that needs an authorized sender", () => {
    expect(Array.from(tools.keys())).toEqual(["another_tool", "demo_tool", "info_tool"]);
    expect(tools.get("demo_tool")?.options).toEqual({ name: "demo_tool", optional: true });
    expect(
      commands.map((definition) => [
        definition.name,
        definition.acceptsArgs,
        definition.requireAuth,
      ]),
    ).toEqual([
      ["confirm", true, true],
      ["broken", false, true],
      ["orphan", false, true],
      ["strict", false, true],
      ["version", false, true],
    ]);
    expect(command("version").description).toBe("Report the running build");
    expect(command("orphan").description).toBe("/orphan");
  });

  it("registers no slash command and no reply hook without a declaration", () => {
    expect(plainCommands.map((definition) => definition.name)).toEqual(["confirm"]);
  });

  it("renders slash commands and the account of each binding into the config", () => {
    const rendered = JSON.parse(
      renderTypedToolPluginConfig({
        runtimeConfigPath: "/c",
        stateDir: "/s",
        operatorUserIds: [],
        confirmTtlMs: 1,
        commandTimeoutMs: 2,
        replyPayloadRewrites: [...TYPED_TOOL_CHAT_UNAVAILABLE_REWRITES],
        tools: [
          {
            name: "a_tool",
            description: "a",
            operations: [],
            slashCommands: { version: "version" },
            bindings: [
              {
                workspaceDir: "/w",
                toolInstanceId: "a",
                script: "/s",
                cwd: "/w",
                accountId: "bot",
              },
            ],
          },
        ],
      }),
    ) as TypedToolPluginConfig;
    expect(rendered.replyPayloadRewrites).toEqual(TYPED_TOOL_CHAT_UNAVAILABLE_REWRITES);
    expect(rendered.tools[0]?.slashCommands).toEqual({ version: "version" });
    expect(rendered.tools[0]?.bindings[0]?.accountId).toBe("bot");
  });

  it("offers a tool only to the agents bound to it", () => {
    expect(tools.get("demo_tool")?.factory({ workspaceDir: join(tempRoot, "other") })).toBeNull();
    expect(tools.get("demo_tool")?.factory({})).toBeNull();
    const tool = toolFor({});
    expect(tool.name).toBe("demo_tool");
    expect(tool.description).toContain("- lower (mode): Lower alerting");
    expect(tool.description).toContain("- raise: Raise alerting");
    expect(tool.parameters.required).toEqual(["operation"]);
    expect(tool.parameters.properties.operation).toEqual({
      type: "string",
      enum: ["show", "raise", "lower", "tune", "slow"],
      description: "Operation to run",
    });
    expect(tool.parameters.properties.mode).toEqual({ type: "string", description: "Mode" });
  });
});

describe("typed tool slash commands", () => {
  it("answers a slash command from the operation's note for the bound account only", async () => {
    const before = (await calls()).length;
    expect(await command("version").handler({ accountId: "info-bot", agentId: "info" })).toEqual({
      text: "Done.",
    });
    expect((await calls()).slice(before)).toEqual([["version", "--json"]]);
  });

  it("stays silent for an account without a binding and for a turn without an account", async () => {
    const before = (await calls()).length;
    expect(await command("version").handler({ accountId: "other-bot" })).toEqual({});
    expect(await command("version").handler({})).toEqual({});
    expect(await command("orphan").handler({ accountId: "info-bot" })).toEqual({});
    expect((await calls()).length).toBe(before);
  });

  it("replies with the error text of a failing run", async () => {
    expect(await command("broken").handler({ accountId: "info-bot" })).toEqual({
      text: "refused by cli",
    });
    expect(await command("strict").handler({ accountId: "info-bot" })).toEqual({
      text: "Operation 'strict' requires 'query'",
    });
    const gone = await command("version").handler({ accountId: "gone-bot" });
    expect(gone.text).toContain("ENOENT");
  });
});

describe("typed tool reply rewrites", () => {
  it("replaces the raw provider error with one calm line and keeps the rest of the payload", () => {
    expect(hooks.map((hook) => hook.name)).toEqual(["reply_payload_sending"]);
    expect(
      rewriteReply({
        text: '404 {"error":{"message":"No allowed providers are available for the selected model."}}',
        isError: true,
      }),
    ).toEqual({
      payload: {
        text: "Chat is not available with the current model settings; mail alerts are not affected. Check the model settings.",
        isError: true,
      },
    });
  });

  it("replaces OpenClaw's own copy for a model the provider does not serve", () => {
    expect(rewriteReply({ text: OPENCLAW_MODEL_UNAVAILABLE_COPY, isError: true })).toEqual({
      payload: {
        text: "Chat is not available with the current model settings; mail alerts are not affected. Check the model settings.",
        isError: true,
      },
    });
  });

  it("leaves every other reply untouched", () => {
    expect(rewriteReply({ text: "Mail Sentinel 2.4.1" })).toBeUndefined();
    expect(rewriteReply({ text: OPENCLAW_PROVIDER_INTERNAL_COPY, isError: true })).toBeUndefined();
    expect(rewriteReply({ text: OPENCLAW_GENERIC_FAILURE_COPY, isError: true })).toBeUndefined();
    expect(rewriteReply({ mediaUrl: "mxc://example.org/x" })).toBeUndefined();
  });
});

describe("assignTypedToolSlashCommands", () => {
  const op = (
    name: string,
    extra: Partial<TypedToolOperationSpec> = {},
  ): TypedToolOperationSpec => ({
    name,
    description: name,
    effect: "read",
    argv: [name],
    ...extra,
  });

  it("maps each slash command to its read operation, first tool by name wins", () => {
    expect(
      assignTypedToolSlashCommands([
        { name: "zeta_tool", operations: [op("about", { slashCommand: "version" })] },
        {
          name: "alpha_tool",
          operations: [
            op("version", { slashCommand: "version" }),
            op("ping", { slashCommand: "ping" }),
            op("plain"),
            op("apply", { effect: "change", slashCommand: "apply" }),
          ],
        },
      ]),
    ).toEqual({
      tools: [
        expect.objectContaining({
          name: "alpha_tool",
          slashCommands: { ping: "ping", version: "version" },
        }),
        expect.not.objectContaining({ slashCommands: expect.anything() }),
      ],
      conflicts: [{ slashCommand: "version", toolName: "zeta_tool", claimedBy: "alpha_tool" }],
    });
  });
});

describe("typed tool plugin execution", () => {
  it("runs a read operation with the gateway's node, a fixed argv and a fixed environment", async () => {
    const result = await toolFor({}).execute("call-1", {
      operation: "show",
      name: "x; touch /tmp/pwned $(id)",
    });
    expect(result.details).toMatchObject({ status: "completed", exitCode: 0, operation: "show" });
    const output = JSON.parse(result.content[0]?.text ?? "{}") as {
      argv: string[];
      env: Record<string, string>;
      cwd: string;
    };
    expect(output.argv).toEqual([
      "show",
      "--instance",
      "demo-core",
      "--json",
      "--name",
      "x; touch /tmp/pwned $(id)",
    ]);
    expect(output.cwd).toBe(workspace);
    expect(output.env.SOVEREIGN_NODE_CONFIG).toBe("/etc/sovereign-node/sovereign-node.json5");
    expect(output.env.PATH).toBe("/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
    expect(Object.keys(output.env).sort()).toEqual(
      expect.arrayContaining(["LANG", "PATH", "SOVEREIGN_NODE_CONFIG"]),
    );
    expect(output.env.npm_config_user_agent).toBeUndefined();
  });

  it("rejects unknown operations and invalid parameters without running anything", async () => {
    const before = (await calls()).length;
    expect(await toolFor({}).execute("c", { operation: "rm" })).toMatchObject({
      details: { status: "failed" },
      content: [{ text: "Unknown operation 'rm'." }],
    });
    expect(await toolFor({}).execute("c", {} as Record<string, unknown>)).toMatchObject({
      content: [{ text: "Unknown operation ''." }],
    });
    expect(await toolFor({}).execute("c", { operation: "show", name: "--json" })).toMatchObject({
      details: { status: "failed", operation: "show" },
      content: [{ text: "Parameter 'name' must not start with '-'" }],
    });
    expect((await calls()).length).toBe(before);
  });

  it("refuses changes in turns the operator did not start", async () => {
    const before = (await calls()).length;
    expect(await toolFor({}).execute("c", { operation: "raise" })).toMatchObject({
      details: { status: "refused" },
      content: [{ text: expect.stringContaining("not started by a Matrix user") }],
    });
    expect(
      await toolFor({ requesterSenderId: "@guest:example.org" }).execute("c", {
        operation: "raise",
      }),
    ).toMatchObject({
      details: { status: "refused", requester: "@guest:example.org" },
      content: [{ text: "Changes are accepted only from the operator. Nothing was changed." }],
    });
    expect((await calls()).length).toBe(before);
  });

  it("applies a change the operator asked for in this turn", async () => {
    const result = await toolFor({ requesterSenderId: OPERATOR }).execute("c", {
      operation: "raise",
    });
    expect(result.details).toMatchObject({ status: "completed", requester: OPERATOR, exitCode: 0 });
    expect((await calls()).at(-1)).toEqual(["raise", "--instance", "demo-core", "--json"]);
  });

  it("only records an alert-lowering change and applies it after the operator confirms", async () => {
    const before = (await calls()).length;
    const pending = await toolFor({ requesterSenderId: OPERATOR, agentAccountId: "demo" }).execute(
      "c",
      {
        operation: "lower",
        mode: "ok",
      },
    );
    expect(pending.details).toMatchObject({ status: "confirmation-required", requester: OPERATOR });
    const payload = JSON.parse(pending.content[0]?.text ?? "{}") as {
      code: string;
      change: string;
      expiresInMinutes: number;
      note: string;
    };
    expect(payload).toMatchObject({ change: 'lower mode="ok"', expiresInMinutes: 15 });
    expect(payload.note).toBe(
      `Nothing has changed yet. To apply this change, the operator sends: /confirm ${payload.code}`,
    );
    expect((await calls()).length).toBe(before);

    expect(
      await confirm({ args: payload.code, senderId: "@guest:example.org", accountId: "demo" }),
    ).toEqual({
      text: "Only the operator can confirm changes. Nothing was changed.",
    });
    expect(
      await confirm({ args: payload.code, senderId: OPERATOR, accountId: "other-bot" }),
    ).toEqual({});
    expect((await calls()).length).toBe(before);

    expect(
      await confirm({ args: payload.code.toLowerCase(), senderId: OPERATOR, accountId: "demo" }),
    ).toEqual({
      text: `Change ${payload.code} applied (lower mode="ok"). Done.`,
    });
    expect((await calls()).at(-1)).toEqual([
      "lower",
      "--instance",
      "demo-core",
      "--json",
      "--mode",
      "ok",
    ]);
    expect(await confirm({ args: payload.code, senderId: OPERATOR, accountId: "demo" })).toEqual({
      text: `Change ${payload.code} was already handled.`,
    });
    const stored = JSON.parse(await readFile(join(stateDir, "pending.json"), "utf8")) as {
      entries: Array<{
        code: string;
        status: string;
        requester: string;
        params: Record<string, unknown>;
      }>;
    };
    expect(stored.entries.find((entry) => entry.code === payload.code)).toMatchObject({
      status: "applied",
      requester: OPERATOR,
      params: { mode: "ok" },
    });
  });

  it("shows the CLI's own preview before recording a change and applies it without the preview flag", async () => {
    const before = (await calls()).length;
    const pending = await toolFor({ requesterSenderId: OPERATOR }).execute("c", {
      operation: "tune",
      mode: "ok",
    });
    const payload = JSON.parse(pending.content[0]?.text ?? "{}") as {
      code: string;
      preview: string;
    };
    expect(JSON.parse(payload.preview)).toMatchObject({
      dryRun: true,
      ruleSummary: "domain example.com -> max-zone amber",
    });
    expect((await calls()).slice(before)).toEqual([
      ["tune", "--instance", "demo-core", "--json", "--mode", "ok", "--dry-run"],
    ]);
    expect(await confirm({ args: payload.code, senderId: OPERATOR })).toMatchObject({
      text: expect.stringContaining(`Change ${payload.code} applied`),
    });
    expect((await calls()).at(-1)).toEqual([
      "tune",
      "--instance",
      "demo-core",
      "--json",
      "--mode",
      "ok",
    ]);
  });

  it("records nothing when the preview fails", async () => {
    const result = await toolFor({ requesterSenderId: OPERATOR }).execute("c", {
      operation: "tune",
      mode: "fail",
    });
    expect(result).toMatchObject({
      details: { status: "failed", exitCode: 3, operation: "tune" },
      content: [{ text: JSON.stringify({ ok: false, error: { message: "refused by cli" } }) }],
    });
    const store = JSON.parse(await readFile(join(stateDir, "pending.json"), "utf8")) as {
      entries: Array<{ operation: string; params: Record<string, unknown> }>;
    };
    expect(
      store.entries.some((entry) => entry.operation === "tune" && entry.params.mode === "fail"),
    ).toBe(false);
  });

  it("reports a confirmed change the CLI refused", async () => {
    const pending = await toolFor({ requesterSenderId: OPERATOR }).execute("c", {
      operation: "lower",
      mode: "fail",
    });
    const { code } = JSON.parse(pending.content[0]?.text ?? "{}") as { code: string };
    expect(await confirm({ args: code, senderId: OPERATOR })).toEqual({
      text: `Change ${code} failed (lower mode="fail"): refused by cli`,
    });
  });

  it("refuses to apply a confirmed change whose binding is gone", async () => {
    const pending = await toolFor({ requesterSenderId: OPERATOR }).execute("c", {
      operation: "lower",
    });
    const { code } = JSON.parse(pending.content[0]?.text ?? "{}") as { code: string };
    const storePath = join(stateDir, "pending.json");
    const store = JSON.parse(await readFile(storePath, "utf8")) as {
      entries: Array<{ code: string; workspaceDir: string }>;
    };
    for (const entry of store.entries) {
      if (entry.code === code) {
        entry.workspaceDir = "/nowhere";
      }
    }
    await writeFile(storePath, JSON.stringify(store), "utf8");
    expect(await confirm({ args: code, senderId: OPERATOR })).toEqual({
      text: `Change ${code} could not be applied: the tool for this change is no longer configured. Nothing was changed.`,
    });
  });

  it("answers usage and unknown codes", async () => {
    expect(await confirm({ senderId: OPERATOR })).toEqual({ text: "Usage: /confirm <code>" });
    expect(await confirm({ args: "QQQQQQ", senderId: OPERATOR })).toEqual({
      text: "No pending change matches QQQQQQ. Nothing was changed.",
    });
  });

  it("starts over with an empty store when the store is damaged", async () => {
    await writeFile(join(stateDir, "pending.json"), "{broken", "utf8");
    expect(await confirm({ args: "QQQQQQ", senderId: OPERATOR })).toMatchObject({
      text: expect.stringContaining("No pending change"),
    });
    await rm(join(stateDir, "pending.json"));
    expect(await confirm({ args: "QQQQQQ", senderId: OPERATOR })).toMatchObject({
      text: expect.stringContaining("No pending change"),
    });
  });

  it("reports a command that cannot start and one that runs too long", async () => {
    const gone = tools.get("demo_tool")?.factory({ workspaceDir: join(tempRoot, "gone") });
    expect(await gone?.execute("c", { operation: "show" })).toMatchObject({
      details: { status: "failed", exitCode: 127 },
    });
    const slow = await toolFor({}).execute("c", { operation: "slow" });
    expect(slow.details).toMatchObject({ status: "failed", exitCode: 1 });
    expect(slow.content[0]?.text).toBe("demo_tool exited with code 1");
  }, 10_000);
});
