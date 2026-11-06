#!/usr/bin/env bash
# Checks, on an installed node, the sender policy of every bot Matrix account
# in the rendered OpenClaw config: DMs and rooms take messages only from the
# node's allowlist, which holds the operator and users of this homeserver,
# whatever the node's federation setting. Run as root.
#
# Usage:
#   verify-bot-sender-allowlist.sh check              every account has the allowlist policy
#   verify-bot-sender-allowlist.sh record <file>      check, and save a fingerprint of the policy
#   verify-bot-sender-allowlist.sh unchanged <file>   check, and require the recorded policy
#
# The fingerprint covers each account's dm, groupPolicy, groupAllowFrom and
# groups, never its access token.
# Exit codes: 0 pass, 1 check failed, 64 usage error.

set -euo pipefail

OPENCLAW_CONFIG="${OPENCLAW_CONFIG:-/var/lib/sovereign-node/openclaw-home/.openclaw/openclaw.json5}"
NODE_CONFIG="${NODE_CONFIG:-/etc/sovereign-node/sovereign-node.json5}"
# A user on another homeserver that nothing on the node lists.
UNLISTED_USER="@ci-unlisted:elsewhere.example.org"

usage() {
  sed -n '2,15p' "$0" >&2
  exit 64
}

mode="${1:-}"
fingerprint_file="${2:-}"
case "$mode" in
  check) [[ $# -eq 1 ]] || usage ;;
  record | unchanged) [[ $# -eq 2 ]] || usage ;;
  *) usage ;;
esac

operator="$(jq -er '.matrix.operator.userId' "$NODE_CONFIG")"
domain="$(jq -er '.matrix.homeserverDomain' "$NODE_CONFIG")"
federation="$(jq -r '.matrix.federationEnabled // false' "$NODE_CONFIG")"
echo "federationEnabled=$federation operator=$operator"

report="$(jq -r \
  --arg operator "$operator" \
  --arg suffix ":$domain" \
  --arg unlisted "$UNLISTED_USER" '
  (.channels.matrix.accounts // {}) as $accounts
  | if ($accounts | length) == 0 then "FAIL no Matrix account is rendered"
    else
      $accounts | to_entries[] | .key as $id | .value as $a
      | ($a.dm.allowFrom // []) as $allow
      | [
          (if $a.dm.policy != "allowlist" then "dm.policy=\($a.dm.policy | tojson)" else empty end),
          (if $a.groupPolicy != "allowlist" then "groupPolicy=\($a.groupPolicy | tojson)" else empty end),
          (if ($allow | length) == 0 then "dm.allowFrom is empty" else empty end),
          (if ($allow | index($operator)) == null then "dm.allowFrom lacks the operator" else empty end),
          (if ($allow | index("*")) != null then "dm.allowFrom contains *" else empty end),
          ($allow[] | select(endswith($suffix) | not) | "dm.allowFrom lists \(.)"),
          (if ($allow | index($unlisted)) != null then "dm.allowFrom lists \($unlisted)" else empty end),
          (if $a.groupAllowFrom != $allow then "groupAllowFrom differs from dm.allowFrom" else empty end),
          (($a.groups // {}) | to_entries[]
            | select(.value.users != $allow)
            | "groups[\(.key)].users differs from dm.allowFrom")
        ] as $problems
      | if ($problems | length) == 0
        then "PASS \($id): allowlist of \($allow | length) user(s)"
        else "FAIL \($id): \($problems | join(", "))"
        end
    end
' "$OPENCLAW_CONFIG")"
printf '%s\n' "$report"
if grep -q '^FAIL' <<<"$report"; then
  exit 1
fi

fingerprint="$(jq -cS '
  (.channels.matrix.accounts // {})
  | with_entries(.value |= {dm, groupPolicy, groupAllowFrom, groups})
' "$OPENCLAW_CONFIG" | sha256sum | cut -d' ' -f1)"

case "$mode" in
  record)
    printf '%s\n' "$fingerprint" > "$fingerprint_file"
    echo "PASS recorded sender policy fingerprint"
    ;;
  unchanged)
    if [[ "$(cat "$fingerprint_file")" != "$fingerprint" ]]; then
      echo "FAIL sender policy differs from the recorded one"
      exit 1
    fi
    echo "PASS sender policy matches the recorded one"
    ;;
esac
