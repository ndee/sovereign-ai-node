# shellcheck shell=bash
# lib-wizard: action resolution and the interactive install/update wizard.
#
# Depends on lib-log, lib-ui, lib-prompt, lib-bot-catalog, lib-matrix-urls,
# lib-request-file. Exported entry points used by main():
#   resolve_action       — pick install vs update, prompts the operator if
#                          $ACTION is not already set on the command line.
#   prepare_request_file — synthesises or refreshes the install request,
#                          dispatching by $ACTION.

resolve_action() {
  local default_choice selected_choice subtitle

  if [[ -n "$ACTION" ]]; then
    if [[ "$ACTION" == "update" && "$CONFIGURED_INSTALLATION" != "1" ]]; then
      die "Update mode requires an existing readable request file: $REQUEST_FILE"
    fi
    return
  fi

  if [[ "$NON_INTERACTIVE" == "1" ]] || ! has_tty; then
    if [[ "$CONFIGURED_INSTALLATION" == "1" ]]; then
      ACTION="update"
    else
      ACTION="install"
    fi
    return
  fi

  if [[ "$INSTALLATION_DETECTED" == "1" ]]; then
    default_choice="2"
    subtitle="Existing installation detected"
  else
    default_choice="1"
    subtitle="No existing installation detected"
  fi

  while true; do
    ui_title "Sovereign Node Setup" "$subtitle"
    selected_choice="$(
      ui_choice_menu \
        "Choose an action:" \
        "$default_choice" \
        "Install (new / reconfigure)" \
        "Update (keep current settings)" \
        "Exit"
    )"
    case "$selected_choice" in
      1)
        ACTION="install"
        return
        ;;
      2)
        if [[ "$CONFIGURED_INSTALLATION" == "1" ]]; then
          ACTION="update"
          return
        fi
        ui_warn "Update is not available because no readable existing request file was found."
        ;;
      3)
        ui_info "Installer exited."
        exit 0
        ;;
    esac
  done
}

