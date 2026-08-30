import { describe, expect, it } from "vitest";

import {
  isPiiKey,
  isSecretKey,
  MAX_VALUE_LENGTH,
  REDACTED,
  REDACTED_PII,
  redactText,
  redactValue,
  stripControlCharacters,
  summarizeRedactions,
} from "./redact.js";

/**
 * Sentinel values.
 *
 * Every adversarial case plants one of these and asserts it is absent from the
 * output. They are deliberately distinctive so a leak cannot hide inside an
 * incidental substring match, and the assertion is always "the sentinel does not
 * appear anywhere in the serialized output" rather than "the output equals X" —
 * an equality assertion on a redactor tests the shape of today's implementation,
 * not the property that matters.
 */
const OPENROUTER = "TEST_OPENROUTER_SECRET_DO_NOT_LEAK";
const MATRIX = "TEST_MATRIX_TOKEN_DO_NOT_LEAK";
const IMAP = "TEST_IMAP_PASSWORD_DO_NOT_LEAK";
const ACTIVATION = "TEST_ACTIVATION_CODE_DO_NOT_LEAK";
const EMAIL_BODY = "TEST_EMAIL_BODY_DO_NOT_LEAK";

const ALL_SENTINELS = [OPENROUTER, MATRIX, IMAP, ACTIVATION, EMAIL_BODY];

/** Assert no sentinel survives anywhere in a value, however nested. */
const expectNoSentinels = (value: unknown): void => {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  for (const sentinel of ALL_SENTINELS) {
    expect(serialized).not.toContain(sentinel);
  }
};

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

describe("redactText — env assignment shapes", () => {
  // The same secret, in every spelling a log line or a dumped env realistically
  // uses. Each case is its own assertion so a failure names the exact shape.
  const assignmentCases: readonly (readonly [string, string])[] = [
    ["unquoted equals", `OPENROUTER_API_KEY=${OPENROUTER}`],
    ["double-quoted equals", `OPENROUTER_API_KEY="${OPENROUTER}"`],
    ["single-quoted equals", `OPENROUTER_API_KEY='${OPENROUTER}'`],
    ["spaced equals", `OPENROUTER_API_KEY = ${OPENROUTER}`],
    ["colon separator", `api_key: ${OPENROUTER}`],
    ["colon no space", `apiKey:${OPENROUTER}`],
    ["yaml style password", `password: ${IMAP}`],
    ["yaml quoted password", `password: "${IMAP}"`],
    ["export form", `export IMAP_PASSWORD=${IMAP}`],
    ["json-ish token", `"token": "${MATRIX}"`],
    ["uppercase SECRET", `SECRET=${OPENROUTER}`],
    ["hyphenated api-key", `api-key=${OPENROUTER}`],
    ["access_key", `access_key=${OPENROUTER}`],
    ["private_key", `private_key=${OPENROUTER}`],
    ["passphrase", `passphrase=${IMAP}`],
    ["credential", `credential=${IMAP}`],
  ];

  for (const [label, input] of assignmentCases) {
    it(`redacts ${label}`, () => {
      const output = redactText(input);
      expectNoSentinels(output);
      expect(output).toContain(REDACTED);
    });
  }
});

