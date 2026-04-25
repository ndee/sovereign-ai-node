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
    node "${INSTALL_LIB_DIR}/js/bin/load-existing-defaults.mjs" "$REQUEST_FILE" "$RUNTIME_CONFIG_FILE"
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
  node "${INSTALL_LIB_DIR}/js/bin/write-request-file.mjs"

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

