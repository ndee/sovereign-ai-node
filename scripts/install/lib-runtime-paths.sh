# shellcheck shell=bash
# lib-runtime-paths: service account + runtime directories + source sync +
# install-provenance writer.
#
# Depends on lib-log (log, die). Reads SERVICE_USER, SERVICE_GROUP, INSTALL_ROOT,
# APP_DIR, BOTS_DIR, SOURCE_DIR, BOTS_SOURCE_DIR, REPO_URL, REF, BOTS_REPO_URL,
# BOTS_REF, PROVENANCE_FILE.

ensure_service_account() {
  if [[ "$SERVICE_USER" == "root" ]]; then
    return
  fi

  if ! getent group "$SERVICE_GROUP" >/dev/null 2>&1; then
    groupadd --system "$SERVICE_GROUP"
  fi

  if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
    if [[ -d /var/lib/sovereign-node ]]; then
      useradd \
        --system \
        --gid "$SERVICE_GROUP" \
        --home /var/lib/sovereign-node \
        --shell /usr/sbin/nologin \
        "$SERVICE_USER"
    else
      useradd \
        --system \
        --gid "$SERVICE_GROUP" \
        --home /var/lib/sovereign-node \
        --create-home \
        --shell /usr/sbin/nologin \
        "$SERVICE_USER"
    fi
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
    /var/log/sovereign-node

  # /var/lib/sovereign-node is chowned with exclusions. Container-managed
  # subtrees (bundled Matrix Postgres data, Synapse data files) are owned
  # by UIDs from inside the containers (postgres=70, synapse=991). A blind
  # recursive chown to SERVICE_USER locks those containers out of their
  # own files — Postgres then fails with "could not open file ... Permission
  # denied" on every subsequent Matrix login, surfacing as HTTP 500
  # "Problem storing device." Any path under bundled-matrix/*/postgres-data
  # or */synapse stays untouched so the compose stack keeps working across
  # re-runs of `sovereign-node update`.
  find /var/lib/sovereign-node \
    -mindepth 1 \
    \( -path '*/bundled-matrix/*/postgres-data' -o -path '*/bundled-matrix/*/synapse' \) -prune \
    -o -print0 \
    | xargs -0 --no-run-if-empty chown "${SERVICE_USER}:${SERVICE_GROUP}"
  chown "${SERVICE_USER}:${SERVICE_GROUP}" /var/lib/sovereign-node
}

resolve_source_mode() {
  local detected_bots_source

  if [[ -n "$SOURCE_DIR" ]]; then
    [[ -d "$SOURCE_DIR" ]] || die "Source directory does not exist: $SOURCE_DIR"
  elif [[ -n "$REPO_URL" ]]; then
    :
  elif [[ -f "./package.json" ]] && grep -q '"name": "sovereign-ai-node"' "./package.json"; then
    SOURCE_DIR="$(pwd)"
    log "Using local source directory: $SOURCE_DIR"
  else
    die "Missing source. Provide --source-dir <path> or --repo-url <url>."
  fi

  if [[ -n "$BOTS_SOURCE_DIR" ]]; then
    [[ -d "$BOTS_SOURCE_DIR" ]] || die "Bot source directory does not exist: $BOTS_SOURCE_DIR"
    return
  fi

  if [[ -n "$BOTS_REPO_URL" ]]; then
    return
  fi

  detected_bots_source="$(find_local_bots_source_dir)"
  if [[ -n "$detected_bots_source" ]]; then
    BOTS_SOURCE_DIR="$detected_bots_source"
    log "Using local bots source directory: $BOTS_SOURCE_DIR"
    return
  fi

  die "Missing bot source. Provide --bots-source-dir <path> or --bots-repo-url <url>."
}

