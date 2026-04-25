#!/usr/bin/env bash
set -euo pipefail

SCRIPT_NAME="$(basename "$0")"

REPO_URL="${SOVEREIGN_NODE_REPO_URL:-https://github.com/ndee/sovereign-ai-node}"
SOURCE_DIR="${SOVEREIGN_NODE_SOURCE_DIR:-}"
REF="${SOVEREIGN_NODE_REF:-main}"
BOTS_REPO_URL="${SOVEREIGN_BOTS_REPO_URL:-https://github.com/ndee/sovereign-ai-bots}"
BOTS_SOURCE_DIR="${SOVEREIGN_BOTS_SOURCE_DIR:-}"
BOTS_REF="${SOVEREIGN_BOTS_REF:-main}"
INSTALL_ROOT="${SOVEREIGN_NODE_INSTALL_ROOT:-/opt/sovereign-ai-node}"
APP_DIR="${INSTALL_ROOT}/app"
BOTS_DIR="${INSTALL_ROOT}/sovereign-ai-bots"
SERVICE_NAME="${SOVEREIGN_NODE_SERVICE_NAME:-sovereign-node-api}"
SERVICE_USER="${SOVEREIGN_NODE_SERVICE_USER:-sovereign-node}"
SERVICE_GROUP="${SOVEREIGN_NODE_SERVICE_GROUP:-}"
ENV_FILE="${SOVEREIGN_NODE_ENV_FILE:-/etc/default/sovereign-node-api}"
API_HOST="${SOVEREIGN_NODE_API_HOST:-127.0.0.1}"
API_PORT="${SOVEREIGN_NODE_API_PORT:-8787}"
REQUEST_FILE="${SOVEREIGN_NODE_REQUEST_FILE:-/etc/sovereign-node/install-request.json}"
PROVENANCE_FILE="/etc/sovereign-node/install-provenance.json"
RUNTIME_CONFIG_FILE="${SOVEREIGN_NODE_CONFIG_FILE:-/etc/sovereign-node/sovereign-node.json5}"
RUN_INSTALL="${SOVEREIGN_NODE_RUN_INSTALL:-1}"
NON_INTERACTIVE="${SOVEREIGN_NODE_NON_INTERACTIVE:-0}"
ACTION="${SOVEREIGN_NODE_ACTION:-}"
INSTALLATION_DETECTED="0"
CONFIGURED_INSTALLATION="0"
EXISTING_REQUEST_VALID="0"
LAST_REQUEST_LOAD_ERROR=""
RECOMMENDED_OPENROUTER_MODEL="qwen/qwen3.5-9b"
LEGACY_OPENROUTER_MODEL="openrouter/anthropic/claude-sonnet-4-5"
DEFAULT_OPENROUTER_MODEL="$RECOMMENDED_OPENROUTER_MODEL"
RECOMMENDED_MATRIX_DOMAIN="matrix.local.test"
RECOMMENDED_MATRIX_PUBLIC_BASE_URL="http://127.0.0.1:8008"
DEFAULT_MATRIX_DOMAIN="matrix.local.test"
DEFAULT_MATRIX_PUBLIC_BASE_URL="http://127.0.0.1:8008"
LEGACY_MATRIX_DOMAIN="matrix.local.test"
LEGACY_MATRIX_PUBLIC_BASE_URL="http://127.0.0.1:8008"
LEGACY_MATRIX_ALT_PUBLIC_BASE_URL="http://matrix.local.test:8008"
DEFAULT_OPERATOR_USERNAME="admin"
DEFAULT_ALERT_ROOM_NAME="Alerts"
DEFAULT_SELECTED_BOTS="mail-sentinel"
DEFAULT_POLL_INTERVAL="30m"
DEFAULT_LOOKBACK_WINDOW="1h"
DEFAULT_FEDERATION_ENABLED="0"
DEFAULT_MANAGED_RELAY_CONTROL_URL="https://relay.sovereign-ai-node.com"
DEFAULT_CONNECTIVITY_MODE="direct"
DEFAULT_RELAY_CONTROL_URL="${SOVEREIGN_NODE_RELAY_CONTROL_URL:-$DEFAULT_MANAGED_RELAY_CONTROL_URL}"
DEFAULT_RELAY_REQUESTED_SLUG=""
DEFAULT_RELAY_HOSTNAME=""
DEFAULT_IMAP_CONFIGURED="0"
DEFAULT_IMAP_HOST="imap.example.org"
DEFAULT_IMAP_PORT="993"
DEFAULT_IMAP_TLS="1"
DEFAULT_IMAP_USERNAME="operator@example.org"
DEFAULT_IMAP_MAILBOX="INBOX"
EXISTING_OPENROUTER_SECRET_REF=""
EXISTING_RELAY_ENROLLMENT_TOKEN=""
EXISTING_IMAP_SECRET_REF=""
LEGACY_OPENROUTER_MODEL_DETECTED="0"
AVAILABLE_BOT_IDS=()
AVAILABLE_BOT_DISPLAY_NAMES=()
AVAILABLE_BOT_DEFAULT_INSTALLS=()
UI_TOTAL_STEPS=0
UI_CURRENT_STEP=0
UI_ACTIVE_STEP_LABEL=""
UI_ACTIVE_STEP_STARTED_AT=0
UI_STEP_LOG_DIR=""
UI_PRESERVE_STEP_LOGS="0"
UI_BAR_WIDTH=28
UI_TERMINAL_WIDTH=80
UI_FANCY="0"
UI_PROGRESS_LINE_OPEN="0"
INSTALL_COMMAND_OUTPUT=""
RUNTIME_STATUS_OUTPUT=""
DOCTOR_REPORT_OUTPUT=""
declare -a UI_SPINNER_FRAMES=("[    ]" "[=   ]" "[==  ]" "[=== ]" "[ ===]" "[  ==]" "[   =]")

