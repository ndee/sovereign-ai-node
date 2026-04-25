# shellcheck shell=bash
# lib-ui: TTY detection, colored output helpers, progress/step rendering.
#
# Reads and mutates UI_* globals (UI_FANCY, UI_TERMINAL_WIDTH, UI_STEP_LOG_DIR,
# UI_CURRENT_STEP, UI_TOTAL_STEPS, UI_ACTIVE_STEP_LABEL,
# UI_ACTIVE_STEP_STARTED_AT, UI_PROGRESS_LINE_OPEN, UI_PRESERVE_STEP_LOGS,
# UI_BAR_WIDTH, UI_SPINNER_FRAMES, ACTION) defined in the sourcing environment.
# Depends on lib-log (log) for non-fancy output.

has_tty() {
  [[ -t 0 || -t 1 ]] && [[ -r /dev/tty ]]
}

supports_color() {
  has_tty && [[ "${TERM:-dumb}" != "dumb" ]]
}

ui_print() {
  # Write human-facing prompts to stderr so interactive runs launched via a pipe
  # still render menus even when writing directly to /dev/tty is unreliable.
  printf '%b' "$*" >&2
}

ui_title() {
  local title subtitle
  title="$1"
  subtitle="${2:-}"
  ui_print "\n"
  if supports_color; then
    ui_print "\033[1;36m${title}\033[0m\n"
  else
    ui_print "${title}\n"
  fi
  if [[ -n "$subtitle" ]]; then
    ui_print "${subtitle}\n"
  fi
}

ui_section() {
  local label
  label="$1"
  ui_print "\n"
  if supports_color; then
    ui_print "\033[1m-- ${label} --\033[0m\n"
  else
    ui_print "-- ${label} --\n"
  fi
}

ui_info() {
  if supports_color; then
    ui_print "\033[36m[info]\033[0m $1\n"
  else
    ui_print "[info] $1\n"
  fi
}

ui_warn() {
  if supports_color; then
    ui_print "\033[33m[warn]\033[0m $1\n"
  else
    ui_print "[warn] $1\n"
  fi
}

ui_error() {
  if supports_color; then
    ui_print "\033[31m[error]\033[0m $1\n"
  else
    ui_print "[error] $1\n"
  fi
}

ui_success() {
  if supports_color; then
    ui_print "\033[32m[ok]\033[0m $1\n"
  else
    ui_print "[ok] $1\n"
  fi
}

ui_is_fancy() {
  [[ "$UI_FANCY" == "1" ]]
}

cleanup_ui_runtime() {
  if [[ "$UI_PRESERVE_STEP_LOGS" != "1" ]] && [[ -n "$UI_STEP_LOG_DIR" ]] && [[ -d "$UI_STEP_LOG_DIR" ]]; then
    rm -rf "$UI_STEP_LOG_DIR"
  fi
}

ui_setup_runtime() {
  UI_FANCY="0"
  if has_tty; then
    UI_FANCY="1"
  fi
  UI_TERMINAL_WIDTH="$(detect_terminal_width)"
  UI_STEP_LOG_DIR="$(mktemp -d /tmp/sovereign-node-installer.XXXXXX)"
  trap cleanup_ui_runtime EXIT
}

ui_configure_progress_plan() {
  UI_TOTAL_STEPS=19
}

detect_terminal_width() {
  local detected

  detected=""
  if has_tty; then
    detected="$(stty size < /dev/tty 2>/dev/null | awk '{print $2}')"
    if [[ -z "$detected" ]] && command -v tput >/dev/null 2>&1; then
      detected="$(tput cols 2>/dev/null || true)"
    fi
  fi

  if [[ -z "$detected" ]] || [[ ! "$detected" =~ ^[0-9]+$ ]] || [[ "$detected" -lt 40 ]]; then
    detected=80
  fi

  printf '%s' "$detected"
}

