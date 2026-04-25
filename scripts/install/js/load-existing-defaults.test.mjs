import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { formatTsv, loadExistingDefaults } from "./load-existing-defaults.mjs";

let workDir;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "load-existing-defaults-test-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const writeRequest = (req) => {
  const path = join(workDir, "install-request.json");
  writeFileSync(path, JSON.stringify(req, null, 2));
  return path;
};

const writeRuntime = (runtime) => {
  const path = join(workDir, "runtime.json5");
  writeFileSync(path, JSON.stringify(runtime, null, 2));
  return path;
};

const baseEnv = {
  SN_DEFAULT_SELECTED_BOTS: "mail-sentinel",
  SN_RECOMMENDED_MATRIX_DOMAIN: "matrix.local.test",
  SN_RECOMMENDED_MATRIX_PUBLIC_BASE_URL: "http://127.0.0.1:8008",
};

const toMap = (pairs) => Object.fromEntries(pairs);

describe("loadExistingDefaults", () => {
  it("emits the canonical pairs for a fresh direct-connectivity request", () => {
    const requestPath = writeRequest({
      mode: "bundled_matrix",
      connectivity: { mode: "direct" },
      openrouter: { model: "qwen/qwen3.5-9b", secretRef: "file:/secrets/or" },
      matrix: {
        homeserverDomain: "matrix.example.com",
        publicBaseUrl: "https://matrix.example.com",
        federationEnabled: true,
        alertRoomName: "Alerts",
      },
      operator: { username: "admin" },
      bots: {
        selected: ["mail-sentinel", "node-operator"],
        config: { "mail-sentinel": { pollInterval: "15m", lookbackWindow: "2h" } },
      },
    });
    const map = toMap(loadExistingDefaults({
      requestPath,
      runtimePath: "/nonexistent/runtime.json5",
      env: baseEnv,
    }));
    expect(map.DEFAULT_OPENROUTER_MODEL).toBe("qwen/qwen3.5-9b");
    expect(map.EXISTING_OPENROUTER_SECRET_REF).toBe("file:/secrets/or");
    expect(map.DEFAULT_MATRIX_DOMAIN).toBe("matrix.example.com");
    expect(map.DEFAULT_MATRIX_PUBLIC_BASE_URL).toBe("https://matrix.example.com");
    expect(map.DEFAULT_FEDERATION_ENABLED).toBe("1");
    expect(map.DEFAULT_CONNECTIVITY_MODE).toBe("direct");
    expect(map.DEFAULT_SELECTED_BOTS).toBe("mail-sentinel,node-operator");
    expect(map.DEFAULT_OPERATOR_USERNAME).toBe("admin");
    expect(map.DEFAULT_ALERT_ROOM_NAME).toBe("Alerts");
    expect(map.DEFAULT_POLL_INTERVAL).toBe("15m");
    expect(map.DEFAULT_LOOKBACK_WINDOW).toBe("2h");
    expect(map.LEGACY_OPENROUTER_MODEL_DETECTED).toBeUndefined();
    expect(map.DEFAULT_IMAP_CONFIGURED).toBeUndefined();
  });

  it("upgrades a legacy openrouter model to the recommended one and flags it", () => {
    const requestPath = writeRequest({
      openrouter: { model: "openrouter/anthropic/claude-sonnet-4-5" },
      matrix: { homeserverDomain: "matrix.example.com", publicBaseUrl: "https://matrix.example.com" },
    });
    const map = toMap(loadExistingDefaults({
      requestPath,
      runtimePath: "/nonexistent",
      env: baseEnv,
    }));
    expect(map.DEFAULT_OPENROUTER_MODEL).toBe("qwen/qwen3.5-9b");
    expect(map.LEGACY_OPENROUTER_MODEL_DETECTED).toBe("1");
  });

  it("upgrades the legacy matrix.local.test+http public base URL to the recommended one", () => {
    const requestPath = writeRequest({
      matrix: { homeserverDomain: "matrix.local.test", publicBaseUrl: "http://matrix.local.test:8008" },
    });
    const env = {
      ...baseEnv,
      SN_RECOMMENDED_MATRIX_PUBLIC_BASE_URL: "https://matrix.example.com",
    };
    const map = toMap(loadExistingDefaults({
      requestPath,
      runtimePath: "/nonexistent",
      env,
    }));
    expect(map.DEFAULT_MATRIX_DOMAIN).toBe("matrix.local.test");
    expect(map.DEFAULT_MATRIX_PUBLIC_BASE_URL).toBe("https://matrix.example.com");
  });

  it("falls back to SN_DEFAULT_SELECTED_BOTS when the request has no bots", () => {
    const requestPath = writeRequest({});
    const map = toMap(loadExistingDefaults({
      requestPath,
      runtimePath: "/nonexistent",
      env: { ...baseEnv, SN_DEFAULT_SELECTED_BOTS: "node-operator" },
    }));
    expect(map.DEFAULT_SELECTED_BOTS).toBe("node-operator");
  });

  it("emits the imap block when imap is present and not pending", () => {
    const requestPath = writeRequest({
      imap: {
        host: "imap.example.com",
        port: 993,
        tls: true,
        username: "u@example.com",
        secretRef: "file:/imap-pwd",
        mailbox: "INBOX",
      },
    });
    const map = toMap(loadExistingDefaults({
      requestPath,
      runtimePath: "/nonexistent",
      env: baseEnv,
    }));
    expect(map.DEFAULT_IMAP_CONFIGURED).toBe("1");
    expect(map.DEFAULT_IMAP_HOST).toBe("imap.example.com");
    expect(map.DEFAULT_IMAP_PORT).toBe("993");
    expect(map.DEFAULT_IMAP_TLS).toBe("1");
    expect(map.DEFAULT_IMAP_USERNAME).toBe("u@example.com");
    expect(map.DEFAULT_IMAP_MAILBOX).toBe("INBOX");
    expect(map.EXISTING_IMAP_SECRET_REF).toBe("file:/imap-pwd");
  });

  it("skips the imap block when status=pending (placeholder created at install)", () => {
    const requestPath = writeRequest({
      imap: { host: "imap.example.com", status: "pending" },
    });
    const map = toMap(loadExistingDefaults({
      requestPath,
      runtimePath: "/nonexistent",
      env: baseEnv,
    }));
    expect(map.DEFAULT_IMAP_CONFIGURED).toBeUndefined();
  });

  it("emits DEFAULT_IMAP_TLS=0 when imap.tls is explicitly false", () => {
    const requestPath = writeRequest({
      imap: { host: "imap.example.com", tls: false },
    });
    const map = toMap(loadExistingDefaults({
      requestPath,
      runtimePath: "/nonexistent",
      env: baseEnv,
    }));
    expect(map.DEFAULT_IMAP_TLS).toBe("0");
  });

  it("flips DEFAULT_CONNECTIVITY_MODE to relay when the request has a relay block", () => {
    const requestPath = writeRequest({
      relay: { controlUrl: "https://relay.sovereign-ai-node.com", enrollmentToken: "token" },
    });
    const map = toMap(loadExistingDefaults({
      requestPath,
      runtimePath: "/nonexistent",
      env: baseEnv,
    }));
    expect(map.DEFAULT_CONNECTIVITY_MODE).toBe("relay");
    expect(map.DEFAULT_RELAY_CONTROL_URL).toBe("https://relay.sovereign-ai-node.com");
    expect(map.EXISTING_RELAY_ENROLLMENT_TOKEN).toBe("token");
  });

  it("prefers runtime-reported relay hostname/publicBaseUrl over the request file", () => {
    const requestPath = writeRequest({
      matrix: { homeserverDomain: "stale.example.com", publicBaseUrl: "https://stale.example.com" },
      relay: { controlUrl: "https://relay.sovereign-ai-node.com", requestedSlug: "old-slug" },
    });
    const runtimePath = writeRuntime({
      relay: {
        enabled: true,
        hostname: "active.relay.example.com",
        publicBaseUrl: "https://active.relay.example.com",
      },
    });
    const map = toMap(loadExistingDefaults({ requestPath, runtimePath, env: baseEnv }));
    expect(map.DEFAULT_MATRIX_DOMAIN).toBe("active.relay.example.com");
    expect(map.DEFAULT_MATRIX_PUBLIC_BASE_URL).toBe("https://active.relay.example.com");
    expect(map.DEFAULT_RELAY_REQUESTED_SLUG).toBe("old-slug");
  });

  it("derives DEFAULT_RELAY_REQUESTED_SLUG from the runtime hostname when not in the request", () => {
    const requestPath = writeRequest({
      relay: { controlUrl: "https://relay.sovereign-ai-node.com" },
    });
    const runtimePath = writeRuntime({
      relay: { enabled: true, hostname: "node1.relay.example.com" },
    });
    const map = toMap(loadExistingDefaults({ requestPath, runtimePath, env: baseEnv }));
    expect(map.DEFAULT_RELAY_REQUESTED_SLUG).toBe("node1");
  });

  it("treats unparseable runtime config as an empty object", () => {
    const requestPath = writeRequest({
      matrix: { homeserverDomain: "matrix.example.com", publicBaseUrl: "https://matrix.example.com" },
    });
    const runtimePath = join(workDir, "broken.json5");
    writeFileSync(runtimePath, "{ this is not json");
    const map = toMap(loadExistingDefaults({ requestPath, runtimePath, env: baseEnv }));
    expect(map.DEFAULT_MATRIX_DOMAIN).toBe("matrix.example.com");
  });

  it("sanitises tab/newline characters from emitted values", () => {
    const requestPath = writeRequest({
      matrix: { alertRoomName: "Alerts\twith\ttabs\nand newlines" },
    });
    const map = toMap(loadExistingDefaults({ requestPath, runtimePath: "/nonexistent", env: baseEnv }));
    expect(map.DEFAULT_ALERT_ROOM_NAME).toBe("Alerts with tabs and newlines");
  });

  it("falls back to openrouter.apiKeySecretRef when secretRef is absent", () => {
    const requestPath = writeRequest({
      openrouter: { apiKeySecretRef: "file:/legacy/path" },
    });
    const map = toMap(loadExistingDefaults({ requestPath, runtimePath: "/nonexistent", env: baseEnv }));
    expect(map.EXISTING_OPENROUTER_SECRET_REF).toBe("file:/legacy/path");
  });
});

describe("formatTsv", () => {
  it("joins pairs with tab separators and newlines, no trailing newline", () => {
    expect(formatTsv([["A", "1"], ["B", "two"]])).toBe("A\t1\nB\ttwo");
  });

  it("returns an empty string for an empty pair list", () => {
    expect(formatTsv([])).toBe("");
  });
});
