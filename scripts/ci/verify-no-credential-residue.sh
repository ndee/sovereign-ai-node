#!/usr/bin/env bash
# Checks, on a host freshly installed by scripts/install.sh, that none of the
# install's credentials ended up in the journal, the auth log, the node's own
# logs or its install job records. Process arguments of privileged calls are
# recorded by sudo, so a secret passed on a command line shows up here.
# Also proves the operator account was registered with its stored password,
# since that password now reaches the homeserver on stdin. Run as root.

set -euo pipefail

SECRETS_DIR="${SECRETS_DIR:-/etc/sovereign-node/secrets}"
STATE_DIR="${STATE_DIR:-/var/lib/sovereign-node}"
LOGS_DIR="${LOGS_DIR:-/var/log/sovereign-node}"
MATRIX_BASE_URL="${MATRIX_BASE_URL:-http://127.0.0.1:8008}"
OPERATOR_LOCALPART="${OPERATOR_LOCALPART:-operator}"
# Shorter values are too likely to match unrelated log text.
MIN_SECRET_LENGTH=12

failed=0
pass() { printf 'PASS %s\n' "$1"; }
fail() {
  printf 'FAIL %s\n' "$1"
  failed=1
}

secrets=()
labels=()
add_secret() {
  local label="$1" value="$2"
  if ((${#value} >= MIN_SECRET_LENGTH)); then
    labels+=("$label")
    secrets+=("$value")
  fi
}

for file in "$SECRETS_DIR"/*; do
  [[ -f "$file" ]] || continue
  [[ "$(wc -l <"$file")" -le 1 ]] || continue
  add_secret "secret file $(basename "$file")" "$(tr -d '\r\n' <"$file")"
done
for homeserver in "$STATE_DIR"/bundled-matrix/*/synapse/homeserver.yaml; do
  [[ -f "$homeserver" ]] || continue
  shared_secret="$(sed -n 's/^registration_shared_secret: "\(.*\)"$/\1/p' "$homeserver")"
  add_secret "registration shared secret" "$shared_secret"
done

if ((${#secrets[@]} >= 3)); then
  pass "collected ${#secrets[@]} install credentials to look for"
else
  fail "expected at least the two account passwords and the registration secret, found ${#secrets[@]}"
fi

residue_dir="$(mktemp -d)"
trap 'rm -rf "$residue_dir"' EXIT
journalctl --no-pager -o cat >"$residue_dir/journal" 2>/dev/null || true
sources=("$residue_dir/journal")
for path in /var/log/auth.log "$LOGS_DIR" "$STATE_DIR/install-jobs"; do
  [[ -e "$path" ]] && sources+=("$path")
done
printf 'searching: %s\n' "${sources[*]}"

for index in "${!secrets[@]}"; do
  # The secret is fed as a pattern file so it never becomes a grep argument.
  if grep -rlF -f <(printf '%s\n' "${secrets[$index]}") "${sources[@]}" >"$residue_dir/hits"; then
    fail "${labels[$index]} found in: $(sed "s|$residue_dir/journal|journal|" "$residue_dir/hits" | tr '\n' ' ')"
  else
    pass "${labels[$index]} is in no log or job record"
  fi
done

operator_password_file="$SECRETS_DIR/matrix-$OPERATOR_LOCALPART.password"
if [[ -f "$operator_password_file" ]] &&
  jq -n --rawfile password "$operator_password_file" --arg user "$OPERATOR_LOCALPART" \
    '{type: "m.login.password", identifier: {type: "m.id.user", user: $user}, password: ($password | rtrimstr("\n"))}' |
  curl -fsS --retry 3 --retry-delay 2 -H 'Content-Type: application/json' --data @- \
    "$MATRIX_BASE_URL/_matrix/client/v3/login" | jq -e '.access_token | length > 0' >/dev/null; then
  pass "operator logs in with the stored password"
else
  fail "operator cannot log in with the stored password"
fi

exit "$failed"
