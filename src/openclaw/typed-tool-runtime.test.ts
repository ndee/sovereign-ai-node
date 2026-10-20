import { describe, expect, it } from "vitest";

import {
  TYPED_TOOL_MAX_LENGTH_LIMIT,
  type TypedToolOperationSpec,
  type TypedToolPendingEntry,
  type TypedToolPendingStore,
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
} from "./typed-tool-runtime.js";

const FEEDBACK: TypedToolOperationSpec = {
  name: "feedback",
  description: "Record feedback on an alert",
  effect: "change",
  argv: ["feedback", "--instance", "<tool-instance-id>"],
  params: {
    alertId: {
      type: "string",
      description: "Alert id",
      pattern: "^[A-Za-z0-9._:-]+$",
      maxLength: 128,
      argv: ["--alert-id", "{value}"],
    },
    latest: { type: "boolean", description: "Newest alert", argv: ["--latest"] },
    action: {
      type: "string",
      description: "Feedback action",
      enum: ["important", "not-important"],
      argv: ["--action", "{value}"],
    },
    note: { type: "string", description: "Free text", argv: ["--note", "{value}"] },
  },
  required: ["action"],
  exactlyOneOf: [["alertId", "latest"]],
  confirm: { param: "action", values: ["not-important"] },
};

const VERSION: TypedToolOperationSpec = {
  name: "version",
  description: "Build identity",
  effect: "read",
  argv: ["version", "--json"],
};

describe("typedToolBuildArgv", () => {
  it("builds a fixed argv with each value as one element", () => {
    expect(
      typedToolBuildArgv({
        operation: FEEDBACK,
        params: {
          operation: "feedback",
          alertId: "a-1",
          action: "important",
          note: "x; rm -rf / $(id)",
        },
        toolInstanceId: "core",
      }),
    ).toEqual([
      "feedback",
      "--instance",
      "core",
      "--alert-id",
      "a-1",
      "--action",
      "important",
      "--note",
      "x; rm -rf / $(id)",
    ]);
  });

  it("is rejected by the pattern when a value does not match", () => {
    expect(() =>
      typedToolBuildArgv({
        operation: {
          ...FEEDBACK,
          params: {
            ...FEEDBACK.params,
            alertId: { ...FEEDBACK.params!.alertId!, maxLength: undefined },
          },
        },
        params: { alertId: "a 1", action: "important" },
        toolInstanceId: "core",
      }),
    ).toThrow("Parameter 'alertId' has an invalid format");
  });

  it("appends boolean flags only when true and ignores null values", () => {
    expect(
      typedToolBuildArgv({
        operation: FEEDBACK,
        params: { latest: true, action: "important", alertId: null },
        toolInstanceId: "core",
      }),
    ).toEqual(["feedback", "--instance", "core", "--latest", "--action", "important"]);
    expect(() =>
      typedToolBuildArgv({
        operation: FEEDBACK,
        params: { latest: false, action: "important" },
        toolInstanceId: "core",
      }),
    ).toThrow("needs exactly one of: alertId, latest");
  });

  it("handles operations without params", () => {
    expect(
      typedToolBuildArgv({
        operation: VERSION,
        params: { operation: "version" },
        toolInstanceId: "x",
      }),
    ).toEqual(["version", "--json"]);
  });

  it.each([
    [[], "Expected the tool parameters to be a JSON object"],
    [
      { extra: "1", action: "important", latest: true },
      "Parameter 'extra' is not accepted by operation 'feedback'",
    ],
    [{ latest: "yes", action: "important" }, "Parameter 'latest' must be true or false"],
    [{ latest: true, action: 3 }, "Parameter 'action' must be a string"],
    [{ latest: true, action: "" }, "Parameter 'action' must be 1 to 200 characters long"],
    [
      { latest: true, action: "important", note: "x".repeat(201) },
      "Parameter 'note' must be 1 to 200 characters long",
    ],
    [
      { latest: true, action: "important", note: "a\nb" },
      "Parameter 'note' must not contain control characters",
    ],
    [
      { latest: true, action: "important", note: "a\u007fb" },
      "Parameter 'note' must not contain control characters",
    ],
    [
      { latest: true, action: "important", note: "--json" },
      "Parameter 'note' must not start with '-'",
    ],
    [
      { latest: true, action: "mute" },
      "Parameter 'action' must be one of: important, not-important",
    ],
    [{ latest: true }, "Operation 'feedback' requires 'action'"],
    [{ latest: true, alertId: "a1", action: "important" }, "needs exactly one of: alertId, latest"],
  ])("rejects %j", (params, message) => {
    expect(() =>
      typedToolBuildArgv({ operation: FEEDBACK, params, toolInstanceId: "core" }),
    ).toThrow(message);
  });

  it("caps maxLength at the hard limit", () => {
    const operation: TypedToolOperationSpec = {
      ...VERSION,
      params: {
        q: { type: "string", description: "q", maxLength: 10_000, argv: ["--q", "{value}"] },
      },
    };
    expect(() =>
      typedToolBuildArgv({
        operation,
        params: { q: "x".repeat(TYPED_TOOL_MAX_LENGTH_LIMIT + 1) },
        toolInstanceId: "x",
      }),
    ).toThrow(`1 to ${String(TYPED_TOOL_MAX_LENGTH_LIMIT)} characters`);
  });
});

