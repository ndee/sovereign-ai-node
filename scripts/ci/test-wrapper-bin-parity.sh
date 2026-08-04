#!/usr/bin/env bash
# test-wrapper-bin-parity.sh — Guard against package.json bin ↔ installer wrapper drift.
#
# WHY THIS EXISTS: Pro web installs shipped hosts without /usr/local/bin/sovereign-tool
# because the wrapper set in scripts/install/lib-build.sh is maintained by hand,
# separately from the package.json `bin` map (issue node-pro#324). Mail Sentinel
# could never scan mail on those hosts. This test fails whenever the two lists —
# or the wrappers' exec targets — drift apart.
#
# Asserts, for every key <name> of package.json `.bin`:
#   1. lib-build.sh contains a `cat > /usr/local/bin/<name>` wrapper block;
#   2. that wrapper execs `dist/<name>.js`, and the bin entry points at the
#      same file (`./dist/<name>.js`);
#   3. the wrapper is included in the chmod line that marks it executable.
# And conversely: every `cat > /usr/local/bin/<name>` wrapper in lib-build.sh
# corresponds to a package.json bin entry.
#
# Dependencies: bash, jq, grep. Exit 0 = parity holds, 1 = drift detected.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PACKAGE_JSON="$REPO_ROOT/package.json"
LIB_BUILD="$REPO_ROOT/scripts/install/lib-build.sh"

fail=0
error() {
  printf 'FAIL: %s\n' "$*" >&2
  fail=1
}

[[ -f "$PACKAGE_JSON" ]] || { error "missing $PACKAGE_JSON"; exit 1; }
[[ -f "$LIB_BUILD" ]] || { error "missing $LIB_BUILD"; exit 1; }
command -v jq >/dev/null 2>&1 || { error "jq is required"; exit 1; }

# ── package.json bin → installer wrapper ──
while IFS=$'\t' read -r name target; do
  # The bin entry must follow the ./dist/<name>.js convention the wrappers assume.
  if [[ "$target" != "./dist/${name}.js" ]]; then
    error "package.json bin '$name' points at '$target', expected './dist/${name}.js'"
  fi

  # 1. A wrapper heredoc must exist for this bin.
  if ! grep -Eq "^[[:space:]]*cat > /usr/local/bin/${name} <<" "$LIB_BUILD"; then
    error "lib-build.sh install_wrappers() has no 'cat > /usr/local/bin/${name}' block — a fresh install would ship without ${name} (see issue node-pro#324)"
    continue
  fi

  # 2. The wrapper must exec the same dist file the bin entry declares.
  wrapper_block="$(sed -n "/^[[:space:]]*cat > \/usr\/local\/bin\/${name} <</,/^EOF$/p" "$LIB_BUILD")"
  if ! grep -Fq "exec node \"\$APP_DIR/dist/${name}.js\"" <<<"$wrapper_block"; then
    error "wrapper /usr/local/bin/${name} does not exec \"\$APP_DIR/dist/${name}.js\" — exec target drifted from package.json bin entry"
  fi

  # 3. The wrapper must be marked executable.
  if ! grep -Eq "^[[:space:]]*chmod [0-7]+ .*(/usr/local/bin/${name})([[:space:]]|\$)" "$LIB_BUILD"; then
    error "lib-build.sh does not chmod /usr/local/bin/${name}"
  fi
done < <(jq -r '.bin | to_entries[] | "\(.key)\t\(.value)"' "$PACKAGE_JSON")

# ── installer wrapper → package.json bin ──
while IFS= read -r wrapper_name; do
  if ! jq -e --arg name "$wrapper_name" '.bin | has($name)' "$PACKAGE_JSON" >/dev/null; then
    error "lib-build.sh installs /usr/local/bin/${wrapper_name} but package.json has no bin entry for it"
  fi
done < <(grep -Eo '^[[:space:]]*cat > /usr/local/bin/[A-Za-z0-9._-]+ <<' "$LIB_BUILD" \
  | sed -E 's|.*/usr/local/bin/([A-Za-z0-9._-]+) <<|\1|')

if [[ $fail -ne 0 ]]; then
  echo "wrapper/bin parity check FAILED" >&2
  exit 1
fi

echo "wrapper/bin parity check passed: package.json bin entries and lib-build.sh wrappers match"