format_duration() {
  local total_seconds minutes seconds
  total_seconds="${1:-0}"
  minutes=$((total_seconds / 60))
  seconds=$((total_seconds % 60))
  if [[ "$minutes" -gt 0 ]]; then
    printf '%dm%02ds' "$minutes" "$seconds"
  else
    printf '%ds' "$seconds"
  fi
}

ui_progress_percent() {
  local completed total
  completed="${1:-0}"
  total="${2:-0}"
  if [[ "$total" -le 0 ]]; then
    printf '0'
    return 0
  fi
  printf '%d' $((completed * 100 / total))
}

ui_progress_bar() {
  local completed total active width filled index bar
  completed="${1:-0}"
  total="${2:-0}"
  active="${3:-0}"
  width="${4:-$UI_BAR_WIDTH}"
  filled=0
  bar=""

  if [[ "$total" -gt 0 ]]; then
    filled=$((completed * width / total))
  fi
  if [[ "$filled" -gt "$width" ]]; then
    filled="$width"
  fi

  for ((index = 0; index < width; index += 1)); do
    if [[ "$index" -lt "$filled" ]]; then
      bar="${bar}="
    elif [[ "$active" == "1" ]] && [[ "$index" -eq "$filled" ]] && [[ "$filled" -lt "$width" ]]; then
      bar="${bar}>"
    else
      bar="${bar}-"
    fi
  done

  printf '%s' "$bar"
}

ui_truncate_text() {
  local input max_width
  input="$1"
  max_width="${2:-0}"

  if [[ "$max_width" -le 0 ]]; then
    printf ''
    return 0
  fi

  if [[ "${#input}" -le "$max_width" ]]; then
    printf '%s' "$input"
    return 0
  fi

  if [[ "$max_width" -le 3 ]]; then
    printf '%s' "${input:0:max_width}"
    return 0
  fi

  printf '%s...' "${input:0:max_width-3}"
}

ui_step_log_path() {
  local slug
  slug="$(
    printf '%s' "${UI_ACTIVE_STEP_LABEL:-step}" \
      | tr '[:upper:]' '[:lower:]' \
      | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//'
  )"
  if [[ -z "$slug" ]]; then
    slug="step"
  fi
  printf '%s/%02d-%s.log' "$UI_STEP_LOG_DIR" "$UI_CURRENT_STEP" "$slug"
}

ui_preserve_logs() {
  UI_PRESERVE_STEP_LOGS="1"
}

ui_show_log_excerpt() {
  local path
  path="$1"
  [[ -f "$path" ]] || return 0

  ui_break_progress_line
  ui_print "\nRecent output:\n"
  while IFS= read -r line; do
    ui_print "  ${line}\n"
  done < <(tail -n 20 "$path")
}

ui_break_progress_line() {
  if ui_is_fancy && [[ "${UI_PROGRESS_LINE_OPEN:-0}" == "1" ]]; then
    ui_print "\n"
    UI_PROGRESS_LINE_OPEN="0"
  fi
}