describe("redactText — transport and URL shapes", () => {
  it("redacts a bearer token", () => {
    const output = redactText(`Authorization: Bearer ${MATRIX}`);
    expectNoSentinels(output);
    expect(output).toContain(REDACTED);
  });

  it("redacts a lowercase bearer token in a prose log line", () => {
    const output = redactText(`request rejected, sent bearer ${MATRIX} upstream`);
    expectNoSentinels(output);
  });

  it("redacts a Basic authorization header", () => {
    const output = redactText(`authorization: Basic ${IMAP}`);
    expectNoSentinels(output);
  });

  it("redacts an authorization header written with an equals sign", () => {
    const output = redactText(`authorization=${MATRIX}`);
    expectNoSentinels(output);
  });

  it("redacts URL userinfo", () => {
    const output = redactText(`connecting to https://operator:${IMAP}@imap.example.com/inbox`);
    expectNoSentinels(output);
    expect(output).toContain(REDACTED);
  });

  it("redacts URL userinfo on a non-http scheme", () => {
    const output = redactText(`imaps://user:${IMAP}@mail.example.org:993`);
    expectNoSentinels(output);
  });

  it("redacts a query-string token", () => {
    const output = redactText(`GET /v1/sync?token=${MATRIX}&since=42`);
    expectNoSentinels(output);
    // The non-secret query parameter must survive — it is diagnostic.
    expect(output).toContain("since=42");
  });

  it("redacts a query-string api_key in a trailing parameter", () => {
    const output = redactText(`https://openrouter.ai/api/v1?model=gpt&api_key=${OPENROUTER}`);
    expectNoSentinels(output);
    expect(output).toContain("model=gpt");
  });

  it("redacts an activation code carried in a query string", () => {
    const output = redactText(`https://updates.example.com/enroll?code=${ACTIVATION}`);
    expectNoSentinels(output);
  });

  it("redacts a Matrix syt_ access token by prefix", () => {
    const output = redactText("syt_c292ZXJlaWdu_AbCdEfGhIjKlMnOpQr_1a2b3c");
    expect(output).not.toContain("syt_c292ZXJlaWdu");
    expect(output).toContain(REDACTED);
  });

  it("redacts an OpenRouter-style sk- key by prefix", () => {
    const output = redactText("sk-or-v1-0123456789abcdef0123456789abcdef");
    expect(output).not.toContain("0123456789abcdef");
    expect(output).toContain(REDACTED);
  });

  it("redacts a GitHub PAT by prefix", () => {
    const output = redactText("remote add origin ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
    expect(output).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    expect(output).toContain(REDACTED);
  });
});

describe("redactText — multi-line continuation", () => {
  it("redacts a value split across lines with a backslash continuation", () => {
    // A shell-style continuation splits the secret so a naive single-line rule
    // would only consume the first fragment and emit the rest verbatim.
    const input = `OPENROUTER_API_KEY=${OPENROUTER}\\\n${OPENROUTER}`;
    const output = redactText(input);
    expectNoSentinels(output);
  });

  it("redacts a continuation split mid-secret", () => {
    const half = OPENROUTER.slice(0, 12);
    const rest = OPENROUTER.slice(12);
    const output = redactText(`api_key=${half}\\\n${rest}`);
    expectNoSentinels(output);
  });
});

describe("redactText — prose forms", () => {
  it("redacts a password stated in prose", () => {
    const output = redactText(`login failed with password ${IMAP}`);
    expectNoSentinels(output);
    // The diagnostic sentence structure survives; only the value is gone.
    expect(output).toContain("login failed with password");
  });

  it("redacts a token stated in prose", () => {
    const output = redactText(`refreshing token ${MATRIX} for the gateway`);
    expectNoSentinels(output);
  });

  it("redacts a quoted prose secret", () => {
    const output = redactText(`used secret "${OPENROUTER}" on the last call`);
    expectNoSentinels(output);
  });
});

describe("redactText — PEM blocks", () => {
  it("collapses a PEM private key block whole", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      OPENROUTER,
      "MIIEowIBAAKCAQEAx0Zx",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const output = redactText(`key material follows\n${pem}\ndone`);
    expectNoSentinels(output);
    expect(output).not.toContain("MIIEowIBAAKCAQEAx0Zx");
    expect(output).toContain(REDACTED);
    // Surrounding diagnostic context survives.
    expect(output).toContain("key material follows");
    expect(output).toContain("done");
  });

  it("collapses an unlabelled PEM private key block", () => {
    const pem = `-----BEGIN PRIVATE KEY-----\n${IMAP}\n-----END PRIVATE KEY-----`;
    expectNoSentinels(redactText(pem));
  });
});

