#!/usr/bin/env bash
set -euo pipefail

SCRIPT_NAME="$(basename "$0")"

REPO_URL="${SOVEREIGN_NODE_REPO_URL:-https://github.com/ndee/sovereign-ai-node}"
SOURCE_DIR="${SOVEREIGN_NODE_SOURCE_DIR:-}"
REF="${SOVEREIGN_NODE_REF:-main}"
BOTS_REPO_URL="${SOVEREIGN_BOTS_REPO_URL:-https://github.com/ndee/sovereign-ai-bots}"
BOTS_SOURCE_DIR="${SOVEREIGN_BOTS_SOURCE_DIR:-}"
BOTS_REF="${SOVEREIGN_BOTS_REF:-main}"
INSTALL_ROOT="${SOVEREIGN_NODE_INSTALL_ROOT:-/opt/sovereign-ai-node}"
APP_DIR="${INSTALL_ROOT}/app"
BOTS_DIR="${INSTALL_ROOT}/sovereign-ai-bots"
SERVICE_NAME="${SOVEREIGN_NODE_SERVICE_NAME:-sovereign-node-api}"
SERVICE_USER="${SOVEREIGN_NODE_SERVICE_USER:-sovereign-node}"
SERVICE_GROUP="${SOVEREIGN_NODE_SERVICE_GROUP:-}"
ENV_FILE="${SOVEREIGN_NODE_ENV_FILE:-/etc/default/sovereign-node-api}"
API_HOST="${SOVEREIGN_NODE_API_HOST:-127.0.0.1}"
API_PORT="${SOVEREIGN_NODE_API_PORT:-8787}"
REQUEST_FILE="${SOVEREIGN_NODE_REQUEST_FILE:-/etc/sovereign-node/install-request.json}"
PROVENANCE_FILE="/etc/sovereign-node/install-provenance.json"
RUNTIME_CONFIG_FILE="${SOVEREIGN_NODE_CONFIG_FILE:-/etc/sovereign-node/sovereign-node.json5}"
RUN_INSTALL="${SOVEREIGN_NODE_RUN_INSTALL:-1}"
NON_INTERACTIVE="${SOVEREIGN_NODE_NON_INTERACTIVE:-0}"
ACTION="${SOVEREIGN_NODE_ACTION:-}"
INSTALLATION_DETECTED="0"
CONFIGURED_INSTALLATION="0"
EXISTING_REQUEST_VALID="0"
LAST_REQUEST_LOAD_ERROR=""
RECOMMENDED_OPENROUTER_MODEL="qwen/qwen3.5-9b"
LEGACY_OPENROUTER_MODEL="openrouter/anthropic/claude-sonnet-4-5"
DEFAULT_OPENROUTER_MODEL="$RECOMMENDED_OPENROUTER_MODEL"
RECOMMENDED_MATRIX_DOMAIN="matrix.local.test"
RECOMMENDED_MATRIX_PUBLIC_BASE_URL="http://127.0.0.1:8008"
DEFAULT_MATRIX_DOMAIN="matrix.local.test"
DEFAULT_MATRIX_PUBLIC_BASE_URL="http://127.0.0.1:8008"
LEGACY_MATRIX_DOMAIN="matrix.local.test"
LEGACY_MATRIX_PUBLIC_BASE_URL="http://127.0.0.1:8008"
LEGACY_MATRIX_ALT_PUBLIC_BASE_URL="http://matrix.local.test:8008"
DEFAULT_OPERATOR_USERNAME="admin"
DEFAULT_ALERT_ROOM_NAME="Alerts"
DEFAULT_SELECTED_BOTS="mail-sentinel"
DEFAULT_POLL_INTERVAL="30m"
DEFAULT_LOOKBACK_WINDOW="1h"
DEFAULT_FEDERATION_ENABLED="0"
DEFAULT_MANAGED_RELAY_CONTROL_URL="https://relay.sovereign-ai-node.com"
DEFAULT_CONNECTIVITY_MODE="direct"
DEFAULT_RELAY_CONTROL_URL="${SOVEREIGN_NODE_RELAY_CONTROL_URL:-$DEFAULT_MANAGED_RELAY_CONTROL_URL}"
DEFAULT_RELAY_REQUESTED_SLUG=""
DEFAULT_RELAY_HOSTNAME=""
DEFAULT_IMAP_CONFIGURED="0"
DEFAULT_IMAP_HOST="imap.example.org"
DEFAULT_IMAP_PORT="993"
DEFAULT_IMAP_TLS="1"
DEFAULT_IMAP_USERNAME="operator@example.org"
DEFAULT_IMAP_MAILBOX="INBOX"
EXISTING_OPENROUTER_SECRET_REF=""
EXISTING_RELAY_ENROLLMENT_TOKEN=""
EXISTING_IMAP_SECRET_REF=""
LEGACY_OPENROUTER_MODEL_DETECTED="0"
AVAILABLE_BOT_IDS=()
AVAILABLE_BOT_DISPLAY_NAMES=()
AVAILABLE_BOT_DEFAULT_INSTALLS=()
UI_TOTAL_STEPS=0
UI_CURRENT_STEP=0
UI_ACTIVE_STEP_LABEL=""
UI_ACTIVE_STEP_STARTED_AT=0
UI_STEP_LOG_DIR=""
UI_PRESERVE_STEP_LOGS="0"
UI_BAR_WIDTH=28
UI_TERMINAL_WIDTH=80
UI_FANCY="0"
UI_PROGRESS_LINE_OPEN="0"
INSTALL_COMMAND_OUTPUT=""
RUNTIME_STATUS_OUTPUT=""
DOCTOR_REPORT_OUTPUT=""
declare -a UI_SPINNER_FRAMES=("[    ]" "[=   ]" "[==  ]" "[=== ]" "[ ===]" "[  ==]" "[   =]")

INSTALL_LIB_DIR="${INSTALL_LIB_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/install" 2>/dev/null && pwd)}"
if [[ -z "${INSTALL_LIB_DIR}" || ! -d "${INSTALL_LIB_DIR}" ]]; then
  printf '[%s] ERROR: cannot locate install library directory (tried: %s)\n' \
    "${SCRIPT_NAME}" "${INSTALL_LIB_DIR:-<unset>}" >&2
  exit 1
fi

# shellcheck source=install/lib-log.sh
source "${INSTALL_LIB_DIR}/lib-log.sh"

# shellcheck source=install/lib-args.sh
source "${INSTALL_LIB_DIR}/lib-args.sh"

# shellcheck source=install/lib-os.sh
source "${INSTALL_LIB_DIR}/lib-os.sh"

# shellcheck source=install/lib-runtime-deps.sh
source "${INSTALL_LIB_DIR}/lib-runtime-deps.sh"

# shellcheck source=install/lib-runtime-paths.sh
source "${INSTALL_LIB_DIR}/lib-runtime-paths.sh"

