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

# Strip the shebang from a library file when inlining (the bundled installer
# already has its own shebang at the top).
strip_shebang() {
  local file="$1"
  if [[ "$(head -n 1 "${file}")" == "#!"* ]]; then
    tail -n +2 "${file}"
  else
    cat "${file}"
  fi
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
      strip_shebang "${lib_path}"
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

echo "Bundled installer written to: ${OUT}"
