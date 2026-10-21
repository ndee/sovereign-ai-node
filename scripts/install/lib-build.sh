# shellcheck shell=bash
# lib-build: app/bot package build, CLI wrapper install, systemd unit, system
# hygiene, request-file template, installation detection.
#
# Depends on lib-log (log, die) and expects base apt packages + Docker + Node
# already installed. Reads NODE_ARTIFACT, APP_DIR, BOTS_DIR, SERVICE_USER, SERVICE_GROUP,
# SERVICE_NAME, INSTALL_ROOT, API_HOST, API_PORT, ENV_FILE, REQUEST_FILE,
# RUNTIME_CONFIG_FILE, INSTALLATION_DETECTED, CONFIGURED_INSTALLATION.

build_app() {
  if [[ -n "$NODE_ARTIFACT" ]]; then
    log "Using verified prebuilt Node runtime; skipping source dependency install and application build"
    return 0
  fi

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
  if [[ -n "$BOTS_ARTIFACT" ]]; then
    log "Using verified prebuilt bot catalog; skipping dependency install and bot build"
    return 0
  fi

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

  # --- docker install helper for the API service ---
  # The sovereign-node-api service may need to install Docker during a
  # bundled-Matrix install run that did not go through scripts/install.sh
  # (typically the pro web installer). Drop a narrowly-scoped helper that
  # delegates to install_docker_if_needed in lib-runtime-deps.sh and a
  # sudoers entry so the SERVICE_USER can call exactly that one script.
  local docker_helper_dir="/usr/local/lib/sovereign-node"
  local docker_helper_path="${docker_helper_dir}/install-docker.sh"
  local docker_helper_libs="${docker_helper_dir}/install"
  install -d -m 0755 "$docker_helper_dir"
  install -d -m 0755 "$docker_helper_libs"
  install -m 0755 "$APP_DIR/scripts/install-docker.sh" "$docker_helper_path"
  install -m 0644 "$APP_DIR/scripts/install/lib-log.sh" "$docker_helper_libs/lib-log.sh"
  install -m 0644 "$APP_DIR/scripts/install/lib-os.sh" "$docker_helper_libs/lib-os.sh"
  install -m 0644 "$APP_DIR/scripts/install/lib-runtime-deps.sh" \
    "$docker_helper_libs/lib-runtime-deps.sh"

  install_privileged_helpers
  install_service_sudoers
}

# Root-owned helpers the runtime API reaches through sudo instead of raw
# root commands: installing a managed systemd unit, running the bundled
# Matrix stack's docker commands, and reclaiming ownership of a fixed set of
# node directories. Each helper validates its arguments against a fixed list
# and reads the service identity from a root-owned settings file, so nothing
# the service user controls decides what runs as root.
install_privileged_helpers() {
  local helper_dir="/usr/local/lib/sovereign-node"
  local module_dir="${helper_dir}/helpers"
  local node_bin name module
  node_bin="$(command -v node)" || die "node is required for the privileged helpers"

  install -d -m 0755 "$helper_dir" "$module_dir" "$module_dir/bin"
  install -m 0644 "$APP_DIR/scripts/install/js/privileged-helper-config.mjs" \
    "$module_dir/privileged-helper-config.mjs"
  for module in \
    privileged-systemd-unit.mjs \
    privileged-bundled-matrix-docker.mjs \
    privileged-reclaim-ownership.mjs; do
    install -m 0644 "$APP_DIR/scripts/install/js/$module" "$module_dir/$module"
    install -m 0644 "$APP_DIR/scripts/install/js/bin/$module" "$module_dir/bin/$module"
  done

  local conf_tmp
  conf_tmp="$(mktemp "${helper_dir}/.privileged-helpers.conf.XXXXXX")"
  cat > "$conf_tmp" <<EOF
# Managed by sovereign-ai-node installer. Read by the privileged helpers.
SERVICE_USER=${SERVICE_USER}
SERVICE_GROUP=${SERVICE_GROUP}
SERVICE_UID=$(id -u "$SERVICE_USER")
SERVICE_GID=$(getent group "$SERVICE_GROUP" | cut -d: -f3)
STATE_DIR=/var/lib/sovereign-node
CONFIG_DIR=/etc/sovereign-node
APP_DIR=${APP_DIR}
EOF
  chmod 0644 "$conf_tmp"
  mv -f "$conf_tmp" "${helper_dir}/privileged-helpers.conf"

  for name in install-systemd-unit bundled-matrix-docker reclaim-ownership; do
    case "$name" in
      install-systemd-unit) module=privileged-systemd-unit.mjs ;;
      bundled-matrix-docker) module=privileged-bundled-matrix-docker.mjs ;;
      reclaim-ownership) module=privileged-reclaim-ownership.mjs ;;
    esac
    cat > "${helper_dir}/${name}" <<EOF