describe("redactText — email addresses", () => {
  it("replaces email addresses with the PII marker by default", () => {
    const output = redactText("delivery failed for boss@example.com");
    expect(output).not.toContain("boss@example.com");
    expect(output).toContain(REDACTED_PII);
  });

  it("can preserve email addresses when explicitly opted out", () => {
    const output = redactText("delivery failed for boss@example.com", { redactEmails: false });
    expect(output).toContain("boss@example.com");
  });
});

describe("redactText — non-secrets are preserved", () => {
  // A redactor that eats everything is useless: the founder gets a bundle of
  // [REDACTED] and still has to SSH in. These assertions are as load-bearing as
  // the leak assertions above.
  it("preserves SAN error codes", () => {
    expect(redactText("check failed: SAN-IMAP-001")).toContain("SAN-IMAP-001");
  });

  it("preserves an IMAP_AUTH_FAILED style error code", () => {
    const output = redactText("mail scan aborted: IMAP_AUTH_FAILED after 3 attempts");
    expect(output).toContain("IMAP_AUTH_FAILED");
    expect(output).toContain("after 3 attempts");
  });

  it("preserves hostnames in prose", () => {
    const output = redactText("could not connect to imap.gmail.com port 993");
    expect(output).toContain("imap.gmail.com");
    expect(output).toContain("993");
  });

  it("preserves version strings", () => {
    const output = redactText("sovereign-node 2.3.5 (commit a1b2c3d4e5f6)");
    expect(output).toContain("2.3.5");
    expect(output).toContain("a1b2c3d4e5f6");
  });

  it("preserves ISO timestamps", () => {
    const output = redactText("last successful poll at 2026-07-26T10:15:30.000Z");
    expect(output).toContain("2026-07-26T10:15:30.000Z");
  });

  it("preserves systemd unit names and states", () => {
    const output = redactText("sovereign-openclaw-gateway.service: ActiveState=failed NRestarts=7");
    expect(output).toContain("sovereign-openclaw-gateway.service");
    expect(output).toContain("NRestarts=7");
  });

  it("preserves file paths that carry no credential", () => {
    const output = redactText("reading /var/lib/sovereign-node/mail-sentinel-state.json");
    expect(output).toContain("/var/lib/sovereign-node/mail-sentinel-state.json");
  });
});

describe("redactText — false-positive guard (stop words)", () => {
  // The prose rule must not eat the verb, or every auth error in the bundle
  // reads "token [REDACTED]" and the founder loses the actual diagnosis.
  const preserved: readonly (readonly [string, string])[] = [
    ["token is invalid", "is invalid"],
    ["token was rejected", "was rejected"],
    ["password was rejected by the server", "was rejected by the server"],
    ["api_key is missing from the configuration", "is missing from the configuration"],
    ["secret not found in the keyring", "not found in the keyring"],
    ["token expired at midnight", "expired at midnight"],
    ["password required for this mailbox", "required for this mailbox"],
    ["passphrase are unavailable", "are unavailable"],
    ["token were rotated", "were rotated"],
    ["token failed validation", "failed validation"],
    ["secret for the gateway", "for the gateway"],
    ["token from the provider", "from the provider"],
    ["token to the upstream", "to the upstream"],
    ["password in the vault", "in the vault"],
    ["token on the request", "on the request"],
  ];

  for (const [input, mustSurvive] of preserved) {
    it(`keeps the meaning of "${input}"`, () => {
      expect(redactText(input)).toContain(mustSurvive);
    });
  }
});