# shellcheck source=install/lib-build.sh
source "${INSTALL_LIB_DIR}/lib-build.sh"

# shellcheck source=install/lib-ui.sh
source "${INSTALL_LIB_DIR}/lib-ui.sh"

# shellcheck source=install/lib-prompt.sh
source "${INSTALL_LIB_DIR}/lib-prompt.sh"

# shellcheck source=install/lib-bot-catalog.sh
source "${INSTALL_LIB_DIR}/lib-bot-catalog.sh"

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

refresh_recommended_matrix_defaults() {
  local detected_ip
  detected_ip="$(detect_primary_ipv4 || true)"

  if [[ -n "$detected_ip" ]]; then
    RECOMMENDED_MATRIX_DOMAIN="$detected_ip"
    RECOMMENDED_MATRIX_PUBLIC_BASE_URL="https://${detected_ip}:8448"
  else
    RECOMMENDED_MATRIX_DOMAIN="$LEGACY_MATRIX_DOMAIN"
    RECOMMENDED_MATRIX_PUBLIC_BASE_URL="$LEGACY_MATRIX_PUBLIC_BASE_URL"
  fi
}

slugify_matrix_project_name() {
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//'
}

build_internal_matrix_ca_path() {
  local homeserver_domain slug
  homeserver_domain="$1"
  slug="$(slugify_matrix_project_name "$homeserver_domain")"
  printf '/var/lib/sovereign-node/bundled-matrix/%s/reverse-proxy-data/caddy/pki/authorities/local/root.crt' "$slug"
}

build_matrix_onboarding_url() {
  local base_url
  base_url="${1%/}"
  printf '%s/onboard' "$base_url"
}

build_matrix_ca_download_url() {
  local base_url
  base_url="${1%/}"
  printf '%s/downloads/caddy-root-ca.crt' "$base_url"
}

build_element_web_link() {
  local base_url username matrix_domain encoded_base encoded_username
  base_url="$1"
  username="$2"
  matrix_domain="$3"

  encoded_base="$(node -p "encodeURIComponent(process.argv[1])" "$base_url")"
  if [[ -n "$username" ]] && [[ -n "$matrix_domain" ]]; then
    encoded_username="$(node -p "encodeURIComponent('@' + process.argv[1] + ':' + process.argv[2])" "$username" "$matrix_domain")"
    printf 'https://app.element.io/#/login?hs_url=%s&login_hint=%s' "$encoded_base" "$encoded_username"
    return 0
  fi

  printf 'https://app.element.io/#/login?hs_url=%s' "$encoded_base"
}

print_onboarding_qr() {
  local url
  url="$1"

  if [[ -z "$url" ]] || [[ "$NON_INTERACTIVE" == "1" ]] || ! has_tty; then
    return 0
  fi

  if ! command -v qrencode >/dev/null 2>&1; then
    return 0
  fi

  printf '\nScan on your phone:\n'
  qrencode -t ANSIUTF8 "$url" || true
  printf '\n'
}

infer_matrix_tls_mode_from_url() {
  node - "$1" <<'NODE'
const raw = process.argv[2] || "";

const isLoopback = (value) =>
  value === "localhost"
  || value === "127.0.0.1"
  || value === "::1"
  || value === "[::1]";

const isIpLiteral = (value) =>
  /^[0-9]{1,3}(?:\.[0-9]{1,3}){3}$/.test(value) || value.includes(":");

const isLikelyLanOnly = (value) =>
  isLoopback(value)
  || isIpLiteral(value)
  || !value.includes(".")
  || value.endsWith(".local")
  || value.endsWith(".localhost")
  || value.endsWith(".home.arpa")
  || value.endsWith(".internal")
  || value.endsWith(".lan");

let mode = "local-dev";
try {
  const parsed = new URL(raw);
  if (parsed.protocol === "https:") {
    const host = parsed.hostname.trim().toLowerCase();
    mode = isLikelyLanOnly(host) ? "internal" : "auto";
  }
} catch {
  mode = raw.startsWith("https://") ? "auto" : "local-dev";
}

process.stdout.write(mode);
NODE
}

resolve_action() {
  local default_choice selected_choice subtitle

  if [[ -n "$ACTION" ]]; then
    if [[ "$ACTION" == "update" && "$CONFIGURED_INSTALLATION" != "1" ]]; then
      die "Update mode requires an existing readable request file: $REQUEST_FILE"
    fi
    return
  fi

  if [[ "$NON_INTERACTIVE" == "1" ]] || ! has_tty; then
    if [[ "$CONFIGURED_INSTALLATION" == "1" ]]; then
      ACTION="update"
    else
      ACTION="install"
    fi
    return
  fi

  if [[ "$INSTALLATION_DETECTED" == "1" ]]; then
    default_choice="2"
    subtitle="Existing installation detected"
  else
    default_choice="1"
    subtitle="No existing installation detected"
  fi

  while true; do
    ui_title "Sovereign Node Setup" "$subtitle"
    selected_choice="$(
      ui_choice_menu \
        "Choose an action:" \
        "$default_choice" \
        "Install (new / reconfigure)" \
        "Update (keep current settings)" \
        "Exit"
    )"
    case "$selected_choice" in
      1)
        ACTION="install"
        return
        ;;
      2)
        if [[ "$CONFIGURED_INSTALLATION" == "1" ]]; then
          ACTION="update"
          return
        fi
        ui_warn "Update is not available because no readable existing request file was found."
        ;;
      3)
        ui_info "Installer exited."
        exit 0
        ;;
    esac
  done
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

