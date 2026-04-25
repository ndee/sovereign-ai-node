// load-existing-defaults: read the install request + runtime config, derive
// the DEFAULT_*/EXISTING_*/LEGACY_* values to repopulate the wizard with, and
// emit them as TSV (key\tvalue per line) on stdout.
//
// Invoked from lib-request-file.sh's load_existing_defaults. The caller pipes
// the TSV into a `read key value` loop and assigns each key as a bash global.
// Inputs:
//   argv[2] — path to the existing install-request.json
//   argv[3] — path to the runtime config (sovereign-node.json5); read on a
//             best-effort basis, treated as `{}` when missing or unparseable
//   env.SN_DEFAULT_SELECTED_BOTS         — fallback when no bots are saved
//   env.SN_RECOMMENDED_MATRIX_DOMAIN
//   env.SN_RECOMMENDED_MATRIX_PUBLIC_BASE_URL — both used to detect and
//             upgrade legacy http://127.0.0.1:8008 / matrix.local.test installs

import { readFileSync } from "node:fs";

const RECOMMENDED_OPENROUTER_MODEL = "qwen/qwen3.5-9b";
const LEGACY_OPENROUTER_MODEL = "openrouter/anthropic/claude-sonnet-4-5";
const LEGACY_MATRIX_DOMAIN = "matrix.local.test";
const LEGACY_MATRIX_PUBLIC_BASE_URLS = new Set([
  "http://127.0.0.1:8008",
  "http://matrix.local.test:8008",
]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deriveSlugFromHostname(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/\.+$/g, "");
  return normalized.length === 0 ? "" : normalized.split(".")[0] || "";
}

