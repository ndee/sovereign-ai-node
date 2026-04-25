#!/usr/bin/env bash
# Concatenate scripts/install.sh and the lib-*.sh files into a single
# self-contained installer for shipping as a GitHub Release asset.
#
# Curl users will fetch the bundled file directly:
#   curl -fsSL https://github.com/ndee/sovereign-ai-node/releases/latest/download/install.sh \
#     | sudo bash
#
# Local-checkout users keep using the multi-file scripts/install.sh — it
# sources the lib-*.sh files at runtime when INSTALL_LIB_DIR resolves to a
# real directory. This builder is for release packaging only.
#
# Usage:
#   scripts/install/build.sh <output-path>
#
# The script does not require root and is safe to run on a developer laptop.
# Running it produces a byte-deterministic output for a given input tree.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <output-path>" >&2
  exit 2
fi

OUT="$1"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALL_SH="${REPO_ROOT}/scripts/install.sh"
LIB_DIR="${REPO_ROOT}/scripts/install"

mkdir -p "$(dirname "${OUT}")"
TMP="$(mktemp --tmpdir install-bundle.XXXXXX.sh)"
trap 'rm -f "${TMP}"' EXIT

JS_DIR="${LIB_DIR}/js"

# Inline a `.mjs` CLI entry as a `node --input-type=module` heredoc. Each CLI
# entry under js/bin/ imports `runCli` from a sibling module under js/ and
# invokes it. We resolve that import statically so the bundled installer can
# carry the JS body inline without needing INSTALL_LIB_DIR/js/ on disk.
#
# argv after the .mjs path (if any) is forwarded verbatim to the inlined
# `node - …` invocation so the JS body's process.argv lines up with the
# multi-file dev path.
inline_mjs() {
  local indent="$1"
  local cli_name="$2"
  local trailing_argv="$3"
  local cli_path="${JS_DIR}/bin/${cli_name}"
  if [[ ! -f "${cli_path}" ]]; then
    echo "::error::missing JS CLI entry: ${cli_path}" >&2
    exit 1
  fi
  local lib_relative
  lib_relative="$(awk -F'"' '/^import .* from "/ {print $2; exit}' "${cli_path}")"
  if [[ -z "${lib_relative}" ]]; then
    echo "::error::cannot find runCli import in ${cli_path}" >&2
    exit 1
  fi
  local lib_path
  lib_path="$(cd "$(dirname "${cli_path}")" && cd "$(dirname "${lib_relative}")" && pwd)/$(basename "${lib_relative}")"
  if [[ ! -f "${lib_path}" ]]; then
    echo "::error::cannot resolve ${lib_relative} from ${cli_path}" >&2
    exit 1
  fi
  if [[ -n "${trailing_argv}" ]]; then
    printf '%snode --input-type=module - %s <<'\''NODE'\''\n' "${indent}" "${trailing_argv}"
  else
    printf '%snode --input-type=module - <<'\''NODE'\''\n' "${indent}"
  fi
  cat "${lib_path}"
  printf 'runCli();\n'
  printf 'NODE\n'
}

# Stream a library file into the bundle, replacing each
#   node "${INSTALL_LIB_DIR}/js/bin/<name>.mjs" [args...]
# invocation with the inlined module heredoc.
inline_lib() {
  local lib_path="$1"
  local first=1
  while IFS= read -r line || [[ -n "${line}" ]]; do
    if [[ "${first}" == "1" ]]; then
      first=0
      [[ "${line}" == "#!"* ]] && continue
    fi
    if [[ "${line}" =~ ^([[:space:]]*)node[[:space:]]+\"\$\{INSTALL_LIB_DIR\}/js/bin/([a-z0-9-]+\.mjs)\"([[:space:]].*)?$ ]]; then
      local trailing="${BASH_REMATCH[3]:-}"
      # Strip leading whitespace from trailing argv.
      trailing="${trailing#"${trailing%%[![:space:]]*}"}"
      inline_mjs "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${trailing}"
    else
      printf '%s\n' "${line}"
    fi
  done < "${lib_path}"
}

while IFS= read -r line; do
  if [[ "${line}" =~ ^source\ \"\$\{INSTALL_LIB_DIR\}/(lib-[a-z-]+\.sh)\"$ ]]; then
    lib_name="${BASH_REMATCH[1]}"
    lib_path="${LIB_DIR}/${lib_name}"
    if [[ ! -f "${lib_path}" ]]; then
      echo "::error::missing library: ${lib_path}" >&2
      exit 1
    fi
    {
      echo "# ===== inlined from ${lib_name} ====="
      inline_lib "${lib_path}"
      echo "# ===== end ${lib_name} ====="
    } >> "${TMP}"
  elif [[ "${line}" =~ ^[[:space:]]*INSTALL_LIB_DIR= ]]; then
    # In the bundled installer, INSTALL_LIB_DIR is meaningless because all
    # libraries are inlined. Replace the lookup block with a no-op that the
    # surrounding `if` guard will accept.
    echo "INSTALL_LIB_DIR=\"\${INSTALL_LIB_DIR:-bundled}\"" >> "${TMP}"
  elif [[ "${line}" =~ ^if\ \[\[\ -z\ \"\$\{INSTALL_LIB_DIR\}\" ]]; then
    # Skip the missing-INSTALL_LIB_DIR error block (and the matching close
    # brace + blank line below). The bundled file does not need it.
    while IFS= read -r block_line; do
      [[ "${block_line}" == "fi" ]] && break
    done
  elif [[ "${line}" =~ ^#\ shellcheck\ source=install/lib- ]]; then
    # Bundled file has nothing to lint against; drop the shellcheck source
    # hint.
    :
  else
    printf '%s\n' "${line}" >> "${TMP}"
  fi
done < "${INSTALL_SH}"

mv "${TMP}" "${OUT}"
chmod +x "${OUT}"
trap - EXIT

# Sanity: bundled file should be syntactically valid bash.
bash -n "${OUT}"

# Sanity: bundled file must not still contain a `source ... lib-*.sh` line.
if grep -qE '^source.*lib-[a-z-]+\.sh' "${OUT}"; then
  echo "::error::bundle still contains a source statement; concatenation failed" >&2
  exit 1
fi

# Sanity: bundled file must not still reference the on-disk JS modules.
if grep -qE 'node[[:space:]]+"\$\{INSTALL_LIB_DIR\}/js/' "${OUT}"; then
  echo "::error::bundle still references INSTALL_LIB_DIR/js; .mjs inlining failed" >&2
  exit 1
fi

echo "Bundled installer written to: ${OUT}"
