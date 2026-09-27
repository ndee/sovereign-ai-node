import { describe, expect, it } from "vitest";

import { decodeEscapes, findSecretShapes } from "./shape-guard.js";

const BS = "\\";

describe("decodeEscapes", () => {
  it("resolves percent, unicode and hex escapes and doubled backslashes", () => {
    expect(decodeEscapes("sk%2Dor")).toBe("sk-or");
    expect(decodeEscapes(`sk${BS}u002dor`)).toBe("sk-or");
    expect(decodeEscapes(`sk${BS}x2dor`)).toBe("sk-or");
    expect(decodeEscapes(`sk${BS}${BS}u002dor`)).toBe("sk-or");
  });
});

describe("findSecretShapes", () => {
  it("passes ordinary diagnostic text", () => {
    expect(
      findSecretShapes(
        [
          "npm error code EACCES",
          "npm error syscall mkdir",
          "npm error path /usr/lib/node_modules/openclaw",
          "Authorization: [REDACTED]",
          "bearer [REDACTED]",
          "//registry.npmjs.org/:_authToken=[REDACTED]",
          "https://user:[REDACTED]@example.com/",
          "task-0123456789abcdefghijklmn",
          "sha512-abcdefghijklmnopqrstuvwxyz0123456789",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it.each([
    ["openrouter-key", "key sk-or-v1-0123456789abcdef"],
    ["openrouter-key", "xsk-or-v1-0123456789abcdef"],
    ["anthropic-key", "sk-ant-api03-abcdefgh"],
    ["provider-api-key", "OPENAI sk-abcdefghijklmnopqrstuvwx"],
    ["matrix-access-token", "session_syt_abc_1234567890"],
    ["github-token", "ghp_abcdefghijklmnop1234"],
    ["slack-token", "xoxb-1234567890-abc"],
    ["aws-access-key", "AKIAABCDEFGHIJKLMNOP"],
    ["pem-private-key", "-----BEGIN OPENSSH PRIVATE KEY-----"],
    ["npm-auth-token", "//registry.npmjs.org/:_authToken=npm_abcdef123456"],
    ["bearer-credential", "Bearer abcdefghijklmnopqrstuvwxyz"],
    ["url-userinfo", "imaps://someone:hunter2@imap.example.com"],
  ])("flags %s in %s", (id, text) => {
    expect(findSecretShapes(text)).toContain(id);
  });

  it("flags a key hidden behind percent encoding", () => {
    expect(findSecretShapes("k=sk%2Dor%2Dv1%2D0123456789abcdef")).toContain("openrouter-key");
  });

  it("flags a key hidden behind JSON unicode escapes", () => {
    const escaped = `"sk${BS}u002dor${BS}u002dv1${BS}u002d0123456789abcdef"`;
    expect(findSecretShapes(escaped)).toContain("openrouter-key");
  });
});
