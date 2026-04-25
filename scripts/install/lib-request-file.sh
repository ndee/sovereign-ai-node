# shellcheck shell=bash
# lib-request-file: install-request JSON IO, secret writing, defaults
# loading/migration, request review printer.
#
# Depends on lib-log (log, die), lib-ui (ui_*), lib-prompt (ui_confirm),
# lib-bot-catalog (bot_list_contains, default_selected_bots_from_catalog,
# describe_selected_bots), lib-matrix-urls (refresh_recommended_matrix_defaults).
# Reads and mutates the entire DEFAULT_*, EXISTING_*, SN_* env-var family plus
# REQUEST_FILE, SERVICE_USER, SERVICE_GROUP.

reset_request_defaults() {
  EXISTING_REQUEST_VALID="0"
  LAST_REQUEST_LOAD_ERROR=""
  refresh_recommended_matrix_defaults
  DEFAULT_OPENROUTER_MODEL="$RECOMMENDED_OPENROUTER_MODEL"
  DEFAULT_MATRIX_DOMAIN="$RECOMMENDED_MATRIX_DOMAIN"
  DEFAULT_MATRIX_PUBLIC_BASE_URL="$RECOMMENDED_MATRIX_PUBLIC_BASE_URL"
  DEFAULT_OPERATOR_USERNAME="admin"
  DEFAULT_ALERT_ROOM_NAME="Alerts"
  DEFAULT_SELECTED_BOTS="$(default_selected_bots_from_catalog)"
  DEFAULT_POLL_INTERVAL="30m"
  DEFAULT_LOOKBACK_WINDOW="1h"
  DEFAULT_FEDERATION_ENABLED="0"
  DEFAULT_RELAY_REQUESTED_SLUG=""
  DEFAULT_RELAY_HOSTNAME=""
  DEFAULT_IMAP_CONFIGURED="0"
  DEFAULT_IMAP_HOST="imap.example.org"
  DEFAULT_IMAP_PORT="993"
  DEFAULT_IMAP_TLS="1"
  DEFAULT_IMAP_USERNAME="operator@example.org"
  DEFAULT_IMAP_MAILBOX="INBOX"
  EXISTING_OPENROUTER_SECRET_REF=""
  EXISTING_IMAP_SECRET_REF=""
  LEGACY_OPENROUTER_MODEL_DETECTED="0"
}

migrate_legacy_openrouter_model_request() {
  local status
  [[ -r "$REQUEST_FILE" ]] || return 0

  if ! status="$(
    node - "$REQUEST_FILE" "$LEGACY_OPENROUTER_MODEL" "$RECOMMENDED_OPENROUTER_MODEL" <<'NODE'
const fs = require("node:fs");
const requestPath = process.argv[2];
const legacyModel = process.argv[3];
const nextModel = process.argv[4];

const raw = fs.readFileSync(requestPath, "utf8");
const parsed = JSON.parse(raw);
if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
  process.stdout.write("0");
  process.exit(0);
}

const openrouter = parsed.openrouter;
if (!openrouter || typeof openrouter !== "object" || Array.isArray(openrouter)) {
  process.stdout.write("0");
  process.exit(0);
}

if (openrouter.model !== legacyModel) {
  process.stdout.write("0");
  process.exit(0);
}

openrouter.model = nextModel;
fs.writeFileSync(requestPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
process.stdout.write("1");
NODE
  )"; then
    return 1
  fi

  if [[ "$status" == "1" ]]; then
    chmod 0640 "$REQUEST_FILE" || true
    chown "${SERVICE_USER}:${SERVICE_GROUP}" "$REQUEST_FILE" || true
    log "Migrated legacy OpenRouter model in request file to ${RECOMMENDED_OPENROUTER_MODEL}"
  fi

  return 0
}

