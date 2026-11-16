import { describe, expect, it } from "vitest";

import {
  INSTALL_REQUEST_LIMITS,
  installRequestSchema,
  matrixOnboardingReadinessSchema,
  reconfigureResultSchema,
} from "./install.js";

describe("installRequestSchema", () => {
  it("accepts managed relay requests without an enrollment token", () => {
    const parsed = installRequestSchema.parse({
      mode: "bundled_matrix",
      connectivity: {
        mode: "relay",
      },
      relay: {
        controlUrl: "https://relay.sovereign-ai-node.com",
      },
      openrouter: {
        secretRef: "file:/etc/sovereign-node/secrets/openrouter-api-key",
      },
      matrix: {
        homeserverDomain: "relay-pending.invalid",
        publicBaseUrl: "https://relay-pending.invalid",
        federationEnabled: false,
        tlsMode: "auto",
        alertRoomName: "Sovereign Alerts",
      },
      operator: {
        username: "operator",
      },
      bots: {
        config: {
          "mail-sentinel": {
            pollInterval: "30m",
            lookbackWindow: "1h",
            e2eeAlertRoom: false,
          },
        },
      },
      advanced: {
        nonInteractive: true,
      },
    });

    expect(parsed.relay).toEqual({
      controlUrl: "https://relay.sovereign-ai-node.com",
    });
  });

  it("accepts a relay request with a dns01 passthrough block and https tunnel type", () => {
    const base = {
      mode: "bundled_matrix" as const,
      connectivity: { mode: "relay" as const },
      openrouter: { secretRef: "file:/etc/sovereign-node/secrets/openrouter-api-key" },
      matrix: {
        homeserverDomain: "node-abc.relay.example.com",
        publicBaseUrl: "https://node-abc.relay.example.com",
        federationEnabled: false,
        tlsMode: "auto" as const,
      },
      operator: { username: "operator" },
    };

    // With a token (first mint / rotation).
    const withToken = installRequestSchema.parse({
      ...base,
      relay: {
        controlUrl: "https://relay.example.com",
        tunnel: {
          serverAddr: "relay.example.com",
          token: "frp-token",
          proxyName: "relay-node-abc",
          type: "https",
        },
        dns01: {
          provider: "desec",
          apiBase: "https://desec.io/api/v1",
          zone: "_acme-challenge.relay.example.com",
          subname: "node-abc",
          acmeEmail: "ops@example.com",
          token: "scoped-desec-token",
        },
      },
    });
    expect(withToken.relay?.dns01?.provider).toBe("desec");
    expect(withToken.relay?.tunnel?.type).toBe("https");

    // Without a token (rotation-absent re-enroll) is still valid.
    const withoutToken = installRequestSchema.parse({
      ...base,
      relay: {
        controlUrl: "https://relay.example.com",
        dns01: {
          provider: "desec",
          apiBase: "https://desec.io/api/v1",
          zone: "_acme-challenge.relay.example.com",
          subname: "node-abc",
        },
      },
    });
    expect(withoutToken.relay?.dns01?.token).toBeUndefined();

    // A non-deSEC provider is rejected.
    expect(() =>
      installRequestSchema.parse({
        ...base,
        relay: {
          controlUrl: "https://relay.example.com",
          dns01: {
            provider: "route53",
            apiBase: "https://example",
            zone: "z",
            subname: "s",
          },
        },
      }),
    ).toThrow();
  });

  it("accepts the wizard-generated install request shape", () => {
    // This payload mirrors exactly what
    // public/setup-ui/screens/wizard/state.js#buildInstallRequest emits.
    // Keeping this test in sync with the wizard guards against
    // frontend/backend drift in the local setup UI.
    const wizardPayload = {
      mode: "bundled_matrix" as const,
      matrix: {
        homeserverDomain: "matrix.example.com",
        publicBaseUrl: "https://matrix.example.com",
        federationEnabled: false,
        alertRoomName: "Sovereign Alerts",
      },
      operator: {
        username: "operator",
        password: "operator-password",
      },
      openrouter: {
        model: "qwen/qwen-2.5-7b-instruct",
        apiKey: "sk-or-test",
      },
      imap: {
        host: "imap.example.com",
        port: 993,
        tls: true,
        username: "alerts@example.com",
        password: "imap-password",
        mailbox: "INBOX",
      },
      bots: {
        selected: ["mail-sentinel", "node-operator"],
      },
    };

    const parsed = installRequestSchema.parse(wizardPayload);
    expect(parsed.matrix.homeserverDomain).toBe("matrix.example.com");
    expect(parsed.imap?.tls).toBe(true);
    expect(parsed.bots?.selected).toEqual(["mail-sentinel", "node-operator"]);
  });

  it("accepts the wizard's local-dev Matrix preset", () => {
    // Mirrors the Local dev card in MatrixStep.js. The schema must accept
    // tlsMode: "local-dev" and a plaintext http://127.0.0.1 base URL so the
    // smoke-test path through the wizard never fails at request validation.
    const parsed = installRequestSchema.parse({
      mode: "bundled_matrix" as const,
      matrix: {
        homeserverDomain: "matrix.local.test",
        publicBaseUrl: "http://127.0.0.1:8008",
        federationEnabled: false,
        tlsMode: "local-dev",
      },
      operator: { username: "operator", password: "operator-password" },
      openrouter: { apiKey: "sk-or-test" },
    });
    expect(parsed.matrix.tlsMode).toBe("local-dev");
  });

  it("accepts the wizard's Local LAN Matrix preset", () => {
    const parsed = installRequestSchema.parse({
      mode: "bundled_matrix" as const,
      matrix: {
        homeserverDomain: "matrix.lan.local",
        publicBaseUrl: "https://matrix.lan.local",
        federationEnabled: false,
        tlsMode: "internal",
      },
      operator: { username: "operator", password: "operator-password" },
      openrouter: { apiKey: "sk-or-test" },
    });
    expect(parsed.matrix.tlsMode).toBe("internal");
  });
});