describe("typedToolNeedsConfirmation", () => {
  it("follows the confirm declaration", () => {
    expect(typedToolNeedsConfirmation(VERSION, {})).toBe(false);
    expect(typedToolNeedsConfirmation({ ...VERSION, confirm: "always" }, {})).toBe(true);
    expect(typedToolNeedsConfirmation(FEEDBACK, { action: "not-important" })).toBe(true);
    expect(typedToolNeedsConfirmation(FEEDBACK, { action: "important" })).toBe(false);
    expect(typedToolNeedsConfirmation(FEEDBACK, { action: 1 })).toBe(false);
  });
});

describe("typedToolDescribeChange", () => {
  it("lists the operation and the values it will pass", () => {
    expect(
      typedToolDescribeChange(FEEDBACK, { latest: true, action: "not-important", alertId: 4 }),
    ).toBe('feedback latest action="not-important"');
    expect(typedToolDescribeChange(VERSION, {})).toBe("version");
  });
});

describe("typedToolNormalizeUserId", () => {
  it("accepts Matrix user ids with or without the channel prefix", () => {
    expect(typedToolNormalizeUserId(" matrix:@Op:Example.org ")).toBe("@op:example.org");
    expect(typedToolNormalizeUserId("@op:example.org")).toBe("@op:example.org");
    expect(typedToolNormalizeUserId("op")).toBeNull();
    expect(typedToolNormalizeUserId(42)).toBeNull();
  });
});

describe("typedToolResolveRequester", () => {
  it("requires a runtime-supplied requester", () => {
    expect(() => typedToolResolveRequester({})).toThrow("not started by a Matrix user");
    expect(() =>
      typedToolResolveRequester({ sessionKey: "agent:ms:matrix:direct:@op:example.org" }),
    ).toThrow("not started by a Matrix user");
  });

  it("returns the requester and checks it against a direct-message session", () => {
    expect(typedToolResolveRequester({ requesterSenderId: "@op:example.org" })).toBe(
      "@op:example.org",
    );
    expect(
      typedToolResolveRequester({
        requesterSenderId: "@op:example.org",
        sessionKey: "agent:ms:matrix:direct:@op:example.org",
      }),
    ).toBe("@op:example.org");
    expect(
      typedToolResolveRequester({
        requesterSenderId: "@op:example.org",
        sessionKey: "agent:ms:matrix:channel:!room:example.org",
      }),
    ).toBe("@op:example.org");
    expect(
      typedToolResolveRequester({
        requesterSenderId: "@op:example.org",
        sessionKey: "agent:ms:matrix:direct:not-a-user",
      }),
    ).toBe("@op:example.org");
    expect(() =>
      typedToolResolveRequester({
        requesterSenderId: "@op:example.org",
        sessionKey: "agent:ms:matrix:direct:@other:example.org",
      }),
    ).toThrow("does not match the direct-message session");
  });
});