export function loadExistingDefaults({ requestPath, runtimePath, env }) {
  const req = JSON.parse(readFileSync(requestPath, "utf8"));

  const openrouter = req.openrouter ?? {};
  const connectivity = req.connectivity ?? {};
  const relay = req.relay ?? {};
  const matrix = req.matrix ?? {};
  const operator = req.operator ?? {};
  const bots = req.bots ?? {};
  const selectedBots = Array.isArray(bots.selected)
    ? bots.selected
        .filter((entry) => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : [];
  const botConfig = isPlainObject(bots) && isPlainObject(bots.config) ? bots.config : {};
  const mailSentinel = isPlainObject(botConfig["mail-sentinel"]) ? botConfig["mail-sentinel"] : {};
  const imap = req.imap ?? {};

  let runtime = {};
  try {
    runtime = JSON.parse(readFileSync(runtimePath, "utf8"));
  } catch {
    runtime = {};
  }
  const runtimeMatrix = isPlainObject(runtime) ? runtime.matrix ?? {} : {};
  const runtimeRelay = isPlainObject(runtime) ? runtime.relay ?? {} : {};

  const recommendedMatrixDomain = env.SN_RECOMMENDED_MATRIX_DOMAIN || "";
  const recommendedMatrixPublicBaseUrl = env.SN_RECOMMENDED_MATRIX_PUBLIC_BASE_URL || "";
  const runtimeMatrixDomain =
    isPlainObject(runtimeMatrix) && typeof runtimeMatrix.homeserverDomain === "string"
      ? runtimeMatrix.homeserverDomain
      : "";
  const runtimeMatrixPublicBaseUrl =
    isPlainObject(runtimeMatrix) && typeof runtimeMatrix.publicBaseUrl === "string"
      ? runtimeMatrix.publicBaseUrl
      : "";
  const runtimeRelayEnabled = isPlainObject(runtimeRelay) && runtimeRelay.enabled === true;
  const runtimeRelayControlUrl =
    runtimeRelayEnabled && typeof runtimeRelay.controlUrl === "string" ? runtimeRelay.controlUrl : "";
  const runtimeRelayHostname =
    runtimeRelayEnabled && typeof runtimeRelay.hostname === "string" ? runtimeRelay.hostname : "";
  const runtimeRelayPublicBaseUrl =
    runtimeRelayEnabled && typeof runtimeRelay.publicBaseUrl === "string" ? runtimeRelay.publicBaseUrl : "";
  const effectiveMatrixDomain = runtimeMatrixDomain || matrix.homeserverDomain || "";
  const effectiveMatrixPublicBaseUrl = runtimeMatrixPublicBaseUrl || matrix.publicBaseUrl || "";

  const pairs = [];
  const emit = (key, value) => {
    if (value === undefined || value === null || value === "") {
      return;
    }
    pairs.push([key, String(value).replace(/\t/g, " ").replace(/\r?\n/g, " ").trim()]);
  };

  if (openrouter.model === LEGACY_OPENROUTER_MODEL) {
    emit("DEFAULT_OPENROUTER_MODEL", RECOMMENDED_OPENROUTER_MODEL);
    emit("LEGACY_OPENROUTER_MODEL_DETECTED", "1");
  } else {
    emit("DEFAULT_OPENROUTER_MODEL", openrouter.model);
  }
  emit("EXISTING_OPENROUTER_SECRET_REF", openrouter.secretRef ?? openrouter.apiKeySecretRef ?? "");

  // Upgrade legacy default Matrix bindings to the recommended public base URL
  // so users opening a stale request file get the new defaults rather than
  // resurrecting the old http://127.0.0.1:8008 wiring.
  if (
    effectiveMatrixDomain === LEGACY_MATRIX_DOMAIN
    && effectiveMatrixPublicBaseUrl.startsWith("http://")
    && recommendedMatrixPublicBaseUrl.length > 0
  ) {
    emit("DEFAULT_MATRIX_DOMAIN", LEGACY_MATRIX_DOMAIN);
    emit("DEFAULT_MATRIX_PUBLIC_BASE_URL", recommendedMatrixPublicBaseUrl);
  } else {
    emit("DEFAULT_MATRIX_DOMAIN", effectiveMatrixDomain);
    emit("DEFAULT_MATRIX_PUBLIC_BASE_URL", effectiveMatrixPublicBaseUrl);
  }

  emit("DEFAULT_FEDERATION_ENABLED", matrix.federationEnabled === true ? "1" : "0");

  if (runtimeRelayEnabled || connectivity.mode === "relay" || relay.controlUrl) {
    emit("DEFAULT_CONNECTIVITY_MODE", "relay");
  } else {
    emit("DEFAULT_CONNECTIVITY_MODE", "direct");
  }
  emit("DEFAULT_RELAY_CONTROL_URL", runtimeRelayControlUrl || relay.controlUrl || "");

  const requestedRelaySlug =
    isPlainObject(relay) && typeof relay.requestedSlug === "string" ? relay.requestedSlug : "";
  emit("DEFAULT_RELAY_REQUESTED_SLUG", requestedRelaySlug || deriveSlugFromHostname(runtimeRelayHostname));
  emit("DEFAULT_RELAY_HOSTNAME", runtimeRelayHostname);
  emit("EXISTING_RELAY_ENROLLMENT_TOKEN", relay.enrollmentToken || "");

  emit(
    "DEFAULT_SELECTED_BOTS",
    selectedBots.length > 0 ? selectedBots.join(",") : (env.SN_DEFAULT_SELECTED_BOTS || ""),
  );

  // Relay-mode: prefer the runtime-reported hostname/publicBaseUrl over the
  // ones derived from the request file, since the runtime knows what the
  // relay actually assigned.
  if (runtimeRelayHostname) {
    emit("DEFAULT_MATRIX_DOMAIN", runtimeRelayHostname);
  }
  if (runtimeRelayPublicBaseUrl) {
    emit("DEFAULT_MATRIX_PUBLIC_BASE_URL", runtimeRelayPublicBaseUrl);
  }

  emit("DEFAULT_ALERT_ROOM_NAME", matrix.alertRoomName);
  emit("DEFAULT_OPERATOR_USERNAME", operator.username);
  emit("DEFAULT_POLL_INTERVAL", mailSentinel.pollInterval);
  emit("DEFAULT_LOOKBACK_WINDOW", mailSentinel.lookbackWindow);

  if (isPlainObject(imap) && Object.keys(imap).length > 0 && imap.status !== "pending") {
    emit("DEFAULT_IMAP_CONFIGURED", "1");
    emit("DEFAULT_IMAP_HOST", imap.host);
    emit("DEFAULT_IMAP_PORT", imap.port);
    emit("DEFAULT_IMAP_TLS", imap.tls === false ? "0" : "1");
    emit("DEFAULT_IMAP_USERNAME", imap.username);
    emit("DEFAULT_IMAP_MAILBOX", imap.mailbox);
    emit("EXISTING_IMAP_SECRET_REF", imap.secretRef);
  }

  return pairs;
}

export function formatTsv(pairs) {
  return pairs.map(([key, value]) => `${key}\t${value}`).join("\n");
}

export function runCli(argv = process.argv, env = process.env) {
  const requestPath = argv[2];
  const runtimePath = argv[3];
  if (!requestPath || !runtimePath) {
    process.stderr.write("load-existing-defaults: requestPath and runtimePath are required\n");
    process.exit(1);
  }
  const pairs = loadExistingDefaults({ requestPath, runtimePath, env });
  process.stdout.write(formatTsv(pairs));
}

// LEGACY_MATRIX_PUBLIC_BASE_URLS is unused by the live code path (preserved
// here for parity with the original inline JS heredoc). Exporting it via
// `_legacy` keeps it referenced and gives tests a single place to inspect
// the constants.
export const _legacy = {
  RECOMMENDED_OPENROUTER_MODEL,
  LEGACY_OPENROUTER_MODEL,
  LEGACY_MATRIX_DOMAIN,
  LEGACY_MATRIX_PUBLIC_BASE_URLS,
};
