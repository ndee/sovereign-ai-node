#!/usr/bin/env bash
# Checks, on an installed node, that the OpenClaw gateway authenticates its
# local callers with the token in the rendered runtime config. The bots read
# their gateway token only from gateway.auth.token there; a gateway that runs
# with a token kept only in its own memory rejects every one of their
# /tools/invoke calls. Run as root.
#
# Usage:
#   verify-gateway-auth.sh config             the config carries the token, owner-only
#   verify-gateway-auth.sh check              config, and the gateway accepts that token and only it
#   verify-gateway-auth.sh record <file>      config, and save a fingerprint of the token
#   verify-gateway-auth.sh unchanged <file>   config, and require the recorded token
#
# The token is never printed (beyond registering it with the CI runner's log
# mask) and never becomes a process argument.
# Exit codes: 0 pass, 1 check failed, 64 usage error.

set -euo pipefail

SERVICE_USER="${SERVICE_USER:-sovereign-node}"
OPENCLAW_SERVICE_HOME="${OPENCLAW_SERVICE_HOME:-/var/lib/sovereign-node/openclaw-home}"
OPENCLAW_CONFIG="${OPENCLAW_CONFIG:-$OPENCLAW_SERVICE_HOME/.openclaw/openclaw.json5}"
GATEWAY_ENV="${GATEWAY_ENV:-$OPENCLAW_SERVICE_HOME/gateway.env}"
NODE_CONFIG_DIR="${NODE_CONFIG_DIR:-/etc/sovereign-node}"
APP_DIR="${APP_DIR:-/opt/sovereign-ai-node/app}"
# A tool no node agent has: an authenticated call reaches tool lookup and gets
# 404 without running a model or touching any state.
PROBE_TOOL="sovereign_ci_gateway_auth_probe"
MIN_TOKEN_LENGTH=32

failed=0
pass() { printf 'PASS %s\n' "$1"; }
fail() {
  printf 'FAIL %s\n' "$1"
  failed=1
}

work_dir="$(mktemp -d)"
chmod 700 "$work_dir"
trap 'rm -rf "$work_dir"' EXIT
token_file="$work_dir/token"

read_config() {
  jq '.' "$OPENCLAW_CONFIG" 2>/dev/null ||
    node -e '
      const JSON5 = require(process.argv[1]);
      process.stdout.write(JSON.stringify(JSON5.parse(require("node:fs").readFileSync(process.argv[2], "utf8"))));
    ' "$APP_DIR/node_modules/json5" "$OPENCLAW_CONFIG"
}

check_config() {
  local mode owner auth_mode token_length
  if [[ ! -f "$OPENCLAW_CONFIG" ]]; then
    fail "$OPENCLAW_CONFIG does not exist"
    return
  fi
  read -r mode owner < <(stat -c '%a %U' "$OPENCLAW_CONFIG")
  if [[ "$mode" == "600" && "$owner" == "$SERVICE_USER" ]]; then
    pass "$OPENCLAW_CONFIG is mode 600 and belongs to $SERVICE_USER"
  else
    fail "$OPENCLAW_CONFIG is mode $mode owned by $owner, expected 600 owned by $SERVICE_USER"
  fi

  read_config >"$work_dir/config.json"
  auth_mode="$(jq -r '.gateway.auth.mode // "<unset>"' "$work_dir/config.json")"
  jq -j '.gateway.auth.token | strings' "$work_dir/config.json" >"$token_file"
  token_length="$(wc -c <"$token_file")"
  if [[ "$auth_mode" == "token" && "$token_length" -ge "$MIN_TOKEN_LENGTH" ]]; then
    pass "gateway.auth is token mode with a ${token_length}-character token"
  else
    fail "gateway.auth.mode is $auth_mode with a ${token_length}-character token, expected token mode and at least $MIN_TOKEN_LENGTH characters"
    return
  fi
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    printf '::add-mask::%s\n' "$(cat "$token_file")"
  fi

  local copies=()
  for path in "$GATEWAY_ENV" "$NODE_CONFIG_DIR"; do
    [[ -e "$path" ]] || continue
    while IFS= read -r hit; do
      copies+=("$hit")
    done < <(grep -rlF -f "$token_file" "$path" || true)
  done
  if ((${#copies[@]} == 0)); then
    pass "the token has no copy in $GATEWAY_ENV or $NODE_CONFIG_DIR"
  else
    fail "the token is also in: ${copies[*]}"
  fi
}

gateway_url() {
  local port
  port="$(jq -r '.gateway.port // 18789' "$work_dir/config.json")"
  printf 'http://127.0.0.1:%s/tools/invoke' "$port"
}

# Prints the HTTP status of one probe call. $1 names a header file or is empty.
invoke_status() {
  local header_file=$1 url
  url="$(gateway_url)"
  local args=(-s -o "$work_dir/body" -w '%{http_code}' --max-time 15 -X POST
    -H 'Content-Type: application/json'
    --data "{\"tool\":\"$PROBE_TOOL\",\"args\":{}}")
  [[ -n "$header_file" ]] && args+=(-H "@$header_file")
  curl "${args[@]}" "$url" || true
}

check_http() {
  local status _
  [[ -s "$token_file" ]] || return 0

  for _ in $(seq 1 60); do
    curl -s -o /dev/null --max-time 2 "$(gateway_url)" && break
    sleep 2
  done

  status="$(invoke_status "")"
  if [[ "$status" == "401" ]]; then
    pass "an unauthenticated /tools/invoke call is rejected with 401"
  else
    fail "an unauthenticated /tools/invoke call got $status, expected 401: $(head -c 300 "$work_dir/body")"
  fi

  printf 'Authorization: Bearer not-the-gateway-token-%s\n' "$RANDOM" >"$work_dir/wrong-header"
  status="$(invoke_status "$work_dir/wrong-header")"
  if [[ "$status" == "401" ]]; then
    pass "a /tools/invoke call with a wrong token is rejected with 401"
  else
    fail "a /tools/invoke call with a wrong token got $status, expected 401"
  fi

  printf 'Authorization: Bearer %s\n' "$(cat "$token_file")" >"$work_dir/header"
  status="$(invoke_status "$work_dir/header")"
  if [[ "$status" == "404" ]]; then
    pass "a /tools/invoke call with the config's token passes auth and reaches tool lookup (404 for $PROBE_TOOL)"
  else
    fail "a /tools/invoke call with the config's token got $status, expected 404 for $PROBE_TOOL: $(head -c 300 "$work_dir/body")"
  fi
}

fingerprint() {
  sha256sum "$token_file" | cut -d' ' -f1
}

command="${1:-}"
case "$command" in
  config) check_config ;;
  check)
    check_config
    check_http
    ;;
  record)
    [[ $# -eq 2 ]] || exit 64
    check_config
    if [[ -s "$token_file" ]]; then
      (umask 077 && fingerprint >"$2")
      pass "recorded the token's fingerprint in $2"
    fi
    ;;
  unchanged)
    [[ $# -eq 2 ]] || exit 64
    check_config
    if [[ -s "$token_file" && "$(fingerprint)" == "$(cat "$2")" ]]; then
      pass "the gateway token is the one recorded before"
    else
      fail "the gateway token differs from the one recorded before"
    fi
    ;;
  *)
    sed -n '/^# Usage:/,/^# Exit/p' "$0" >&2
    exit 64
    ;;
esac

exit "$failed"