run_install_wizard() {
  local defaults_status openrouter_api_key openrouter_model matrix_domain matrix_public_base_url
  local operator_username alert_room_name selected_bots poll_interval lookback_window federation_enabled
  local matrix_tls_mode connectivity_choice connectivity_choice_default connectivity_mode
  local prompted_selected_bots
  local relay_control_url relay_enrollment_token relay_requested_slug relay_requested_hostname
  local openrouter_secret_ref openrouter_secret_path openrouter_secret_mode
  local configure_imap imap_choice imap_host imap_port imap_tls imap_username imap_password
  local imap_mailbox imap_secret_ref imap_secret_path imap_secret_mode

  defaults_status=0
  load_existing_defaults || defaults_status=$?
  if [[ "$defaults_status" -ne 0 ]]; then
    ui_warn "${LAST_REQUEST_LOAD_ERROR}. Falling back to default values."
  fi

  ui_title "Sovereign Node Install" \
    "$( [[ "$INSTALLATION_DETECTED" == "1" ]] && printf 'Reconfigure the existing installation with current values prefilled.' || printf 'New installation with guided setup.' )"

  openrouter_model="$DEFAULT_OPENROUTER_MODEL"
  matrix_domain="$DEFAULT_MATRIX_DOMAIN"
  matrix_public_base_url="$DEFAULT_MATRIX_PUBLIC_BASE_URL"
  operator_username="$DEFAULT_OPERATOR_USERNAME"
  alert_room_name="$DEFAULT_ALERT_ROOM_NAME"
  selected_bots="$DEFAULT_SELECTED_BOTS"
  poll_interval="$DEFAULT_POLL_INTERVAL"
  lookback_window="$DEFAULT_LOOKBACK_WINDOW"
  federation_enabled="$DEFAULT_FEDERATION_ENABLED"
  connectivity_mode="$DEFAULT_CONNECTIVITY_MODE"
  relay_control_url="$DEFAULT_RELAY_CONTROL_URL"
  relay_requested_slug="$DEFAULT_RELAY_REQUESTED_SLUG"
  relay_requested_hostname="$DEFAULT_RELAY_HOSTNAME"
  openrouter_secret_ref="$EXISTING_OPENROUTER_SECRET_REF"
  openrouter_secret_mode="replaced"
  matrix_tls_mode="$(infer_matrix_tls_mode_from_url "$matrix_public_base_url")"

  ui_section "OpenRouter"
  openrouter_model="$(prompt_value "OpenRouter model" "$openrouter_model")"
  if [[ -n "$openrouter_secret_ref" ]] && [[ "$EXISTING_REQUEST_VALID" == "1" ]]; then
    if secret_ref_path_exists "$openrouter_secret_ref"; then
      if ui_confirm "Keep existing OpenRouter API key?" "y"; then
        openrouter_secret_mode="kept"
      else
        openrouter_secret_ref=""
      fi
    else
      ui_warn "Existing OpenRouter secret is missing. Enter a new OpenRouter API key."
      openrouter_secret_ref=""
    fi
  fi
  if [[ -z "$openrouter_secret_ref" ]]; then
    openrouter_api_key="$(
      prompt_required_secret \
        "OpenRouter API key (sk-or-...)" \
        "OpenRouter API key is required."
    )"
    openrouter_secret_path="/etc/sovereign-node/secrets/openrouter-api-key"
    write_secret_file "$openrouter_secret_path" "$openrouter_api_key"
    openrouter_secret_ref="file:${openrouter_secret_path}"
    openrouter_secret_mode="replaced"
  fi

  ui_section "Connection"
  if [[ "$connectivity_mode" == "relay" ]]; then
    # Relay mode was pre-configured (e.g. by the Pro installer).
    ui_info "Connection mode: Managed Relay (configured by Pro installer)"
  else
    connectivity_choice_default="2"
    if [[ "$matrix_tls_mode" != "internal" ]] && [[ "$matrix_tls_mode" != "local-dev" ]]; then
      connectivity_choice_default="1"
    fi
    connectivity_choice="$(
      ui_choice_menu \
        "Choose how users should connect:" \
        "$connectivity_choice_default" \
        "Public Domain / Direct HTTPS" \
        "LAN Only"
    )"
    connectivity_mode="direct"
    if [[ "$connectivity_choice" == "2" ]]; then
      if [[ "$matrix_domain" == "$LEGACY_MATRIX_DOMAIN" ]] || [[ -z "$matrix_domain" ]]; then
        matrix_domain="$RECOMMENDED_MATRIX_DOMAIN"
      fi
      if [[ "$matrix_public_base_url" == "$LEGACY_MATRIX_PUBLIC_BASE_URL" ]] \
        || [[ "$matrix_public_base_url" == "$LEGACY_MATRIX_ALT_PUBLIC_BASE_URL" ]] \
        || [[ -z "$matrix_public_base_url" ]]; then
        matrix_public_base_url="$RECOMMENDED_MATRIX_PUBLIC_BASE_URL"
      fi
    fi
  fi

  ui_section "Matrix"
  if [[ "$connectivity_mode" == "relay" ]]; then
    relay_enrollment_token=""
    if [[ "${relay_control_url%/}" == "$DEFAULT_MANAGED_RELAY_CONTROL_URL" ]]; then
      ui_info "Using Sovereign managed relay: ${relay_control_url}"
    else
      relay_control_url="$(prompt_value "Relay server URL" "$relay_control_url")"
    fi
    if [[ "${relay_control_url%/}" != "$DEFAULT_MANAGED_RELAY_CONTROL_URL" ]]; then
      if [[ -n "$EXISTING_RELAY_ENROLLMENT_TOKEN" ]] && [[ "$EXISTING_REQUEST_VALID" == "1" ]]; then
        if ui_confirm "Keep existing relay enrollment token?" "y"; then
          relay_enrollment_token="$EXISTING_RELAY_ENROLLMENT_TOKEN"
        fi
      fi
      if [[ -z "${relay_enrollment_token:-}" ]]; then
        relay_enrollment_token="$(
          prompt_required_secret \
            "Relay enrollment token" \
            "A custom relay enrollment token is required for non-Sovereign relays."
        )"
      fi
    fi
    if [[ -z "$matrix_domain" ]]; then
      matrix_domain="relay-pending.invalid"
    fi
    if [[ -z "$matrix_public_base_url" ]]; then
      matrix_public_base_url="https://relay-pending.invalid"
    fi
    matrix_tls_mode="auto"
    federation_enabled="0"
  else
    matrix_domain="$(prompt_value "Matrix homeserver domain" "$matrix_domain")"
    matrix_public_base_url="$(prompt_value "Matrix public base URL" "$matrix_public_base_url")"
    matrix_tls_mode="$(infer_matrix_tls_mode_from_url "$matrix_public_base_url")"
  fi
  operator_username="$(prompt_value "Operator username" "$operator_username")"
  alert_room_name="$(prompt_value "Alert room name" "$alert_room_name")"
  if [[ "$connectivity_mode" == "direct" ]]; then
    if ui_confirm "Enable Matrix federation?" "$( [[ "$federation_enabled" == "1" ]] && printf 'y' || printf 'n' )"; then
      federation_enabled="1"
    else
      federation_enabled="0"
    fi
  fi

  configure_imap="0"
  imap_host="$DEFAULT_IMAP_HOST"
  imap_port="$DEFAULT_IMAP_PORT"
  imap_tls="$DEFAULT_IMAP_TLS"
  imap_username="$DEFAULT_IMAP_USERNAME"
  imap_mailbox="$DEFAULT_IMAP_MAILBOX"
  imap_secret_ref="$EXISTING_IMAP_SECRET_REF"
  imap_secret_mode="pending"

  ui_section "Bots"
  prompted_selected_bots="$(prompt_bot_selection "$selected_bots")"
  selected_bots="$prompted_selected_bots"

  if bot_list_contains "$selected_bots" "mail-sentinel"; then
    ui_section "Mail Sentinel"
    poll_interval="$(prompt_value "Mail Sentinel poll interval" "$poll_interval")"
    lookback_window="$(prompt_value "Mail Sentinel lookback window" "$lookback_window")"

    ui_section "IMAP (optional)"
    if [[ "$DEFAULT_IMAP_CONFIGURED" == "1" ]] && [[ "$EXISTING_REQUEST_VALID" == "1" ]]; then
      imap_choice="$(
        ui_choice_menu \
          "Choose how to handle IMAP:" \
          "1" \
          "Keep current IMAP configuration" \
          "Replace IMAP configuration" \
          "Leave IMAP pending"
      )"
      case "$imap_choice" in
        1)
          if secret_ref_path_exists "$imap_secret_ref"; then
            configure_imap="1"
            imap_secret_mode="kept"
          else
            ui_warn "Existing IMAP secret is missing. Enter replacement IMAP credentials."
            imap_choice="2"
          fi
          ;;
        3)
          configure_imap="0"
          imap_secret_ref=""
          imap_secret_mode="pending"
          ;;
      esac
      if [[ "$imap_choice" == "2" ]]; then
        configure_imap="1"
        imap_host="$(prompt_value "IMAP host" "$imap_host")"
        imap_port="$(prompt_value "IMAP port" "$imap_port")"
        if ui_confirm "Use TLS for IMAP?" "$( [[ "$imap_tls" == "1" ]] && printf 'y' || printf 'n' )"; then
          imap_tls="1"
        else
          imap_tls="0"
        fi
        imap_username="$(prompt_value "IMAP username" "$imap_username")"
        imap_password="$(
          prompt_required_secret \
            "IMAP password/app password" \
            "IMAP password is required when IMAP is configured."
        )"
        imap_mailbox="$(prompt_value "IMAP mailbox" "$imap_mailbox")"
        imap_secret_path="/etc/sovereign-node/secrets/imap-password"
        write_secret_file "$imap_secret_path" "$imap_password"
        imap_secret_ref="file:${imap_secret_path}"
        imap_secret_mode="replaced"
      fi
    else
      if ui_confirm "Configure IMAP now? (choose no to keep IMAP pending)" "n"; then
        configure_imap="1"
        imap_host="$(prompt_value "IMAP host" "$imap_host")"
        imap_port="$(prompt_value "IMAP port" "$imap_port")"
        if ui_confirm "Use TLS for IMAP?" "y"; then
          imap_tls="1"
        else
          imap_tls="0"
        fi
        imap_username="$(prompt_value "IMAP username" "$imap_username")"
        imap_password="$(
          prompt_required_secret \
            "IMAP password/app password" \
            "IMAP password is required when IMAP is configured."
        )"
        imap_mailbox="$(prompt_value "IMAP mailbox" "$imap_mailbox")"
        imap_secret_path="/etc/sovereign-node/secrets/imap-password"
        write_secret_file "$imap_secret_path" "$imap_password"
        imap_secret_ref="file:${imap_secret_path}"
        imap_secret_mode="replaced"
      fi
    fi
  fi

  export SN_REQUEST_FILE="$REQUEST_FILE"
  export SN_CONNECTIVITY_MODE="$connectivity_mode"
  export SN_OPENROUTER_MODEL="$openrouter_model"
  export SN_OPENROUTER_SECRET_REF="$openrouter_secret_ref"
  export SN_OPENROUTER_SECRET_MODE="$openrouter_secret_mode"
  export SN_RELAY_CONTROL_URL="${relay_control_url:-}"
  export SN_RELAY_ENROLLMENT_TOKEN="${relay_enrollment_token:-}"
  export SN_RELAY_REQUESTED_SLUG="${relay_requested_slug:-}"
  export SN_RELAY_REQUESTED_HOSTNAME="${relay_requested_hostname:-}"
  export SN_MATRIX_DOMAIN="$matrix_domain"
  export SN_MATRIX_PUBLIC_BASE_URL="$matrix_public_base_url"
  export SN_MATRIX_TLS_MODE="$matrix_tls_mode"
  export SN_MATRIX_INTERNAL_CA_PATH="$(build_internal_matrix_ca_path "$matrix_domain")"
  export SN_MATRIX_FEDERATION_ENABLED="$federation_enabled"
  export SN_OPERATOR_USERNAME="$operator_username"
  export SN_ALERT_ROOM_NAME="$alert_room_name"
  export SN_SELECTED_BOTS="$selected_bots"
  export SN_POLL_INTERVAL="$poll_interval"
  export SN_LOOKBACK_WINDOW="$lookback_window"
  export SN_IMAP_CONFIGURE="$configure_imap"
  export SN_IMAP_HOST="$imap_host"
  export SN_IMAP_PORT="$imap_port"
  export SN_IMAP_TLS="$imap_tls"
  export SN_IMAP_USERNAME="$imap_username"
  export SN_IMAP_SECRET_REF="$imap_secret_ref"
  export SN_IMAP_SECRET_MODE="$imap_secret_mode"
  export SN_IMAP_MAILBOX="$imap_mailbox"

  review_install_request
  if ! ui_confirm "Write the request file and continue?" "y"; then
    ui_info "Installer exited without changing the request file."
    exit 0
  fi

  write_request_file_from_env
  ui_success "Request file updated."
}