ui_render_step_line() {
  local state label detail frame completed percent bar counter line prefix prefix_plain
  local body line_prefix bar_width available_body_width terminal_width
  state="$1"
  label="$2"
  detail="${3:-}"
  frame="${4:-}"

  case "$state" in
    running)
      completed=$((UI_CURRENT_STEP - 1))
      prefix="$frame"
      if [[ -z "$prefix" ]]; then
        prefix="[....]"
      fi
      ;;
    success)
      completed="$UI_CURRENT_STEP"
      prefix="[ok]"
      ;;
    failed)
      completed=$((UI_CURRENT_STEP - 1))
      prefix="[!!]"
      ;;
    skipped)
      completed="$UI_CURRENT_STEP"
      prefix="[--]"
      ;;
    *)
      completed="$UI_CURRENT_STEP"
      prefix="[--]"
      ;;
  esac

  percent="$(ui_progress_percent "$completed" "$UI_TOTAL_STEPS")"
  bar_width="$UI_BAR_WIDTH"
  terminal_width="${UI_TERMINAL_WIDTH:-80}"
  if [[ "$terminal_width" -lt 72 ]]; then
    bar_width=16
  elif [[ "$terminal_width" -lt 88 ]]; then
    bar_width=20
  fi
  bar="$(ui_progress_bar "$completed" "$UI_TOTAL_STEPS" "$( [[ "$state" == "running" ]] && printf '1' || printf '0' )" "$bar_width")"
  counter="$(printf '%02d/%02d' "$UI_CURRENT_STEP" "$UI_TOTAL_STEPS")"
  line_prefix="$(printf '%3s%% |%s| %s ' "$percent" "$bar" "$counter")"
  body="$label"
  if [[ -n "$detail" ]]; then
    body="${body} - ${detail}"
  fi
  prefix_plain="$prefix"
  available_body_width=$((terminal_width - ${#prefix_plain} - 1 - ${#line_prefix}))
  if [[ "$available_body_width" -lt 8 ]]; then
    available_body_width=8
  fi
  body="$(ui_truncate_text "$body" "$available_body_width")"
  line="${line_prefix}${body}"

  if supports_color; then
    case "$state" in
      running)
        prefix="\033[36m${prefix}\033[0m"
        ;;
      success)
        prefix="\033[32m${prefix}\033[0m"
        ;;
      failed)
        prefix="\033[31m${prefix}\033[0m"
        ;;
      skipped)
        prefix="\033[33m${prefix}\033[0m"
        ;;
    esac
  fi

  if ui_is_fancy; then
    if [[ "$state" == "running" ]]; then
      ui_print "\r\033[2K${prefix} ${line}"
      UI_PROGRESS_LINE_OPEN="1"
    elif [[ "$state" == "failed" ]]; then
      ui_print "\r\033[2K${prefix} ${line}\n"
      UI_PROGRESS_LINE_OPEN="0"
    else
      ui_print "\r\033[2K${prefix} ${line}"
      UI_PROGRESS_LINE_OPEN="1"
    fi
  elif [[ "$state" == "success" ]]; then
    log "${label}: ${detail:-done}"
  elif [[ "$state" == "failed" ]]; then
    log "${label}: ${detail:-failed}"
  elif [[ "$state" == "skipped" ]]; then
    log "${label}: ${detail:-skipped}"
  else
    log "$label"
  fi
}

ui_begin_step() {
  UI_CURRENT_STEP=$((UI_CURRENT_STEP + 1))
  UI_ACTIVE_STEP_LABEL="$1"
  UI_ACTIVE_STEP_STARTED_AT="$SECONDS"
  ui_render_step_line "running" "$UI_ACTIVE_STEP_LABEL" "starting" "${UI_SPINNER_FRAMES[0]}"
}

ui_begin_step_static() {
  UI_CURRENT_STEP=$((UI_CURRENT_STEP + 1))
  UI_ACTIVE_STEP_LABEL="$1"
  UI_ACTIVE_STEP_STARTED_AT="$SECONDS"
  ui_render_step_line "running" "$UI_ACTIVE_STEP_LABEL" "${2:-working}" "${UI_SPINNER_FRAMES[0]}"
}

ui_update_step() {
  local detail frame_index frame_count frame
  detail="${1:-working}"
  frame_index="${2:-0}"
  frame_count="${#UI_SPINNER_FRAMES[@]}"
  frame="${UI_SPINNER_FRAMES[$((frame_index % frame_count))]}"
  ui_render_step_line "running" "$UI_ACTIVE_STEP_LABEL" "$detail" "$frame"
}

ui_complete_step() {
  local detail elapsed formatted
  detail="${1:-done}"
  elapsed=$((SECONDS - UI_ACTIVE_STEP_STARTED_AT))
  formatted="$(format_duration "$elapsed")"
  ui_render_step_line "success" "$UI_ACTIVE_STEP_LABEL" "${detail} (${formatted})"
  UI_ACTIVE_STEP_LABEL=""
  UI_ACTIVE_STEP_STARTED_AT=0
}

