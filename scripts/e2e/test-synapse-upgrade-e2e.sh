#!/usr/bin/env bash
# Unit tests for the pure helpers in scripts/e2e/synapse-upgrade-e2e.sh: they
# decide what the upgrade E2E accepts as "migrated", "delivered" and "stable",
# so a wrong predicate would turn the job into a false pass.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e/synapse-upgrade-e2e.sh
source "$here/synapse-upgrade-e2e.sh"

tmp="$(mktemp -d --tmpdir synapse-upgrade-test.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT

failures=0
fail() {
  printf 'FAIL: %s\n' "$1" >&2
  failures=$((failures + 1))
}
expect_eq() {
  local name=$1 expected=$2 actual=$3
  [[ "$expected" == "$actual" ]] || fail "$name: expected [$expected], got [$actual]"
}
expect_ok() {
  local name=$1
  shift
  "$@" >/dev/null 2>&1 || fail "$name: expected success"
}
expect_err() {
  local name=$1
  shift
  if "$@" >/dev/null 2>&1; then fail "$name: expected failure"; fi
}

# --- image reference parsing ------------------------------------------------
pinned="matrixdotorg/synapse:v1.164.1@sha256:fa4aa980f279bcf26d4e7ecc2a2c9a701c73f2ebe8841da9bdcf3b2fdf693d75"
expect_eq "version of a digest-pinned ref" "1.164.1" "$(su_image_version "$pinned")"
expect_eq "version of a tag-only ref" "1.125.0" "$(su_image_version "matrixdotorg/synapse:v1.125.0")"
expect_err "version of a ref without a tag" su_image_version "matrixdotorg/synapse@sha256:abc"
expect_eq "digest of a pinned ref" \
  "sha256:fa4aa980f279bcf26d4e7ecc2a2c9a701c73f2ebe8841da9bdcf3b2fdf693d75" \
  "$(su_image_digest "$pinned")"
expect_eq "digest of a tag-only ref" "" "$(su_image_digest "matrixdotorg/synapse:v1.125.0")"
expect_eq "repository of a pinned ref" "matrixdotorg/synapse" "$(su_image_repository "$pinned")"
expect_eq "repository of a registry ref with a port" "registry.local:5000/synapse" \
  "$(su_image_repository "registry.local:5000/synapse:v1.2.3")"

# --- constants read from the product source ---------------------------------
cat >"$tmp/matrix.ts" <<'EOF'
const MATRIX_UPGRADE_READY_TIMEOUT_MS = resolveDurationFromEnv(
  "SOVEREIGN_MATRIX_UPGRADE_READY_TIMEOUT_MS",
  30 * 60_000,
);
const DEFAULT_SYNAPSE_IMAGE =
  "matrixdotorg/synapse:v1.164.1@sha256:fa4aa980f279bcf26d4e7ecc2a2c9a701c73f2ebe8841da9bdcf3b2fdf693d75";
const DEFAULT_CADDY_IMAGE = "caddy:2.10.2-alpine";
EOF
expect_eq "image constant on its own line" "$pinned" "$(su_default_synapse_image "$tmp/matrix.ts")"
printf 'const DEFAULT_SYNAPSE_IMAGE = "matrixdotorg/synapse:v1.125.0";\n' >"$tmp/old-matrix.ts"
expect_eq "image constant on one line" "matrixdotorg/synapse:v1.125.0" \
  "$(su_default_synapse_image "$tmp/old-matrix.ts")"
printf 'const OTHER = 1;\n' >"$tmp/none.ts"
expect_err "missing image constant" su_default_synapse_image "$tmp/none.ts"

expect_eq "upgrade timeout expression" "1800000" "$(su_upgrade_ready_timeout_ms "$tmp/matrix.ts")"
printf '  "SOVEREIGN_MATRIX_UPGRADE_READY_TIMEOUT_MS",\n  900_000,\n' >"$tmp/literal.ts"
expect_eq "upgrade timeout literal" "900000" "$(su_upgrade_ready_timeout_ms "$tmp/literal.ts")"
printf '  "SOVEREIGN_MATRIX_UPGRADE_READY_TIMEOUT_MS",\n  readTimeout(),\n' >"$tmp/dynamic.ts"
expect_err "non-numeric timeout expression" su_upgrade_ready_timeout_ms "$tmp/dynamic.ts"
expect_err "missing timeout constant" su_upgrade_ready_timeout_ms "$tmp/none.ts"

# --- durations and the readiness budget -------------------------------------
expect_eq "seconds only" "0m 07s" "$(su_format_duration 7)"
expect_eq "minutes" "12m 03s" "$(su_format_duration 723)"
expect_eq "fractional seconds round down" "1m 05s" "$(su_format_duration 65.9)"

expect_eq "well inside the budget" "ok" "$(su_budget_verdict 42 1800000 300)"
expect_eq "exactly at the margin" "ok" "$(su_budget_verdict 1500 1800000 300)"
expect_eq "inside the margin" "warn" "$(su_budget_verdict 1501 1800000 300)"
expect_eq "past the deadline" "warn" "$(su_budget_verdict 4000 1800000 300)"
expect_eq "margin larger than the deadline" "warn" "$(su_budget_verdict 1 60000 300)"
expect_err "non-numeric duration" su_budget_verdict abc 1800000 300