load_existing_defaults() {
  local output
  reset_request_defaults

  if [[ ! -r "$REQUEST_FILE" ]]; then
    return 0
  fi

  if ! output="$(
    SN_DEFAULT_SELECTED_BOTS="$DEFAULT_SELECTED_BOTS" \
    SN_RECOMMENDED_MATRIX_DOMAIN="$RECOMMENDED_MATRIX_DOMAIN" \
    SN_RECOMMENDED_MATRIX_PUBLIC_BASE_URL="$RECOMMENDED_MATRIX_PUBLIC_BASE_URL" \
    node - "$REQUEST_FILE" "$RUNTIME_CONFIG_FILE" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const runtimePath = process.argv[3];
const raw = fs.readFileSync(path, "utf8");
const req = JSON.parse(raw);
const lines = [];
const clean = (value) => String(value).replace(/\t/g, " ").replace(/\r?\n/g, " ").trim();
const emit = (key, value) => {
  if (value === undefined || value === null || value === "") {
    return;
  }
  lines.push(`${key}\t${clean(value)}`);
};

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
const botConfig = bots && typeof bots === "object" && !Array.isArray(bots)
  && bots.config && typeof bots.config === "object" && !Array.isArray(bots.config)
  ? bots.config
  : {};
const mailSentinel =
  botConfig["mail-sentinel"] && typeof botConfig["mail-sentinel"] === "object"
  && !Array.isArray(botConfig["mail-sentinel"])
    ? botConfig["mail-sentinel"]
    : {};
const imap = req.imap ?? {};
let runtime = {};
try {
  const runtimeRaw = fs.readFileSync(runtimePath, "utf8");
  runtime = JSON.parse(runtimeRaw);
} catch {
  runtime = {};
}
const runtimeMatrix = runtime && typeof runtime === "object" && !Array.isArray(runtime)
  ? runtime.matrix ?? {}
  : {};
const runtimeRelay = runtime && typeof runtime === "object" && !Array.isArray(runtime)
  ? runtime.relay ?? {}
  : {};

const recommendedOpenrouterModel = "qwen/qwen3.5-9b";
const legacyOpenrouterModel = "openrouter/anthropic/claude-sonnet-4-5";
const recommendedMatrixDomain = process.env.SN_RECOMMENDED_MATRIX_DOMAIN || "";
const recommendedMatrixPublicBaseUrl = process.env.SN_RECOMMENDED_MATRIX_PUBLIC_BASE_URL || "";
const legacyMatrixDomain = "matrix.local.test";
const legacyMatrixPublicBaseUrls = new Set([
  "http://127.0.0.1:8008",
  "http://matrix.local.test:8008",
]);
const runtimeMatrixDomain =
  runtimeMatrix && typeof runtimeMatrix === "object" && !Array.isArray(runtimeMatrix)
  && typeof runtimeMatrix.homeserverDomain === "string"
  ? runtimeMatrix.homeserverDomain
  : "";
const runtimeMatrixPublicBaseUrl =
  runtimeMatrix && typeof runtimeMatrix === "object" && !Array.isArray(runtimeMatrix)
  && typeof runtimeMatrix.publicBaseUrl === "string"
  ? runtimeMatrix.publicBaseUrl
  : "";
const runtimeRelayEnabled =
  runtimeRelay && typeof runtimeRelay === "object" && !Array.isArray(runtimeRelay)
  && runtimeRelay.enabled === true;
const runtimeRelayControlUrl =
  runtimeRelayEnabled && typeof runtimeRelay.controlUrl === "string"
    ? runtimeRelay.controlUrl
    : "";
const runtimeRelayHostname =
  runtimeRelayEnabled && typeof runtimeRelay.hostname === "string"
    ? runtimeRelay.hostname
    : "";
const runtimeRelayPublicBaseUrl =
  runtimeRelayEnabled && typeof runtimeRelay.publicBaseUrl === "string"
    ? runtimeRelay.publicBaseUrl
    : "";
const effectiveMatrixDomain = runtimeMatrixDomain || matrix.homeserverDomain || "";
const effectiveMatrixPublicBaseUrl = runtimeMatrixPublicBaseUrl || matrix.publicBaseUrl || "";
if (openrouter.model === legacyOpenrouterModel) {
  emit("DEFAULT_OPENROUTER_MODEL", recommendedOpenrouterModel);
  emit("LEGACY_OPENROUTER_MODEL_DETECTED", "1");
} else {
  emit("DEFAULT_OPENROUTER_MODEL", openrouter.model);
}
emit("EXISTING_OPENROUTER_SECRET_REF", openrouter.secretRef ?? openrouter.apiKeySecretRef ?? "");
if (
  effectiveMatrixDomain === legacyMatrixDomain
  && effectiveMatrixPublicBaseUrl.startsWith("http://")
  && recommendedMatrixPublicBaseUrl.length > 0
) {
  emit("DEFAULT_MATRIX_DOMAIN", legacyMatrixDomain);
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
  relay && typeof relay === "object" && !Array.isArray(relay) && typeof relay.requestedSlug === "string"
    ? relay.requestedSlug
    : "";
const deriveSlugFromHostname = (value) => {
  const normalized = String(value || "").trim().toLowerCase().replace(/\.+$/g, "");
  return normalized.length === 0 ? "" : normalized.split(".")[0] || "";
};
emit("DEFAULT_RELAY_REQUESTED_SLUG", requestedRelaySlug || deriveSlugFromHostname(runtimeRelayHostname));
emit("DEFAULT_RELAY_HOSTNAME", runtimeRelayHostname);
emit("EXISTING_RELAY_ENROLLMENT_TOKEN", relay.enrollmentToken || "");
emit(
  "DEFAULT_SELECTED_BOTS",
  selectedBots.length > 0 ? selectedBots.join(",") : (process.env.SN_DEFAULT_SELECTED_BOTS || ""),
);
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

if (imap && typeof imap === "object" && Object.keys(imap).length > 0 && imap.status !== "pending") {
  emit("DEFAULT_IMAP_CONFIGURED", "1");
  emit("DEFAULT_IMAP_HOST", imap.host);
  emit("DEFAULT_IMAP_PORT", imap.port);
  emit("DEFAULT_IMAP_TLS", imap.tls === false ? "0" : "1");
  emit("DEFAULT_IMAP_USERNAME", imap.username);
  emit("DEFAULT_IMAP_MAILBOX", imap.mailbox);
  emit("EXISTING_IMAP_SECRET_REF", imap.secretRef);
}

process.stdout.write(lines.join("\n"));
NODE
  )"; then
    LAST_REQUEST_LOAD_ERROR="Failed to parse existing request file: ${REQUEST_FILE}"
    return 1
  fi

  while IFS=$'\t' read -r key value; do
    [[ -n "$key" ]] || continue
    case "$key" in
      DEFAULT_OPENROUTER_MODEL)
        DEFAULT_OPENROUTER_MODEL="$value"
        ;;
      LEGACY_OPENROUTER_MODEL_DETECTED)
        LEGACY_OPENROUTER_MODEL_DETECTED="$value"
        ;;
      EXISTING_OPENROUTER_SECRET_REF)
        EXISTING_OPENROUTER_SECRET_REF="$value"
        ;;
      DEFAULT_MATRIX_DOMAIN)
        DEFAULT_MATRIX_DOMAIN="$value"
        ;;
      DEFAULT_MATRIX_PUBLIC_BASE_URL)
        DEFAULT_MATRIX_PUBLIC_BASE_URL="$value"
        ;;
      DEFAULT_FEDERATION_ENABLED)
        DEFAULT_FEDERATION_ENABLED="$value"
        ;;
      DEFAULT_CONNECTIVITY_MODE)
        DEFAULT_CONNECTIVITY_MODE="$value"
        ;;
      DEFAULT_RELAY_CONTROL_URL)
        DEFAULT_RELAY_CONTROL_URL="$value"
        ;;
      DEFAULT_RELAY_REQUESTED_SLUG)
        DEFAULT_RELAY_REQUESTED_SLUG="$value"
        ;;
      DEFAULT_RELAY_HOSTNAME)
        DEFAULT_RELAY_HOSTNAME="$value"
        ;;
      EXISTING_RELAY_ENROLLMENT_TOKEN)
        EXISTING_RELAY_ENROLLMENT_TOKEN="$value"
        ;;
      DEFAULT_ALERT_ROOM_NAME)
        DEFAULT_ALERT_ROOM_NAME="$value"
        ;;
      DEFAULT_SELECTED_BOTS)
        DEFAULT_SELECTED_BOTS="$value"
        ;;
      DEFAULT_OPERATOR_USERNAME)
        DEFAULT_OPERATOR_USERNAME="$value"
        ;;
      DEFAULT_POLL_INTERVAL)
        DEFAULT_POLL_INTERVAL="$value"
        ;;
      DEFAULT_LOOKBACK_WINDOW)
        DEFAULT_LOOKBACK_WINDOW="$value"
        ;;
      DEFAULT_IMAP_CONFIGURED)
        DEFAULT_IMAP_CONFIGURED="$value"
        ;;
      DEFAULT_IMAP_HOST)
        DEFAULT_IMAP_HOST="$value"
        ;;
      DEFAULT_IMAP_PORT)
        DEFAULT_IMAP_PORT="$value"
        ;;
      DEFAULT_IMAP_TLS)
        DEFAULT_IMAP_TLS="$value"
        ;;
      DEFAULT_IMAP_USERNAME)
        DEFAULT_IMAP_USERNAME="$value"
        ;;
      DEFAULT_IMAP_MAILBOX)
        DEFAULT_IMAP_MAILBOX="$value"
        ;;
      EXISTING_IMAP_SECRET_REF)
        EXISTING_IMAP_SECRET_REF="$value"
        ;;
    esac
  done <<< "$output"

  EXISTING_REQUEST_VALID="1"
  return 0
}