find_local_bots_source_dir() {
  local sibling_root candidate

  if [[ -z "$SOURCE_DIR" ]]; then
    return 0
  fi

  sibling_root="$(dirname "$SOURCE_DIR")"
  candidate="${sibling_root}/sovereign-ai-bots"
  if [[ -d "$candidate" ]]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  for candidate in "${sibling_root}"/sovereign-ai-bots-*; do
    if [[ -d "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 0
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

sync_bots_source() {
  log "Syncing bot packages into $BOTS_DIR"
  rm -rf "$BOTS_DIR"
  install -d -m 0755 "$BOTS_DIR"

  if [[ -n "$BOTS_SOURCE_DIR" ]]; then
    cp -a "${BOTS_SOURCE_DIR}/." "$BOTS_DIR/"
    rm -rf "$BOTS_DIR/node_modules" "$BOTS_DIR/dist" "$BOTS_DIR/.git"
    return
  fi

  git clone --depth 1 --branch "$BOTS_REF" "$BOTS_REPO_URL" "$BOTS_DIR" || {
    rm -rf "$BOTS_DIR"
    git clone "$BOTS_REPO_URL" "$BOTS_DIR"
    git -C "$BOTS_DIR" checkout "$BOTS_REF"
  }
}

write_install_provenance() {
  local node_commit_sha="unknown"
  local node_ref_resolved="$REF"
  local node_repo="$REPO_URL"
  local bots_commit_sha="unknown"
  local bots_ref_resolved="$BOTS_REF"
  local bots_repo="$BOTS_REPO_URL"
  local install_source="git-clone"

  if [[ -n "$SOURCE_DIR" ]]; then
    install_source="local-copy"
    node_repo="local-copy"
    if [[ -d "${SOURCE_DIR}/.git" ]]; then
      node_commit_sha="$(git -C "$SOURCE_DIR" rev-parse HEAD 2>/dev/null || echo "unknown")"
      node_ref_resolved="$(git -C "$SOURCE_DIR" symbolic-ref --short HEAD 2>/dev/null || echo "$REF")"
    fi
  elif [[ -d "${APP_DIR}/.git" ]]; then
    node_commit_sha="$(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || echo "unknown")"
  fi

  if [[ -n "$BOTS_SOURCE_DIR" ]]; then
    bots_repo="local-copy"
    if [[ -d "${BOTS_SOURCE_DIR}/.git" ]]; then
      bots_commit_sha="$(git -C "$BOTS_SOURCE_DIR" rev-parse HEAD 2>/dev/null || echo "unknown")"
      bots_ref_resolved="$(git -C "$BOTS_SOURCE_DIR" symbolic-ref --short HEAD 2>/dev/null || echo "$BOTS_REF")"
    fi
  elif [[ -d "${BOTS_DIR}/.git" ]]; then
    bots_commit_sha="$(git -C "$BOTS_DIR" rev-parse HEAD 2>/dev/null || echo "unknown")"
  fi

  # Detect curl-installer mode: when piped from stdin there is no SOURCE_DIR
  if [[ -z "$SOURCE_DIR" && "$REPO_URL" == *"github.com"* ]]; then
    install_source="curl-installer"
  fi

  local node_version="unknown"
  local bots_version="unknown"
  local node_pkg_dir="${SOURCE_DIR:-$APP_DIR}"
  local bots_pkg_dir="${BOTS_SOURCE_DIR:-$BOTS_DIR}"
  if [[ -f "${node_pkg_dir}/package.json" ]]; then
    node_version="$(jq -r '.version // "unknown"' "${node_pkg_dir}/package.json" 2>/dev/null || echo "unknown")"
  fi
  if [[ -f "${bots_pkg_dir}/package.json" ]]; then
    bots_version="$(jq -r '.version // "unknown"' "${bots_pkg_dir}/package.json" 2>/dev/null || echo "unknown")"
  fi

  local installed_at
  installed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  cat > "$PROVENANCE_FILE" <<PROVENANCE_EOF
{
  "nodeRepoUrl": "${node_repo}",
  "nodeRef": "${node_ref_resolved}",
  "nodeVersion": "${node_version}",
  "nodeCommitSha": "${node_commit_sha}",
  "botsRepoUrl": "${bots_repo}",
  "botsRef": "${bots_ref_resolved}",
  "botsVersion": "${bots_version}",
  "botsCommitSha": "${bots_commit_sha}",
  "installedAt": "${installed_at}",
  "installSource": "${install_source}"
}
PROVENANCE_EOF

  chmod 0644 "$PROVENANCE_FILE"
  chown "${SERVICE_USER}:${SERVICE_GROUP}" "$PROVENANCE_FILE" 2>/dev/null || true
  log "Install provenance written to $PROVENANCE_FILE"
}

