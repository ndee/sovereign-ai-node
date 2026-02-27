#!/usr/bin/env bash
set -euo pipefail

SCRIPT_NAME="$(basename "$0")"

REPO_URL="${SOVEREIGN_NODE_REPO_URL:-https://github.com/ndee/sovereign-ai-node}"
SOURCE_DIR="${SOVEREIGN_NODE_SOURCE_DIR:-}"
REF="${SOVEREIGN_NODE_REF:-main}"
INSTALL_ROOT="${SOVEREIGN_NODE_INSTALL_ROOT:-/opt/sovereign-ai-node}"
APP_DIR="${INSTALL_ROOT}/app"
SERVICE_NAME="${SOVEREIGN_NODE_SERVICE_NAME:-sovereign-node-api}"
SERVICE_USER="${SOVEREIGN_NODE_SERVICE_USER:-root}"
SERVICE_GROUP="${SOVEREIGN_NODE_SERVICE_GROUP:-root}"
ENV_FILE="${SOVEREIGN_NODE_ENV_FILE:-/etc/default/sovereign-node-api}"
API_HOST="${SOVEREIGN_NODE_API_HOST:-127.0.0.1}"
API_PORT="${SOVEREIGN_NODE_API_PORT:-8787}"

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
  --service-user <user>    systemd service user (default: root)
  --service-group <group>  systemd service group (default: root)
  --api-host <host>        API bind host (default: 127.0.0.1)
  --api-port <port>        API bind port (default: 8787)
  -h, --help               Show help
EOF
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

main() {
  parse_args "$@"
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

  cat <<'EOF'
Install completed.

Next steps:
1. Create IMAP secret:
   printf '%s\n' '<imap-password>' > /etc/sovereign-node/secrets/imap-password
   chmod 600 /etc/sovereign-node/secrets/imap-password
2. Copy and edit the request file:
   cp /etc/sovereign-node/install-request.example.json /etc/sovereign-node/install-request.json
3. Run install flow:
   sovereign-node install --request-file /etc/sovereign-node/install-request.json --json
4. Verify:
   sovereign-node status --json
   sovereign-node doctor --json
EOF
}

main "$@"