describe("stripControlCharacters", () => {
  it("strips ANSI CSI colour sequences", () => {
    const input = `${ESC}[31mfailed${ESC}[0m`;
    const output = stripControlCharacters(input);
    expect(output).toBe("failed");
    expect(output).not.toContain(ESC);
  });

  it("strips ANSI cursor movement and screen clears", () => {
    const output = stripControlCharacters(`${ESC}[2J${ESC}[1;1Hcleared`);
    expect(output).toBe("cleared");
  });

  it("strips OSC window-title sequences terminated by BEL", () => {
    const output = stripControlCharacters(`${ESC}]0;pwned${BEL}safe`);
    expect(output).toBe("safe");
    expect(output).not.toContain("pwned");
  });

  it("strips OSC sequences terminated by ST", () => {
    const output = stripControlCharacters(`${ESC}]0;pwned${ESC}\\safe`);
    expect(output).toBe("safe");
  });

  it("strips two-byte escape sequences", () => {
    const output = stripControlCharacters(`${ESC}Mtext`);
    expect(output).not.toContain(ESC);
    expect(output).toContain("text");
  });

  it("strips C0 controls, DEL and the C1 range but keeps tab and newline", () => {
    const input = [
      "a",
      String.fromCharCode(0x00),
      String.fromCharCode(0x07),
      "\t",
      "b",
      String.fromCharCode(0x7f),
      "\n",
      String.fromCharCode(0x9b),
      "c",
    ].join("");
    expect(stripControlCharacters(input)).toBe("a\tb\nc");
  });

  it("is applied by redactText", () => {
    const output = redactText(`${ESC}[31mIMAP_AUTH_FAILED${ESC}[0m`);
    expect(output).not.toContain(ESC);
    expect(output).toContain("IMAP_AUTH_FAILED");
  });

  it("does not let an ANSI sequence smuggle a secret past the assignment rule", () => {
    // Escapes are stripped BEFORE pattern rules run, so an escape spliced into
    // the middle of an assignment cannot break the rule's anchor.
    const output = redactText(`password=${ESC}[0m${IMAP}`);
    expectNoSentinels(output);
  });
});

describe("redactText — length cap", () => {
  it("truncates beyond MAX_VALUE_LENGTH", () => {
    const output = redactText("a".repeat(MAX_VALUE_LENGTH + 5_000));
    expect(output.length).toBeLessThan(MAX_VALUE_LENGTH + 100);
    expect(output).toContain("[truncated]");
  });

  it("leaves a value at exactly the cap untouched", () => {
    const output = redactText("a".repeat(MAX_VALUE_LENGTH));
    expect(output).not.toContain("[truncated]");
    expect(output).toHaveLength(MAX_VALUE_LENGTH);
  });

  it("does not let truncation resurrect a secret that follows the cap", () => {
    // Truncation must never be the thing that "saves" us; assert the secret is
    // gone because it was redacted, at a position well inside the cap.
    const output = redactText(`password=${IMAP}\n${"x".repeat(MAX_VALUE_LENGTH + 10)}`);
    expectNoSentinels(output);
  });
});

describe("isSecretKey / isPiiKey", () => {
  const secretKeys = [
    "password",
    "PASSWORD",
    "imap_password",
    "openrouterApiKey",
    "OPENROUTER_API_KEY",
    "api-key",
    "accessKey",
    "access_key",
    "privateKey",
    "credential",
    "Authorization",
    "auth_header",
    "sessionId",
    "cookie",
    "activationCode",
    "activation_code",
    "claimCode",
    "bootstrapToken",
    "signingKey",
    "passphrase",
    "salt",
    "passwd",
    "matrixAccessToken",
  ];
  for (const key of secretKeys) {
    it(`treats ${key} as a secret key`, () => {
      expect(isSecretKey(key)).toBe(true);
    });
  }

  const piiKeys = [
    "subject",
    "Subject",
    "snippet",
    "excerpt",
    "body",
    "sender",
    "fromAddress",
    "from_address",
    "toAddress",
    "recipient",
    "emailAddress",
    "mailFrom",
    "messageId",
  ];
  for (const key of piiKeys) {
    it(`treats ${key} as a PII key`, () => {
      expect(isPiiKey(key)).toBe(true);
    });
  }

  const neutralKeys = ["status", "count", "version", "unit", "activeState", "zone", "retryable"];
  for (const key of neutralKeys) {
    it(`treats ${key} as neither secret nor PII`, () => {
      expect(isSecretKey(key)).toBe(false);
      expect(isPiiKey(key)).toBe(false);
    });
  }

  it("normalizes hyphens and whitespace in key names", () => {
    expect(isSecretKey("api key")).toBe(true);
    expect(isSecretKey("private-key")).toBe(true);
  });
});

