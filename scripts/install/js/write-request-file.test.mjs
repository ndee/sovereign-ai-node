import { describe, expect, it } from "vitest";

import { buildRequest, inferMatrixTlsMode } from "./write-request-file.mjs";

const baseEnv = {
  SN_REQUEST_FILE: "/tmp/test-req.json",
  SN_OPENROUTER_MODEL: "qwen/qwen3.5-9b",
  SN_OPENROUTER_SECRET_REF: "file:/etc/sovereign-node/secrets/openrouter-api-key",
  SN_MATRIX_DOMAIN: "matrix.example.com",
  SN_MATRIX_PUBLIC_BASE_URL: "https://matrix.example.com",
  SN_MATRIX_TLS_MODE: "auto",
  SN_MATRIX_FEDERATION_ENABLED: "0",
  SN_ALERT_ROOM_NAME: "Alerts",
  SN_OPERATOR_USERNAME: "admin",
  SN_CONNECTIVITY_MODE: "direct",
};

describe("inferMatrixTlsMode", () => {
  it("returns local-dev for non-https URLs", () => {
    expect(inferMatrixTlsMode("http://127.0.0.1:8008")).toBe("local-dev");
    expect(inferMatrixTlsMode("http://matrix.example.com")).toBe("local-dev");
  });

  it("returns auto for https URLs with public hostnames", () => {
    expect(inferMatrixTlsMode("https://matrix.example.com")).toBe("auto");
  });

  it("returns internal for https URLs with LAN-only hostnames", () => {
    expect(inferMatrixTlsMode("https://matrix.local")).toBe("internal");
    expect(inferMatrixTlsMode("https://matrix.home.arpa")).toBe("internal");
    expect(inferMatrixTlsMode("https://matrix.lan")).toBe("internal");
    expect(inferMatrixTlsMode("https://matrix.internal")).toBe("internal");
    expect(inferMatrixTlsMode("https://matrix")).toBe("internal");
  });

  it("returns internal for https URLs with loopback or IP-literal hosts", () => {
    expect(inferMatrixTlsMode("https://127.0.0.1")).toBe("internal");
    expect(inferMatrixTlsMode("https://localhost")).toBe("internal");
    expect(inferMatrixTlsMode("https://[::1]")).toBe("internal");
  });

  it("falls back when the input is not a parseable URL", () => {
    expect(inferMatrixTlsMode("https://")).toBe("auto");
    expect(inferMatrixTlsMode("not a url")).toBe("local-dev");
    expect(inferMatrixTlsMode("")).toBe("local-dev");
  });
});

