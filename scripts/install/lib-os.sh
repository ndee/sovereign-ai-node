# shellcheck shell=bash
# lib-os: OS detection and apt/dpkg lock-aware wrappers.

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

wait_for_apt_lock() {
  local attempt
  for attempt in $(seq 1 180); do
    if fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || fuser /var/lib/dpkg/lock >/dev/null 2>&1; then
      sleep 5
      continue
    fi
    return 0
  done
  die "Timed out waiting for apt/dpkg lock"
}

apt_get_locked() {
  wait_for_apt_lock
  apt-get "$@"
}
