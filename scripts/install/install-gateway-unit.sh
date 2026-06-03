#!/usr/bin/env bash
# install-gateway-unit.sh: install the OpenClaw gateway systemd unit safely.
#
# This wrapper exists so the sovereign-node API service (running as a
# non-root SERVICE_USER) can (re)write and start the OpenClaw gateway
# systemd unit during a bundled-Matrix install via a single, narrowly-scoped
# sudoers entry — WITHOUT being able to choose the unit's privilege.
#
# Previously the service user was granted `sudo tee
# /etc/systemd/system/sovereign-openclaw-gateway.service` plus
# `systemctl enable --now`. Because tee writes whatever is piped in, the
# service user could write `User=root` and an arbitrary `ExecStart=` and
# have systemd run it as root — turning any service-user foothold into
# trivial root. This helper removes that primitive:
#
#   * The unit body is read from stdin, but User=/Group= are FORCED to the
#     trusted service identity (read from a root-owned file the service user
#     cannot write), and any unit that still names a different/extra
#     User=/Group= after normalization is rejected.
#   * The destination path is hard-coded here (never taken from argv/stdin)
#     and written without following a symlink.
#   * daemon-reload + enable are performed here, as root, so the service
#     user no longer needs those grants.
#
# Exit codes:
#   0  unit installed and daemon reloaded
#   non-zero  rejected or failed; stderr explains why.

set -euo pipefail

SCRIPT_NAME="install-gateway-unit"

err() {
  printf '[%s] ERROR: %s\n' "$SCRIPT_NAME" "$1" >&2
  exit 1
}

if [[ "$(id -u)" -ne 0 ]]; then
  err "must run as root"
fi

# Canonical, non-negotiable destination. Never derived from the unit body on
# stdin. SOVEREIGN_NODE_GATEWAY_UNIT_PATH exists only for tests; it is safe
# because the production sudoers grant invokes this helper through `sudo`
# with env_reset, so the service user's environment (including this var) is
# stripped and cannot reach the helper.
UNIT_PATH="${SOVEREIGN_NODE_GATEWAY_UNIT_PATH:-/etc/systemd/system/sovereign-openclaw-gateway.service}"
UNIT_NAME="sovereign-openclaw-gateway.service"

# Trusted service identity. Written root-owned by the installer
# (lib-build.sh) at /etc/sovereign-node/gateway-service-identity as two
# lines: "user=<name>" / "group=<name>". The service user cannot write this
# file (parent dir is root-owned 0755), so it cannot influence the identity.
IDENTITY_FILE="${SOVEREIGN_NODE_GATEWAY_IDENTITY_FILE:-/etc/sovereign-node/gateway-service-identity}"

SERVICE_USER=""
SERVICE_GROUP=""
if [[ -r "$IDENTITY_FILE" ]]; then
  while IFS='=' read -r key value; do
    case "$key" in
      user) SERVICE_USER="$value" ;;
      group) SERVICE_GROUP="$value" ;;
    esac
  done < "$IDENTITY_FILE"
fi
SERVICE_USER="${SERVICE_USER:-sovereign-node}"
SERVICE_GROUP="${SERVICE_GROUP:-${SERVICE_USER}}"

# A service identity of root would re-open the escalation; refuse it.
if [[ "$SERVICE_USER" == "root" || "$SERVICE_GROUP" == "root" ]]; then
  err "refusing to install a gateway unit that runs as root"
fi

# Validate the identity looks like a plausible unix account name (so a
# corrupted identity file can't inject systemd directives via the value).
identity_ok() {
  [[ "$1" =~ ^[a-z_][a-z0-9_-]*$ ]]
}
identity_ok "$SERVICE_USER" || err "invalid service user: $SERVICE_USER"
identity_ok "$SERVICE_GROUP" || err "invalid service group: $SERVICE_GROUP"

# Read the proposed unit from stdin.
unit_in="$(cat)"
if [[ -z "$unit_in" ]]; then
  err "empty unit on stdin"
fi

# Normalize: drop every existing User=/Group= line (any leading whitespace),
# then inject exactly one forced User=/Group= immediately after the
# [Service] header. This guarantees the unit runs as the service identity
# regardless of what the caller supplied.
normalized="$(
  printf '%s\n' "$unit_in" \
    | grep -ivE '^[[:space:]]*(User|Group)[[:space:]]*=' \
    | awk -v user="$SERVICE_USER" -v group="$SERVICE_GROUP" '
        { print }
        /^\[Service\][[:space:]]*$/ {
          print "User=" user
          print "Group=" group
        }
      '
)"

# Belt-and-suspenders: after normalization there must be exactly one
# User= and one Group=, each equal to the trusted identity. Anything else
# (e.g. a [Service] header the caller smuggled in twice) is rejected.
user_lines="$(printf '%s\n' "$normalized" | grep -icE '^User[[:space:]]*=' || true)"
group_lines="$(printf '%s\n' "$normalized" | grep -icE '^Group[[:space:]]*=' || true)"
if [[ "$user_lines" -ne 1 || "$group_lines" -ne 1 ]]; then
  err "unexpected User=/Group= count after normalization (user=$user_lines group=$group_lines)"
fi
if ! printf '%s\n' "$normalized" | grep -qxE "User=${SERVICE_USER}"; then
  err "normalized unit does not run as the trusted service user"
fi
if ! printf '%s\n' "$normalized" | grep -qxE "Group=${SERVICE_GROUP}"; then
  err "normalized unit does not run as the trusted service group"
fi
# A [Service] section is required for the forced identity to take effect.
if ! printf '%s\n' "$normalized" | grep -qxE '\[Service\][[:space:]]*'; then
  err "unit has no [Service] section"
fi

# Refuse to write through a symlink at the destination.
if [[ -L "$UNIT_PATH" ]]; then
  err "refusing to write through a symlink at $UNIT_PATH"
fi

# Write atomically via a temp file in the same directory, root-owned 0644.
unit_dir="$(dirname "$UNIT_PATH")"
install -d -m 0755 "$unit_dir"
tmp_unit="$(mktemp "${unit_dir}/.${UNIT_NAME}.XXXXXX")"
trap 'rm -f "$tmp_unit"' EXIT
printf '%s\n' "$normalized" > "$tmp_unit"
chown root:root "$tmp_unit"
chmod 0644 "$tmp_unit"
mv -f "$tmp_unit" "$UNIT_PATH"
trap - EXIT

systemctl daemon-reload
systemctl enable "$UNIT_NAME" >/dev/null 2>&1 || true

printf '[%s] installed %s (User=%s Group=%s)\n' \
  "$SCRIPT_NAME" "$UNIT_PATH" "$SERVICE_USER" "$SERVICE_GROUP"
