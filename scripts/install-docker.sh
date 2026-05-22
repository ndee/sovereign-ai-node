#!/usr/bin/env bash
# install-docker.sh: Idempotent Docker Engine + Compose plugin install.
#
# This wrapper exists so the sovereign-node API service (running as a
# non-root SERVICE_USER) can install the Docker runtime during a bundled
# Matrix install via a single, narrowly-scoped sudoers entry.
#
# On a fresh host the API service has nothing to call: scripts/install.sh
# installs Docker during the bash bootstrap, but the API-driven install
# path (used by the web wizard) needs to fix this itself. The wrapper
# delegates to install_docker_if_needed in lib-runtime-deps.sh so apt
# logic is not duplicated.
#
# Exit codes:
#   0  Docker + Compose are available (no-op or installed)
#   non-zero  Installation failed; stderr explains why.

set -euo pipefail

SCRIPT_NAME="install-docker"

# When installed to /usr/local/lib/sovereign-node/install-docker.sh by
# lib-build.sh, the install/ helper libs live alongside it. When invoked
# from the source tree (development), resolve relative to this script.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${INSTALL_DOCKER_LIB_DIR:-$SCRIPT_DIR/install}"

if [[ ! -d "$LIB_DIR" ]]; then
  printf '[%s] ERROR: helper lib dir not found: %s\n' "$SCRIPT_NAME" "$LIB_DIR" >&2
  exit 1
fi

# shellcheck source=scripts/install/lib-log.sh
source "$LIB_DIR/lib-log.sh"
# shellcheck source=scripts/install/lib-os.sh
source "$LIB_DIR/lib-os.sh"
# shellcheck source=scripts/install/lib-runtime-deps.sh
source "$LIB_DIR/lib-runtime-deps.sh"

require_root
ensure_supported_os
install_docker_if_needed
