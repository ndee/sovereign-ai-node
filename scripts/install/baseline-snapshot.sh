#!/usr/bin/env bash
# Capture byte-identical baseline fixtures for the installer.
#
# This drives the observable surface that the refactor must preserve:
#   * `scripts/install.sh --help` output
#   * `write_request_file_from_env` output for a matrix of SN_* fixtures
#
# Re-run at every extraction step; diff the output directory against the
# committed baseline under `scripts/install/baseline/` to prove the refactor
# is behaviour-preserving.
#
# Usage:
#   scripts/install/baseline-snapshot.sh <output-dir>
#
# The script does not require root, does not touch /etc or /opt, and is safe
# to run on a developer laptop.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <output-dir>" >&2
  exit 2
fi

OUT="$1"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALL_SH="${REPO_ROOT}/scripts/install.sh"

mkdir -p "${OUT}"

# --- 1. --help output ------------------------------------------------------
bash "${INSTALL_SH}" --help > "${OUT}/help.txt" 2>&1

# --- 2. write_request_file_from_env fixtures -------------------------------
# Each fixture exports a set of SN_* variables and invokes the function. The
# function is bash-only (calls a `node` heredoc internally), so we need to
# source install.sh. The file has a sourceable guard — sourcing does not run
# main.

render_fixture() {
  local name="$1"
  shift
  # Pass the SN_* assignments into `env`, which both exports them and isolates
  # them from subsequent fixtures. `env -i` would wipe PATH and friends, so we
  # layer on top of the current environment instead.
  local request_file
  request_file="$(mktemp --tmpdir baseline-req.XXXXXX.json)"
  env "SN_REQUEST_FILE=${request_file}" "$@" bash -c '
    set -euo pipefail
    export SERVICE_USER="${SERVICE_USER:-sovereign-node}"
    export SERVICE_GROUP="${SERVICE_GROUP:-sovereign-node}"
    # shellcheck disable=SC1090
    source "$1"
    # Override side-effect functions AFTER sourcing so install.sh defs do not
    # win the override contest.
    chmod() { :; }
    chown() { :; }
    log() { :; }
    REQUEST_FILE="${SN_REQUEST_FILE}"
    write_request_file_from_env
  ' _ "${INSTALL_SH}"

  cp "${request_file}" "${OUT}/request-${name}.json"
  rm -f "${request_file}"
}

# Fixture A: fresh install defaults, direct connectivity, only node-operator
# selected. Mirrors what synthesize_default_request will emit after the
# feature PR.
render_fixture "fresh-direct-node-operator" \
  SN_CONNECTIVITY_MODE="direct" \
  SN_OPENROUTER_MODEL="qwen/qwen3.5-9b" \
  SN_OPENROUTER_SECRET_REF="file:/etc/sovereign-node/secrets/openrouter-api-key" \
  SN_MATRIX_DOMAIN="matrix.example.com" \
  SN_MATRIX_PUBLIC_BASE_URL="https://matrix.example.com" \
  SN_MATRIX_TLS_MODE="auto" \
  SN_MATRIX_FEDERATION_ENABLED="0" \
  SN_ALERT_ROOM_NAME="Alerts" \
  SN_OPERATOR_USERNAME="admin" \
  SN_SELECTED_BOTS="node-operator" \
  SN_POLL_INTERVAL="30m" \
  SN_LOOKBACK_WINDOW="1h"

# Fixture B: mail-sentinel selected with IMAP configured. Exercises the
# openrouter + matrix + imap + bots.config paths together.
render_fixture "mail-sentinel-imap" \
  SN_CONNECTIVITY_MODE="direct" \
  SN_OPENROUTER_MODEL="qwen/qwen3.5-9b" \
  SN_OPENROUTER_SECRET_REF="file:/etc/sovereign-node/secrets/openrouter-api-key" \
  SN_MATRIX_DOMAIN="matrix.example.com" \
  SN_MATRIX_PUBLIC_BASE_URL="https://matrix.example.com" \
  SN_MATRIX_TLS_MODE="auto" \
  SN_MATRIX_FEDERATION_ENABLED="1" \
  SN_ALERT_ROOM_NAME="Alerts" \
  SN_OPERATOR_USERNAME="admin" \
  SN_SELECTED_BOTS="mail-sentinel,node-operator" \
  SN_POLL_INTERVAL="15m" \
  SN_LOOKBACK_WINDOW="2h" \
  SN_IMAP_CONFIGURE="1" \
  SN_IMAP_HOST="imap.example.com" \
  SN_IMAP_PORT="993" \
  SN_IMAP_TLS="1" \
  SN_IMAP_USERNAME="operator@example.com" \
  SN_IMAP_SECRET_REF="file:/etc/sovereign-node/secrets/imap-password" \
  SN_IMAP_MAILBOX="INBOX"

# Fixture C: LAN-only mode with http base URL. Exercises the tls-mode
# inference path (local-dev).
render_fixture "lan-only" \
  SN_CONNECTIVITY_MODE="direct" \
  SN_OPENROUTER_MODEL="qwen/qwen3.5-9b" \
  SN_OPENROUTER_SECRET_REF="file:/etc/sovereign-node/secrets/openrouter-api-key" \
  SN_MATRIX_DOMAIN="matrix.local.test" \
  SN_MATRIX_PUBLIC_BASE_URL="http://127.0.0.1:8008" \
  SN_MATRIX_FEDERATION_ENABLED="0" \
  SN_ALERT_ROOM_NAME="Alerts" \
  SN_OPERATOR_USERNAME="admin" \
  SN_SELECTED_BOTS="mail-sentinel" \
  SN_POLL_INTERVAL="30m" \
  SN_LOOKBACK_WINDOW="1h"

# Fixture D: relay connectivity. Exercises the relay block.
render_fixture "relay" \
  SN_CONNECTIVITY_MODE="relay" \
  SN_OPENROUTER_MODEL="qwen/qwen3.5-9b" \
  SN_OPENROUTER_SECRET_REF="file:/etc/sovereign-node/secrets/openrouter-api-key" \
  SN_MATRIX_DOMAIN="relay-pending.invalid" \
  SN_MATRIX_PUBLIC_BASE_URL="https://relay-pending.invalid" \
  SN_MATRIX_TLS_MODE="auto" \
  SN_MATRIX_FEDERATION_ENABLED="0" \
  SN_ALERT_ROOM_NAME="Alerts" \
  SN_OPERATOR_USERNAME="admin" \
  SN_SELECTED_BOTS="mail-sentinel" \
  SN_POLL_INTERVAL="30m" \
  SN_LOOKBACK_WINDOW="1h" \
  SN_RELAY_CONTROL_URL="https://relay.sovereign-ai-node.com" \
  SN_RELAY_ENROLLMENT_TOKEN="" \
  SN_RELAY_REQUESTED_SLUG=""

echo "Baseline snapshots written to: ${OUT}"