describe("typedToolIsOperator", () => {
  it("matches normalized operator ids only", () => {
    expect(typedToolIsOperator("@op:example.org", ["@Op:example.org"])).toBe(true);
    expect(typedToolIsOperator("@guest:example.org", ["@op:example.org"])).toBe(false);
    expect(typedToolIsOperator("@op:example.org", "@op:example.org")).toBe(false);
  });
});

describe("typedToolBuildEnv", () => {
  it("passes a fixed environment and only HOME and TMPDIR from the gateway", () => {
    expect(
      typedToolBuildEnv(
        { HOME: "/home/svc", TMPDIR: "", PATH: "/evil", SOVEREIGN_TOOL_EXECUTABLE: "/evil" },
        "/etc/sovereign-node/sovereign-node.json5",
      ),
    ).toEqual({
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      LANG: "C.UTF-8",
      SOVEREIGN_NODE_CONFIG: "/etc/sovereign-node/sovereign-node.json5",
      HOME: "/home/svc",
    });
  });
});

const pending = (overrides: Partial<TypedToolPendingEntry> = {}): TypedToolPendingEntry => ({
  code: "ABCDEF",
  tool: "mail_sentinel",
  workspaceDir: "/ws",
  operation: "feedback",
  params: { latest: true, action: "not-important" },
  requester: "@op:example.org",
  accountId: "mail-sentinel",
  summary: "feedback latest",
  createdAt: 1_000,
  expiresAt: 10_000,
  status: "pending",
  ...overrides,
});

const store = (...entries: TypedToolPendingEntry[]): TypedToolPendingStore => ({
  version: 1,
  entries,
});

describe("pending store", () => {
  it("reads tolerantly", () => {
    expect(typedToolReadStore(undefined)).toEqual(store());
    expect(typedToolReadStore("not json")).toEqual(store());
    expect(typedToolReadStore("[]")).toEqual(store());
    expect(
      typedToolReadStore(JSON.stringify({ entries: [pending(), { code: 1 }, "x", { code: "Z" }] })),
    ).toEqual(store(pending()));
  });

  it("prunes old entries and caps the store", () => {
    const old = pending({ code: "OLD111", expiresAt: 0 });
    expect(typedToolPruneStore(store(old, pending()), 24 * 60 * 60 * 1000 + 1)).toEqual(
      store(pending()),
    );
    const many = Array.from({ length: 60 }, (_, index) => pending({ code: `C${String(index)}` }));
    expect(typedToolPruneStore(store(...many), 0).entries).toHaveLength(50);
  });

  it("generates six-character codes from an unambiguous alphabet", () => {
    expect(typedToolGenerateCode(new Uint8Array([0, 1, 31, 32, 255, 8]))).toBe("AB9A9J");
    expect(typedToolGenerateCode(new Uint8Array([]))).toBe("AAAAAA");
  });

  it("marks completed confirmations", () => {
    expect(
      typedToolCompleteConfirmation(
        store(pending(), pending({ code: "OTHER1" })),
        "ABCDEF",
        "applied",
      ).entries.map((entry) => entry.status),
    ).toEqual(["applied", "pending"]);
  });
});

