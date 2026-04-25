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
  apt_get_locked update -y
  apt_get_locked install -y nodejs
}