secret_ref_path_exists() {
  local secret_ref
  secret_ref="$1"
  if [[ -z "$secret_ref" ]]; then
    return 1
  fi
  if [[ "$secret_ref" != file:* ]]; then
    return 0
  fi
  [[ -f "${secret_ref#file:}" ]]
}

warn_if_missing_secret_ref() {
  local label secret_ref
  label="$1"
  secret_ref="$2"
  if [[ "$secret_ref" == file:* ]] && [[ ! -f "${secret_ref#file:}" ]]; then
    ui_warn "${label} secret file is missing: ${secret_ref#file:}"
    return 1
  fi
  return 0
}

detect_primary_ipv4() {
  local detected

  detected=""
  if command -v ip >/dev/null 2>&1; then
    detected="$(
      ip -4 route get 1.1.1.1 2>/dev/null \
        | awk '{for (i = 1; i <= NF; i += 1) if ($i == "src") { print $(i + 1); exit }}'
    )"
  fi

  if [[ -z "$detected" ]]; then
    detected="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi

  if [[ -z "$detected" ]] || [[ "$detected" == "127."* ]] || [[ "$detected" == "0.0.0.0" ]]; then
    return 1
  fi

  printf '%s' "$detected"
}


write_secret_file() {
  local path value
  path="$1"
  value="$2"
  install -d -m 0700 "$(dirname "$path")"
  printf '%s\n' "$value" > "$path"
  chmod 0600 "$path"
  chown "${SERVICE_USER}:${SERVICE_GROUP}" "$path" || true
}