describe("redactValue — key-aware redaction", () => {
  it("redacts a secret-named key's value whatever its type", () => {
    const output = redactValue({
      password: IMAP,
      token: 12345,
      apiKey: { nested: OPENROUTER },
      activationCode: [ACTIVATION],
    }) as Record<string, unknown>;
    expectNoSentinels(output);
    expect(output.password).toBe(REDACTED);
    // A number-valued token is still a token.
    expect(output.token).toBe(REDACTED);
    expect(output.apiKey).toBe(REDACTED);
    expect(output.activationCode).toBe(REDACTED);
  });

  it("redacts a PII-named key's value with the PII marker", () => {
    const output = redactValue({
      subject: EMAIL_BODY,
      snippet: EMAIL_BODY,
      sender: "boss@example.com",
    }) as Record<string, unknown>;
    expectNoSentinels(output);
    expect(output.subject).toBe(REDACTED_PII);
    expect(output.snippet).toBe(REDACTED_PII);
    expect(output.sender).toBe(REDACTED_PII);
  });

  it("preserves neutral keys and their values", () => {
    const output = redactValue({
      unit: "sovereign-node-api",
      activeState: "failed",
      nRestarts: 7,
      retryable: true,
    }) as Record<string, unknown>;
    expect(output).toEqual({
      unit: "sovereign-node-api",
      activeState: "failed",
      nRestarts: 7,
      retryable: true,
    });
  });
});

describe("redactValue — identifying OBJECT KEYS (the sender-weight leak)", () => {
  it("does not emit an email-address key, and reports cardinality instead", () => {
    // This is the exact shape of Mail Sentinel's learning.senderWeights.
    const output = redactValue({
      "boss@example.com": 4,
      "hr@example.com": 2,
      "newsletter@marketing.example.org": -1,
    }) as Record<string, unknown>;

    expect(JSON.stringify(output)).not.toContain("boss@example.com");
    expect(JSON.stringify(output)).not.toContain("hr@example.com");
    expect(JSON.stringify(output)).not.toContain("example.org");
    // Cardinality survives — that is the only useful signal in the map.
    expect(output[REDACTED_PII]).toBe("3 identifying key(s) withheld");
  });

  it("does not emit bare domain keys", () => {
    const output = redactValue({
      "example.com": 1,
      "acme-competitor.com": 5,
      "sub.domain.co.uk": 2,
    }) as Record<string, unknown>;
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain("example.com");
    expect(serialized).not.toContain("acme-competitor");
    expect(serialized).not.toContain("co.uk");
    expect(output[REDACTED_PII]).toBe("3 identifying key(s) withheld");
  });

  it("counts identifying keys separately per object rather than merging them", () => {
    // Two sibling maps, neither of which has a PII-classified name, so the
    // key-cardinality path (not the PII-key path) is what handles them.
    const output = redactValue({
      inboundWeights: { "a@x.com": 1, "b@x.com": 2 },
      outboundWeights: { "x.com": 3 },
    }) as Record<string, Record<string, unknown>>;
    expect(output.inboundWeights?.[REDACTED_PII]).toBe("2 identifying key(s) withheld");
    expect(output.outboundWeights?.[REDACTED_PII]).toBe("1 identifying key(s) withheld");
  });

  it("collapses senderWeights entirely, because its KEY is PII-classified", () => {
    // Defence in depth: `senderWeights` matches the `sender` PII fragment, so
    // the map never even reaches the key-counting path. Stronger than the
    // cardinality treatment, and asserted so a future rename of the fragment
    // list cannot silently downgrade it.
    const output = redactValue({
      learning: { senderWeights: { "boss@example.com": 4 } },
    }) as { learning: Record<string, unknown> };
    expect(output.learning.senderWeights).toBe(REDACTED_PII);
    expect(JSON.stringify(output)).not.toContain("boss@example.com");
  });

  it("emits no cardinality entry when there are no identifying keys", () => {
    const output = redactValue({ count: 3 }) as Record<string, unknown>;
    expect(Object.keys(output)).toEqual(["count"]);
  });

  it("keeps non-identifying keys alongside withheld ones", () => {
    const output = redactValue({
      "boss@example.com": 4,
      totalScored: 1,
    }) as Record<string, unknown>;
    expect(output.totalScored).toBe(1);
    expect(JSON.stringify(output)).not.toContain("boss@example.com");
  });

  it("does not mistake a hostname-with-port or a unit name for a domain key", () => {
    // DOMAIN_KEY_RE is anchored; these must survive because they are diagnostic.
    const output = redactValue({
      "sovereign-node-api": "active",
      "imap host": "imap.gmail.com",
    }) as Record<string, unknown>;
    expect(output["sovereign-node-api"]).toBe("active");
    expect(output["imap host"]).toBe("imap.gmail.com");
  });
});