cat >"$tmp/watch.json" <<'EOF'
{"updateStartedAt": 1793614000.5, "containerStartedAt": "2026-11-02T10:11:12.000000000Z", "readyAt": 1793614302.25}
EOF
durations="$(su_watch_durations "$tmp/watch.json")"
expect_eq "migration seconds" "30.25" "$(jq -r '.migrationSeconds' <<<"$durations")"
expect_eq "upgrade-to-ready seconds" "301.75" "$(jq -r '.totalSeconds' <<<"$durations")"
printf '{"updateStartedAt": 1793614000}\n' >"$tmp/unobserved.json"
expect_err "new container never observed" su_watch_durations "$tmp/unobserved.json"

# --- message history ---------------------------------------------------------
cat >"$tmp/messages.json" <<'EOF'
{"chunk": [
  {"type": "m.room.message", "content": {"body": "upgrade-history 3 run-7"}},
  {"type": "m.room.member", "content": {"membership": "join"}},
  {"type": "m.room.message", "content": {"body": "upgrade-history 1 run-7"}}
]}
EOF
expect_eq "all markers present" "" \
  "$(su_missing_markers "$tmp/messages.json" "upgrade-history 1 run-7" "upgrade-history 3 run-7")"
expect_eq "one marker missing" "upgrade-history 2 run-7" \
  "$(su_missing_markers "$tmp/messages.json" "upgrade-history 1 run-7" "upgrade-history 2 run-7")"
expect_eq "a marker is matched exactly, not as a prefix" "upgrade-history 1 run-7x" \
  "$(su_missing_markers "$tmp/messages.json" "upgrade-history 1 run-7x")"

# --- test alert delivery -----------------------------------------------------
bot="@sovereign-bot:ci.local.test"
operator="@operator:ci.local.test"
cat >"$tmp/event.json" <<EOF
{"event_id": "\$a", "sender": "$bot", "type": "m.room.message",
 "content": {"msgtype": "m.text", "body": "x", "m.mentions": {"user_ids": ["$operator"]}}}
EOF
expect_ok "alert from the bot mentioning the operator" su_alert_event_ok "$tmp/event.json" "$bot" "$operator"
expect_err "alert from another sender" su_alert_event_ok "$tmp/event.json" "@other:ci.local.test" "$operator"
jq 'del(.content["m.mentions"])' "$tmp/event.json" >"$tmp/no-mentions.json"
expect_err "alert without m.mentions" su_alert_event_ok "$tmp/no-mentions.json" "$bot" "$operator"
jq '.content["m.mentions"].user_ids = ["@someone:ci.local.test"]' "$tmp/event.json" >"$tmp/other-mention.json"
expect_err "alert mentioning someone else" su_alert_event_ok "$tmp/other-mention.json" "$bot" "$operator"

cat >"$tmp/notifications.json" <<'EOF'
{"notifications": [
  {"event": {"event_id": "plain-event"}, "actions": ["notify"]},
  {"event": {"event_id": "off-event"}, "actions": ["notify", {"set_tweak": "highlight", "value": false}]},
  {"event": {"event_id": "hl-event"}, "actions": ["notify", {"set_tweak": "sound", "value": "default"}, {"set_tweak": "highlight"}]}
]}
EOF
expect_ok "highlighted notification" su_notification_highlighted "$tmp/notifications.json" hl-event
expect_err "notification without highlight" su_notification_highlighted "$tmp/notifications.json" plain-event
expect_err "highlight explicitly false" su_notification_highlighted "$tmp/notifications.json" off-event
expect_err "event not notified at all" su_notification_highlighted "$tmp/notifications.json" missing-event

# --- restart stability -------------------------------------------------------
cat >"$tmp/before.json" <<'EOF'
[{"RestartCount": 0, "State": {"Status": "running", "Running": true, "StartedAt": "2026-11-02T10:00:00Z", "Health": {"Status": "healthy"}}}]
EOF
expect_ok "unchanged running container" su_restart_stable "$tmp/before.json" "$tmp/before.json"
jq '.[0].State.StartedAt = "2026-11-02T10:00:30Z"' "$tmp/before.json" >"$tmp/restarted.json"
expect_err "container restarted on its own" su_restart_stable "$tmp/before.json" "$tmp/restarted.json"
jq '.[0].RestartCount = 1' "$tmp/before.json" >"$tmp/policy-restart.json"
expect_err "restart policy kicked in" su_restart_stable "$tmp/before.json" "$tmp/policy-restart.json"
jq '.[0].State.Status = "exited" | .[0].State.Running = false' "$tmp/before.json" >"$tmp/exited.json"
expect_err "container exited" su_restart_stable "$tmp/before.json" "$tmp/exited.json"
jq '.[0].State.Health.Status = "unhealthy"' "$tmp/before.json" >"$tmp/unhealthy.json"
expect_err "container turned unhealthy" su_restart_stable "$tmp/before.json" "$tmp/unhealthy.json"

if [[ "$failures" -ne 0 ]]; then
  printf '%s test(s) failed\n' "$failures" >&2
  exit 1
fi
echo "synapse-upgrade-e2e helpers: all tests passed"
