import { describe, expect, it } from "vitest";

import {
  extractGuardedJsonStateActorFromConversationInfoText,
  extractGuardedJsonStateActorFromDirectSessionKey,
  extractLatestGuardedJsonStateActorFromBranch,
  resolveGuardedJsonStateSessionContext,
  resolveGuardedJsonStateToolContext,
  resolveGuardedJsonStateWorkspaceDir,
} from "./guarded-json-state-context.js";

describe("guarded-json-state OpenClaw context helpers", () => {
  it("extracts the actor from a direct Matrix session key", () => {
    expect(
      extractGuardedJsonStateActorFromDirectSessionKey(
        "agent:bitcoin-skill-match:matrix:direct:@satoshi:example.org",
      ),
    ).toBe("@satoshi:example.org");
  });

  it("extracts the actor from the latest Matrix user message metadata", () => {
    expect(
      extractGuardedJsonStateActorFromConversationInfoText(
        [
          "Conversation info (untrusted metadata):",
          "```json",
          JSON.stringify({
            sender_id: "@ndee:example.org",
            sender: "@ndee:example.org",
            is_group_chat: true,
          }, null, 2),
          "```",
          "",
          "ndee: Ich suche Hilfe mit Lightning.",
        ].join("\n"),
      ),
    ).toBe("@ndee:example.org");
  });

  it("resolves the current actor from the session registry and branch metadata in rooms", () => {
    const context = resolveGuardedJsonStateSessionContext({
      sessionId: "room-session-id",
      sessionsRegistry: {
        "agent:bitcoin-skill-match:matrix:channel:!room:example.org": {
          sessionId: "room-session-id",
          origin: {
            from: "matrix:channel:!room:example.org",
          },
        },
      },
      branchEntries: [
        {
          type: "message",
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: [
                  "Conversation info (untrusted metadata):",
                  "```json",
                  JSON.stringify({
                    sender_id: "@satoshi:example.org",
                    sender: "@satoshi:example.org",
                    is_group_chat: true,
                  }, null, 2),
                  "```",
                ].join("\n"),
              },
            ],
          },
        },
      ],
    });

    expect(context).toEqual({
      sessionKey: "agent:bitcoin-skill-match:matrix:channel:!room:example.org",
      originFrom: "matrix:channel:!room:example.org",
      actor: "@satoshi:example.org",
    });
  });

  it("fails closed when direct-session and user-message actors disagree", () => {
    expect(() =>
      resolveGuardedJsonStateSessionContext({
        sessionId: "dm-session-id",
        sessionsRegistry: {
          "agent:bitcoin-skill-match:matrix:direct:@ndee:example.org": {
            sessionId: "dm-session-id",
            origin: {
              from: "matrix:@ndee:example.org",
            },
          },
        },
        branchEntries: [
          {
            type: "message",
            message: {
              role: "user",
              content: [
                {
                  type: "text",
                  text: [
                    "Conversation info (untrusted metadata):",
                    "```json",
                    JSON.stringify({
                      sender_id: "@satoshi:example.org",
                      sender: "@satoshi:example.org",
                    }, null, 2),
                    "```",
                  ].join("\n"),
                },
              ],
            },
          },
        ],
      })).toThrow(/sender mismatch/i);
  });

  it("uses the latest user message when older branches mention another sender", () => {
    expect(
      extractLatestGuardedJsonStateActorFromBranch([
        {
          type: "message",
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: [
                  "Conversation info (untrusted metadata):",
                  "```json",
                  JSON.stringify({
                    sender_id: "@old:example.org",
                  }, null, 2),
                  "```",
                ].join("\n"),
              },
            ],
          },
        },
        {
          type: "message",
          message: {
            role: "assistant",
            content: "ignored",
          },
        },
        {
          type: "message",
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: [
                  "Conversation info (untrusted metadata):",
                  "```json",
                  JSON.stringify({
                    sender_id: "@new:example.org",
                  }, null, 2),
                  "```",
                ].join("\n"),
              },
            ],
          },
        },
      ]),
    ).toBe("@new:example.org");
  });

  it("resolves the current actor from the official OpenClaw tool context", () => {
    expect(
      resolveGuardedJsonStateToolContext({
        workspaceDir: "/var/lib/sovereign-node/bitcoin-skill-match/workspace",
        requesterSenderId: "@ndee:example.org",
        sessionKey: "agent:bitcoin-skill-match:matrix:channel:!room:example.org",
      }),
    ).toEqual({
      workspaceDir: "/var/lib/sovereign-node/bitcoin-skill-match/workspace",
      actor: "@ndee:example.org",
      sessionKey: "agent:bitcoin-skill-match:matrix:channel:!room:example.org",
      originFrom: "@ndee:example.org",
    });
  });

  it("fails closed when the tool context sender and direct session disagree", () => {
    expect(() =>
      resolveGuardedJsonStateToolContext({
        workspaceDir: "/var/lib/sovereign-node/bitcoin-skill-match/workspace",
        requesterSenderId: "@ndee:example.org",
        sessionKey: "agent:bitcoin-skill-match:matrix:direct:@satoshi:example.org",
      })).toThrow(/sender mismatch/i);
  });

  it("requires a workspace directory from the tool context", () => {
    expect(() => resolveGuardedJsonStateWorkspaceDir(undefined)).toThrow(/workspaceDir/i);
  });
});
