# shellcheck shell=bash
# lib-prompt: interactive prompts (choice menus, yes/no, value, secret).
#
# Depends on lib-ui (ui_print, ui_warn, ui_is_fancy, supports_color, has_tty,
# UI_TERMINAL_WIDTH) and lib-log indirectly.

ui_screen_line_count() {
  local text width length count
  text="$1"
  width="${UI_TERMINAL_WIDTH:-80}"
  length="${#text}"

  if [[ "$width" -lt 1 ]]; then
    width=80
  fi

  if [[ "$length" -le 0 ]]; then
    printf '1'
    return 0
  fi

  count=$(((length + width - 1) / width))
  if [[ "$count" -lt 1 ]]; then
    count=1
  fi
  printf '%s' "$count"
}

ui_choice_menu_simple() {
  local prompt default_choice answer option_count index option_number
  prompt="$1"
  default_choice="$2"
  shift 2
  local options=("$@")
  option_count="${#options[@]}"

  while true; do
    ui_print "${prompt}\n"
    for index in "${!options[@]}"; do
      option_number=$((index + 1))
      if [[ "$option_number" == "$default_choice" ]]; then
        ui_print "  ${option_number}) ${options[$index]} [default]\n"
      else
        ui_print "  ${option_number}) ${options[$index]}\n"
      fi
    done
    ui_print "Select [${default_choice}]: "
    IFS= read -r answer < /dev/tty || true
    if [[ -z "$answer" ]]; then
      answer="$default_choice"
    fi
    if [[ "$answer" =~ ^[0-9]+$ ]] && (( answer >= 1 && answer <= option_count )); then
      printf '%s' "$answer"
      return 0
    fi
    ui_warn "Please enter a number between 1 and ${option_count}."
  done
}

ui_choice_menu_graphical() {
  local prompt default_choice current_index rendered_lines key extra option_count index option_number
  local plain_line display_line help_line summary_line
  prompt="$1"
  default_choice="$2"
  shift 2
  local options=("$@")
  option_count="${#options[@]}"
  current_index=$((default_choice - 1))
  rendered_lines=0
  key=""
  extra=""
  help_line="  arrows move, enter confirm."

  while true; do
    if [[ "$rendered_lines" -gt 0 ]]; then
      ui_print "\033[${rendered_lines}A\r\033[J"
    fi

    rendered_lines=0
    ui_print "${prompt}\n"
    rendered_lines=$((rendered_lines + $(ui_screen_line_count "$prompt")))
    ui_print "${help_line}\n"
    rendered_lines=$((rendered_lines + $(ui_screen_line_count "$help_line")))

    for index in "${!options[@]}"; do
      option_number=$((index + 1))
      plain_line="${options[$index]}"
      if [[ "$option_number" == "$default_choice" ]]; then
        plain_line="${plain_line}  default"
      fi
      display_line="  ${plain_line}"

      if [[ "$index" == "$current_index" ]]; then
        if supports_color; then
          ui_print "  \033[1;36m>\033[0m \033[7m${display_line}\033[0m\n"
        else
          ui_print "  > ${display_line}\n"
        fi
      else
        ui_print "    ${display_line}\n"
      fi
      rendered_lines=$((rendered_lines + $(ui_screen_line_count "  > ${display_line}")))
    done

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
            continue
            ;;
          B)
            if [[ "$current_index" -lt $((option_count - 1)) ]]; then
              current_index=$((current_index + 1))
            fi
            continue
            ;;
        esac
      fi
    fi

    case "$key" in
      "")
        summary_line="Selected: ${options[$current_index]}"
        ui_print "\033[${rendered_lines}A\r\033[J"
        ui_print "${summary_line}\n"
        printf '%s' "$((current_index + 1))"
        return 0
        ;;
      j|J)
        if [[ "$current_index" -lt $((option_count - 1)) ]]; then
          current_index=$((current_index + 1))
        fi
        ;;
      k|K)
        if [[ "$current_index" -gt 0 ]]; then
          current_index=$((current_index - 1))
        fi
        ;;
      [1-9])
        index=$((10#$key - 1))
        if [[ "$index" -lt "$option_count" ]]; then
          current_index="$index"
        fi
        ;;
    esac
  done
}

ui_choice_menu() {
  if ui_is_fancy && has_tty; then
    ui_choice_menu_graphical "$@"
    return 0
  fi

  ui_choice_menu_simple "$@"
}

ui_confirm_simple() {
  local prompt default answer normalized
  prompt="$1"
  default="$2"
  while true; do
    ui_print "${prompt} [y/n] (default: ${default}): "
    IFS= read -r answer < /dev/tty || true
    normalized="$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]')"
    if [[ -z "$normalized" ]]; then
      normalized="$default"
    fi
    case "$normalized" in
      y|yes)
        return 0
        ;;
      n|no)
        return 1
        ;;
    esac
    ui_warn "Please answer y or n."
  done
}

ui_confirm() {
  local prompt default selected_choice default_choice
  prompt="$1"
  default="$2"

  if ui_is_fancy && has_tty; then
    if [[ "$default" == "y" ]] || [[ "$default" == "yes" ]]; then
      default_choice="1"
    else
      default_choice="2"
    fi
    selected_choice="$(
      ui_choice_menu \
        "$prompt" \
        "$default_choice" \
        "Yes" \
        "No"
    )"
    [[ "$selected_choice" == "1" ]]
    return $?
  fi

  ui_confirm_simple "$prompt" "$default"
}

prompt_value() {
  local prompt default value
  prompt="$1"
  default="${2:-}"
  if [[ -n "$default" ]]; then
    ui_print "${prompt} [${default}]: "
  else
    ui_print "${prompt}: "
  fi
  IFS= read -r value < /dev/tty || true
  if [[ -z "$value" ]]; then
    value="$default"
  fi
  printf '%s' "$value"
}

prompt_secret() {
  local prompt value
  prompt="$1"
  ui_print "${prompt}: "
  stty -echo < /dev/tty
  IFS= read -r value < /dev/tty || true
  stty echo < /dev/tty
  ui_print "\n"
  printf '%s' "$value"
}

prompt_required_secret() {
  local prompt empty_message value
  prompt="$1"
  empty_message="$2"
  value="$(prompt_secret "$prompt")"
  while [[ -z "$value" ]]; do
    ui_warn "$empty_message"
    value="$(prompt_secret "$prompt")"
  done
  printf '%s' "$value"
}
