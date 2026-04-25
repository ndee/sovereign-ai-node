# shellcheck shell=bash
# lib-build: app/bot package build, CLI wrapper install, systemd unit, system
# hygiene, request-file template, installation detection.
#
# Depends on lib-log (log, die) and expects base apt packages + Docker + Node
# already installed. Reads APP_DIR, BOTS_DIR, SERVICE_USER, SERVICE_GROUP,
# SERVICE_NAME, INSTALL_ROOT, API_HOST, API_PORT, ENV_FILE, REQUEST_FILE,
# RUNTIME_CONFIG_FILE, INSTALLATION_DETECTED, CONFIGURED_INSTALLATION.

build_app() {
  log "Installing dependencies and building app"
  (
    cd "$APP_DIR"
    if [[ -f "pnpm-lock.yaml" ]]; then
      if command -v corepack >/dev/null 2>&1; then
        corepack pnpm install --frozen-lockfile
        corepack pnpm run build
        exit 0
      fi

      if command -v pnpm >/dev/null 2>&1; then
        pnpm install --frozen-lockfile
        pnpm run build
        exit 0
      fi

      die "pnpm lockfile detected but neither corepack nor pnpm is available"
    fi

    npm ci
    npm run build
  )
}

build_bots() {
  if [[ ! -f "${BOTS_DIR}/package.json" ]]; then
    log "No package.json under ${BOTS_DIR}; skipping bot build"
    return 0
  fi
  log "Installing dependencies and building bots"
  (
    cd "$BOTS_DIR"
    if [[ -f "pnpm-lock.yaml" ]]; then
      if command -v corepack >/dev/null 2>&1; then
        corepack pnpm install --frozen-lockfile
        corepack pnpm run build
        exit 0
      fi

      if command -v pnpm >/dev/null 2>&1; then
        pnpm install --frozen-lockfile
        pnpm run build
        exit 0
      fi

      die "pnpm lockfile detected in ${BOTS_DIR} but neither corepack nor pnpm is available"
    fi

    npm ci
    npm run build
  )
}

install_wrappers() {
  log "Installing CLI wrappers into /usr/local/bin"

cat > /usr/local/bin/sovereign-node <<EOF
#!/usr/bin/env bash
set -euo pipefail
export SOVEREIGN_NODE_APP_DIR="$APP_DIR"
export SOVEREIGN_BOTS_REPO_DIR="$BOTS_DIR"
exec node "$APP_DIR/dist/sovereign-node.js" "\$@"
EOF

  cat > /usr/local/bin/sovereign-node-api <<EOF
#!/usr/bin/env bash
set -euo pipefail
export SOVEREIGN_NODE_APP_DIR="$APP_DIR"
export SOVEREIGN_BOTS_REPO_DIR="$BOTS_DIR"
exec node "$APP_DIR/dist/sovereign-node-api.js" "\$@"
EOF

  cat > /usr/local/bin/sovereign-tool <<EOF
#!/usr/bin/env bash
set -euo pipefail
export SOVEREIGN_NODE_APP_DIR="$APP_DIR"
export SOVEREIGN_BOTS_REPO_DIR="$BOTS_DIR"
exec node "$APP_DIR/dist/sovereign-tool.js" "\$@"
EOF

  chmod 0755 /usr/local/bin/sovereign-node /usr/local/bin/sovereign-node-api /usr/local/bin/sovereign-tool
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
  systemctl enable "${SERVICE_NAME}.service"
  systemctl restart "${SERVICE_NAME}.service"
}

