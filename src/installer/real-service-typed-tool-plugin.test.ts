import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TypedToolOperationSpec } from "../openclaw/typed-tool-runtime.js";
import {
  renderTypedToolPluginConfig,
  renderTypedToolPluginIndex,
  renderTypedToolPluginManifest,
  renderTypedToolPluginRuntime,
  type TypedToolPluginConfig,
} from "./real-service-typed-tool-plugin.js";

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
  acceptsArgs: boolean;
  requireAuth: boolean;
  handler: (ctx: Record<string, unknown>) => Promise<{ text?: string }>;
};

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

let tempRoot = "";
let workspace = "";
let pluginDir = "";
let stateDir = "";
const tools = new Map<string, { factory: ToolFactory; options: Record<string, unknown> }>();
const commands: CommandDefinition[] = [];

const toolFor = (context: Record<string, unknown>): RegisteredTool => {
  const tool = tools.get("demo_tool")?.factory({ workspaceDir: ` ${workspace} `, ...context });
  if (tool === null || tool === undefined) {
    throw new Error("expected the demo tool to be bound");
  }
  return tool;
};

const confirm = async (ctx: Record<string, unknown>): Promise<{ text?: string }> => {
  const command = commands[0];
  if (command === undefined) {
    throw new Error("confirm command missing");
  }
  return await command.handler(ctx);
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
    ],
  };
  await writeFile(join(pluginDir, "openclaw.plugin.json"), renderTypedToolPluginManifest(), "utf8");
  await writeFile(
    join(pluginDir, "plugin-config.json"),
    renderTypedToolPluginConfig(config),
    "utf8",
  );
  await writeFile(join(pluginDir, "index.mjs"), renderTypedToolPluginIndex(), "utf8");
  await writeFile(join(pluginDir, "runtime.mjs"), renderTypedToolPluginRuntime(), "utf8");
  // The plugin imports ./runtime.js; load it as ESM under vitest.
  const indexSource = (await readFile(join(pluginDir, "index.mjs"), "utf8")).replace(
    '"./runtime.js"',
    '"./runtime.mjs"',
  );
  await writeFile(join(pluginDir, "index.mjs"), indexSource, "utf8");
  const plugin = (await import(pathToFileURL(join(pluginDir, "index.mjs")).href)) as {
    default: (api: unknown) => void;
  };
  plugin.default({
    registerTool: (factory: ToolFactory, options: Record<string, unknown>) => {
      tools.set(String(options.name), { factory, options });
    },
    registerCommand: (command: CommandDefinition) => {
      commands.push(command);
    },
  });
});

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("typed tool plugin rendering", () => {
  it("renders a manifest without plugin config and a sorted, deduplicated config", () => {
    expect(JSON.parse(renderTypedToolPluginManifest())).toEqual({
      id: "sovereign-typed-tools",
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
    expect(Array.from(tools.keys())).toEqual(["another_tool", "demo_tool"]);
    expect(tools.get("demo_tool")?.options).toEqual({ name: "demo_tool", optional: true });
    expect(
      commands.map((command) => [command.name, command.acceptsArgs, command.requireAuth]),
    ).toEqual([["confirm", true, true]]);
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
