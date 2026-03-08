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
        requestedNodeName: "pilot-node",
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
      mailSentinel: {
        pollInterval: "5m",
        lookbackWindow: "15m",
        e2eeAlertRoom: false,
      },
      advanced: {
        nonInteractive: true,
      },
    });

    expect(parsed.relay).toEqual({
      controlUrl: "https://relay.sovereign-ai-node.com",
      requestedNodeName: "pilot-node",
    });
  });

  it("rejects invalid requested relay node names", () => {
    expect(() => installRequestSchema.parse({
      mode: "bundled_matrix",
      connectivity: {
        mode: "relay",
      },
      relay: {
        controlUrl: "https://relay.sovereign-ai-node.com",
        requestedNodeName: "Pilot Node",
      },
      openrouter: {
        secretRef: "file:/etc/sovereign-node/secrets/openrouter-api-key",
      },
      matrix: {
        homeserverDomain: "relay-pending.invalid",
        publicBaseUrl: "https://relay-pending.invalid",
      },
      operator: {
        username: "operator",
      },
    })).toThrow(/requestedNodeName/i);
  });
});
