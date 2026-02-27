#!/usr/bin/env bash
set -euo pipefail

SCRIPT_NAME="$(basename "$0")"

REPO_URL="${SOVEREIGN_NODE_REPO_URL:-https://github.com/ndee/sovereign-ai-node}"
SOURCE_DIR="${SOVEREIGN_NODE_SOURCE_DIR:-}"
REF="${SOVEREIGN_NODE_REF:-main}"
INSTALL_ROOT="${SOVEREIGN_NODE_INSTALL_ROOT:-/opt/sovereign-ai-node}"
APP_DIR="${INSTALL_ROOT}/app"
SERVICE_NAME="${SOVEREIGN_NODE_SERVICE_NAME:-sovereign-node-api}"
SERVICE_USER="${SOVEREIGN_NODE_SERVICE_USER:-sovereign-node}"
SERVICE_GROUP="${SOVEREIGN_NODE_SERVICE_GROUP:-}"
ENV_FILE="${SOVEREIGN_NODE_ENV_FILE:-/etc/default/sovereign-node-api}"
API_HOST="${SOVEREIGN_NODE_API_HOST:-127.0.0.1}"
API_PORT="${SOVEREIGN_NODE_API_PORT:-8787}"
REQUEST_FILE="${SOVEREIGN_NODE_REQUEST_FILE:-/etc/sovereign-node/install-request.json}"
RUN_INSTALL="${SOVEREIGN_NODE_RUN_INSTALL:-1}"
NON_INTERACTIVE="${SOVEREIGN_NODE_NON_INTERACTIVE:-0}"

log() {
  printf '[%s] %s\n' "$SCRIPT_NAME" "$*"
}

die() {
  printf '[%s] ERROR: %s\n' "$SCRIPT_NAME" "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Options:
  --repo-url <url>         Git URL for sovereign-ai-node (default: https://github.com/ndee/sovereign-ai-node)
  --source-dir <path>      Local source directory (alternative to --repo-url)
  --ref <ref>              Git ref (default: main)
  --install-root <path>    Install root (default: /opt/sovereign-ai-node)
  --service-user <user>    systemd service user (default: sovereign-node)
  --service-group <group>  systemd service group (default: same as service user)
  --api-host <host>        API bind host (default: 127.0.0.1)
  --api-port <port>        API bind port (default: 8787)
  --request-file <path>    Install request output path (default: /etc/sovereign-node/install-request.json)
  --skip-install-run       Only bootstrap host; do not run sovereign-node install
  --non-interactive        Do not prompt; keep/generate request file and exit
  -h, --help               Show help
EOF
}

normalize_service_identity() {
  if [[ -z "$SERVICE_GROUP" ]]; then
    SERVICE_GROUP="$SERVICE_USER"
  fi
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --repo-url)
        REPO_URL="$2"
        shift 2
        ;;
      --source-dir)
        SOURCE_DIR="$2"
        shift 2
        ;;
      --ref)
        REF="$2"
        shift 2
        ;;
      --install-root)
        INSTALL_ROOT="$2"
        APP_DIR="${INSTALL_ROOT}/app"
        shift 2
        ;;
      --service-user)
        SERVICE_USER="$2"
        shift 2
        ;;
      --service-group)
        SERVICE_GROUP="$2"
        shift 2
        ;;
      --api-host)
        API_HOST="$2"
        shift 2
        ;;
      --api-port)
        API_PORT="$2"
        shift 2
        ;;
      --request-file)
        REQUEST_FILE="$2"
        shift 2
        ;;
      --skip-install-run)
        RUN_INSTALL="0"
        shift
        ;;
      --non-interactive)
        NON_INTERACTIVE="1"
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        die "Unknown argument: $1"
        ;;
    esac
  done
}

require_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    die "Run as root (for example: sudo bash scripts/install.sh ...)"
  fi
}