ui_fail_step() {
  local detail elapsed formatted
  detail="${1:-failed}"
  elapsed=$((SECONDS - UI_ACTIVE_STEP_STARTED_AT))
  formatted="$(format_duration "$elapsed")"
  ui_render_step_line "failed" "$UI_ACTIVE_STEP_LABEL" "${detail} (${formatted})"
  UI_ACTIVE_STEP_LABEL=""
  UI_ACTIVE_STEP_STARTED_AT=0
}

ui_skip_step() {
  local label reason
  label="$1"
  reason="$2"
  UI_CURRENT_STEP=$((UI_CURRENT_STEP + 1))
  ui_render_step_line "skipped" "$label" "$reason"
}

ui_run_step_captured() {
  local label log_path step_status frame_index pid
  label="$1"
  shift

  if ! ui_is_fancy; then
    ui_begin_step_static "$label"
    set +e
    "$@"
    step_status=$?
    set -e
    if [[ "$step_status" -eq 0 ]]; then
      ui_complete_step
      return 0
    fi
    ui_fail_step
    return "$step_status"
  fi

  ui_begin_step "$label"
  log_path="$(ui_step_log_path)"
  : > "$log_path"
  "$@" >"$log_path" 2>&1 &
  pid=$!
  frame_index=0

  while kill -0 "$pid" 2>/dev/null; do
    ui_update_step "working" "$frame_index"
    frame_index=$((frame_index + 1))
    sleep 0.12
  done

  set +e
  wait "$pid"
  step_status=$?
  set -e

  if [[ "$step_status" -eq 0 ]]; then
    ui_complete_step
    return 0
  fi

  ui_preserve_logs
  ui_fail_step "see $(basename "$log_path")"
  ui_error "Step log: $log_path"
  ui_show_log_excerpt "$log_path"
  return "$step_status"
}

ui_run_step_foreground() {
  local label step_status
  label="$1"
  shift
  ui_begin_step_static "$label"
  set +e
  "$@"
  step_status=$?
  set -e
  if [[ "$step_status" -eq 0 ]]; then
    ui_complete_step
    return 0
  fi
  ui_fail_step
  return "$step_status"
}

ui_run_step_interactive() {
  local label step_status
  label="$1"
  shift
  ui_begin_step_static "$label" "interactive"
  ui_break_progress_line
  set +e
  "$@"
  step_status=$?
  set -e
  if [[ "$step_status" -eq 0 ]]; then
    ui_complete_step
    return 0
  fi
  ui_fail_step
  return "$step_status"
}

ui_print_banner() {
  local subtitle
  if [[ "${ACTION:-install}" == "update" ]]; then
    subtitle="Upgrade the existing Sovereign node in place."
  else
    subtitle="Provision and configure a Sovereign node from the terminal."
  fi

  ui_print "\n"
  if supports_color; then
    ui_print "\033[1;36m"
  fi
  ui_print " ___  _____   _____ ___ ___ ___ ___ _  _\n"
  ui_print "/ __|/ _ \\ \\ / / __| _ \\ __|_ _/ __| \\| |\n"
  ui_print "\\__ \\ (_) \\ V /| _||   / _| | | (_ | .\` |\n"
  ui_print "|___/\\___/ \\_/ |___|_|_\\___|___\\___|_|\\_|\n"
  ui_print "\n"
  ui_print "       _   ___   _  _  ___  ___  ___\n"
  ui_print "      /_\\ |_ _| | \\| |/ _ \\|   \\| __|\n"
  ui_print "     / _ \\ | |  | .\` | (_) | |) | _|\n"
  ui_print "    /_/ \\_\\___| |_|\\_|\\___/|___/|___|\n"
  if supports_color; then
    ui_print "\033[0m"
  fi
  ui_print "  ${subtitle}\n"
  ui_print "  ${UI_TOTAL_STEPS} phases queued.\n\n"
}

ui_print_summary_block() {
  local title payload
  title="$1"
  payload="$2"
  [[ -n "$payload" ]] || return 0
  ui_section "$title"
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    ui_print "  ${line}\n"
  done <<< "$payload"
}