prepare_install_request_for_install() {
  if [[ "$NON_INTERACTIVE" == "1" ]]; then
    if [[ ! -f "$REQUEST_FILE" ]]; then
      if [[ -f /etc/sovereign-node/install-request.example.json ]]; then
        cp /etc/sovereign-node/install-request.example.json "$REQUEST_FILE"
        chmod 0640 "$REQUEST_FILE"
        chown "${SERVICE_USER}:${SERVICE_GROUP}" "$REQUEST_FILE" || true
        log "Non-interactive install: wrote template request to $REQUEST_FILE"
      else
        log "Non-interactive install: no request file exists yet; skipping install run"
      fi
      RUN_INSTALL="0"
    fi
    return
  fi

  if ! has_tty; then
    if [[ ! -f "$REQUEST_FILE" ]]; then
      if [[ -f /etc/sovereign-node/install-request.example.json ]]; then
        cp /etc/sovereign-node/install-request.example.json "$REQUEST_FILE"
        chmod 0640 "$REQUEST_FILE"
        chown "${SERVICE_USER}:${SERVICE_GROUP}" "$REQUEST_FILE" || true
      fi
      log "No TTY available; wrote template request file and skipped the install run"
      RUN_INSTALL="0"
      return
    fi
    log "No TTY available; reusing existing request file for install mode"
    return
  fi

  run_install_wizard
}