run_install_wizard() {
  local defaults_status openrouter_api_key openrouter_model matrix_domain matrix_public_base_url
  local operator_username alert_room_name selected_bots poll_interval lookback_window federation_enabled
  local matrix_tls_mode connectivity_choice connectivity_choice_default connectivity_mode
  local prompted_selected_bots
  local relay_control_url relay_enrollment_token relay_requested_slug relay_requested_hostname
  local openrouter_secret_ref openrouter_secret_path openrouter_secret_mode
  local configure_imap imap_choice imap_host imap_port imap_tls imap_username imap_password
  local imap_mailbox imap_secret_ref imap_secret_path imap_secret_mode

  defaults_status=0
  load_existing_defaults || defaults_status=$?
  if [[ "$defaults_status" -ne 0 ]]; then
    ui_warn "${LAST_REQUEST_LOAD_ERROR}. Falling back to default values."
  fi

  ui_title "Sovereign Node Install" \
    "$( [[ "$INSTALLATION_DETECTED" == "1" ]] && printf 'Reconfigure the existing installation with current values prefilled.' || printf 'New installation with guided setup.' )"

  openrouter_model="$DEFAULT_OPENROUTER_MODEL"
  matrix_domain="$DEFAULT_MATRIX_DOMAIN"
  matrix_public_base_url="$DEFAULT_MATRIX_PUBLIC_BASE_URL"
  operator_username="$DEFAULT_OPERATOR_USERNAME"
  alert_room_name="$DEFAULT_ALERT_ROOM_NAME"
  selected_bots="$DEFAULT_SELECTED_BOTS"
  poll_interval="$DEFAULT_POLL_INTERVAL"
  lookback_window="$DEFAULT_LOOKBACK_WINDOW"
  federation_enabled="$DEFAULT_FEDERATION_ENABLED"
  connectivity_mode="$DEFAULT_CONNECTIVITY_MODE"
  relay_control_url="$DEFAULT_RELAY_CONTROL_URL"
  relay_requested_slug="$DEFAULT_RELAY_REQUESTED_SLUG"
  relay_requested_hostname="$DEFAULT_RELAY_HOSTNAME"
  openrouter_secret_ref="$EXISTING_OPENROUTER_SECRET_REF"
  openrouter_secret_mode="replaced"
  matrix_tls_mode="$(infer_matrix_tls_mode_from_url "$matrix_public_base_url")"

  ui_section "OpenRouter"
  openrouter_model="$(prompt_value "OpenRouter model" "$openrouter_model")"
  if [[ -n "$openrouter_secret_ref" ]] && [[ "$EXISTING_REQUEST_VALID" == "1" ]]; then
    if secret_ref_path_exists "$openrouter_secret_ref"; then
      if ui_confirm "Keep existing OpenRouter API key?" "y"; then
        openrouter_secret_mode="kept"
      else
        openrouter_secret_ref=""
      fi
    else
      ui_warn "Existing OpenRouter secret is missing. Enter a new OpenRouter API key."
      openrouter_secret_ref=""
    fi
  fi
  if [[ -z "$openrouter_secret_ref" ]]; then
    openrouter_api_key="$(
      prompt_required_secret \
        "OpenRouter API key (sk-or-...)" \
        "OpenRouter API key is required."
    )"
    openrouter_secret_path="/etc/sovereign-node/secrets/openrouter-api-key"
    write_secret_file "$openrouter_secret_path" "$openrouter_api_key"
    openrouter_secret_ref="file:${openrouter_secret_path}"
    openrouter_secret_mode="replaced"
  fi

  ui_section "Connection"
  if [[ "$connectivity_mode" == "relay" ]]; then
    # Relay mode was pre-configured (e.g. by the Pro installer).
    ui_info "Connection mode: Managed Relay (configured by Pro installer)"
  else
    connectivity_choice_default="2"
    if [[ "$matrix_tls_mode" != "internal" ]] && [[ "$matrix_tls_mode" != "local-dev" ]]; then
      connectivity_choice_default="1"
    fi
    connectivity_choice="$(
      ui_choice_menu \
        "Choose how users should connect:" \
        "$connectivity_choice_default" \
        "Public Domain / Direct HTTPS" \
        "LAN Only"
    )"
    connectivity_mode="direct"
    if [[ "$connectivity_choice" == "2" ]]; then
      if [[ "$matrix_domain" == "$LEGACY_MATRIX_DOMAIN" ]] || [[ -z "$matrix_domain" ]]; then
        matrix_domain="$RECOMMENDED_MATRIX_DOMAIN"
      fi
      if [[ "$matrix_public_base_url" == "$LEGACY_MATRIX_PUBLIC_BASE_URL" ]] \
        || [[ "$matrix_public_base_url" == "$LEGACY_MATRIX_ALT_PUBLIC_BASE_URL" ]] \
        || [[ -z "$matrix_public_base_url" ]]; then
        matrix_public_base_url="$RECOMMENDED_MATRIX_PUBLIC_BASE_URL"
      fi
    fi
  fi

  ui_section "Matrix"
  if [[ "$connectivity_mode" == "relay" ]]; then
    relay_enrollment_token=""
    if [[ "${relay_control_url%/}" == "$DEFAULT_MANAGED_RELAY_CONTROL_URL" ]]; then
      ui_info "Using Sovereign managed relay: ${relay_control_url}"
    else
      relay_control_url="$(prompt_value "Relay server URL" "$relay_control_url")"
    fi
    if [[ "${relay_control_url%/}" != "$DEFAULT_MANAGED_RELAY_CONTROL_URL" ]]; then
      if [[ -n "$EXISTING_RELAY_ENROLLMENT_TOKEN" ]] && [[ "$EXISTING_REQUEST_VALID" == "1" ]]; then
        if ui_confirm "Keep existing relay enrollment token?" "y"; then
          relay_enrollment_token="$EXISTING_RELAY_ENROLLMENT_TOKEN"
        fi
      fi
      if [[ -z "${relay_enrollment_token:-}" ]]; then
        relay_enrollment_token="$(
          prompt_required_secret \
            "Relay enrollment token" \
            "A custom relay enrollment token is required for non-Sovereign relays."
        )"
      fi
    fi
    if [[ -z "$matrix_domain" ]]; then
      matrix_domain="relay-pending.invalid"
    fi
    if [[ -z "$matrix_public_base_url" ]]; then
      matrix_public_base_url="https://relay-pending.invalid"
    fi
    matrix_tls_mode="auto"
    federation_enabled="0"
  else
    matrix_domain="$(prompt_value "Matrix homeserver domain" "$matrix_domain")"
    matrix_public_base_url="$(prompt_value "Matrix public base URL" "$matrix_public_base_url")"
    matrix_tls_mode="$(infer_matrix_tls_mode_from_url "$matrix_public_base_url")"
  fi
  operator_username="$(prompt_value "Operator username" "$operator_username")"
  alert_room_name="$(prompt_value "Alert room name" "$alert_room_name")"
  if [[ "$connectivity_mode" == "direct" ]]; then
    if ui_confirm "Enable Matrix federation?" "$( [[ "$federation_enabled" == "1" ]] && printf 'y' || printf 'n' )"; then
      federation_enabled="1"
    else
      federation_enabled="0"
    fi
  fi

  configure_imap="0"
  imap_host="$DEFAULT_IMAP_HOST"
  imap_port="$DEFAULT_IMAP_PORT"
  imap_tls="$DEFAULT_IMAP_TLS"
  imap_username="$DEFAULT_IMAP_USERNAME"
  imap_mailbox="$DEFAULT_IMAP_MAILBOX"
  imap_secret_ref="$EXISTING_IMAP_SECRET_REF"
  imap_secret_mode="pending"

  ui_section "Bots"
  prompted_selected_bots="$(prompt_bot_selection "$selected_bots")"
  selected_bots="$prompted_selected_bots"

  if bot_list_contains "$selected_bots" "mail-sentinel"; then
    ui_section "Mail Sentinel"
    poll_interval="$(prompt_value "Mail Sentinel poll interval" "$poll_interval")"
    lookback_window="$(prompt_value "Mail Sentinel lookback window" "$lookback_window")"

    ui_section "IMAP (optional)"
    if [[ "$DEFAULT_IMAP_CONFIGURED" == "1" ]] && [[ "$EXISTING_REQUEST_VALID" == "1" ]]; then
      imap_choice="$(
        ui_choice_menu \
          "Choose how to handle IMAP:" \
          "1" \
          "Keep current IMAP configuration" \
          "Replace IMAP configuration" \
          "Leave IMAP pending"
      )"
      case "$imap_choice" in
        1)
          if secret_ref_path_exists "$imap_secret_ref"; then
            configure_imap="1"
            imap_secret_mode="kept"
          else
            ui_warn "Existing IMAP secret is missing. Enter replacement IMAP credentials."
            imap_choice="2"
          fi
          ;;
        3)
          configure_imap="0"
          imap_secret_ref=""
          imap_secret_mode="pending"
          ;;
      esac
      if [[ "$imap_choice" == "2" ]]; then
        configure_imap="1"
        imap_host="$(prompt_value "IMAP host" "$imap_host")"
        imap_port="$(prompt_value "IMAP port" "$imap_port")"
        if ui_confirm "Use TLS for IMAP?" "$( [[ "$imap_tls" == "1" ]] && printf 'y' || printf 'n' )"; then
          imap_tls="1"
        else
          imap_tls="0"
        fi
        imap_username="$(prompt_value "IMAP username" "$imap_username")"
        imap_password="$(
          prompt_required_secret \
            "IMAP password/app password" \
            "IMAP password is required when IMAP is configured."
        )"
        imap_mailbox="$(prompt_value "IMAP mailbox" "$imap_mailbox")"
        imap_secret_path="/etc/sovereign-node/secrets/imap-password"
        write_secret_file "$imap_secret_path" "$imap_password"
        imap_secret_ref="file:${imap_secret_path}"
        imap_secret_mode="replaced"
      fi
    else
      if ui_confirm "Configure IMAP now? (choose no to keep IMAP pending)" "n"; then
        configure_imap="1"
        imap_host="$(prompt_value "IMAP host" "$imap_host")"
        imap_port="$(prompt_value "IMAP port" "$imap_port")"
        if ui_confirm "Use TLS for IMAP?" "y"; then
          imap_tls="1"
        else
          imap_tls="0"
        fi
        imap_username="$(prompt_value "IMAP username" "$imap_username")"
        imap_password="$(
          prompt_required_secret \
            "IMAP password/app password" \
            "IMAP password is required when IMAP is configured."
        )"
        imap_mailbox="$(prompt_value "IMAP mailbox" "$imap_mailbox")"
        imap_secret_path="/etc/sovereign-node/secrets/imap-password"
        write_secret_file "$imap_secret_path" "$imap_password"
        imap_secret_ref="file:${imap_secret_path}"
        imap_secret_mode="replaced"
      fi
    fi
  fi

  export SN_REQUEST_FILE="$REQUEST_FILE"
  export SN_CONNECTIVITY_MODE="$connectivity_mode"
  export SN_OPENROUTER_MODEL="$openrouter_model"
  export SN_OPENROUTER_SECRET_REF="$openrouter_secret_ref"
  export SN_OPENROUTER_SECRET_MODE="$openrouter_secret_mode"
  export SN_RELAY_CONTROL_URL="${relay_control_url:-}"
  export SN_RELAY_ENROLLMENT_TOKEN="${relay_enrollment_token:-}"
  export SN_RELAY_REQUESTED_SLUG="${relay_requested_slug:-}"
  export SN_RELAY_REQUESTED_HOSTNAME="${relay_requested_hostname:-}"
  export SN_MATRIX_DOMAIN="$matrix_domain"
  export SN_MATRIX_PUBLIC_BASE_URL="$matrix_public_base_url"
  export SN_MATRIX_TLS_MODE="$matrix_tls_mode"
  export SN_MATRIX_INTERNAL_CA_PATH="$(build_internal_matrix_ca_path "$matrix_domain")"
  export SN_MATRIX_FEDERATION_ENABLED="$federation_enabled"
  export SN_OPERATOR_USERNAME="$operator_username"
  export SN_ALERT_ROOM_NAME="$alert_room_name"
  export SN_SELECTED_BOTS="$selected_bots"
  export SN_POLL_INTERVAL="$poll_interval"
  export SN_LOOKBACK_WINDOW="$lookback_window"
  export SN_IMAP_CONFIGURE="$configure_imap"
  export SN_IMAP_HOST="$imap_host"
  export SN_IMAP_PORT="$imap_port"
  export SN_IMAP_TLS="$imap_tls"
  export SN_IMAP_USERNAME="$imap_username"
  export SN_IMAP_SECRET_REF="$imap_secret_ref"
  export SN_IMAP_SECRET_MODE="$imap_secret_mode"
  export SN_IMAP_MAILBOX="$imap_mailbox"

  review_install_request
  if ! ui_confirm "Write the request file and continue?" "y"; then
    ui_info "Installer exited without changing the request file."
    exit 0
  fi

  write_request_file_from_env
  ui_success "Request file updated."
}