write_request_file_from_env() {
  node <<'NODE'
const fs = require("node:fs");
const matrixPublicBaseUrl = process.env.SN_MATRIX_PUBLIC_BASE_URL || "";
const connectivityMode = process.env.SN_CONNECTIVITY_MODE || "direct";
const inferMatrixTlsMode = (value) => {
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
};

const matrixTlsMode = process.env.SN_MATRIX_TLS_MODE || inferMatrixTlsMode(matrixPublicBaseUrl);
const selectedBots = (process.env.SN_SELECTED_BOTS || "")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);
const req = {
  mode: "bundled_matrix",
  connectivity: {
    mode: connectivityMode,
  },
  openclaw: {
    manageInstallation: true,
    installMethod: "install_sh",
    version: "2026.3.13",
    skipIfCompatibleInstalled: true,
    forceReinstall: false,
    runOnboard: false,
  },
  openrouter: {
    model: process.env.SN_OPENROUTER_MODEL,
    secretRef: process.env.SN_OPENROUTER_SECRET_REF,
  },
  matrix: {
    homeserverDomain: process.env.SN_MATRIX_DOMAIN,
    publicBaseUrl: matrixPublicBaseUrl,
    federationEnabled: process.env.SN_MATRIX_FEDERATION_ENABLED === "1",
    tlsMode: matrixTlsMode,
    alertRoomName: process.env.SN_ALERT_ROOM_NAME,
  },
  operator: {
    username: process.env.SN_OPERATOR_USERNAME,
  },
  advanced: {
    nonInteractive: true,
  },
};