prepare_install_request_for_update() {
  if [[ "$CONFIGURED_INSTALLATION" != "1" ]]; then
    die "Update mode requires an existing readable request file: $REQUEST_FILE"
  fi

  if ! load_existing_defaults; then
    die "${LAST_REQUEST_LOAD_ERROR}"
  fi
  if [[ "$LEGACY_OPENROUTER_MODEL_DETECTED" == "1" ]]; then
    migrate_legacy_openrouter_model_request \
      || die "Failed to migrate the saved request file to ${RECOMMENDED_OPENROUTER_MODEL}"
  fi

  if [[ "$NON_INTERACTIVE" == "1" ]] || ! has_tty; then
    return
  fi

  ui_title "Sovereign Node Update" "Reuse the current configuration and update in place."
  ui_section "Update"
  ui_info "Will update application code."
  ui_info "Will preserve /etc/sovereign-node, /etc/sovereign-node/secrets, and /var/lib/sovereign-node."
  ui_info "Will reuse request file: ${REQUEST_FILE}"
  if [[ "$DEFAULT_CONNECTIVITY_MODE" == "relay" ]]; then
    ui_info "Managed relay mode is enabled."
    ui_info "Relay control URL: ${DEFAULT_RELAY_CONTROL_URL}"
  fi
  warn_if_missing_secret_ref "OpenRouter" "$EXISTING_OPENROUTER_SECRET_REF" || true
  warn_if_missing_secret_ref "IMAP" "$EXISTING_IMAP_SECRET_REF" || true
  if ! ui_confirm "Continue with update?" "y"; then
    ui_info "Update cancelled."
    exit 0
  fi
}

prepare_request_file() {
  case "$ACTION" in
    update)
      prepare_install_request_for_update
      ;;
    *)
      prepare_install_request_for_install
      ;;
  esac
}