prepare_install_request_for_install() {
  if [[ "$NON_INTERACTIVE" == "1" ]]; then
    if [[ ! -f "$REQUEST_FILE" ]]; then
      if [[ -f /etc/sovereign-node/install-request.example.json ]]; then
        cp /etc/sovereign-node/install-request.example.json "$REQUEST_FILE"
        chmod 0640 "$REQUEST_FILE"
        chown "${SERVICE_USER}:${SERVICE_GROUP}" "$REQUEST_FILE" || true
        log "Non-interactive install: wrote template request to $REQUEST_FILE"
      else
        log "Non-interactive install: no request file exists yet; skipping install run"
      fi
      RUN_INSTALL="0"
    fi
    return
  fi

  if ! has_tty; then
    if [[ ! -f "$REQUEST_FILE" ]]; then
      if [[ -f /etc/sovereign-node/install-request.example.json ]]; then
        cp /etc/sovereign-node/install-request.example.json "$REQUEST_FILE"
        chmod 0640 "$REQUEST_FILE"
        chown "${SERVICE_USER}:${SERVICE_GROUP}" "$REQUEST_FILE" || true
      fi
      log "No TTY available; wrote template request file and skipped the install run"
      RUN_INSTALL="0"
      return
    fi
    log "No TTY available; reusing existing request file for install mode"
    return
  fi

  run_install_wizard
}