ensure_supported_os() {
  if [[ ! -f /etc/os-release ]]; then
    die "Cannot detect OS (missing /etc/os-release)"
  fi

  # shellcheck disable=SC1091
  source /etc/os-release
  case "${ID:-}" in
    ubuntu|debian)
      return 0
      ;;
    *)
      die "Unsupported OS '${ID:-unknown}'. This installer currently supports Ubuntu/Debian."
      ;;
  esac
}

install_base_packages() {
  log "Installing base packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y \
    ca-certificates \
    curl \
    git \
    build-essential \
    gnupg
}

node_major_version() {
  if ! command -v node >/dev/null 2>&1; then
    echo "0"
    return
  fi
  node -v | sed -E 's/^v([0-9]+).*/\1/'
}

install_node22_if_needed() {
  local major
  major="$(node_major_version)"
  if [[ "$major" -ge 22 ]]; then
    log "Node.js v${major} detected (>=22), skipping Node install"
    return
  fi

  log "Installing Node.js 22"
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list

  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y nodejs
}

ensure_service_account() {
  if [[ "$SERVICE_USER" == "root" ]]; then
    return
  fi

  if ! getent group "$SERVICE_GROUP" >/dev/null 2>&1; then
    groupadd --system "$SERVICE_GROUP"
  fi

  if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
    useradd \
      --system \
      --gid "$SERVICE_GROUP" \
      --home /var/lib/sovereign-node \
      --create-home \
      --shell /usr/sbin/nologin \
      "$SERVICE_USER"
  fi

  if getent group docker >/dev/null 2>&1; then
    usermod -aG docker "$SERVICE_USER" || true
  fi
}

ensure_runtime_directories() {
  log "Preparing runtime directories"

  install -d -m 0755 /etc/sovereign-node
  install -d -m 0700 /etc/sovereign-node/secrets
  install -d -m 0755 /var/lib/sovereign-node
  install -d -m 0755 /var/lib/sovereign-node/openclaw-home
  install -d -m 0755 /var/lib/sovereign-node/install-jobs
  install -d -m 0755 /var/log/sovereign-node
  install -d -m 0755 "$INSTALL_ROOT"

  chown -R "${SERVICE_USER}:${SERVICE_GROUP}" \
    /etc/sovereign-node \
    /var/lib/sovereign-node \
    /var/log/sovereign-node
}

resolve_source_mode() {
  if [[ -n "$SOURCE_DIR" ]]; then
    [[ -d "$SOURCE_DIR" ]] || die "Source directory does not exist: $SOURCE_DIR"
    return
  fi

  if [[ -n "$REPO_URL" ]]; then
    return
  fi

  if [[ -f "./package.json" ]] && grep -q '"name": "sovereign-ai-node"' "./package.json"; then
    SOURCE_DIR="$(pwd)"
    log "Using local source directory: $SOURCE_DIR"
    return
  fi

  die "Missing source. Provide --source-dir <path> or --repo-url <url>."
}

sync_app_source() {
  log "Syncing application source into $APP_DIR"
  rm -rf "$APP_DIR"
  install -d -m 0755 "$APP_DIR"

  if [[ -n "$SOURCE_DIR" ]]; then
    cp -a "${SOURCE_DIR}/." "$APP_DIR/"
    rm -rf "$APP_DIR/node_modules" "$APP_DIR/dist" "$APP_DIR/.git"
    return
  fi

  git clone --depth 1 --branch "$REF" "$REPO_URL" "$APP_DIR" || {
    rm -rf "$APP_DIR"
    git clone "$REPO_URL" "$APP_DIR"
    git -C "$APP_DIR" checkout "$REF"
  }
}

build_app() {
  log "Installing dependencies and building app"
  (
    cd "$APP_DIR"
    npm ci
    npm run build
  )
}

install_wrappers() {
  log "Installing CLI wrappers into /usr/local/bin"

  cat > /usr/local/bin/sovereign-node <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec node "$APP_DIR/dist/sovereign-node.js" "\$@"
EOF

  cat > /usr/local/bin/sovereign-node-api <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec node "$APP_DIR/dist/sovereign-node-api.js" "\$@"
EOF

  chmod 0755 /usr/local/bin/sovereign-node /usr/local/bin/sovereign-node-api
}

