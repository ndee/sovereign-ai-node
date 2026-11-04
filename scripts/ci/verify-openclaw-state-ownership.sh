#!/usr/bin/env bash
# Checks, on a host installed by scripts/install.sh, that the OpenClaw home
# belongs to the gateway's service user. OpenClaw 2026.8 keeps its state in a
# SQLite database under .openclaw/state; one entry there created by a root-run
# command locks the gateway out of its own state, and a root-owned ~/.npm stops
# the service user's plugin installs. Only the trusted extension tree is
# root-owned by design. Run as root.

set -euo pipefail

SERVICE_USER="${SERVICE_USER:-sovereign-node}"
OPENCLAW_SERVICE_HOME="${OPENCLAW_SERVICE_HOME:-/var/lib/sovereign-node/openclaw-home}"
STATE_DIR="$OPENCLAW_SERVICE_HOME/.openclaw/state"
TRUSTED_EXTENSIONS="$OPENCLAW_SERVICE_HOME/.openclaw/extensions"

failed=0
pass() { printf 'PASS %s\n' "$1"; }
fail() {
  printf 'FAIL %s\n' "$1"
  failed=1
}

if [[ -d "$STATE_DIR" && "$(stat -c %U "$STATE_DIR")" == "$SERVICE_USER" ]]; then
  pass "$STATE_DIR exists and belongs to $SERVICE_USER"
else
  fail "$STATE_DIR is missing or does not belong to $SERVICE_USER"
fi

if sudo -u "$SERVICE_USER" -- test -r "$STATE_DIR" -a -w "$STATE_DIR" -a -x "$STATE_DIR"; then
  pass "$SERVICE_USER can read, write and enter $STATE_DIR"
else
  fail "$SERVICE_USER cannot read, write or enter $STATE_DIR"
fi

foreign="$(find "$OPENCLAW_SERVICE_HOME" -xdev -path "$TRUSTED_EXTENSIONS" -prune -o ! -user "$SERVICE_USER" -printf '%u:%g %m %p\n')"
if [[ -z "$foreign" ]]; then
  pass "everything in $OPENCLAW_SERVICE_HOME outside the trusted extensions belongs to $SERVICE_USER"
else
  fail "entries in $OPENCLAW_SERVICE_HOME belong to another user:"
  printf '%s\n' "$foreign"
fi

exit "$failed"