prepare_install_request_for_update() {
  if [[ "$CONFIGURED_INSTALLATION" != "1" ]]; then
    die "Update mode requires an existing readable request file: $REQUEST_FILE"
  fi

  if ! load_existing_defaults; then
    die "${LAST_REQUEST_LOAD_ERROR}"
  fi
  if [[ "$LEGACY_OPENROUTER_MODEL_DETECTED" == "1" ]]; then
    migrate_legacy_openrouter_model_request \
      || die "Failed to migrate the saved request file to ${RECOMMENDED_OPENROUTER_MODEL}"
  fi

  if [[ "$NON_INTERACTIVE" == "1" ]] || ! has_tty; then
    return
  fi

  ui_title "Sovereign Node Update" "Reuse the current configuration and update in place."
  ui_section "Update"
  ui_info "Will update application code."
  ui_info "Will preserve /etc/sovereign-node, /etc/sovereign-node/secrets, and /var/lib/sovereign-node."
  ui_info "Will reuse request file: ${REQUEST_FILE}"
  if [[ "$DEFAULT_CONNECTIVITY_MODE" == "relay" ]]; then
    ui_info "Managed relay mode is enabled."
    ui_info "Relay control URL: ${DEFAULT_RELAY_CONTROL_URL}"
  fi
  warn_if_missing_secret_ref "OpenRouter" "$EXISTING_OPENROUTER_SECRET_REF" || true
  warn_if_missing_secret_ref "IMAP" "$EXISTING_IMAP_SECRET_REF" || true
  if ! ui_confirm "Continue with update?" "y"; then
    ui_info "Update cancelled."
    exit 0
  fi
}

prepare_request_file() {
  case "$ACTION" in
    update)
      prepare_install_request_for_update
      ;;
    *)
      prepare_install_request_for_install
      ;;
  esac
}

parse_install_result() {
  node - "$1" <<'NODE'
const raw = process.argv[2] ?? "";
let parsed;
try {
  parsed = JSON.parse(raw);
} catch {
  const recovered = recoverJsonObject(raw);
  if (recovered === null) {
    process.stdout.write("parse_error\tUnable to parse install command JSON output");
    process.exit(0);
  }

  parsed = recovered;
}

const state = parsed?.result?.job?.state;
if (typeof state !== "string") {
  process.stdout.write("unknown\tInstall response did not include a valid job state");
  process.exit(0);
}

if (state === "succeeded") {
  const warnedSteps = Array.isArray(parsed?.result?.job?.steps)
    ? parsed.result.job.steps.filter((step) => step?.state === "warned")
    : [];
  if (warnedSteps.length > 0) {
    const warnings = warnedSteps.map((step) => `${step.id}: ${step.error?.message ?? "warning"}`).join("; ");
    process.stdout.write(`succeeded\tInstall completed with warnings: ${warnings}`);
  } else {
    process.stdout.write("succeeded\tInstall job completed successfully");
  }
  process.exit(0);
}

const failedStep = Array.isArray(parsed?.result?.job?.steps)
  ? parsed.result.job.steps.find((step) => step?.state === "failed")
  : undefined;
const errorCode = failedStep?.error?.code ?? parsed?.error?.code ?? "INSTALL_FAILED";
const errorMessage =
  failedStep?.error?.message
  ?? parsed?.error?.message
  ?? "Install job did not succeed";
const failedStepId = typeof failedStep?.id === "string" ? failedStep.id : "unknown-step";
process.stdout.write(`${state}\t${failedStepId}: ${errorCode}: ${errorMessage}`);

function recoverJsonObject(input) {
  const lines = input.split(/\r?\n/);

  for (let start = 0; start < lines.length; start += 1) {
    const candidate = lines.slice(start).join("\n").trim();
    if (!candidate.startsWith("{")) {
      continue;
    }
    try {
      return JSON.parse(candidate);
    } catch {
      // keep trying smaller tails
    }
  }

  for (let start = 0; start < lines.length; start += 1) {
    for (let end = lines.length; end > start; end -= 1) {
      const candidate = lines.slice(start, end).join("\n").trim();
      if (!candidate.startsWith("{") || !candidate.endsWith("}")) {
        continue;
      }
      try {
        return JSON.parse(candidate);
      } catch {
        // keep scanning
      }
    }
  }

  return null;
}
NODE
}

parse_runtime_readiness() {
  node - "$1" <<'NODE'
const raw = process.argv[2] ?? "";
let parsed;
try {
  parsed = JSON.parse(raw);
} catch {
  const recovered = recoverJsonObject(raw);
  if (recovered === null) {
    process.stdout.write("0\tstatus-json-parse-failed");
    process.exit(0);
  }
  parsed = recovered;
}

const result = parsed?.result ?? {};
const matrix = result.matrix ?? {};
const openclaw = result.openclaw ?? {};

const matrixReady = matrix.health === "healthy" && matrix.roomReachable === true;
const openclawReady =
  openclaw.cliInstalled === true
  && (openclaw.health === "healthy" || openclaw.health === "degraded")
  && openclaw.agentPresent === true;

if (matrixReady && openclawReady) {
  process.stdout.write("1\tmatrix+openclaw-ready");
  process.exit(0);
}

const reasons = [];
if (!matrixReady) {
  reasons.push(`matrix(health=${String(matrix.health)},roomReachable=${String(matrix.roomReachable)})`);
}
if (!openclawReady) {
  reasons.push(
    `openclaw(cliInstalled=${String(openclaw.cliInstalled)},serviceInstalled=${String(openclaw.serviceInstalled)},serviceState=${String(openclaw.serviceState)},health=${String(openclaw.health)},agentPresent=${String(openclaw.agentPresent)},cronPresent=${String(openclaw.cronPresent)})`,
  );
}

process.stdout.write(`0\t${reasons.join(";")}`);

function recoverJsonObject(input) {
  const lines = input.split(/\r?\n/);

  for (let start = 0; start < lines.length; start += 1) {
    const candidate = lines.slice(start).join("\n").trim();
    if (!candidate.startsWith("{")) {
      continue;
    }
    try {
      return JSON.parse(candidate);
    } catch {
      // keep trying
    }
  }

  for (let start = 0; start < lines.length; start += 1) {
    for (let end = lines.length; end > start; end -= 1) {
      const candidate = lines.slice(start, end).join("\n").trim();
      if (!candidate.startsWith("{") || !candidate.endsWith("}")) {
        continue;
      }
      try {
        return JSON.parse(candidate);
      } catch {
        // keep scanning
      }
    }
  }

  return null;
}
NODE
}

wait_for_runtime_ready() {
  local max_attempts delay_s log_path attempt status_output parsed readiness_flag readiness_reason frame_index
  max_attempts="${1:-45}"
  delay_s="${2:-2}"
  log_path="${3:-}"
  frame_index=0

  for attempt in $(seq 1 "$max_attempts"); do
    status_output="$(timeout --foreground 45s sovereign-node status --json || true)"
    if [[ -n "$log_path" ]]; then
      {
        printf '%s\n' "--- runtime probe ${attempt}/${max_attempts} ---"
        printf '%s\n\n' "$status_output"
      } >> "$log_path"
    fi
    parsed="$(parse_runtime_readiness "$status_output")"
    readiness_flag="${parsed%%$'\t'*}"
    readiness_reason="${parsed#*$'\t'}"

    if [[ "$readiness_flag" == "1" ]]; then
      printf '%s\n' "$status_output"
      return 0
    fi

    if [[ "$attempt" -lt "$max_attempts" ]]; then
      if ui_is_fancy; then
        ui_update_step "probe ${attempt}/${max_attempts}: ${readiness_reason}" "$frame_index"
        frame_index=$((frame_index + 1))
      else
        log "Runtime not ready yet (${attempt}/${max_attempts}): ${readiness_reason}"
      fi
      sleep "$delay_s"
    else
      printf '%s\n' "$status_output"
      return 1
    fi
  done
}

