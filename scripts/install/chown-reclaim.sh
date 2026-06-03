#!/usr/bin/env bash
# chown-reclaim.sh: re-claim ownership of a fixed set of runtime paths.
#
# The sovereign-node API service (non-root SERVICE_USER) sometimes needs to
# re-claim ownership of runtime directories that docker-compose or the
# bootstrap install.sh left root-owned. Previously this was a sudoers grant
# of `chown -R [0-9]*:[0-9]* .../bundled-matrix/*` and `.../secrets/*` with a
# glob top-level argument — a planted symlink as that argument could redirect
# the recursive chown outside the intended subtree.
#
# This helper removes that risk:
#   * The caller passes an ALLOWLIST KEY, not a path. The key maps to a
#     hard-coded canonical path here, so no caller-supplied path is ever
#     chowned.
#   * The target must be a real directory, not a symlink, or the helper
#     refuses (closing the symlink-redirect vector).
#   * The new owner is uid:gid, each validated as numeric.
#
# Usage:
#   chown-reclaim.sh <key> <uid> <gid>
#   key ∈ { bundled-matrix, secrets }
#
# Exit codes:
#   0  ownership reclaimed
#   non-zero  rejected or failed; stderr explains why.

set -euo pipefail

SCRIPT_NAME="chown-reclaim"

err() {
  printf '[%s] ERROR: %s\n' "$SCRIPT_NAME" "$1" >&2
  exit 1
}

if [[ "$(id -u)" -ne 0 ]]; then
  err "must run as root"
fi

key="${1:-}"
uid="${2:-}"
gid="${3:-}"

# Allowlist: key -> canonical path. No caller path input is honored.
case "$key" in
  bundled-matrix) target="/var/lib/sovereign-node/bundled-matrix" ;;
  secrets)        target="/etc/sovereign-node/secrets" ;;
  *)              err "unknown reclaim key: ${key:-<empty>}" ;;
esac

[[ "$uid" =~ ^[0-9]+$ ]] || err "uid must be numeric: ${uid:-<empty>}"
[[ "$gid" =~ ^[0-9]+$ ]] || err "gid must be numeric: ${gid:-<empty>}"

# Refuse to chown a non-existent target, or one that is (or is reached via) a
# symlink — that is exactly the redirect vector this helper closes.
if [[ -L "$target" ]]; then
  err "refusing to chown a symlinked target: $target"
fi
if [[ ! -d "$target" ]]; then
  err "target is not a directory: $target"
fi

# -h would only matter for the top entry; -R needs --no-dereference behaviour
# on the whole tree. coreutils chown -R does not follow symlinks it
# encounters during recursion unless -L is given, and we explicitly do not
# pass -L, so symlinks inside the tree are chowned as links, not followed.
chown -R --no-dereference "${uid}:${gid}" "$target"

printf '[%s] reclaimed %s -> %s:%s\n' "$SCRIPT_NAME" "$target" "$uid" "$gid"
