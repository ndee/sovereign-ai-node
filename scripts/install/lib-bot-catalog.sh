# shellcheck shell=bash
# lib-bot-catalog: bot list parsing, catalog loading, selection prompts.
#
# Depends on lib-log, lib-ui (ui_print, ui_warn, ui_is_fancy, supports_color,
# has_tty, UI_TERMINAL_WIDTH), lib-prompt (ui_screen_line_count) and reads the
# BOT_CATALOG_* globals populated by load_available_bot_catalog.

bot_list_contains() {
  local selected bot_id
  selected="$1"
  bot_id="$2"
  case ",${selected}," in
    *,"${bot_id}",*)
      return 0
      ;;
  esac
  return 1
}

append_selected_bot() {
  local selected bot_id
  selected="$1"
  bot_id="$2"
  if [[ -z "$selected" ]]; then
    printf '%s' "$bot_id"
  else
    printf '%s,%s' "$selected" "$bot_id"
  fi
}

load_available_bot_catalog() {
  local output id display default_install
  AVAILABLE_BOT_IDS=()
  AVAILABLE_BOT_DISPLAY_NAMES=()
  AVAILABLE_BOT_DEFAULT_INSTALLS=()

  if ! output="$(
    SOVEREIGN_BOTS_REPO_DIR="$BOTS_DIR" node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const repoDir = process.env.SOVEREIGN_BOTS_REPO_DIR || "";
const botsDir = path.join(repoDir, "bots");
if (!fs.existsSync(botsDir)) {
  throw new Error(`Bot repository is missing a bots/ directory: ${botsDir}`);
}

const packages = fs.readdirSync(botsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const manifestPath = path.join(botsDir, entry.name, "sovereign-bot.json");
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Missing sovereign-bot.json for bot package: ${entry.name}`);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      throw new Error(`Invalid bot manifest: ${manifestPath}`);
    }
    if (manifest.kind !== "sovereign-bot-package") {
      throw new Error(`Unsupported bot manifest kind in ${manifestPath}`);
    }
    if (typeof manifest.id !== "string" || manifest.id.trim().length === 0) {
      throw new Error(`Bot manifest is missing a valid id: ${manifestPath}`);
    }
    if (typeof manifest.displayName !== "string" || manifest.displayName.trim().length === 0) {
      throw new Error(`Bot manifest is missing a valid displayName: ${manifestPath}`);
    }
    return {
      id: manifest.id.trim(),
      displayName: manifest.displayName.trim(),
      defaultInstall: manifest.defaultInstall === true,
    };
  })
  .sort((left, right) =>
    left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id));

if (packages.length === 0) {
  throw new Error(`No sovereign bot packages found in ${botsDir}`);
}

process.stdout.write(packages.map((entry) =>
  [entry.id, entry.displayName, entry.defaultInstall ? "1" : "0"].join("\t")).join("\n"));
NODE
  )"; then
    die "Failed to load bot packages from ${BOTS_DIR}"
  fi

  while IFS=$'\t' read -r id display default_install; do
    [[ -n "$id" ]] || continue
    AVAILABLE_BOT_IDS+=("$id")
    AVAILABLE_BOT_DISPLAY_NAMES+=("$display")
    AVAILABLE_BOT_DEFAULT_INSTALLS+=("$default_install")
  done <<< "$output"
}

default_selected_bots_from_catalog() {
  local selected index
  selected=""
  for index in "${!AVAILABLE_BOT_IDS[@]}"; do
    if [[ "${AVAILABLE_BOT_DEFAULT_INSTALLS[$index]}" == "1" ]]; then
      selected="$(append_selected_bot "$selected" "${AVAILABLE_BOT_IDS[$index]}")"
    fi
  done
  printf '%s' "$selected"
}

resolve_bot_display_name() {
  local bot_id index
  bot_id="$1"
  for index in "${!AVAILABLE_BOT_IDS[@]}"; do
    if [[ "${AVAILABLE_BOT_IDS[$index]}" == "$bot_id" ]]; then
      printf '%s' "${AVAILABLE_BOT_DISPLAY_NAMES[$index]}"
      return 0
    fi
  done
  return 1
}

describe_selected_bots() {
  local selected joined entry display
  local -a entries
  selected="$1"
  joined=""
  IFS=',' read -r -a entries <<< "$selected"
  for entry in "${entries[@]}"; do
    [[ -n "$entry" ]] || continue
    if ! display="$(resolve_bot_display_name "$entry")"; then
      display="$entry"
    fi
    if [[ -n "$joined" ]]; then
      joined="${joined}, ${display}"
      continue
    fi
    joined="$display"
  done
  if [[ -z "$joined" ]]; then
    joined="none"
  fi
  printf '%s' "$joined"
}

build_default_bot_selection_numbers() {
  local selected numbers index option_number
  selected="$1"
  numbers=""

  for index in "${!AVAILABLE_BOT_IDS[@]}"; do
    if bot_list_contains "$selected" "${AVAILABLE_BOT_IDS[$index]}"; then
      option_number=$((index + 1))
      if [[ -n "$numbers" ]]; then
        numbers="${numbers},${option_number}"
      else
        numbers="$option_number"
      fi
    fi
  done

  printf '%s' "$numbers"
}

parse_bot_selection_input() {
  local raw token selected index option_number
  local -a requested_numbers
  raw="$1"
  selected=""
  requested_numbers=()

  case "$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')" in
    all)
      for index in "${!AVAILABLE_BOT_IDS[@]}"; do
        selected="$(append_selected_bot "$selected" "${AVAILABLE_BOT_IDS[$index]}")"
      done
      printf '%s' "$selected"
      return 0
      ;;
    none)
      printf ''
      return 0
      ;;
  esac

  raw="$(printf '%s' "$raw" | tr ',' ' ')"
  for token in $raw; do
    if [[ ! "$token" =~ ^[0-9]+$ ]]; then
      return 1
    fi
    if (( token < 1 || token > ${#AVAILABLE_BOT_IDS[@]} )); then
      return 1
    fi
    requested_numbers+=("$token")
  done

  for index in "${!AVAILABLE_BOT_IDS[@]}"; do
    option_number=$((index + 1))
    for token in "${requested_numbers[@]}"; do
      if [[ "$token" == "$option_number" ]]; then
        selected="$(append_selected_bot "$selected" "${AVAILABLE_BOT_IDS[$index]}")"
        break
      fi
    done
  done

  printf '%s' "$selected"
}

build_bot_selection_from_flags() {
  local result index
  result=""

  for index in "${!AVAILABLE_BOT_IDS[@]}"; do
    if [[ "${BOT_SELECTION_FLAGS[$index]:-0}" == "1" ]]; then
      result="$(append_selected_bot "$result" "${AVAILABLE_BOT_IDS[$index]}")"
    fi
  done

  printf '%s' "$result"
}

set_bot_selection_flags_from_list() {
  local selected index
  selected="$1"

  BOT_SELECTION_FLAGS=()
  for index in "${!AVAILABLE_BOT_IDS[@]}"; do
    if bot_list_contains "$selected" "${AVAILABLE_BOT_IDS[$index]}"; then
      BOT_SELECTION_FLAGS+=("1")
    else
      BOT_SELECTION_FLAGS+=("0")
    fi
  done
}

prompt_bot_selection_simple() {
  local selected default_numbers answer parsed_selection index option_number marker suffix
  selected="$1"

  if [[ "${#AVAILABLE_BOT_IDS[@]}" -eq 0 ]]; then
    die "No bots were loaded from ${BOTS_DIR}. Check the bots repository before continuing."
  fi

  while true; do
    default_numbers="$(build_default_bot_selection_numbers "$selected")"
    ui_print "Choose bots to install (comma-separated numbers, or 'all').\n"
    for index in "${!AVAILABLE_BOT_IDS[@]}"; do
      option_number=$((index + 1))
      marker=" "
      suffix=""
      if bot_list_contains "$selected" "${AVAILABLE_BOT_IDS[$index]}"; then
        marker="x"
      fi
      if [[ "${AVAILABLE_BOT_DEFAULT_INSTALLS[$index]}" == "1" ]]; then
        suffix=" [default]"
      fi
      ui_print "  ${option_number}) [${marker}] ${AVAILABLE_BOT_DISPLAY_NAMES[$index]}${suffix}\n"
    done
    if [[ -n "$default_numbers" ]]; then
      ui_print "Select [${default_numbers}]: "
    else
      ui_print "Select: "
    fi
    IFS= read -r answer < /dev/tty || true
    if [[ -z "$answer" ]]; then
      answer="$default_numbers"
    fi
    if ! parsed_selection="$(parse_bot_selection_input "$answer")"; then
      ui_warn "Enter one or more bot numbers separated by commas, or 'all'."
      continue
    fi
    if [[ -z "$parsed_selection" ]]; then
      ui_warn "Select at least one bot to install."
      continue
    fi
    printf '%s' "$parsed_selection"
    return 0
  done
}

prompt_bot_selection_graphical() {
  local selected current_index rendered_lines key extra current_selection
  local index marker line suffix status_line display_name
  local title_line help_line summary_plain

  selected="$1"
  current_index=0
  rendered_lines=0
  key=""
  extra=""
  status_line=""
  title_line="Choose bots to install"
  help_line="  arrows move, space toggle, enter confirm, a all, n none."

  if [[ "${#AVAILABLE_BOT_IDS[@]}" -eq 0 ]]; then
    die "No bots were loaded from ${BOTS_DIR}. Check the bots repository before continuing."
  fi

  set_bot_selection_flags_from_list "$selected"
  for index in "${!BOT_SELECTION_FLAGS[@]}"; do
    if [[ "${BOT_SELECTION_FLAGS[$index]}" == "1" ]]; then
      current_index="$index"
      break
    fi
  done

  redraw_bot_selection_menu() {
    local selected_count

    if [[ "$rendered_lines" -gt 0 ]]; then
      ui_print "\033[${rendered_lines}A\r\033[J"
    fi

    rendered_lines=0
    current_selection="$(build_bot_selection_from_flags)"
    selected_count=0
    for index in "${!BOT_SELECTION_FLAGS[@]}"; do
      if [[ "${BOT_SELECTION_FLAGS[$index]}" == "1" ]]; then
        selected_count=$((selected_count + 1))
      fi
    done

    ui_print "${title_line}\n"
    rendered_lines=$((rendered_lines + $(ui_screen_line_count "$title_line")))
    ui_print "${help_line}\n"
    rendered_lines=$((rendered_lines + $(ui_screen_line_count "$help_line")))

    for index in "${!AVAILABLE_BOT_IDS[@]}"; do
      if [[ "${BOT_SELECTION_FLAGS[$index]}" == "1" ]]; then
        marker="[x]"
      else
        marker="[ ]"
      fi

      suffix=""
      if [[ "${AVAILABLE_BOT_DEFAULT_INSTALLS[$index]}" == "1" ]]; then
        suffix="  default"
      fi
      display_name="${AVAILABLE_BOT_DISPLAY_NAMES[$index]}${suffix}"
      line="  ${marker} ${display_name}"

      if [[ "$index" == "$current_index" ]]; then
        if supports_color; then
          ui_print "  \033[1;36m>\033[0m \033[7m${line}\033[0m\n"
        else
          ui_print "  > ${line}\n"
        fi
      else
        ui_print "    ${line}\n"
      fi
      rendered_lines=$((rendered_lines + $(ui_screen_line_count "  > ${line}")))
    done

    if [[ -n "$status_line" ]]; then
      if supports_color; then
        ui_print "  \033[33m${status_line}\033[0m\n"
      else
        ui_print "  ${status_line}\n"
      fi
      rendered_lines=$((rendered_lines + $(ui_screen_line_count "  ${status_line}")))
    else
      summary_plain="  Selected (${selected_count}): $(describe_selected_bots "$current_selection")"
      ui_print "${summary_plain}\n"
      rendered_lines=$((rendered_lines + $(ui_screen_line_count "$summary_plain")))
    fi
  }

  while true; do
    redraw_bot_selection_menu
    IFS= read -rsn1 key < /dev/tty || true

    if [[ "$key" == $'\e' ]]; then
      IFS= read -rsn1 -t 0.05 extra < /dev/tty || extra=""
      if [[ "$extra" == "[" ]]; then
        IFS= read -rsn1 -t 0.05 extra < /dev/tty || extra=""
        case "$extra" in
          A)
            if [[ "$current_index" -gt 0 ]]; then
              current_index=$((current_index - 1))
            fi
            status_line=""
            continue
            ;;
          B)
            if [[ "$current_index" -lt $((${#AVAILABLE_BOT_IDS[@]} - 1)) ]]; then
              current_index=$((current_index + 1))
            fi
            status_line=""
            continue
            ;;
        esac
      fi
    fi

    case "$key" in
      " ")
        if [[ "${BOT_SELECTION_FLAGS[$current_index]}" == "1" ]]; then
          BOT_SELECTION_FLAGS[$current_index]="0"
        else
          BOT_SELECTION_FLAGS[$current_index]="1"
        fi
        status_line=""
        ;;
      "")
        current_selection="$(build_bot_selection_from_flags)"
        if [[ -z "$current_selection" ]]; then
          status_line="Select at least one bot to install."
          continue
        fi
        ui_print "\033[${rendered_lines}A\r\033[J"
        ui_print "Selected bots: $(describe_selected_bots "$current_selection")\n"
        printf '%s' "$current_selection"
        return 0
        ;;
      a|A)
        for index in "${!BOT_SELECTION_FLAGS[@]}"; do
          BOT_SELECTION_FLAGS[$index]="1"
        done
        status_line=""
        ;;
      n|N)
        for index in "${!BOT_SELECTION_FLAGS[@]}"; do
          BOT_SELECTION_FLAGS[$index]="0"
        done
        status_line=""
        ;;
      j|J)
        if [[ "$current_index" -lt $((${#AVAILABLE_BOT_IDS[@]} - 1)) ]]; then
          current_index=$((current_index + 1))
        fi
        status_line=""
        ;;
      k|K)
        if [[ "$current_index" -gt 0 ]]; then
          current_index=$((current_index - 1))
        fi
        status_line=""
        ;;
      [1-9])
        index=$((10#$key - 1))
        if [[ "$index" -lt "${#BOT_SELECTION_FLAGS[@]}" ]]; then
          if [[ "${BOT_SELECTION_FLAGS[$index]}" == "1" ]]; then
            BOT_SELECTION_FLAGS[$index]="0"
          else
            BOT_SELECTION_FLAGS[$index]="1"
          fi
          current_index="$index"
          status_line=""
        fi
        ;;
      *)
        status_line="Use up/down, space, enter, a, or n."
        ;;
    esac
  done
}

prompt_bot_selection() {
  if ui_is_fancy && has_tty; then
    prompt_bot_selection_graphical "$1"
    return 0
  fi

  prompt_bot_selection_simple "$1"
}