summarize_install_command_output() {
  node - "$1" <<'NODE'
const raw = process.argv[2] ?? "";
let parsed;
try {
  parsed = JSON.parse(raw);
} catch {
  parsed = recoverJsonObject(raw);
}

const job = parsed?.result?.job ?? parsed?.job;
if (!job || typeof job !== "object") {
  process.exit(0);
}

const steps = Array.isArray(job.steps) ? job.steps : [];
const completed = steps.filter((step) => step?.state === "succeeded" || step?.state === "skipped").length;
const lines = [
  `Job id: ${typeof job.jobId === "string" ? job.jobId : "unknown"}`,
  `Job state: ${typeof job.state === "string" ? job.state : "unknown"}`,
  `Installer steps: ${completed}/${steps.length} complete`,
];

if (typeof job.currentStepId === "string") {
  lines.push(`Last recorded step: ${job.currentStepId}`);
}

process.stdout.write(lines.join("\n"));

function recoverJsonObject(input) {
  const lines = input.split(/\r?\n/);

  for (let start = 0; start < lines.length; start += 1) {
    const candidate = lines.slice(start).join("\n").trim();
    if (!candidate.startsWith("{")) {
      continue;
    }
    try {
      return JSON.parse(candidate);
    } catch {
      // keep scanning
    }
  }

  return null;
}
NODE
}

summarize_status_output() {
  node - "$1" <<'NODE'
const raw = process.argv[2] ?? "";
let parsed;
try {
  parsed = JSON.parse(raw);
} catch {
  parsed = recoverJsonObject(raw);
}

const result = parsed?.result;
if (!result || typeof result !== "object") {
  process.exit(0);
}

const lines = [];
if (typeof result.matrix?.homeserverUrl === "string") {
  lines.push(`Matrix URL: ${result.matrix.homeserverUrl}`);
}
lines.push(
  `Matrix: ${String(result.matrix?.health ?? "unknown")} (${result.matrix?.roomReachable === true ? "alert room reachable" : "alert room pending"})`,
);

const openclawVersion =
  typeof result.openclaw?.version === "string" && result.openclaw.version.length > 0
    ? ` ${result.openclaw.version}`
    : "";
lines.push(
  `OpenClaw${openclawVersion}: ${String(result.openclaw?.health ?? "unknown")} (service ${String(result.openclaw?.serviceState ?? "unknown")})`,
);

if (result.relay?.enabled === true) {
  const relayTarget =
    typeof result.relay.hostname === "string" && result.relay.hostname.length > 0
      ? result.relay.hostname
      : typeof result.relay.publicBaseUrl === "string" && result.relay.publicBaseUrl.length > 0
        ? result.relay.publicBaseUrl
        : "managed relay";
  lines.push(`Relay: ${relayTarget} (${result.relay.connected === true ? "connected" : "not connected"})`);
}

process.stdout.write(lines.join("\n"));

function recoverJsonObject(input) {
  const lines = input.split(/\r?\n/);

  for (let start = 0; start < lines.length; start += 1) {
    const candidate = lines.slice(start).join("\n").trim();
    if (!candidate.startsWith("{")) {
      continue;
    }
    try {
      return JSON.parse(candidate);
    } catch {
      // keep scanning
    }
  }

  return null;
}
NODE
}

summarize_doctor_output() {
  node - "$1" <<'NODE'
const raw = process.argv[2] ?? "";
let parsed;
try {
  parsed = JSON.parse(raw);
} catch {
  parsed = recoverJsonObject(raw);
}

const report = parsed?.result ?? parsed;
if (!report || typeof report !== "object") {
  process.exit(0);
}

const checks = Array.isArray(report.checks) ? report.checks : [];
const flagged = checks.filter((entry) => entry?.status === "warn" || entry?.status === "fail");
const lines = [
  `Doctor overall: ${typeof report.overall === "string" ? report.overall : "unknown"} (${checks.length} checks)`,
];

for (const entry of flagged.slice(0, 3)) {
  const label =
    typeof entry?.label === "string" && entry.label.length > 0
      ? entry.label
      : typeof entry?.id === "string" && entry.id.length > 0
        ? entry.id
        : "check";
  const message =
    typeof entry?.message === "string" && entry.message.length > 0
      ? ` - ${entry.message}`
      : "";
  lines.push(`Attention: ${label}${message}`);
}

if (flagged.length > 0 && Array.isArray(report.suggestedCommands) && report.suggestedCommands.length > 0) {
  lines.push(`Suggested command: ${String(report.suggestedCommands[0])}`);
}

process.stdout.write(lines.join("\n"));

function recoverJsonObject(input) {
  const lines = input.split(/\r?\n/);

  for (let start = 0; start < lines.length; start += 1) {
    const candidate = lines.slice(start).join("\n").trim();
    if (!candidate.startsWith("{")) {
      continue;
    }
    try {
      return JSON.parse(candidate);
    } catch {
      // keep scanning
    }
  }

  return null;
}
NODE
}

print_matrix_client_onboarding_guidance() {
  local guidance guidance_payload onboarding_json onboarding_url
  [[ -r "$REQUEST_FILE" ]] || return 0

  onboarding_json="$(sovereign-node onboarding issue --json 2>/dev/null || true)"
  guidance_payload="$(
    node - "$REQUEST_FILE" "$onboarding_json" <<'NODE'
const fs = require("node:fs");
const requestPath = process.argv[2];
const onboardingRaw = process.argv[3] ?? "";
let req = {};
try {
  req = JSON.parse(fs.readFileSync(requestPath, "utf8"));
} catch {
  req = {};
}
let onboarding = {};
try {
  const parsed = JSON.parse(onboardingRaw);
  onboarding = parsed?.result ?? {};
} catch {
  onboarding = {};
}
const matrix = req?.matrix ?? {};
const issuedOnboardingUrl =
  typeof onboarding.onboardingUrl === "string" ? onboarding.onboardingUrl.replace(/\/+$/, "") : "";
const issuedUsername = typeof onboarding.username === "string" ? onboarding.username : "";
const publicBaseUrl = issuedOnboardingUrl
  ? issuedOnboardingUrl.replace(/\/onboard$/, "")
  : (typeof matrix.publicBaseUrl === "string" ? matrix.publicBaseUrl : "");
const tlsMode =
  typeof matrix.tlsMode === "string" && matrix.tlsMode.length > 0
    ? matrix.tlsMode
    : publicBaseUrl.startsWith("https://")
      ? "auto"
      : "local-dev";
if (tlsMode === "local-dev" || !publicBaseUrl) {
  process.exit(0);
}
const homeserverDomain =
  issuedUsername.includes(":")
    ? issuedUsername.slice(issuedUsername.indexOf(":") + 1)
    : (typeof matrix.homeserverDomain === "string" && matrix.homeserverDomain.length > 0
        ? matrix.homeserverDomain
        : "matrix.local.test");
const slug = homeserverDomain
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+/, "")
  .replace(/-+$/, "");