install_systemd_unit() {
  local template unit_path
  template="$APP_DIR/deploy/systemd/sovereign-node-api.service"
  unit_path="/etc/systemd/system/${SERVICE_NAME}.service"

  [[ -f "$template" ]] || die "Missing systemd unit template: $template"

  sed \
    -e "s|__SERVICE_USER__|${SERVICE_USER}|g" \
    -e "s|__SERVICE_GROUP__|${SERVICE_GROUP}|g" \
    -e "s|__ENV_FILE__|${ENV_FILE}|g" \
    -e "s|__APP_DIR__|${APP_DIR}|g" \
    "$template" > "$unit_path"

  if [[ ! -f "$ENV_FILE" ]]; then
    install -d -m 0755 "$(dirname "$ENV_FILE")"
    cat > "$ENV_FILE" <<EOF
SOVEREIGN_NODE_API_HOST=${API_HOST}
SOVEREIGN_NODE_API_PORT=${API_PORT}
EOF
    chmod 0644 "$ENV_FILE"
  fi

  systemctl daemon-reload
  systemctl enable --now "${SERVICE_NAME}.service"
}

install_request_template() {
  local src dst
  src="$APP_DIR/deploy/install-request.example.json"
  dst="/etc/sovereign-node/install-request.example.json"
  [[ -f "$src" ]] || die "Missing request template: $src"
  cp "$src" "$dst"
  chmod 0640 "$dst"
}

has_tty() {
  [[ -e /dev/tty ]]
}

prompt_value() {
  local prompt default value
  prompt="$1"
  default="${2:-}"
  if [[ -n "$default" ]]; then
    printf "%s [%s]: " "$prompt" "$default" > /dev/tty
  else
    printf "%s: " "$prompt" > /dev/tty
  fi
  IFS= read -r value < /dev/tty || true
  if [[ -z "$value" ]]; then
    value="$default"
  fi
  printf '%s' "$value"
}

prompt_secret() {
  local prompt value
  prompt="$1"
  printf "%s: " "$prompt" > /dev/tty
  stty -echo < /dev/tty
  IFS= read -r value < /dev/tty || true
  stty echo < /dev/tty
  printf "\n" > /dev/tty
  printf '%s' "$value"
}

prompt_yes_no() {
  local prompt default answer normalized
  prompt="$1"
  default="$2"
  while true; do
    printf "%s [%s/%s] (default: %s): " \
      "$prompt" \
      "y" \
      "n" \
      "$default" > /dev/tty
    IFS= read -r answer < /dev/tty || true
    normalized="$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]')"
    if [[ -z "$normalized" ]]; then
      normalized="$default"
    fi
    case "$normalized" in
      y|yes)
        printf '1'
        return
        ;;
      n|no)
        printf '0'
        return
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