describe("matrixOnboardingReadinessSchema", () => {
  it("accepts a ready reading with optional status/reason", () => {
    const parsed = matrixOnboardingReadinessSchema.parse({
      ready: true,
      url: "https://node.relay.example.com/onboard",
      mode: "relay-passthrough",
      status: 200,
      reason: "public-200",
    });
    expect(parsed.ready).toBe(true);
    expect(parsed.mode).toBe("relay-passthrough");
  });

  it("accepts a not-ready reading with an empty url and no status", () => {
    const parsed = matrixOnboardingReadinessSchema.parse({
      ready: false,
      url: "",
      mode: "direct",
      reason: "config-not-found",
    });
    expect(parsed.ready).toBe(false);
    expect(parsed.status).toBeUndefined();
  });

  it("rejects an unknown mode", () => {
    expect(() =>
      matrixOnboardingReadinessSchema.parse({ ready: false, url: "", mode: "carrier-pigeon" }),
    ).toThrow();
  });
});

describe("reconfigureResultSchema", () => {
  const base = {
    target: "openrouter",
    changed: ["openrouter.privacy"],
    restartRequiredServices: ["openclaw-gateway"],
    validation: [],
  };

  it("still accepts a result without the restart report or warnings", () => {
    expect(
      reconfigureResultSchema.parse({
        ...base,
        gateway: { ready: true, waitedMs: 1, deadlineMs: 300_000 },
      }),
    ).not.toHaveProperty("warnings");
  });

  it("carries the restart report and warnings", () => {
    const result = {
      ...base,
      gateway: {
        ready: true,
        waitedMs: 1,
        deadlineMs: 300_000,
        invocationIdBefore: null,
        invocationIdAfter: "c0ffee",
        restarted: true,
      },
      warnings: [
        {
          code: "OPENROUTER_AGENT_MODEL_NOT_SERVABLE",
          message: "Agent mail-sentinel uses qwen/qwen3.5-27b, which OpenRouter cannot serve",
          agentId: "mail-sentinel",
          model: "qwen/qwen3.5-27b",
        },
        { code: "OPENROUTER_SERVABILITY_UNKNOWN", message: "Could not check" },
      ],
    };
    expect(reconfigureResultSchema.parse(result)).toEqual(result);
  });

  it("rejects an empty invocation id or a warning without a code", () => {
    expect(
      reconfigureResultSchema.safeParse({
        ...base,
        gateway: { ready: true, waitedMs: 1, deadlineMs: 1, invocationIdAfter: "" },
      }).success,
    ).toBe(false);
    expect(
      reconfigureResultSchema.safeParse({ ...base, warnings: [{ code: "", message: "x" }] })
        .success,
    ).toBe(false);
  });
});