if (selectedBots.length > 0) {
  req.bots = {
    selected: selectedBots,
  };
  if (selectedBots.includes("mail-sentinel")) {
    req.bots.config = {
      "mail-sentinel": {
        pollInterval: process.env.SN_POLL_INTERVAL,
        lookbackWindow: process.env.SN_LOOKBACK_WINDOW,
        e2eeAlertRoom: false,
      },
    };
  }
}

if (connectivityMode === "relay") {
  // Read pre-enrolled relay fields from existing request file (seeded by Pro installer).
  let existingRelay = {};
  try {
    const existing = JSON.parse(fs.readFileSync(process.env.SN_REQUEST_FILE, "utf8"));
    if (existing && typeof existing.relay === "object" && existing.relay !== null) {
      existingRelay = existing.relay;
    }
  } catch {}
  req.relay = {
    ...existingRelay,
    controlUrl: process.env.SN_RELAY_CONTROL_URL || existingRelay.controlUrl,
  };
  if ((process.env.SN_RELAY_ENROLLMENT_TOKEN || "").trim().length > 0) {
    req.relay.enrollmentToken = process.env.SN_RELAY_ENROLLMENT_TOKEN;
  }
  if ((process.env.SN_RELAY_REQUESTED_SLUG || "").trim().length > 0) {
    req.relay.requestedSlug = process.env.SN_RELAY_REQUESTED_SLUG;
  }
}

if (process.env.SN_IMAP_CONFIGURE === "1") {
  req.imap = {
    host: process.env.SN_IMAP_HOST,
    port: Number(process.env.SN_IMAP_PORT || "993"),
    tls: process.env.SN_IMAP_TLS === "1",
    username: process.env.SN_IMAP_USERNAME,
    secretRef: process.env.SN_IMAP_SECRET_REF,
    mailbox: process.env.SN_IMAP_MAILBOX || "INBOX",
  };
}

fs.mkdirSync(require("node:path").dirname(process.env.SN_REQUEST_FILE), { recursive: true });
fs.writeFileSync(process.env.SN_REQUEST_FILE, `${JSON.stringify(req, null, 2)}\n`, "utf8");
NODE

  chmod 0640 "$REQUEST_FILE"
  chown "${SERVICE_USER}:${SERVICE_GROUP}" "$REQUEST_FILE" || true
  log "Wrote install request: $REQUEST_FILE"
}