run_install_wizard() {
  local openrouter_api_key openrouter_model matrix_domain matrix_public_base_url
  local operator_username alert_room_name poll_interval lookback_window federation_enabled
  local configure_imap imap_host imap_port imap_tls imap_username imap_password imap_mailbox
  local openrouter_secret_path imap_secret_path

  log "Starting guided Sovereign Node install wizard"

  openrouter_api_key="$(prompt_secret "OpenRouter API key (sk-or-...)")"
  while [[ -z "$openrouter_api_key" ]]; do
    printf "OpenRouter API key is required.\n" > /dev/tty
    openrouter_api_key="$(prompt_secret "OpenRouter API key (sk-or-...)")"
  done

  openrouter_model="$(prompt_value "OpenRouter model" "openrouter/anthropic/claude-sonnet-4-5")"
  matrix_domain="$(prompt_value "Matrix homeserver domain" "matrix.local.test")"
  matrix_public_base_url="$(prompt_value "Matrix public base URL" "http://127.0.0.1:8008")"
  operator_username="$(prompt_value "Operator username" "operator")"
  alert_room_name="$(prompt_value "Alert room name" "Sovereign Alerts")"
  poll_interval="$(prompt_value "Mail Sentinel poll interval" "5m")"
  lookback_window="$(prompt_value "Mail Sentinel lookback window" "15m")"
  federation_enabled="$(prompt_yes_no "Enable Matrix federation?" "n")"
  configure_imap="$(prompt_yes_no "Configure IMAP now? (choose no to keep IMAP pending)" "n")"

  imap_host=""
  imap_port="993"
  imap_tls="1"
  imap_username=""
  imap_password=""
  imap_mailbox="INBOX"

  if [[ "$configure_imap" == "1" ]]; then
    imap_host="$(prompt_value "IMAP host" "imap.example.org")"
    imap_port="$(prompt_value "IMAP port" "993")"
    imap_tls="$(prompt_yes_no "Use TLS for IMAP?" "y")"
    imap_username="$(prompt_value "IMAP username" "operator@example.org")"
    imap_password="$(prompt_secret "IMAP password/app password")"
    while [[ -z "$imap_password" ]]; do
      printf "IMAP password is required when IMAP is configured.\n" > /dev/tty
      imap_password="$(prompt_secret "IMAP password/app password")"
    done
    imap_mailbox="$(prompt_value "IMAP mailbox" "INBOX")"
  fi

  openrouter_secret_path="/etc/sovereign-node/secrets/openrouter-api-key"
  write_secret_file "$openrouter_secret_path" "$openrouter_api_key"

  imap_secret_path="/etc/sovereign-node/secrets/imap-password"
  if [[ "$configure_imap" == "1" ]]; then
    write_secret_file "$imap_secret_path" "$imap_password"
  fi

  export SN_REQUEST_FILE="$REQUEST_FILE"
  export SN_OPENROUTER_MODEL="$openrouter_model"
  export SN_OPENROUTER_SECRET_REF="file:${openrouter_secret_path}"
  export SN_MATRIX_DOMAIN="$matrix_domain"
  export SN_MATRIX_PUBLIC_BASE_URL="$matrix_public_base_url"
  export SN_MATRIX_FEDERATION_ENABLED="$federation_enabled"
  export SN_OPERATOR_USERNAME="$operator_username"
  export SN_ALERT_ROOM_NAME="$alert_room_name"
  export SN_POLL_INTERVAL="$poll_interval"
  export SN_LOOKBACK_WINDOW="$lookback_window"
  export SN_IMAP_CONFIGURE="$configure_imap"
  export SN_IMAP_HOST="$imap_host"
  export SN_IMAP_PORT="$imap_port"
  export SN_IMAP_TLS="$imap_tls"
  export SN_IMAP_USERNAME="$imap_username"
  export SN_IMAP_SECRET_REF="file:${imap_secret_path}"
  export SN_IMAP_MAILBOX="$imap_mailbox"

  node <<'NODE'
const fs = require("node:fs");
const req = {
  mode: "bundled_matrix",
  openclaw: {
    manageInstallation: true,
    installMethod: "install_sh",
    version: "pinned-by-sovereign",
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
    publicBaseUrl: process.env.SN_MATRIX_PUBLIC_BASE_URL,
    federationEnabled: process.env.SN_MATRIX_FEDERATION_ENABLED === "1",
    tlsMode: "local-dev",
    alertRoomName: process.env.SN_ALERT_ROOM_NAME,
  },
  operator: {
    username: process.env.SN_OPERATOR_USERNAME,
  },
  mailSentinel: {
    pollInterval: process.env.SN_POLL_INTERVAL,
    lookbackWindow: process.env.SN_LOOKBACK_WINDOW,
    e2eeAlertRoom: false,
  },
  advanced: {
    nonInteractive: true,
  },
};

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

prepare_request_file() {
  if [[ "$NON_INTERACTIVE" == "1" ]]; then
    if [[ ! -f "$REQUEST_FILE" ]]; then
      cp /etc/sovereign-node/install-request.example.json "$REQUEST_FILE"
      chmod 0640 "$REQUEST_FILE"
      chown "${SERVICE_USER}:${SERVICE_GROUP}" "$REQUEST_FILE" || true
      log "Non-interactive mode: wrote template request to $REQUEST_FILE"
    fi
    return
  fi

  if ! has_tty; then
    if [[ ! -f "$REQUEST_FILE" ]]; then
      cp /etc/sovereign-node/install-request.example.json "$REQUEST_FILE"
      chmod 0640 "$REQUEST_FILE"
      chown "${SERVICE_USER}:${SERVICE_GROUP}" "$REQUEST_FILE" || true
    fi
    log "No TTY available; skipping interactive installer wizard"
    RUN_INSTALL="0"
    return
  fi

  run_install_wizard
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
  process.stdout.write("succeeded\tInstall job completed successfully");
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
  && openclaw.agentPresent === true
  && openclaw.cronPresent === true;

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
  local max_attempts delay_s attempt status_output parsed readiness_flag readiness_reason
  max_attempts="${1:-45}"
  delay_s="${2:-2}"

  for attempt in $(seq 1 "$max_attempts"); do
    status_output="$(timeout --foreground 20s sovereign-node status --json || true)"
    parsed="$(parse_runtime_readiness "$status_output")"
    readiness_flag="${parsed%%$'\t'*}"
    readiness_reason="${parsed#*$'\t'}"

    if [[ "$readiness_flag" == "1" ]]; then
      printf '%s\n' "$status_output"
      return 0
    fi

    if [[ "$attempt" -lt "$max_attempts" ]]; then
      log "Runtime not ready yet (${attempt}/${max_attempts}): ${readiness_reason}"
      sleep "$delay_s"
    else
      printf '%s\n' "$status_output"
      return 1
    fi
  done
}

run_install_flow() {
  local install_output install_exit_code parsed install_state install_summary status_output doctor_output

  if [[ "$RUN_INSTALL" != "1" ]]; then
    log "Skipping sovereign-node install run (--skip-install-run)"
    return
  fi

  if [[ ! -f "$REQUEST_FILE" ]]; then
    die "Install request file not found: $REQUEST_FILE"
  fi

  log "Running sovereign-node install"
  set +e
  install_output="$(
    timeout --foreground 30m env \
      "SOVEREIGN_NODE_SERVICE_USER=$SERVICE_USER" \
      "SOVEREIGN_NODE_SERVICE_GROUP=$SERVICE_GROUP" \
      sovereign-node install --request-file "$REQUEST_FILE" --json
  )"
  install_exit_code=$?
  set -e
  printf '%s\n' "$install_output"

  if [[ "$install_exit_code" -eq 124 ]]; then
    die "Install did not complete within 30 minutes"
  fi
  if [[ "$install_exit_code" -ne 0 ]]; then
    die "Install command exited with status ${install_exit_code}"
  fi

  parsed="$(parse_install_result "$install_output")"
  install_state="${parsed%%$'\t'*}"
  install_summary="${parsed#*$'\t'}"
  if [[ "$install_state" != "succeeded" ]]; then
    die "Install did not complete successfully (${install_summary})"
  fi

  log "Install job succeeded. Waiting for Matrix and OpenClaw runtime readiness"
  if ! status_output="$(wait_for_runtime_ready 45 2)"; then
    printf '%s\n' "$status_output"
    die "Runtime did not reach healthy state for Matrix/OpenClaw within timeout"
  fi
  printf '%s\n' "$status_output"

  log "Running post-install diagnostics"
  doctor_output="$(sovereign-node doctor --json || true)"
  printf '%s\n' "$doctor_output"
}

main() {
  parse_args "$@"
  normalize_service_identity
  require_root
  ensure_supported_os
  resolve_source_mode
  install_base_packages
  install_node22_if_needed
  ensure_service_account
  ensure_runtime_directories
  sync_app_source
  build_app
  install_wrappers
  install_systemd_unit
  install_request_template
  prepare_request_file
  run_install_flow

  cat <<EOF
Bootstrap completed.

Request file: ${REQUEST_FILE}

Useful commands:
- sovereign-node install --request-file ${REQUEST_FILE} --json
- sovereign-node status --json
- sovereign-node doctor --json
EOF
}

main "$@"