describe("installRequestSchema size limits", () => {
  const baseRequest = {
    mode: "bundled_matrix" as const,
    openrouter: { secretRef: "file:/etc/sovereign-node/secrets/openrouter-api-key" },
    matrix: {
      homeserverDomain: "matrix.example.com",
      publicBaseUrl: "https://matrix.example.com",
    },
    operator: { username: "operator" },
  };
  const instance = (overrides: Record<string, unknown> = {}) => ({
    id: "mail-sentinel",
    packageId: "mail-sentinel",
    ...overrides,
  });
  const withBots = (bots: Record<string, unknown>) => ({ ...baseRequest, bots });
  const withPrivacyOnly = (only: string[]) => ({
    ...baseRequest,
    openrouter: { ...baseRequest.openrouter, privacy: { only } },
  });
  const filled = <T>(length: number, value: (index: number) => T): T[] =>
    Array.from({ length }, (_, index) => value(index));
  const entries = <T>(count: number, value: T): Record<string, T> =>
    Object.fromEntries(filled(count, (index) => [`key-${index}`, value]));
  const mxid = (index: number) => `@user-${index}:matrix.example.com`;
  const oversizedString = (length: number) => "a".repeat(length);

  const cases: Array<{
    name: string;
    limit: number;
    path: (string | number)[];
    request: (size: number) => unknown;
  }> = [
    {
      name: "bots.selected entries",
      limit: INSTALL_REQUEST_LIMITS.botsSelected,
      path: ["bots", "selected"],
      request: (size) => withBots({ selected: filled(size, (index) => `bot-${index}`) }),
    },
    {
      name: "bots.instances entries",
      limit: INSTALL_REQUEST_LIMITS.botInstances,
      path: ["bots", "instances"],
      request: (size) =>
        withBots({ instances: filled(size, (index) => instance({ id: `instance-${index}` })) }),
    },
    {
      name: "bots.config bots",
      limit: INSTALL_REQUEST_LIMITS.botsConfigBots,
      path: ["bots", "config"],
      request: (size) => withBots({ config: entries(size, { pollInterval: "30m" }) }),
    },
    {
      name: "bots.config keys per bot",
      limit: INSTALL_REQUEST_LIMITS.botConfigEntries,
      path: ["bots", "config", "mail-sentinel"],
      request: (size) => withBots({ config: { "mail-sentinel": entries(size, "value") } }),
    },
    {
      name: "bots.instances[].config keys",
      limit: INSTALL_REQUEST_LIMITS.botConfigEntries,
      path: ["bots", "instances", 0, "config"],
      request: (size) => withBots({ instances: [instance({ config: entries(size, true) })] }),
    },
    {
      name: "bots.instances[].secretRefs keys",
      limit: INSTALL_REQUEST_LIMITS.botSecretRefs,
      path: ["bots", "instances", 0, "secretRefs"],
      request: (size) =>
        withBots({ instances: [instance({ secretRefs: entries(size, "env:SECRET") })] }),
    },
    {
      name: "bots.instances[].matrix.allowedUsers entries",
      limit: INSTALL_REQUEST_LIMITS.allowedUsers,
      path: ["bots", "instances", 0, "matrix", "allowedUsers"],
      request: (size) =>
        withBots({ instances: [instance({ matrix: { allowedUsers: filled(size, mxid) } })] }),
    },
    {
      name: "openrouter.privacy.only entries",
      limit: INSTALL_REQUEST_LIMITS.providerSlugs,
      path: ["openrouter", "privacy", "only"],
      request: (size) => withPrivacyOnly(filled(size, (index) => `provider-${index}`)),
    },
    {
      name: "bots.selected[] id length",
      limit: INSTALL_REQUEST_LIMITS.botIdLength,
      path: ["bots", "selected", 0],
      request: (size) => withBots({ selected: [oversizedString(size)] }),
    },
    {
      name: "bots.instances[].id length",
      limit: INSTALL_REQUEST_LIMITS.botIdLength,
      path: ["bots", "instances", 0, "id"],
      request: (size) => withBots({ instances: [instance({ id: oversizedString(size) })] }),
    },
    {
      name: "bots.instances[].packageId length",
      limit: INSTALL_REQUEST_LIMITS.botIdLength,
      path: ["bots", "instances", 0, "packageId"],
      request: (size) => withBots({ instances: [instance({ packageId: oversizedString(size) })] }),
    },
    {
      name: "bots.instances[].matrix.allowedUsers[] length",
      limit: INSTALL_REQUEST_LIMITS.matrixUserIdLength,
      path: ["bots", "instances", 0, "matrix", "allowedUsers", 0],
      request: (size) =>
        withBots({ instances: [instance({ matrix: { allowedUsers: [oversizedString(size)] } })] }),
    },
    {
      name: "openrouter.privacy.only[] length",
      limit: INSTALL_REQUEST_LIMITS.providerSlugLength,
      path: ["openrouter", "privacy", "only", 0],
      request: (size) => withPrivacyOnly([oversizedString(size)]),
    },
  ];

  it.each(cases)("accepts $name at the limit", ({ limit, request }) => {
    expect(installRequestSchema.safeParse(request(limit)).success).toBe(true);
  });

  it.each(cases)("refuses $name one above the limit", ({ limit, path, request }) => {
    const result = installRequestSchema.safeParse(request(limit + 1));

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({ code: "too_big", maximum: limit, path }),
    ]);
  });

  it("refuses a 500k-element array with one small issue before checking any element", () => {
    const request = withBots({
      instances: [instance({ matrix: { allowedUsers: filled(500_000, () => "") } })],
    });

    const startedAt = performance.now();
    const result = installRequestSchema.safeParse(request);
    const elapsedMs = performance.now() - startedAt;

    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(1);
    expect(JSON.stringify(result.error?.issues).length).toBeLessThan(1_000);
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it("refuses a 500k-entry record with one small issue before checking any value", () => {
    const request = withBots({ config: { "mail-sentinel": entries(500_000, null) } });

    const startedAt = performance.now();
    const result = installRequestSchema.safeParse(request);
    const elapsedMs = performance.now() - startedAt;

    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(1);
    expect(JSON.stringify(result.error?.issues).length).toBeLessThan(1_000);
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it("still reports invalid values inside a record that is within its limit", () => {
    const result = installRequestSchema.safeParse(
      withBots({ config: { "mail-sentinel": { pollInterval: null } } }),
    );

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({ path: ["bots", "config", "mail-sentinel", "pollInterval"] }),
    ]);
  });

  it("refuses a bots.config record that is not an object", () => {
    const result = installRequestSchema.safeParse(withBots({ config: ["mail-sentinel"] }));

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({ code: "invalid_type", path: ["bots", "config"] }),
    ]);
  });
});