const caPath = `/var/lib/sovereign-node/bundled-matrix/${slug}/reverse-proxy-data/caddy/pki/authorities/local/root.crt`;
const normalizedBaseUrl = publicBaseUrl.replace(/\/+$/, "");
const onboardingUrl = issuedOnboardingUrl || `${normalizedBaseUrl}/onboard`;
const caDownloadUrl = `${normalizedBaseUrl}/downloads/caddy-root-ca.crt`;
const operatorUserId =
  issuedUsername.length > 0
    ? issuedUsername
    : (typeof req?.operator?.username === "string" && req.operator.username.length > 0
        ? `@${req.operator.username}:${homeserverDomain}`
        : `@operator:${homeserverDomain}`);
const elementLink =
  `https://app.element.io/#/login?hs_url=${encodeURIComponent(publicBaseUrl)}`
  + `&login_hint=${encodeURIComponent(operatorUserId)}`;
const lines = [
  "Phone onboarding:",
  `- Onboarding page: ${onboardingUrl}`,
  `- Element Web login: ${elementLink}`,
  "- Use a one-time onboarding code to unlock the password on the onboarding page.",
];
if (typeof onboarding.code === "string" && onboarding.code.length > 0) {
  lines.push(`- One-time onboarding code: ${onboarding.code}`);
}
if (typeof onboarding.expiresAt === "string" && onboarding.expiresAt.length > 0) {
  lines.push(`- Code expires at: ${onboarding.expiresAt}`);
}
if (issuedUsername.length > 0) {
  lines.push(`- Username: ${issuedUsername}`);
  lines.push("- Regenerate later: sudo sovereign-node onboarding issue");
}
if (tlsMode === "internal") {
  lines.push(`- CA download URL: ${caDownloadUrl}`);
  lines.push(`- Client CA certificate: ${caPath}`);
  lines.push("- Install this CA on every client device before using Element Web.");
}
process.stdout.write(`${onboardingUrl}\n${lines.join("\n")}`);
NODE
  )" || return 0

  if [[ -n "$guidance_payload" ]]; then
    onboarding_url="${guidance_payload%%$'\n'*}"
    guidance="${guidance_payload#*$'\n'}"
    printf '\n%s\n' "$guidance"
    print_onboarding_qr "$onboarding_url"
  fi
}

run_install_command() {
  local install_output install_exit_code parsed install_state install_summary
  local action_label log_path pid frame_index

  if [[ "$RUN_INSTALL" != "1" ]]; then
    return 0
  fi

  if [[ ! -f "$REQUEST_FILE" ]]; then
    die "Install request file not found: $REQUEST_FILE"
  fi

  action_label="${ACTION:-install}"
  if ! ui_is_fancy; then
    if [[ "$action_label" == "update" ]]; then
      log "Running Sovereign Node update"
    else
      log "Running Sovereign Node install"
    fi
    set +e
    install_output="$(
      timeout --foreground 30m env \
        "SOVEREIGN_INTERNAL_INSTALL=1" \
        "SOVEREIGN_NODE_SERVICE_USER=$SERVICE_USER" \
        "SOVEREIGN_NODE_SERVICE_GROUP=$SERVICE_GROUP" \
        sovereign-node install --request-file "$REQUEST_FILE" --json
    )"
    install_exit_code=$?
    set -e
    INSTALL_COMMAND_OUTPUT="$install_output"
    printf '%s\n' "$install_output"
  else
    ui_begin_step "Apply ${action_label}"
    log_path="$(ui_step_log_path)"
    : > "$log_path"
    set +e
    timeout --foreground 30m env \
      "SOVEREIGN_INTERNAL_INSTALL=1" \
      "SOVEREIGN_NODE_SERVICE_USER=$SERVICE_USER" \
      "SOVEREIGN_NODE_SERVICE_GROUP=$SERVICE_GROUP" \
      sovereign-node install --request-file "$REQUEST_FILE" --json >"$log_path" 2>&1 &
    pid=$!
    frame_index=0
    while kill -0 "$pid" 2>/dev/null; do
      if [[ "$action_label" == "update" ]]; then
        ui_update_step "reconciling services" "$frame_index"
      else
        ui_update_step "provisioning services" "$frame_index"
      fi
      frame_index=$((frame_index + 1))
      sleep 0.12
    done
    wait "$pid"
    install_exit_code=$?
    set -e
    INSTALL_COMMAND_OUTPUT="$(cat "$log_path" 2>/dev/null || true)"
  fi

  if [[ "$install_exit_code" -eq 124 ]]; then
    if ui_is_fancy; then
      ui_preserve_logs
      ui_fail_step "timed out after 30 minutes"
      ui_error "Step log: $log_path"
      ui_show_log_excerpt "$log_path"
    else
      die "Install did not complete within 30 minutes"
    fi
    return 1
  fi
  if [[ "$install_exit_code" -ne 0 ]]; then
    if ui_is_fancy; then
      ui_preserve_logs
      ui_fail_step "command exited with status ${install_exit_code}"
      ui_error "Step log: $log_path"
      ui_show_log_excerpt "$log_path"
    else
      die "Install command exited with status ${install_exit_code}"
    fi
    return 1
  fi

  parsed="$(parse_install_result "$INSTALL_COMMAND_OUTPUT")"
  install_state="${parsed%%$'\t'*}"
  install_summary="${parsed#*$'\t'}"
  if [[ "$install_state" != "succeeded" ]]; then
    if ui_is_fancy; then
      ui_preserve_logs
      ui_fail_step "$install_summary"
      ui_error "Step log: $log_path"
      ui_show_log_excerpt "$log_path"
    else
      die "Install did not complete successfully (${install_summary})"
    fi
    return 1
  fi

  if ui_is_fancy; then
    if [[ "$install_summary" == *"warnings:"* ]]; then
      ui_complete_step "job completed (with warnings)"
      log "Warning: $install_summary"
    else
      ui_complete_step "job completed"
    fi
  else
    if [[ "$install_summary" == *"warnings:"* ]]; then
      log "Warning: $install_summary"
    fi
  fi
  return 0
}

