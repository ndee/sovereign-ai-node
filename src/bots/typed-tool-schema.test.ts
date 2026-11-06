import { describe, expect, it } from "vitest";

import { scanAgentTemplateSchema, typedToolTemplateSchema } from "./typed-tool-schema.js";

const operation = (overrides: Record<string, unknown> = {}) => ({
  name: "feedback",
  description: "Record feedback",
  effect: "change",
  argv: ["feedback", "--instance", "<tool-instance-id>", "--json"],
  params: {
    alertId: {
      type: "string",
      description: "Alert id",
      pattern: "^[A-Za-z0-9-]{1,64}$",
      maxLength: 64,
      argv: ["--alert-id", "{value}"],
    },
    latest: { type: "boolean", description: "Newest", argv: ["--latest"] },
    action: {
      type: "string",
      description: "Action",
      enum: ["important", "not-important"],
      argv: ["--action", "{value}"],
    },
  },
  required: ["action"],
  exactlyOneOf: [["alertId", "latest"]],
  confirm: { param: "action", values: ["not-important"] },
  ...overrides,
});

const tool = (overrides: Record<string, unknown> = {}) => ({
  name: "mail_sentinel",
  description: "Mail Sentinel",
  script: "workspace/bin/dist/mail-sentinel.js",
  operations: [
    { name: "version", description: "Build", effect: "read", argv: ["version", "--json"] },
    operation(),
    {
      name: "policy-remove",
      description: "Remove",
      effect: "change",
      argv: ["policy", "remove", "--instance", "<tool-instance-id>"],
      params: { id: { type: "string", description: "Id", argv: ["--id", "{value}"] } },
      required: ["id"],
      confirm: "always",
    },
  ],
  ...overrides,
});

const issues = (value: unknown): string[] => {
  const result = typedToolTemplateSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
};

describe("typedToolTemplateSchema", () => {
  it("accepts a well-formed typed tool", () => {
    expect(issues(tool())).toEqual([]);
  });

  it.each([
    ["a core tool name", tool({ name: "exec" }), "must not shadow a core tool or the plugin id"],
    ["the plugin id", tool({ name: "sovereign-typed-tools" }), "Invalid string"],
    [
      "a script outside the package",
      tool({ script: "workspace/../../etc/passwd" }),
      "must be a relative path inside the bot package",
    ],
    ["an absolute script", tool({ script: "/usr/bin/node" }), "Invalid string"],
    [
      "a duplicate operation",
      tool({ operations: [operation(), operation()] }),
      "duplicate operation 'feedback'",
    ],
    [
      "a change operation without an instance",
      tool({ operations: [operation({ argv: ["feedback"] })] }),
      "must target <tool-instance-id>",
    ],
    [
      "a value placeholder in the fixed argv",
      tool({ operations: [operation({ argv: ["feedback", "{value}", "<tool-instance-id>"] })] }),
      "fixed argv must not contain {value}",
    ],
    [
      "a control character in the fixed argv",
      tool({ operations: [operation({ argv: ["feed\nback", "<tool-instance-id>"] })] }),
      "must not contain control characters",
    ],
    [
      "a string parameter without a flag",
      tool({
        operations: [
          operation({
            params: { q: { type: "string", description: "q", argv: ["{value}"] } },
            required: [],
            exactlyOneOf: [],
            confirm: undefined,
          }),
        ],
      }),
      'string parameters map to exactly ["--flag", "{value}"]',
    ],
    [
      "a boolean parameter with a value",
      tool({
        operations: [
          operation({
            params: { b: { type: "boolean", description: "b", argv: ["--b", "{value}"] } },
            required: [],
            exactlyOneOf: [],
            confirm: undefined,
          }),
        ],
      }),
      "boolean parameters map to exactly one --flag",
    ],
    [
      "a boolean parameter with an enum",
      tool({
        operations: [
          operation({
            params: { b: { type: "boolean", description: "b", enum: ["x"], argv: ["--b"] } },
            required: [],
            exactlyOneOf: [],
            confirm: undefined,
          }),
        ],
      }),
      "boolean parameters take no enum, pattern or maxLength",
    ],
    [
      "an invalid pattern",
      tool({
        operations: [
          operation({
            params: {
              q: { type: "string", description: "q", pattern: "(", argv: ["--q", "{value}"] },
            },
            required: [],
            exactlyOneOf: [],
            confirm: undefined,
          }),
        ],
      }),
      "must be a valid regex",
    ],
    [
      "a preview without a confirmation",
      tool({ operations: [operation({ confirm: undefined, confirmPreviewArgv: ["--dry-run"] })] }),
      "a preview needs a confirmation",
    ],
    [
      "a preview argument that is not a flag",
      tool({ operations: [operation({ confirmPreviewArgv: ["dry-run"] })] }),
      "Invalid string",
    ],
    [
      "an unknown required parameter",
      tool({ operations: [operation({ required: ["nope"] })] }),
      "unknown parameter 'nope'",
    ],
    [
      "confirmation on a read operation",
      tool({ operations: [operation({ effect: "read" })] }),
      "only change operations can ask for confirmation",
    ],
    [
      "confirmation keyed on a parameter without enum",
      tool({ operations: [operation({ confirm: { param: "alertId", values: ["x"] } })] }),
      "confirmation must key on a string parameter with an enum",
    ],
    [
      "confirmation values outside the enum",
      tool({ operations: [operation({ confirm: { param: "action", values: ["mute"] } })] }),
      "values must come from the parameter enum",
    ],
    [
      "a parameter that changes type",
      tool({
        operations: [
          operation(),
          {
            name: "explain",
            description: "Explain",
            effect: "read",
            argv: ["explain"],
            params: { latest: { type: "string", description: "x", argv: ["--latest", "{value}"] } },
          },
        ],
      }),
      "parameter 'latest' changes type between operations",
    ],
  ])("rejects %s", (_label, value, message) => {
    expect(issues(value).join("\n")).toContain(message);
  });

  it("rejects the reserved parameter name", () => {
    expect(
      issues(
        tool({
          operations: [
            operation({
              params: { operation: { type: "boolean", description: "x", argv: ["--x"] } },
              required: [],
              exactlyOneOf: [],
              confirm: undefined,
            }),
          ],
        }),
      ).join("\n"),
    ).toContain("Invalid key in record");
  });
});