#!/bin/sh
# Managed by sovereign-ai-node installer. Runs with an empty environment so
# nothing from the calling user reaches the node runtime.
exec /usr/bin/env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \\
  "${node_bin}" "${module_dir}/bin/${module}" "\$@"
EOF
    chmod 0755 "${helper_dir}/${name}"
  done
}

# Prints the sudoers fragment for the runtime API's service user. Every rule
# names an exact command line or one of the root-owned helpers above; there
# are no argument wildcards and no rule that writes a file chosen by the
# caller.
render_service_sudoers() {
  local user="$1"
  local helper_dir="/usr/local/lib/sovereign-node"
  local unit
  cat <<EOF
# Managed by sovereign-ai-node installer. Scoped sudo for the runtime API
# service: root-owned validating helpers plus exact systemctl commands for the
# node's own units.
${user} ALL=(root) NOPASSWD: ${helper_dir}/install-systemd-unit
${user} ALL=(root) NOPASSWD: ${helper_dir}/bundled-matrix-docker
${user} ALL=(root) NOPASSWD: ${helper_dir}/reclaim-ownership
${user} ALL=(root) NOPASSWD: ${helper_dir}/install-docker.sh
${user} ALL=(root) NOPASSWD: /bin/systemctl daemon-reload
EOF
  for unit in sovereign-openclaw-gateway sovereign-matrix-relay-tunnel; do
    cat <<EOF
${user} ALL=(root) NOPASSWD: /bin/systemctl restart ${unit}, /bin/systemctl restart ${unit}.service
${user} ALL=(root) NOPASSWD: /bin/systemctl enable --now ${unit}, /bin/systemctl enable --now ${unit}.service
${user} ALL=(root) NOPASSWD: /bin/systemctl is-active ${unit}, /bin/systemctl is-active ${unit}.service
${user} ALL=(root) NOPASSWD: /bin/systemctl status ${unit}, /bin/systemctl status ${unit}.service
EOF
  done
  unit=sovereign-mail-sentinel-scan
  cat <<EOF
${user} ALL=(root) NOPASSWD: /bin/systemctl enable ${unit}.service, /bin/systemctl enable ${unit}.timer
${user} ALL=(root) NOPASSWD: /bin/systemctl restart ${unit}.service, /bin/systemctl restart ${unit}.timer
${user} ALL=(root) NOPASSWD: /bin/systemctl is-active ${unit}.service, /bin/systemctl is-active ${unit}.timer
${user} ALL=(root) NOPASSWD: /bin/systemctl is-enabled ${unit}.service, /bin/systemctl is-enabled ${unit}.timer
EOF
}

# The fragment is validated with visudo before it replaces the installed one,
# so a bad render never reaches /etc/sudoers.d. If it does not validate, the
# old fragment is removed rather than left in place with its broader rules.
install_service_sudoers() {
  local sudoers_path="/etc/sudoers.d/sovereign-node-gateway"
  local candidate
  install -d -m 0755 /etc/sudoers.d
  candidate="$(mktemp)"
  render_service_sudoers "$SERVICE_USER" > "$candidate"
  chmod 0440 "$candidate"
  if visudo -cf "$candidate" >/dev/null 2>&1; then
    install -m 0440 -o root -g root "$candidate" "$sudoers_path"
  else
    rm -f "$sudoers_path"
    log "WARN: sudoers fragment for ${SERVICE_USER} failed validation; removed"
  fi
  rm -f "$candidate"
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