INSTALL_LIB_DIR="${INSTALL_LIB_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/install" 2>/dev/null && pwd)}"
if [[ -z "${INSTALL_LIB_DIR}" || ! -d "${INSTALL_LIB_DIR}" ]]; then
  printf '[%s] ERROR: cannot locate install library directory (tried: %s)\n' \
    "${SCRIPT_NAME}" "${INSTALL_LIB_DIR:-<unset>}" >&2
  exit 1
fi

# shellcheck source=install/lib-log.sh
source "${INSTALL_LIB_DIR}/lib-log.sh"

# shellcheck source=install/lib-args.sh
source "${INSTALL_LIB_DIR}/lib-args.sh"

# shellcheck source=install/lib-os.sh
source "${INSTALL_LIB_DIR}/lib-os.sh"

# shellcheck source=install/lib-runtime-deps.sh
source "${INSTALL_LIB_DIR}/lib-runtime-deps.sh"

# shellcheck source=install/lib-runtime-paths.sh
source "${INSTALL_LIB_DIR}/lib-runtime-paths.sh"

# shellcheck source=install/lib-build.sh
source "${INSTALL_LIB_DIR}/lib-build.sh"

# shellcheck source=install/lib-ui.sh
source "${INSTALL_LIB_DIR}/lib-ui.sh"

# shellcheck source=install/lib-prompt.sh
source "${INSTALL_LIB_DIR}/lib-prompt.sh"

# shellcheck source=install/lib-bot-catalog.sh
source "${INSTALL_LIB_DIR}/lib-bot-catalog.sh"

# shellcheck source=install/lib-matrix-urls.sh
source "${INSTALL_LIB_DIR}/lib-matrix-urls.sh"

# shellcheck source=install/lib-request-file.sh
source "${INSTALL_LIB_DIR}/lib-request-file.sh"

# shellcheck source=install/lib-wizard.sh
source "${INSTALL_LIB_DIR}/lib-wizard.sh"

# shellcheck source=install/lib-runner.sh
source "${INSTALL_LIB_DIR}/lib-runner.sh"

main() {
  local completion_label

  parse_args "$@"
  normalize_service_identity
  require_root
  ensure_supported_os
  ui_setup_runtime
  ui_configure_progress_plan
  if ui_is_fancy; then
    ui_print_banner
  fi
  detect_installation_state
  resolve_action

  ui_run_step_foreground "Check source inputs" resolve_source_mode
  ui_run_step_captured "Install base packages" install_base_packages
  ui_run_step_captured "Prepare Ansible runtime" install_ansible_if_needed
  ui_run_step_captured "Prepare Docker runtime" install_docker_if_needed
  ui_run_step_captured "Prepare Node runtime" install_node22_if_needed
  ui_run_step_captured "Ensure service account" ensure_service_account
  ui_run_step_captured "Prepare runtime directories" ensure_runtime_directories
  ui_run_step_captured "Sync application source" sync_app_source
  ui_run_step_captured "Sync bot package source" sync_bots_source
  ui_run_step_captured "Write install provenance" write_install_provenance
  ui_run_step_foreground "Load bot catalog" load_available_bot_catalog
  ui_run_step_captured "Build bot packages" build_bots
  ui_run_step_captured "Build application" build_app
  ui_run_step_captured "Install CLI wrappers" install_wrappers
  ui_run_step_captured "Install systemd service" install_systemd_unit
  ui_run_step_captured "Configure system hygiene" configure_system_hygiene
  ui_run_step_captured "Write request template" install_request_template
  if [[ "$NON_INTERACTIVE" == "1" ]] || ! has_tty; then
    ui_run_step_foreground "Configure request file" prepare_request_file
  else
    ui_run_step_interactive "Configure request file" prepare_request_file
  fi

  if [[ "$RUN_INSTALL" == "1" ]]; then
    run_install_command
    ui_run_step_captured "Apply host resources" run_post_install_ansible_step
    run_post_install_diagnostics_step
  else
    ui_skip_step "Apply ${ACTION:-install}" "--skip-install-run"
    ui_skip_step "Apply host resources" "install run skipped"
    ui_skip_step "Run post-install diagnostics" "install run skipped"
  fi

  if [[ "$RUN_INSTALL" != "1" ]]; then
    completion_label="Bootstrap completed. Install run skipped."
  elif [[ "${ACTION:-install}" == "update" ]]; then
    completion_label="Update completed."
  else
    completion_label="Install completed."
  fi

  if ui_is_fancy; then
    ui_break_progress_line
    ui_title "Summary" "$completion_label"
    ui_print_summary_block "Installer" "$(summarize_install_command_output "$INSTALL_COMMAND_OUTPUT")"
    ui_print_summary_block "Runtime" "$(summarize_status_output "$RUNTIME_STATUS_OUTPUT")"
    ui_print_summary_block "Diagnostics" "$(summarize_doctor_output "$DOCTOR_REPORT_OUTPUT")"
  fi

  ui_break_progress_line
  cat <<EOF
${completion_label}

Request file: ${REQUEST_FILE}

Useful commands:
- bash ${APP_DIR}/scripts/install.sh --request-file ${REQUEST_FILE} --install --non-interactive
- sovereign-node status --json
- sovereign-node doctor --json
- sovereign-node onboarding issue --json
EOF
  print_matrix_client_onboarding_guidance
}

if ! (return 0 2>/dev/null); then
  main "$@"
fi