describe("typedToolResolveConfirmation", () => {
  const base = {
    senderId: "@op:example.org",
    accountId: "mail-sentinel",
    operatorUserIds: ["@op:example.org"],
    nowMs: 5_000,
  };

  it("commits a pending change for the same operator in a later message", () => {
    const outcome = typedToolResolveConfirmation({
      ...base,
      store: store(pending({ code: "OTHER1" }), pending()),
      args: " abcdef ",
    });
    expect(outcome.kind).toBe("commit");
    if (outcome.kind === "commit") {
      expect(outcome.entry.status).toBe("applying");
      expect(outcome.store.entries.map((entry) => entry.status)).toEqual(["pending", "applying"]);
    }
  });

  it.each([
    [{ args: undefined }, "Usage: /confirm <code>"],
    [{ args: "abc" }, "Usage: /confirm <code>"],
    [{ args: "ZZZZZZ" }, "No pending change matches ZZZZZZ"],
    [{ args: "ABCDEF", senderId: "@guest:example.org" }, "Only the operator can confirm changes"],
    [{ args: "ABCDEF", senderId: undefined }, "Only the operator can confirm changes"],
  ])("refuses %j", (overrides, text) => {
    const outcome = typedToolResolveConfirmation({
      ...base,
      store: store(pending()),
      ...overrides,
    });
    expect(outcome).toMatchObject({ kind: "reply" });
    expect(outcome.kind === "reply" ? outcome.text : "").toContain(text);
  });

  it("stays silent for a change another bot account recorded", () => {
    expect(
      typedToolResolveConfirmation({
        ...base,
        accountId: "other-bot",
        store: store(pending()),
        args: "ABCDEF",
      }),
    ).toMatchObject({ kind: "silent" });
  });

  it("answers when either side has no account id", () => {
    expect(
      typedToolResolveConfirmation({
        ...base,
        accountId: undefined,
        store: store(pending()),
        args: "ABCDEF",
      }).kind,
    ).toBe("commit");
    expect(
      typedToolResolveConfirmation({
        ...base,
        store: store(
          (({ accountId: _accountId, ...entry }) => entry)(pending()) as TypedToolPendingEntry,
        ),
        args: "ABCDEF",
      }).kind,
    ).toBe("commit");
  });

  it("refuses handled, expired and foreign changes", () => {
    expect(
      typedToolResolveConfirmation({
        ...base,
        store: store(pending({ status: "applied" })),
        args: "ABCDEF",
      }),
    ).toMatchObject({ kind: "reply", text: "Change ABCDEF was already handled." });
    const expired = typedToolResolveConfirmation({
      ...base,
      nowMs: 10_000,
      store: store(pending()),
      args: "ABCDEF",
    });
    expect(expired).toMatchObject({ kind: "reply", store: store() });
    expect(expired.kind === "reply" ? expired.text : "").toContain("expired");
    const foreign = typedToolResolveConfirmation({
      ...base,
      operatorUserIds: ["@op:example.org", "@op2:example.org"],
      senderId: "@op2:example.org",
      store: store(pending()),
      args: "ABCDEF",
    });
    expect(foreign.kind === "reply" ? foreign.text : "").toContain("requested by another user");
  });
});

describe("typedToolSummarizeOutput", () => {
  it("prefers the CLI note, then the CLI error, then raw output", () => {
    expect(typedToolSummarizeOutput('{"note":"Feedback applied."}', "", 0)).toBe(
      "Feedback applied.",
    );
    expect(typedToolSummarizeOutput('{"ok":false,"error":{"message":"boom"}}', "", 1)).toBe("boom");
    expect(typedToolSummarizeOutput('{"note":""}', "", 0)).toBe('{"note":""}');
    expect(typedToolSummarizeOutput('{"error":"flat"}', "", 1)).toBe('{"error":"flat"}');
    expect(typedToolSummarizeOutput("[1]", "", 0)).toBe("[1]");
    expect(typedToolSummarizeOutput("plain", "", 0)).toBe("plain");
    expect(typedToolSummarizeOutput("", " err ", 2)).toBe("err");
    expect(typedToolSummarizeOutput("", "", 3)).toBe("Command exited with code 3");
    expect(typedToolSummarizeOutput("x".repeat(600), "", 0)).toHaveLength(500);
  });
});

describe("typedToolIsRecord", () => {
  it("accepts plain objects only", () => {
    expect(typedToolIsRecord({})).toBe(true);
    expect(typedToolIsRecord(null)).toBe(false);
    expect(typedToolIsRecord([])).toBe(false);
  });
});