describe("redactValue — structural adversarial cases", () => {
  it("redacts a secret nested five levels deep", () => {
    // `note` carries the secret in an anchored assignment shape. A BARE
    // high-entropy string under a neutral key is deliberately NOT matched — see
    // the "documented non-goal" test below.
    const deep = {
      l1: { l2: { l3: { l4: { l5: { password: IMAP, note: `sent api_key=${OPENROUTER}` } } } } },
    };
    expectNoSentinels(redactValue(deep));
  });

  it("documented non-goal: a bare unanchored secret under a neutral key survives", () => {
    // This is a deliberate design choice, not an oversight (see the TEXT_RULES
    // header): matching "a long random-looking string" would redact hashes,
    // UUIDs and base64 payloads that are genuinely useful in diagnostics. The
    // allowlist in collectors.ts is what keeps such values out of the bundle;
    // redaction is the second layer, not the control. Pinning it here means a
    // future change to that trade-off has to be made consciously.
    const output = redactValue({ note: `raw ${OPENROUTER}` }) as { note: string };
    expect(output.note).toContain(OPENROUTER);
  });

  it("redacts a secret nested six levels deep inside arrays", () => {
    const deep = [[[[[{ apiKey: OPENROUTER }]]]]];
    expectNoSentinels(redactValue(deep));
  });

  it("redacts secrets inside arrays of strings", () => {
    const output = redactValue([
      `OPENROUTER_API_KEY=${OPENROUTER}`,
      `password: ${IMAP}`,
      `Authorization: Bearer ${MATRIX}`,
    ]);
    expectNoSentinels(output);
    expect(Array.isArray(output)).toBe(true);
  });

  it("redacts an identifying key map nested inside an array", () => {
    const output = redactValue([{ senderWeights: { "boss@example.com": 9 } }]);
    expect(JSON.stringify(output)).not.toContain("boss@example.com");
  });

  it("redacts a free-text secret reached through a neutral key", () => {
    const output = redactValue({
      lastError: { message: `auth rejected, sent api_key=${OPENROUTER}` },
    });
    expectNoSentinels(output);
  });

  it("does not throw on a self-referencing object", () => {
    const cyclic: Record<string, unknown> = { password: IMAP };
    cyclic.self = cyclic;
    let output: unknown;
    expect(() => {
      output = redactValue(cyclic);
    }).not.toThrow();
    expectNoSentinels(output);
    expect(JSON.stringify(output)).toContain("[REDACTED:CYCLE]");
  });

  it("does not throw on a cycle through an array", () => {
    const arr: unknown[] = [{ token: MATRIX }];
    arr.push(arr);
    expect(() => redactValue(arr)).not.toThrow();
    expectNoSentinels(redactValue(arr));
  });

  it("does not throw on mutually recursive objects", () => {
    const a: Record<string, unknown> = { name: "a" };
    const b: Record<string, unknown> = { name: "b", a };
    a.b = b;
    expect(() => redactValue(a)).not.toThrow();
  });

  it("collapses beyond the depth limit rather than recursing without bound", () => {
    // Build a chain deeper than MAX_DEPTH (12) and assert the marker appears.
    let node: Record<string, unknown> = { password: IMAP };
    for (let index = 0; index < 30; index += 1) {
      node = { child: node };
    }
    const output = redactValue(node);
    expectNoSentinels(output);
    expect(JSON.stringify(output)).toContain("[REDACTED:DEPTH]");
  });

  it("returns the depth marker when called at a depth already past the limit", () => {
    expect(redactValue({ password: IMAP }, 13)).toBe("[REDACTED:DEPTH]");
  });

  it("truncates an over-long string reached through a structure", () => {
    const output = redactValue({ log: "z".repeat(MAX_VALUE_LENGTH + 100) }) as {
      log: string;
    };
    expect(output.log).toContain("[truncated]");
  });
});