describe("buildRequest", () => {
  it("synthesises the canonical fresh-direct-node-operator request", () => {
    const req = buildRequest({
      ...baseEnv,
      SN_SELECTED_BOTS: "node-operator",
      SN_POLL_INTERVAL: "30m",
      SN_LOOKBACK_WINDOW: "1h",
    });
    expect(req).toEqual({
      mode: "bundled_matrix",
      connectivity: { mode: "direct" },
      openclaw: {
        manageInstallation: true,
        installMethod: "install_sh",
        version: "2026.3.13",
        skipIfCompatibleInstalled: true,
        forceReinstall: false,
        runOnboard: false,
      },
      openrouter: {
        model: "qwen/qwen3.5-9b",
        secretRef: "file:/etc/sovereign-node/secrets/openrouter-api-key",
      },
      matrix: {
        homeserverDomain: "matrix.example.com",
        publicBaseUrl: "https://matrix.example.com",
        federationEnabled: false,
        tlsMode: "auto",
        alertRoomName: "Alerts",
      },
      operator: { username: "admin" },
      advanced: { nonInteractive: true },
      bots: { selected: ["node-operator"] },
    });
  });

  it("adds bots.config['mail-sentinel'] when mail-sentinel is selected", () => {
    const req = buildRequest({
      ...baseEnv,
      SN_SELECTED_BOTS: "mail-sentinel,node-operator",
      SN_POLL_INTERVAL: "15m",
      SN_LOOKBACK_WINDOW: "2h",
    });
    expect(req.bots).toEqual({
      selected: ["mail-sentinel", "node-operator"],
      config: {
        "mail-sentinel": {
          pollInterval: "15m",
          lookbackWindow: "2h",
          e2eeAlertRoom: false,
        },
      },
    });
  });

  it("omits the bots block when no bots are selected", () => {
    const req = buildRequest({ ...baseEnv, SN_SELECTED_BOTS: "" });
    expect(req.bots).toBeUndefined();
  });

  it("trims and filters empty entries from SN_SELECTED_BOTS", () => {
    const req = buildRequest({ ...baseEnv, SN_SELECTED_BOTS: " a , ,b " });
    expect(req.bots).toEqual({ selected: ["a", "b"] });
  });

  it("sets matrix.federationEnabled true only when SN_MATRIX_FEDERATION_ENABLED == '1'", () => {
    expect(buildRequest({ ...baseEnv, SN_MATRIX_FEDERATION_ENABLED: "1" }).matrix.federationEnabled).toBe(true);
    expect(buildRequest({ ...baseEnv, SN_MATRIX_FEDERATION_ENABLED: "0" }).matrix.federationEnabled).toBe(false);
    expect(buildRequest({ ...baseEnv, SN_MATRIX_FEDERATION_ENABLED: "true" }).matrix.federationEnabled).toBe(false);
    expect(buildRequest({ ...baseEnv, SN_MATRIX_FEDERATION_ENABLED: undefined }).matrix.federationEnabled).toBe(false);
  });

  it("infers matrixTlsMode when SN_MATRIX_TLS_MODE is unset", () => {
    const req = buildRequest({
      ...baseEnv,
      SN_MATRIX_TLS_MODE: undefined,
      SN_MATRIX_PUBLIC_BASE_URL: "http://127.0.0.1:8008",
    });
    expect(req.matrix.tlsMode).toBe("local-dev");
  });

  it("includes the imap block only when SN_IMAP_CONFIGURE == '1'", () => {
    const off = buildRequest(baseEnv);
    expect(off.imap).toBeUndefined();

    const on = buildRequest({
      ...baseEnv,
      SN_IMAP_CONFIGURE: "1",
      SN_IMAP_HOST: "imap.example.com",
      SN_IMAP_PORT: "993",
      SN_IMAP_TLS: "1",
      SN_IMAP_USERNAME: "operator@example.com",
      SN_IMAP_SECRET_REF: "file:/etc/sovereign-node/secrets/imap-password",
      SN_IMAP_MAILBOX: "INBOX",
    });
    expect(on.imap).toEqual({
      host: "imap.example.com",
      port: 993,
      tls: true,
      username: "operator@example.com",
      secretRef: "file:/etc/sovereign-node/secrets/imap-password",
      mailbox: "INBOX",
    });
  });

  it("defaults imap.port to 993 and imap.mailbox to INBOX", () => {
    const req = buildRequest({
      ...baseEnv,
      SN_IMAP_CONFIGURE: "1",
      SN_IMAP_HOST: "imap.example.com",
      SN_IMAP_TLS: "0",
      SN_IMAP_USERNAME: "u",
      SN_IMAP_SECRET_REF: "ref",
    });
    expect(req.imap.port).toBe(993);
    expect(req.imap.mailbox).toBe("INBOX");
    expect(req.imap.tls).toBe(false);
  });

  it("includes a relay block when SN_CONNECTIVITY_MODE=relay", () => {
    const req = buildRequest({
      ...baseEnv,
      SN_CONNECTIVITY_MODE: "relay",
      SN_RELAY_CONTROL_URL: "https://relay.sovereign-ai-node.com",
      SN_RELAY_ENROLLMENT_TOKEN: "token-xyz",
      SN_RELAY_REQUESTED_SLUG: "my-node",
      SN_REQUEST_FILE: "/nonexistent",
    });
    expect(req.connectivity.mode).toBe("relay");
    expect(req.relay).toEqual({
      controlUrl: "https://relay.sovereign-ai-node.com",
      enrollmentToken: "token-xyz",
      requestedSlug: "my-node",
    });
  });

  it("omits relay enrollmentToken / requestedSlug when their env vars are blank or missing", () => {
    const req = buildRequest({
      ...baseEnv,
      SN_CONNECTIVITY_MODE: "relay",
      SN_RELAY_CONTROL_URL: "https://relay.sovereign-ai-node.com",
      SN_RELAY_ENROLLMENT_TOKEN: "  ",
      SN_RELAY_REQUESTED_SLUG: "",
      SN_REQUEST_FILE: "/nonexistent",
    });
    expect(req.relay.enrollmentToken).toBeUndefined();
    expect(req.relay.requestedSlug).toBeUndefined();
  });
});
