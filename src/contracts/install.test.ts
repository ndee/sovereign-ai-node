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
});