describe("redactValue — scalar and exotic types", () => {
  it("passes null and undefined through unchanged", () => {
    expect(redactValue(null)).toBeNull();
    expect(redactValue(undefined)).toBeUndefined();
  });

  it("passes numbers and booleans through unchanged", () => {
    expect(redactValue(42)).toBe(42);
    expect(redactValue(0)).toBe(0);
    expect(redactValue(true)).toBe(true);
    expect(redactValue(false)).toBe(false);
  });

  it("stringifies bigints", () => {
    expect(redactValue(10n)).toBe("10");
  });

  it("refuses functions and symbols", () => {
    expect(redactValue(() => undefined)).toBe("[REDACTED:UNSUPPORTED]");
    expect(redactValue(Symbol("s"))).toBe("[REDACTED:UNSUPPORTED]");
  });

  it("redacts a bare string input", () => {
    expectNoSentinels(redactValue(`token=${MATRIX}`));
  });
});

describe("redactValue — realistic composite payload", () => {
  it("leaks nothing from a payload carrying every sentinel in every shape", () => {
    const payload = {
      env: {
        OPENROUTER_API_KEY: OPENROUTER,
        IMAP_PASSWORD: IMAP,
      },
      headers: { authorization: `Bearer ${MATRIX}` },
      connection: `imaps://user:${IMAP}@mail.example.org:993`,
      enrollment: `https://updates.example.com/enroll?code=${ACTIVATION}`,
      logs: [
        `${ESC}[31mERROR${ESC}[0m login failed with password ${IMAP}`,
        `-----BEGIN PRIVATE KEY-----\n${OPENROUTER}\n-----END PRIVATE KEY-----`,
        `OPENROUTER_API_KEY=${OPENROUTER}\\\n${OPENROUTER}`,
        `{"token": "${MATRIX}", "unit": "sovereign-node-api"}`,
      ],
      mail: {
        messages: [{ subject: EMAIL_BODY, snippet: EMAIL_BODY, sender: "boss@example.com" }],
        learning: {
          senderWeights: { "boss@example.com": 4, "hr@example.com": 1 },
          domainWeights: { "example.com": 5 },
        },
      },
      diagnostics: {
        code: "SAN-IMAP-001",
        host: "imap.gmail.com",
        version: "2.3.5",
        observedAt: "2026-07-26T10:15:30.000Z",
      },
    };

    const output = redactValue(payload);
    const serialized = JSON.stringify(output);

    expectNoSentinels(output);
    expect(serialized).not.toContain("boss@example.com");
    expect(serialized).not.toContain("hr@example.com");
    expect(serialized).not.toContain(ESC);

    // And the diagnostics that make the bundle worth sending survive intact.
    expect(serialized).toContain("SAN-IMAP-001");
    expect(serialized).toContain("imap.gmail.com");
    expect(serialized).toContain("2.3.5");
    expect(serialized).toContain("2026-07-26T10:15:30.000Z");
  });
});