describe("typedToolTemplateSchema slash commands", () => {
  const read = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    description: name,
    effect: "read",
    argv: [name, "--json"],
    ...extra,
  });

  it("keeps a slash command on a parameterless read operation", () => {
    const parsed = typedToolTemplateSchema.parse(
      tool({ operations: [read("version", { slashCommand: "version" }), operation()] }),
    );
    expect(parsed.operations[0]?.slashCommand).toBe("version");
    expect(parsed.operations[1]).not.toHaveProperty("slashCommand");
  });

  it.each([
    ["an uppercase name", read("shout", { slashCommand: "Shout" }), "must match"],
    ["a hyphenated name", read("shout", { slashCommand: "shout-now" }), "must match"],
    [
      "a name over 32 characters",
      read("long", { slashCommand: `a${"b".repeat(32)}` }),
      "must match",
    ],
    ["a built-in command", read("state", { slashCommand: "status" }), "is reserved"],
    ["a 2026.8 built-in command", read("code", { slashCommand: "codex" }), "is reserved"],
    ["the confirm command", read("ok", { slashCommand: "confirm" }), "is reserved"],
    [
      "a change operation",
      {
        ...read("apply", { slashCommand: "apply" }),
        effect: "change",
        argv: ["apply", "<tool-instance-id>"],
      },
      "only a read operation can have a slash command",
    ],
    [
      "an operation with parameters",
      read("lookup", {
        slashCommand: "lookup",
        params: { query: { type: "string", description: "Query", argv: ["--query", "{value}"] } },
      }),
      "a slash command takes no parameters",
    ],
    [
      "an operation with an empty requirement list",
      read("lookup", { slashCommand: "lookup", required: [] }),
      "a slash command takes no parameters",
    ],
    [
      "an operation with an empty exactlyOneOf list",
      read("lookup", { slashCommand: "lookup", exactlyOneOf: [] }),
      "a slash command takes no parameters",
    ],
  ])("rejects %s", (_label, value, message) => {
    expect(issues(tool({ operations: [value] })).join("\n")).toContain(message);
  });

  it("rejects a slash command two operations of one tool declare", () => {
    expect(
      issues(
        tool({
          operations: [
            read("version", { slashCommand: "version" }),
            read("about", { slashCommand: "version" }),
          ],
        }),
      ),
    ).toEqual(["duplicate slash command 'version'"]);
  });
});

describe("scanAgentTemplateSchema", () => {
  it("accepts plugin tools and rejects core tools", () => {
    expect(scanAgentTemplateSchema.safeParse({ toolNames: ["llm-task"] }).success).toBe(true);
    expect(scanAgentTemplateSchema.safeParse({ toolNames: ["exec"] }).success).toBe(false);
    expect(scanAgentTemplateSchema.safeParse({ toolNames: [] }).success).toBe(false);
  });
});
