// write-request-file: synthesise the install request JSON from SN_* env vars.
//
// Invoked from lib-request-file.sh's write_request_file_from_env. All inputs
// arrive as environment variables; the output is written to the path in
// SN_REQUEST_FILE.
//
// Required env:
//   SN_REQUEST_FILE              — output path
//   SN_OPENROUTER_MODEL          — openrouter.model
//   SN_OPENROUTER_SECRET_REF     — openrouter.secretRef
//   SN_MATRIX_DOMAIN             — matrix.homeserverDomain
//   SN_MATRIX_PUBLIC_BASE_URL    — matrix.publicBaseUrl
//   SN_MATRIX_FEDERATION_ENABLED — "1" → matrix.federationEnabled true
//   SN_OPERATOR_USERNAME         — operator.username
//   SN_ALERT_ROOM_NAME           — matrix.alertRoomName
//
// Optional env:
//   SN_CONNECTIVITY_MODE      — "direct" | "relay" (default "direct")
//   SN_MATRIX_TLS_MODE        — overrides the inferred TLS mode
//   SN_SELECTED_BOTS          — comma-separated bot ids
//   SN_POLL_INTERVAL          — mail-sentinel poll interval (when bot selected)
//   SN_LOOKBACK_WINDOW        — mail-sentinel lookback window (when bot selected)
//   SN_RELAY_CONTROL_URL      — when SN_CONNECTIVITY_MODE=relay
//   SN_RELAY_ENROLLMENT_TOKEN — when SN_CONNECTIVITY_MODE=relay (custom relay)
//   SN_RELAY_REQUESTED_SLUG   — when SN_CONNECTIVITY_MODE=relay
//   SN_IMAP_CONFIGURE         — "1" includes the imap block
//   SN_IMAP_HOST              — imap.host
//   SN_IMAP_PORT              — imap.port (numeric, default 993)
//   SN_IMAP_TLS               — "1" → imap.tls true
//   SN_IMAP_USERNAME          — imap.username
//   SN_IMAP_SECRET_REF        — imap.secretRef
//   SN_IMAP_MAILBOX           — imap.mailbox (default "INBOX")
//
// Two entry points:
//   - The pure functions `inferMatrixTlsMode` and `buildRequest(env)` are
//     importable for unit tests without side effects.
//   - `runCli(env)` performs the file IO described above; the wrapper at
//     `bin/write-request-file.mjs` invokes it. Bash callers (and the bundled
//     installer's inlined heredoc) hit `bin/write-request-file.mjs`, not this
//     module directly.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function inferMatrixTlsMode(value) {
  const isLoopback = (host) =>
    host === "localhost"
    || host === "127.0.0.1"
    || host === "::1"
    || host === "[::1]";
  const isIpLiteral = (host) =>
    /^[0-9]{1,3}(?:\.[0-9]{1,3}){3}$/.test(host) || host.includes(":");
  const isLikelyLanOnly = (host) =>
    isLoopback(host)
    || isIpLiteral(host)
    || !host.includes(".")
    || host.endsWith(".local")
    || host.endsWith(".localhost")
    || host.endsWith(".home.arpa")
    || host.endsWith(".internal")
    || host.endsWith(".lan");

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") {
      return "local-dev";
    }
    return isLikelyLanOnly(parsed.hostname.trim().toLowerCase()) ? "internal" : "auto";
  } catch {
    return value.startsWith("https://") ? "auto" : "local-dev";
  }
}

export function buildRequest(env) {
  const matrixPublicBaseUrl = env.SN_MATRIX_PUBLIC_BASE_URL || "";
  const connectivityMode = env.SN_CONNECTIVITY_MODE || "direct";
  const matrixTlsMode = env.SN_MATRIX_TLS_MODE || inferMatrixTlsMode(matrixPublicBaseUrl);
  const selectedBots = (env.SN_SELECTED_BOTS || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const req = {
    mode: "bundled_matrix",
    connectivity: { mode: connectivityMode },
    openclaw: {
      manageInstallation: true,
      installMethod: "install_sh",
      version: "2026.3.13",
      skipIfCompatibleInstalled: true,
      forceReinstall: false,
      runOnboard: false,
    },
    openrouter: {
      model: env.SN_OPENROUTER_MODEL,
      secretRef: env.SN_OPENROUTER_SECRET_REF,
    },
    matrix: {
      homeserverDomain: env.SN_MATRIX_DOMAIN,
      publicBaseUrl: matrixPublicBaseUrl,
      federationEnabled: env.SN_MATRIX_FEDERATION_ENABLED === "1",
      tlsMode: matrixTlsMode,
      alertRoomName: env.SN_ALERT_ROOM_NAME,
    },
    operator: {
      username: env.SN_OPERATOR_USERNAME,
    },
    advanced: {
      nonInteractive: true,
    },
  };

  if (selectedBots.length > 0) {
    req.bots = { selected: selectedBots };
    if (selectedBots.includes("mail-sentinel")) {
      req.bots.config = {
        "mail-sentinel": {
          pollInterval: env.SN_POLL_INTERVAL,
          lookbackWindow: env.SN_LOOKBACK_WINDOW,
          e2eeAlertRoom: false,
        },
      };
    }
  }

  if (connectivityMode === "relay") {
    // Read pre-enrolled relay fields from existing request file (seeded by Pro installer).
    let existingRelay = {};
    try {
      const existing = JSON.parse(readFileSync(env.SN_REQUEST_FILE, "utf8"));
      if (existing && typeof existing.relay === "object" && existing.relay !== null) {
        existingRelay = existing.relay;
      }
    } catch {
      // No existing file, or unreadable — proceed with empty relay block.
    }
    req.relay = {
      ...existingRelay,
      controlUrl: env.SN_RELAY_CONTROL_URL || existingRelay.controlUrl,
    };
    if ((env.SN_RELAY_ENROLLMENT_TOKEN || "").trim().length > 0) {
      req.relay.enrollmentToken = env.SN_RELAY_ENROLLMENT_TOKEN;
    }
    if ((env.SN_RELAY_REQUESTED_SLUG || "").trim().length > 0) {
      req.relay.requestedSlug = env.SN_RELAY_REQUESTED_SLUG;
    }
  }

  if (env.SN_IMAP_CONFIGURE === "1") {
    req.imap = {
      host: env.SN_IMAP_HOST,
      port: Number(env.SN_IMAP_PORT || "993"),
      tls: env.SN_IMAP_TLS === "1",
      username: env.SN_IMAP_USERNAME,
      secretRef: env.SN_IMAP_SECRET_REF,
      mailbox: env.SN_IMAP_MAILBOX || "INBOX",
    };
  }

  return req;
}

export function runCli(env = process.env) {
  const outPath = env.SN_REQUEST_FILE;
  if (!outPath) {
    process.stderr.write("write-request-file: SN_REQUEST_FILE is required\n");
    process.exit(1);
  }
  const req = buildRequest(env);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(req, null, 2)}\n`, "utf8");
}
