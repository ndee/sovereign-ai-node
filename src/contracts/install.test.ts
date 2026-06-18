import { describe, expect, it } from "vitest";

import { installRequestSchema } from "./install.js";

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
        model: "qwen/qwen3.5-9b",
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