review_install_request() {
  local onboarding_url ca_download_url element_web_link

  onboarding_url="$(build_matrix_onboarding_url "${SN_MATRIX_PUBLIC_BASE_URL}")"
  ca_download_url="$(build_matrix_ca_download_url "${SN_MATRIX_PUBLIC_BASE_URL}")"
  element_web_link="$(build_element_web_link "${SN_MATRIX_PUBLIC_BASE_URL}" "${SN_OPERATOR_USERNAME}" "${SN_MATRIX_DOMAIN}")"

  ui_section "Review"
  ui_info "OpenRouter model: ${SN_OPENROUTER_MODEL}"
  ui_info "OpenRouter secret: ${SN_OPENROUTER_SECRET_MODE}"
  if [[ "${SN_CONNECTIVITY_MODE}" == "relay" ]]; then
    ui_info "Connection mode: relay"
    ui_info "Relay control URL: ${SN_RELAY_CONTROL_URL}"
    if [[ "${SN_RELAY_CONTROL_URL%/}" == "$DEFAULT_MANAGED_RELAY_CONTROL_URL" ]]; then
      ui_info "Relay enrollment: automatic via the Sovereign managed relay"
    else
      ui_info "Relay enrollment: token-based (custom relay)"
    fi
    if [[ -n "${SN_RELAY_REQUESTED_SLUG:-}" ]]; then
      ui_info "Requested node name: ${SN_RELAY_REQUESTED_SLUG}"
      if [[ -n "${SN_RELAY_REQUESTED_HOSTNAME:-}" ]]; then
        ui_info "Requested node hostname: ${SN_RELAY_REQUESTED_HOSTNAME}"
      fi
    elif [[ -n "${SN_RELAY_REQUESTED_HOSTNAME:-}" ]]; then
      ui_info "Node hostname: ${SN_RELAY_REQUESTED_HOSTNAME} (existing assignment)"
    else
      ui_info "Node name: auto-generated by relay"
    fi
    ui_info "Matrix hostname and public URL will be assigned by the relay during install."
  else
    ui_info "Connection mode: direct"
  fi
  ui_info "Matrix homeserver domain: ${SN_MATRIX_DOMAIN}"
  ui_info "Matrix public base URL: ${SN_MATRIX_PUBLIC_BASE_URL}"
  if [[ "${SN_MATRIX_TLS_MODE}" == "auto" ]]; then
    ui_info "Matrix TLS mode: auto (bundled HTTPS reverse proxy)"
  elif [[ "${SN_MATRIX_TLS_MODE}" == "internal" ]]; then
    ui_info "Matrix TLS mode: internal (LAN HTTPS with Caddy local CA)"
    ui_info "Client CA certificate: ${SN_MATRIX_INTERNAL_CA_PATH}"
    ui_info "Client CA download URL: ${ca_download_url}"
    ui_info "Trust this CA on each client device before using Element Web."
  else
    ui_info "Matrix TLS mode: local-dev"
  fi
  if [[ "${SN_MATRIX_TLS_MODE}" != "local-dev" ]]; then
    ui_info "Phone onboarding URL: ${onboarding_url}"
    ui_info "Element Web login: ${element_web_link}"
  fi
  if [[ "${SN_MATRIX_FEDERATION_ENABLED}" == "1" ]]; then
    ui_info "Matrix federation: enabled"
  else
    ui_info "Matrix federation: disabled"
  fi
  ui_info "Operator username: ${SN_OPERATOR_USERNAME}"
  ui_info "Alert room name: ${SN_ALERT_ROOM_NAME}"
  ui_info "Bots: $(describe_selected_bots "$SN_SELECTED_BOTS")"
  if bot_list_contains "$SN_SELECTED_BOTS" "mail-sentinel"; then
    ui_info "Mail Sentinel poll interval: ${SN_POLL_INTERVAL}"
    ui_info "Mail Sentinel lookback window: ${SN_LOOKBACK_WINDOW}"
    if [[ "${SN_IMAP_CONFIGURE}" == "1" ]]; then
      ui_info "IMAP: configured (${SN_IMAP_SECRET_MODE})"
      ui_info "IMAP host: ${SN_IMAP_HOST}"
      ui_info "IMAP username: ${SN_IMAP_USERNAME}"
      ui_info "IMAP mailbox: ${SN_IMAP_MAILBOX}"
    else
      ui_info "IMAP: pending"
    fi
  else
    ui_info "Mail Sentinel: not selected"
    ui_info "IMAP: not required"
  fi
}