configure_system_hygiene() {
  # --- journald size limit ---
  local journald_dropin="/etc/systemd/journald.conf.d/sovereign-node.conf"
  install -d -m 0755 /etc/systemd/journald.conf.d
  cp "$APP_DIR/deploy/config/journald-sovereign-node.conf" "$journald_dropin"
  chmod 0644 "$journald_dropin"
  systemctl restart systemd-journald 2>/dev/null || true

  # --- logrotate for sovereign-node logs ---
  cp "$APP_DIR/deploy/config/logrotate-sovereign-node" /etc/logrotate.d/sovereign-node
  chmod 0644 /etc/logrotate.d/sovereign-node

  # --- snap retention limit (no-op if snap is absent) ---
  if command -v snap >/dev/null 2>&1; then
    snap set system refresh.retain=2 2>/dev/null || true
  fi

  # --- docker image prune timer ---
  if docker_cli_available; then
    cp "$APP_DIR/deploy/systemd/sovereign-node-docker-prune.service" \
      /etc/systemd/system/sovereign-node-docker-prune.service
    cp "$APP_DIR/deploy/systemd/sovereign-node-docker-prune.timer" \
      /etc/systemd/system/sovereign-node-docker-prune.timer
    systemctl daemon-reload
    systemctl enable --now sovereign-node-docker-prune.timer 2>/dev/null || true
  fi

  # --- reduce reserved blocks on small disks ---
  if command -v tune2fs >/dev/null 2>&1; then
    local root_dev total_kb reserved_pct
    root_dev="$(df -P / | tail -1 | awk '{print $1}')"
    total_kb="$(df -Pk / | tail -1 | awk '{print $2}')"
    if [[ "$total_kb" -lt $((64 * 1024 * 1024)) ]]; then
      reserved_pct="$(tune2fs -l "$root_dev" 2>/dev/null \
        | awk '/Reserved block count/ {rc=$NF} /Block count/ {bc=$NF} END {if (bc>0) printf "%d", rc*100/bc}' || true)"
      if [[ -n "$reserved_pct" ]] && [[ "$reserved_pct" -gt 1 ]]; then
        tune2fs -m 1 "$root_dev" 2>/dev/null || true
        log "Reduced reserved blocks on $root_dev from ${reserved_pct}% to 1%"
      fi
    fi
  fi

  # --- disk space check timer ---
  chmod +x "$APP_DIR/deploy/scripts/sovereign-node-disk-check.sh"
  sed -e "s|__SCRIPTS_DIR__|${APP_DIR}/deploy/scripts|g" \
    "$APP_DIR/deploy/systemd/sovereign-node-disk-check.service" \
    > /etc/systemd/system/sovereign-node-disk-check.service
  cp "$APP_DIR/deploy/systemd/sovereign-node-disk-check.timer" \
    /etc/systemd/system/sovereign-node-disk-check.timer
  systemctl daemon-reload
  systemctl enable --now sovereign-node-disk-check.timer 2>/dev/null || true
}

install_request_template() {
  local src dst selected_bots
  src="$APP_DIR/deploy/install-request.example.json"
  dst="/etc/sovereign-node/install-request.example.json"
  [[ -f "$src" ]] || die "Missing request template: $src"
  selected_bots="$(default_selected_bots_from_catalog)"
  SN_TEMPLATE_SELECTED_BOTS="$selected_bots" node - "$src" "$dst" <<'NODE'
const fs = require("node:fs");

const src = process.argv[2];
const dst = process.argv[3];
const selectedBots = (process.env.SN_TEMPLATE_SELECTED_BOTS || "")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);
const parsed = JSON.parse(fs.readFileSync(src, "utf8"));

if (!parsed.bots || typeof parsed.bots !== "object" || Array.isArray(parsed.bots)) {
  parsed.bots = {};
}
parsed.bots.selected = selectedBots;

if (parsed.bots.config && typeof parsed.bots.config === "object" && !Array.isArray(parsed.bots.config)) {
  if (!selectedBots.includes("mail-sentinel")) {
    delete parsed.bots.config["mail-sentinel"];
  }
  if (Object.keys(parsed.bots.config).length === 0) {
    delete parsed.bots.config;
  }
}

fs.writeFileSync(dst, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
NODE
  chmod 0640 "$dst"
}

detect_installation_state() {
  INSTALLATION_DETECTED="0"
  CONFIGURED_INSTALLATION="0"

  if [[ -e "$REQUEST_FILE" || -e /etc/sovereign-node/sovereign-node.json5 || -x /usr/local/bin/sovereign-node ]]; then
    INSTALLATION_DETECTED="1"
  fi

  if [[ -r "$REQUEST_FILE" ]]; then
    CONFIGURED_INSTALLATION="1"
  fi
}