run_runtime_readiness_step() {
  local status_output log_path

  if [[ "$RUN_INSTALL" != "1" ]]; then
    return 0
  fi

  if ! ui_is_fancy; then
    if ! status_output="$(wait_for_runtime_ready 20 5)"; then
      RUNTIME_STATUS_OUTPUT="$status_output"
      printf '%s\n' "$status_output"
      die "Runtime did not reach healthy state for Matrix/OpenClaw within timeout"
    fi
    RUNTIME_STATUS_OUTPUT="$status_output"
    printf '%s\n' "$status_output"
    return 0
  fi

  ui_begin_step "Wait for runtime health"
  log_path="$(ui_step_log_path)"
  : > "$log_path"
  if status_output="$(wait_for_runtime_ready 20 5 "$log_path")"; then
    RUNTIME_STATUS_OUTPUT="$status_output"
    ui_complete_step "Matrix and OpenClaw healthy"
    return 0
  fi

  RUNTIME_STATUS_OUTPUT="$status_output"
  ui_preserve_logs
  ui_fail_step "runtime probes did not converge"
  ui_error "Step log: $log_path"
  ui_show_log_excerpt "$log_path"
  return 1
}

run_post_install_diagnostics_step() {
  local doctor_exit_code summary_headline log_path pid frame_index

  if [[ "$RUN_INSTALL" != "1" ]]; then
    return 0
  fi

  if ! ui_is_fancy; then
    log "Running post-install diagnostics"
    DOCTOR_REPORT_OUTPUT="$(sovereign-node doctor --json || true)"
    printf '%s\n' "$DOCTOR_REPORT_OUTPUT"
    return 0
  fi

  ui_begin_step "Run post-install diagnostics"
  log_path="$(ui_step_log_path)"
  : > "$log_path"
  set +e
  sovereign-node doctor --json >"$log_path" 2>&1 &
  pid=$!
  frame_index=0
  while kill -0 "$pid" 2>/dev/null; do
    ui_update_step "collecting health report" "$frame_index"
    frame_index=$((frame_index + 1))
    sleep 0.12
  done
  wait "$pid"
  doctor_exit_code=$?
  set -e
  DOCTOR_REPORT_OUTPUT="$(cat "$log_path" 2>/dev/null || true)"
  summary_headline="$(summarize_doctor_output "$DOCTOR_REPORT_OUTPUT")"
  summary_headline="${summary_headline%%$'\n'*}"
  if [[ -z "$summary_headline" ]]; then
    summary_headline="report ready"
  fi

  ui_complete_step "$summary_headline"
  if [[ "$doctor_exit_code" -ne 0 ]]; then
    ui_preserve_logs
    ui_warn "Doctor command exited with status ${doctor_exit_code}."
    ui_warn "Step log: $log_path"
  fi
}

run_post_install_ansible_step() {
  local playbook ansible_exit_code

  if [[ "$RUN_INSTALL" != "1" ]]; then
    return 0
  fi

  playbook="$APP_DIR/deploy/ansible/playbooks/post-install-local.yml"
  [[ -f "$playbook" ]] || die "Missing internal host resource playbook: $playbook"

  set +e
  timeout --foreground 15m env \
    "ANSIBLE_CONFIG=$APP_DIR/deploy/ansible/ansible.cfg" \
    "ANSIBLE_ROLES_PATH=$APP_DIR/deploy/ansible/roles" \
    ansible-playbook -i localhost, -c local "$playbook"
  ansible_exit_code=$?
  set -e

  if [[ "$ansible_exit_code" -eq 124 ]]; then
    die "Internal host resource reconciliation timed out after 15 minutes"
  fi
  if [[ "$ansible_exit_code" -ne 0 ]]; then
    die "Internal host resource reconciliation failed"
  fi
}

main() {
  local completion_label

  parse_args "$@"
  normalize_service_identity
  require_root
  ensure_supported_os
  ui_setup_runtime
  ui_configure_progress_plan
  if ui_is_fancy; then
    ui_print_banner
  fi
  detect_installation_state
  resolve_action

  ui_run_step_foreground "Check source inputs" resolve_source_mode
  ui_run_step_captured "Install base packages" install_base_packages
  ui_run_step_captured "Prepare Ansible runtime" install_ansible_if_needed
  ui_run_step_captured "Prepare Docker runtime" install_docker_if_needed
  ui_run_step_captured "Prepare Node runtime" install_node22_if_needed
  ui_run_step_captured "Ensure service account" ensure_service_account
  ui_run_step_captured "Prepare runtime directories" ensure_runtime_directories
  ui_run_step_captured "Sync application source" sync_app_source
  ui_run_step_captured "Sync bot package source" sync_bots_source
  ui_run_step_captured "Write install provenance" write_install_provenance
  ui_run_step_foreground "Load bot catalog" load_available_bot_catalog
  ui_run_step_captured "Build bot packages" build_bots
  ui_run_step_captured "Build application" build_app
  ui_run_step_captured "Install CLI wrappers" install_wrappers
  ui_run_step_captured "Install systemd service" install_systemd_unit
  ui_run_step_captured "Configure system hygiene" configure_system_hygiene
  ui_run_step_captured "Write request template" install_request_template
  if [[ "$NON_INTERACTIVE" == "1" ]] || ! has_tty; then
    ui_run_step_foreground "Configure request file" prepare_request_file
  else
    ui_run_step_interactive "Configure request file" prepare_request_file
  fi

  if [[ "$RUN_INSTALL" == "1" ]]; then
    run_install_command
    ui_run_step_captured "Apply host resources" run_post_install_ansible_step
    run_post_install_diagnostics_step
  else
    ui_skip_step "Apply ${ACTION:-install}" "--skip-install-run"
    ui_skip_step "Apply host resources" "install run skipped"
    ui_skip_step "Run post-install diagnostics" "install run skipped"
  fi

  if [[ "$RUN_INSTALL" != "1" ]]; then
    completion_label="Bootstrap completed. Install run skipped."
  elif [[ "${ACTION:-install}" == "update" ]]; then
    completion_label="Update completed."
  else
    completion_label="Install completed."
  fi

  if ui_is_fancy; then
    ui_break_progress_line
    ui_title "Summary" "$completion_label"
    ui_print_summary_block "Installer" "$(summarize_install_command_output "$INSTALL_COMMAND_OUTPUT")"
    ui_print_summary_block "Runtime" "$(summarize_status_output "$RUNTIME_STATUS_OUTPUT")"
    ui_print_summary_block "Diagnostics" "$(summarize_doctor_output "$DOCTOR_REPORT_OUTPUT")"
  fi

  ui_break_progress_line
  cat <<EOF
${completion_label}

Request file: ${REQUEST_FILE}

Useful commands:
- bash ${APP_DIR}/scripts/install.sh --request-file ${REQUEST_FILE} --install --non-interactive
- sovereign-node status --json
- sovereign-node doctor --json
- sovereign-node onboarding issue --json
EOF
  print_matrix_client_onboarding_guidance
}

if ! (return 0 2>/dev/null); then
  main "$@"
fi