describe("summarizeRedactions", () => {
  it("counts secret and PII markers", () => {
    const redacted = `${REDACTED} and ${REDACTED} and ${REDACTED_PII}`;
    // REDACTED_PII contains REDACTED as a prefix substring, so the secret count
    // includes it; the assertion documents the actual contract rather than an
    // assumed one.
    const summary = summarizeRedactions(redacted);
    expect(summary.piiRedacted).toBe(1);
    expect(summary.secretsRedacted).toBeGreaterThanOrEqual(2);
  });

  it("reports zero for clean text", () => {
    expect(summarizeRedactions("all fine")).toEqual({ secretsRedacted: 0, piiRedacted: 0 });
  });
});

describe("redaction is linear-ish on large inputs (ReDoS regression)", () => {
  // The email pattern originally used unbounded quantifiers and backtracked
  // catastrophically on long runs of local-part-legal characters with no `@`.
  // Cost grew quadratically — 512 KiB took over two minutes — on the exact path
  // that processes up to MAX_ARTIFACT_BYTES of journal text per unit.
  const budgetMs = 5_000;

  it("redacts 256 KiB of at-free text well within the budget", () => {
    const started = Date.now();
    redactText("x".repeat(256 * 1024));
    expect(Date.now() - started).toBeLessThan(budgetMs);
  });

  it("redacts 256 KiB of local-part-legal characters within the budget", () => {
    const started = Date.now();
    redactText("a.b+c_d-e%f".repeat(24_000));
    expect(Date.now() - started).toBeLessThan(budgetMs);
  });

  it("redacts a long run ending in a near-miss address within the budget", () => {
    // The adversarial shape: a long candidate local part whose `@` never
    // resolves to a valid domain, forcing maximum backtracking.
    const started = Date.now();
    const output = redactText(`${"a".repeat(200_000)}@`);
    expect(Date.now() - started).toBeLessThan(budgetMs);
    expect(output).toContain("[truncated]");
  });

  it("still redacts addresses embedded in a large input", () => {
    // Performance must not have been bought by weakening the match. The address
    // is placed inside MAX_VALUE_LENGTH so the assertion tests redaction rather
    // than truncation, with a large tail behind it to keep the input big.
    const output = redactText(`${"x".repeat(1_000)} boss@example.com ${"y".repeat(200_000)}`);
    expect(output).not.toContain("boss@example.com");
    expect(output).toContain(REDACTED_PII);
  });

  const addresses = [
    "boss@example.com",
    "a.b+c%d_e@sub.domain.co.uk",
    "newsletter@marketing.example.org",
    "user@x.io",
    "first.last@team-name.example.com",
  ];
  for (const address of addresses) {
    it(`still matches ${address}`, () => {
      expect(redactText(`contact ${address} now`)).not.toContain(address);
    });
  }

  const nonAddresses = ["no-at-sign-here", "trailing@", "@leading.com", "a@b"];
  for (const value of nonAddresses) {
    it(`does not treat ${value} as an address`, () => {
      expect(redactText(value)).toContain(value);
    });
  }
});

describe("regex state safety", () => {
  it("does not leak lastIndex state between successive calls", () => {
    // Global regexes are module-level singletons; a missing lastIndex reset
    // would make every second call silently skip a match. That failure mode is
    // exactly how a secret escapes in production but not in a single-case test.
    for (let index = 0; index < 10; index += 1) {
      const output = redactText(`api_key=${OPENROUTER} for user boss@example.com`);
      expectNoSentinels(output);
      expect(output).not.toContain("boss@example.com");
    }
  });

  it("does not leak key-matching state across sibling objects", () => {
    const output = redactValue({
      a: { "one@example.com": 1 },
      b: { "two@example.com": 1 },
      c: { "three@example.com": 1 },
    });
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain("one@example.com");
    expect(serialized).not.toContain("two@example.com");
    expect(serialized).not.toContain("three@example.com");
  });
});
