# shellcheck shell=bash
# lib-runtime-deps: apt-based bootstrap of the host runtime dependencies.
#
# Depends on lib-log (log, die) and lib-os (apt_get_locked). Reads RUN_INSTALL,
# ID, VERSION_CODENAME (the latter two populated by sourcing /etc/os-release
# inside ensure_supported_os from lib-os).

install_base_packages() {
  log "Installing base packages"
  export DEBIAN_FRONTEND=noninteractive
  apt_get_locked update -y
  apt_get_locked install -y \
    ca-certificates \
    curl \
    git \
    build-essential \
    gnupg \
    qrencode
  command -v git >/dev/null 2>&1 || die "git is required but could not be installed"
}

ansible_playbook_available() {
  command -v ansible-playbook >/dev/null 2>&1
}

install_ansible_if_needed() {
  if [[ "$RUN_INSTALL" != "1" ]]; then
    log "Install run skipped, skipping Ansible runtime"
    return 0
  fi

  if ansible_playbook_available; then
    log "Ansible runtime detected, skipping install"
    return 0
  fi

  log "Installing Ansible runtime"
  export DEBIAN_FRONTEND=noninteractive
  apt_get_locked update -y
  if ! apt_get_locked install -y ansible-core; then
    apt_get_locked install -y ansible
  fi

  ansible_playbook_available || die "Failed to install ansible-playbook"
}

docker_cli_available() {
  command -v docker >/dev/null 2>&1
}

docker_compose_available() {
  if ! docker_cli_available; then
    return 1
  fi
  docker compose version >/dev/null 2>&1
}

docker_daemon_available() {
  if ! docker_cli_available; then
    return 1
  fi
  docker info >/dev/null 2>&1
}

ensure_docker_daemon() {
  if command -v systemctl >/dev/null 2>&1; then
    systemctl enable --now docker >/dev/null 2>&1 || true
  fi

  if ! docker_daemon_available; then
    die "Docker CLI is available but the Docker daemon is not reachable. Ensure docker.service is installed and running."
  fi
}

configure_docker_apt_repo() {
  local arch codename repo_url keyring_path list_path
  arch="$(dpkg --print-architecture)"
  codename="${VERSION_CODENAME:-}"
  if [[ -z "$codename" ]]; then
    die "Cannot detect distro codename (VERSION_CODENAME missing in /etc/os-release)"
  fi

  repo_url="https://download.docker.com/linux/${ID}"
  keyring_path="/etc/apt/keyrings/docker.gpg"
  list_path="/etc/apt/sources.list.d/docker.list"

  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL "${repo_url}/gpg" | gpg --dearmor --yes -o "$keyring_path"
  chmod a+r "$keyring_path"

  cat > "$list_path" <<EOF
deb [arch=${arch} signed-by=${keyring_path}] ${repo_url} ${codename} stable
EOF
}

install_docker_if_needed() {
  if docker_cli_available && docker_compose_available; then
    log "Docker + Compose detected, skipping Docker install"
    ensure_docker_daemon
    return
  fi

  log "Installing Docker Engine and Docker Compose"
  configure_docker_apt_repo

  export DEBIAN_FRONTEND=noninteractive
  apt_get_locked update -y

  if ! apt_get_locked install -y \
    docker-ce \
    docker-ce-cli \
    containerd.io \
    docker-buildx-plugin \
    docker-compose-plugin; then
    log "Docker CE package install failed, falling back to distro docker packages"
    apt_get_locked install -y docker.io docker-compose-v2 \
      || apt_get_locked install -y docker.io docker-compose-plugin \
      || apt_get_locked install -y docker.io docker-compose
  fi

  ensure_docker_daemon

  if ! docker_cli_available; then
    die "Docker installation finished but docker CLI is unavailable"
  fi
  if ! docker_compose_available; then
    die "Docker installation finished but docker compose is unavailable"
  fi
}

# The Node.js range the gateway and sovereign-node run on: below the floor the
# pinned OpenClaw refuses to start, which systemd turns into a crash loop.
# Keep in sync with src/system/node-runtime-floor.ts and package.json engines.
NODE_RUNTIME_MIN_VERSION="22.22.3"
NODE_RUNTIME_MAJOR_LIMIT="23"
NODE_RUNTIME_RANGE=">=${NODE_RUNTIME_MIN_VERSION} <${NODE_RUNTIME_MAJOR_LIMIT}"

# Prints the active node's version as "major.minor.patch", or nothing when no
# node is on PATH or it reports something unparsable.
node_runtime_version() {
  local raw
  command -v node >/dev/null 2>&1 || return 0
  raw="$(node -v 2>/dev/null || true)"
  if [[ "$raw" =~ ^v?([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then
    printf '%s.%s.%s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
  fi
}

# Succeeds when the given "major.minor.patch" is inside NODE_RUNTIME_RANGE.
node_version_supported() {
  local version="$1" index
  local -a have want
  [[ "$version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || return 1
  have=("$((10#${BASH_REMATCH[1]}))" "$((10#${BASH_REMATCH[2]}))" "$((10#${BASH_REMATCH[3]}))")
  IFS=. read -r -a want <<<"$NODE_RUNTIME_MIN_VERSION"
  ((have[0] < NODE_RUNTIME_MAJOR_LIMIT)) || return 1
  for index in 0 1 2; do
    if ((have[index] > want[index])); then
      return 0
    fi
    if ((have[index] < want[index])); then
      return 1
    fi
  done
  return 0
}

configure_nodesource_node22_repo() {
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
}

install_node22_if_needed() {
  local version major
  version="$(node_runtime_version)"
  if [[ -n "$version" ]] && node_version_supported "$version"; then
    log "Node.js v${version} detected (${NODE_RUNTIME_RANGE}), skipping Node install"
    return
  fi

  major="${version%%.*}"
  if [[ -n "$version" ]] && ((major >= NODE_RUNTIME_MAJOR_LIMIT)); then
    die "Node.js v${version} ($(command -v node)) is not supported; Sovereign requires Node.js ${NODE_RUNTIME_RANGE}. Install Node.js 22 (for example from NodeSource node_22.x) and rerun the installer."
  fi

  export DEBIAN_FRONTEND=noninteractive
  if [[ "$major" == "22" ]]; then
    log "Node.js v${version} is below ${NODE_RUNTIME_MIN_VERSION}; upgrading the installed nodejs package"
    apt_get_locked update -y
    apt_get_locked install -y --only-upgrade nodejs
    version="$(node_runtime_version)"
    if [[ -n "$version" ]] && node_version_supported "$version"; then
      log "Node.js upgraded to v${version}"
      return
    fi
  fi

  log "Installing Node.js 22 from NodeSource"
  configure_nodesource_node22_repo
  apt_get_locked update -y
  apt_get_locked install -y nodejs

  version="$(node_runtime_version)"
  if [[ -z "$version" ]] || ! node_version_supported "$version"; then
    die "Node.js ${NODE_RUNTIME_RANGE} is required, but the node on PATH ($(command -v node || echo none)) reports ${version:-no version} after the install. Remove or upgrade that Node.js and rerun the installer."
  fi
  log "Node.js v${version} installed"
}
