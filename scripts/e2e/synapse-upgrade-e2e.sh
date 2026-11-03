#!/usr/bin/env bash
# synapse-upgrade-e2e.sh — drives and checks the CI upgrade scenario: a node
# installed from the previous release is updated in place to the checked-out
# tree, and its bundled Synapse must migrate without losing rooms or history.
#
# Usage (see the "E2E Upgrade" job in .github/workflows/ci.yml):
#   synapse-upgrade-e2e.sh expected-image <matrix.ts>
#   synapse-upgrade-e2e.sh ready-timeout-ms <matrix.ts>
#   synapse-upgrade-e2e.sh image-version <image-ref>
#   sudo ... synapse-upgrade-e2e.sh seed <state.json>
#   synapse-upgrade-e2e.sh snapshot <out.json>
#   synapse-upgrade-e2e.sh run-update <install.sh> <source-dir> <bots-dir> <expected-image> <watch.json>
#   synapse-upgrade-e2e.sh verify-image <expected-image> <pre.json> <post.json>
#   sudo ... synapse-upgrade-e2e.sh verify-history <state.json>
#   sudo ... synapse-upgrade-e2e.sh verify-alert <state.json>
#   synapse-upgrade-e2e.sh restarts <count>
#   synapse-upgrade-e2e.sh report <watch.json> <ready-timeout-ms> <margin-s> <pre.json> <post.json>
#
# Sourcing the file only defines the functions, so the predicates below can be
# unit-tested (scripts/e2e/test-synapse-upgrade-e2e.sh) without a node.
set -euo pipefail

SU_CONFIG_FILE="${SOVEREIGN_NODE_CONFIG_FILE:-/etc/sovereign-node/sovereign-node.json5}"
SU_MATRIX_URL="${SU_MATRIX_URL:-http://127.0.0.1:8008}"
SU_READY_WAIT_SECONDS="${SU_READY_WAIT_SECONDS:-2700}"
SU_HEALTHY_WAIT_SECONDS="${SU_HEALTHY_WAIT_SECONDS:-300}"
SU_SETTLE_SECONDS="${SU_SETTLE_SECONDS:-20}"

su_log() {
  printf '[synapse-upgrade-e2e] %s\n' "$*" >&2
}

su_die() {
  printf '::error::%s\n' "$*" >&2
  exit 1
}

# --- pure helpers (unit-tested) ---------------------------------------------

# Reads the DEFAULT_SYNAPSE_IMAGE string literal, whether the value sits on the
# declaration line or on the next one.
su_default_synapse_image() {
  local file=$1 image
  image="$(awk '
    /const DEFAULT_SYNAPSE_IMAGE[[:space:]]*=/ { grab = 1 }
    grab && match($0, /"[^"]+"/) { print substr($0, RSTART + 1, RLENGTH - 2); exit }
  ' "$file")"
  [[ -n "$image" ]] || return 1
  printf '%s\n' "$image"
}

# Evaluates the default of SOVEREIGN_MATRIX_UPGRADE_READY_TIMEOUT_MS, the line
# after the env name, accepting only digits, "_" separators and "*".
su_upgrade_ready_timeout_ms() {
  local file=$1 expr
  expr="$(awk '
    found { print; exit }
    /"SOVEREIGN_MATRIX_UPGRADE_READY_TIMEOUT_MS"/ { found = 1 }
  ' "$file")"
  expr="${expr//_/}"
  expr="${expr%,}"
  expr="${expr//[[:space:]]/}"
  [[ "$expr" =~ ^[0-9]+(\*[0-9]+)*$ ]] || return 1
  printf '%s\n' "$((expr))"
}

su_image_repository() {
  local ref=${1%%@*} last
  last="${ref##*/}"
  if [[ "$last" == *:* ]]; then
    ref="${ref%:*}"
  fi
  printf '%s\n' "$ref"
}

su_image_version() {
  local ref=${1%%@*} last tag
  last="${ref##*/}"
  [[ "$last" == *:* ]] || return 1
  tag="${last##*:}"
  printf '%s\n' "${tag#v}"
}

su_image_digest() {
  local ref=$1
  if [[ "$ref" == *@* ]]; then
    printf '%s\n' "${ref##*@}"
  else
    printf '\n'
  fi
}

su_format_duration() {
  local total=${1%%.*}
  printf '%dm %02ds\n' "$((total / 60))" "$((total % 60))"
}

# "warn" once the measured time eats into the safety margin before the
# readiness deadline that a real update would hit.
su_budget_verdict() {
  local duration=$1 timeout_ms=$2 margin_s=$3
  [[ "$duration" =~ ^[0-9]+(\.[0-9]+)?$ ]] || return 2
  [[ "$timeout_ms" =~ ^[0-9]+$ && "$margin_s" =~ ^[0-9]+$ ]] || return 2
  awk -v d="$duration" -v t="$timeout_ms" -v m="$margin_s" \
    'BEGIN { print (d <= t / 1000 - m ? "ok" : "warn") }'
}

su_iso_to_epoch() {
  date -u -d "$1" +%s.%N
}

su_watch_durations() {
  local watch=$1 update_started container_started ready started_epoch
  update_started="$(jq -er '.updateStartedAt' "$watch")" || return 1
  container_started="$(jq -er '.containerStartedAt' "$watch")" || return 1
  ready="$(jq -er '.readyAt' "$watch")" || return 1
  started_epoch="$(su_iso_to_epoch "$container_started")" || return 1
  jq -n --argjson u "$update_started" --argjson s "$started_epoch" --argjson r "$ready" '
    def round2: (. * 100 | round) / 100;
    {migrationSeconds: (($r - $s) | round2), totalSeconds: (($r - $u) | round2)}
  '
}

# Prints every marker that is not the exact body of a message in the
# /messages response.
su_missing_markers() {
  local messages=$1
  shift
  jq -r --args '
    [.chunk[] | select(.type == "m.room.message") | .content.body] as $bodies
    | $ARGS.positional[] | select(. as $m | $bodies | index($m) | not)
  ' "$@" <"$messages"
}

su_alert_event_ok() {
  local event=$1 bot=$2 operator=$3
  jq -e --arg bot "$bot" --arg op "$operator" '
    .sender == $bot
    and .type == "m.room.message"
    and ((.content["m.mentions"].user_ids // []) | index($op) != null)
  ' "$event" >/dev/null
}

su_notification_highlighted() {
  local notifications=$1 event_id=$2
  jq -e --arg id "$event_id" '
    [.notifications[]
      | select(.event.event_id == $id)
      | .actions[]
      | objects
      | select(.set_tweak == "highlight" and (if has("value") then .value else true end) == true)]
    | length > 0
  ' "$notifications" >/dev/null
}

# A clean start stays put: same start time, no restart-policy restarts, still
# running and healthy after the settle window.
su_restart_stable() {
  local before=$1 after=$2
  jq -e --slurpfile b "$before" '
    .[0] as $a | $b[0][0] as $p
    | $a.State.StartedAt == $p.State.StartedAt
      and $a.RestartCount == $p.RestartCount
      and $a.State.Running == true
      and $a.State.Status == "running"
      and $a.State.Health.Status == "healthy"
  ' "$after" >/dev/null
}

# --- node interaction --------------------------------------------------------

su_container_id() {
  local service=$1 ids count
  ids="$(docker ps -a --filter "label=com.docker.compose.service=${service}" --format '{{.ID}}')"
  count="$(grep -c . <<<"$ids" || true)"
  [[ "$count" == "1" ]] || su_die "expected exactly one '${service}' container, found ${count}"
  printf '%s\n' "$ids"
}

su_postgres_container_id() {
  local project ids
  project="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$(su_container_id synapse)")"
  ids="$(docker ps --filter "label=com.docker.compose.project=${project}" \
    --filter "label=com.docker.compose.service=postgres" --format '{{.ID}}')"
  [[ "$(grep -c . <<<"$ids" || true)" == "1" ]] || su_die "no single postgres container in project ${project}"
  printf '%s\n' "$ids"
}

su_versions_ok() {
  curl -fsS --max-time 3 "${SU_MATRIX_URL}/_matrix/client/versions" >/dev/null 2>&1
}

su_wait_healthy() {
  local cid=$1 deadline status
  deadline=$(($(date +%s) + SU_HEALTHY_WAIT_SECONDS))
  while :; do
    status="$(docker inspect --format '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$cid")"
    if [[ "$status" == "running/healthy" ]] && su_versions_ok; then
      return 0
    fi
    [[ "$(date +%s)" -lt "$deadline" ]] || su_die "synapse not healthy within ${SU_HEALTHY_WAIT_SECONDS}s (state ${status})"
    sleep 2
  done
}

su_config() {
  jq -er "$@" "$SU_CONFIG_FILE"
}

su_secret_from_ref() {
  local ref=$1
  [[ "$ref" == file:* ]] || su_die "unsupported secret ref: ${ref}"
  cat -- "${ref#file:}"
}

# Matrix client call with the operator token. Prints the body; fails on a
# non-2xx status.
su_matrix() {
  local method=$1 path=$2 token=$3 body=${4:-}
  local args=(-fsS --max-time 30 -X "$method" -H "Authorization: Bearer ${token}")
  if [[ -n "$body" ]]; then
    args+=(-H "Content-Type: application/json" --data "$body")
  fi
  curl "${args[@]}" "${SU_MATRIX_URL}${path}"
}

su_urlencode() {
  jq -rn --arg v "$1" '$v | @uri'
}

su_operator_login() {
  local localpart password
  localpart="$(su_config '.matrix.operator.localpart // (.matrix.operator.userId | ltrimstr("@") | split(":")[0])')"
  # shellcheck disable=SC2016 # \(...) is jq string interpolation
  password="$(su_secret_from_ref "$(su_config --arg dir "$(dirname "$SU_CONFIG_FILE")/secrets" --arg lp "$localpart" \
    '.matrix.operator.passwordSecretRef // "file:\($dir)/matrix-\($lp).password"')")"
  jq -n --arg user "$localpart" --arg pw "$password" '{
    type: "m.login.password",
    identifier: {type: "m.id.user", user: $user},
    password: $pw,
    initial_device_display_name: "upgrade-e2e"
  }' | curl -fsS --max-time 30 -H "Content-Type: application/json" --data @- \
    "${SU_MATRIX_URL}/_matrix/client/v3/login" | jq -er '.access_token'
}

# The token is taken before the upgrade; reusing it afterwards also proves
# existing client sessions survive the migration.
su_state_token() {
  local state=$1 token
  token="$(jq -er '.token' "$state")"
  su_matrix GET /_matrix/client/v3/account/whoami "$token" >/dev/null ||
    su_die "the operator session created before the upgrade is no longer valid"
  printf '%s\n' "$token"
}

su_send_text() {
  local token=$1 room=$2 body=$3 txn
  txn="upgrade-e2e-$(date +%s%N)"
  su_matrix PUT "/_matrix/client/v3/rooms/$(su_urlencode "$room")/send/m.room.message/${txn}" "$token" \
    "$(jq -nc --arg b "$body" '{msgtype: "m.text", body: $b}')" | jq -er '.event_id'
}

su_room_messages() {
  local token=$1 room=$2
  su_matrix GET "/_matrix/client/v3/rooms/$(su_urlencode "$room")/messages?dir=b&limit=200" "$token"
}

su_check_room_history() {
  local token=$1 room=$2 label=$3
  shift 3
  local messages missing
  messages="$(mktemp)"
  su_room_messages "$token" "$room" >"$messages"
  missing="$(su_missing_markers "$messages" "$@")"
  rm -f "$messages"
  [[ -z "$missing" ]] || su_die "${label} room ${room} lost messages: ${missing//$'\n'/, }"
  su_log "${label} room ${room}: all $# messages readable"
}

su_cmd_seed() {
  local state=$1 token alert_room history_room tag label i
  local -a alert_markers=() history_markers=()
  tag="run-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}"
  token="$(su_operator_login)"
  alert_room="$(su_config '.matrix.alertRoom.roomId')"
  history_room="$(su_matrix POST /_matrix/client/v3/createRoom "$token" \
    '{"name":"Upgrade history","preset":"private_chat"}' | jq -er '.room_id')"
  for i in 1 2 3; do
    label="upgrade-history alert-${i} ${tag}"
    su_send_text "$token" "$alert_room" "$label" >/dev/null
    alert_markers+=("$label")
    label="upgrade-history history-${i} ${tag}"
    su_send_text "$token" "$history_room" "$label" >/dev/null
    history_markers+=("$label")
  done
  su_check_room_history "$token" "$alert_room" alert "${alert_markers[@]}"
  su_check_room_history "$token" "$history_room" history "${history_markers[@]}"

  (
    umask 077
    jq -n \
      --arg token "$token" \
      --arg alertRoomId "$alert_room" \
      --arg historyRoomId "$history_room" \
      --arg operatorUserId "$(su_config '.matrix.operator.userId')" \
      --arg botUserId "$(su_config '.matrix.bot.userId')" \
      --arg tag "$tag" \
      --args '{
        token: $token, alertRoomId: $alertRoomId, historyRoomId: $historyRoomId,
        operatorUserId: $operatorUserId, botUserId: $botUserId, tag: $tag,
        alertMarkers: $ARGS.positional[0:3], historyMarkers: $ARGS.positional[3:6]
      }' "${alert_markers[@]}" "${history_markers[@]}" >"$state"
  )
  su_log "seeded the alert room ${alert_room} and the history room ${history_room}"
}

su_cmd_verify_history() {
  local state=$1 token
  token="$(su_state_token "$state")"
  mapfile -t alert_markers < <(jq -r '.alertMarkers[]' "$state")
  mapfile -t history_markers < <(jq -r '.historyMarkers[]' "$state")
  su_check_room_history "$token" "$(jq -r '.alertRoomId' "$state")" alert "${alert_markers[@]}"
  su_check_room_history "$token" "$(jq -r '.historyRoomId' "$state")" history "${history_markers[@]}"
  su_matrix GET /_matrix/client/v3/joined_rooms "$token" | jq -e \
    --arg a "$(jq -r '.alertRoomId' "$state")" --arg h "$(jq -r '.historyRoomId' "$state")" \
    '(.joined_rooms | index($a) != null) and (.joined_rooms | index($h) != null)' >/dev/null ||
    su_die "the operator is no longer joined to both pre-upgrade rooms"
}

su_cmd_verify_alert() {
  local state=$1 token alert_room result event_id event notifications i
  token="$(su_state_token "$state")"
  alert_room="$(jq -r '.alertRoomId' "$state")"
  result="$(sovereign-node test-alert --json --text "upgrade-e2e test alert $(jq -r '.tag' "$state")")"
  printf '%s\n' "$result" | jq . >&2
  event_id="$(jq -er '.result | select(.delivered == true) | .messageId' <<<"$result")" ||
    su_die "the test alert was not delivered"
  jq -e --arg room "$alert_room" '.result.target.roomId == $room' <<<"$result" >/dev/null ||
    su_die "the test alert went to a different room than the pre-upgrade alert room"

  event="$(mktemp)"
  notifications="$(mktemp)"
  su_matrix GET "/_matrix/client/v3/rooms/$(su_urlencode "$alert_room")/event/$(su_urlencode "$event_id")" \
    "$token" >"$event"
  jq '{sender, type, content}' "$event" >&2
  su_alert_event_ok "$event" "$(jq -r '.botUserId' "$state")" "$(jq -r '.operatorUserId' "$state")" ||
    su_die "the test alert is not from the bot or does not mention the operator in m.mentions"

  # Push actions are computed while the event is persisted; a short retry
  # covers the gap before the notification is queryable.
  for i in $(seq 1 15); do
    su_matrix GET "/_matrix/client/v3/notifications?only=highlight&limit=50" "$token" >"$notifications"
    if su_notification_highlighted "$notifications" "$event_id"; then
      su_log "the operator received the test alert ${event_id} as a highlighted mention"
      rm -f "$event" "$notifications"
      return 0
    fi
    sleep 2
  done
  jq '.notifications | map({event_id: .event.event_id, actions})' "$notifications" >&2 || true
  rm -f "$event" "$notifications"
  su_die "the test alert ${event_id} did not reach the operator as a highlighted mention"
}

su_cmd_snapshot() {
  local out=$1 synapse postgres image repo_digests health version schema code_schema
  synapse="$(su_container_id synapse)"
  su_wait_healthy "$synapse"
  postgres="$(su_postgres_container_id)"
  image="$(docker inspect --format '{{.Config.Image}}' "$synapse")"
  repo_digests="$(docker image inspect --format '{{json .RepoDigests}}' \
    "$(docker inspect --format '{{.Image}}' "$synapse")")"
  health="$(docker inspect --format '{{.State.Health.Status}}' "$synapse")"
  version="$(docker exec "$synapse" python3 -c 'import synapse; print(synapse.__version__)')"
  code_schema="$(docker exec "$synapse" python3 -c \
    'from synapse.storage.schema import SCHEMA_VERSION; print(SCHEMA_VERSION)')"
  schema="$(docker exec "$postgres" psql -U synapse -d synapse -tAc 'SELECT version FROM schema_version')"
  jq -n --arg image "$image" --argjson repoDigests "$repo_digests" --arg health "$health" \
    --arg version "$version" --argjson schema "$schema" --argjson codeSchema "$code_schema" \
    '{image: $image, repoDigests: $repoDigests, health: $health, synapseVersion: $version,
      dbSchemaVersion: $schema, codeSchemaVersion: $codeSchema}' | tee "$out"
}

su_cmd_verify_image() {
  local expected=$1 pre=$2 post=$3 repo digest
  repo="$(su_image_repository "$expected")"
  digest="$(su_image_digest "$expected")"
  [[ -n "$digest" ]] || su_die "the expected image ${expected} is not pinned by digest"
  jq -e --arg img "$expected" '.image == $img' "$post" >/dev/null ||
    su_die "synapse runs $(jq -r .image "$post"), expected ${expected}"
  jq -e --arg d "${repo}@${digest}" '.repoDigests | index($d) != null' "$post" >/dev/null ||
    su_die "the running synapse image is not ${repo}@${digest}"
  jq -e '.health == "healthy"' "$post" >/dev/null || su_die "synapse is not healthy after the upgrade"
  jq -e --arg v "$(su_image_version "$expected")" '.synapseVersion == $v' "$post" >/dev/null ||
    su_die "synapse reports version $(jq -r .synapseVersion "$post"), expected $(su_image_version "$expected")"
  jq -e '.dbSchemaVersion == .codeSchemaVersion' "$post" >/dev/null ||
    su_die "database schema $(jq -r .dbSchemaVersion "$post") != synapse schema $(jq -r .codeSchemaVersion "$post")"
  jq -e --slurpfile p "$pre" '.dbSchemaVersion > $p[0].dbSchemaVersion' "$post" >/dev/null ||
    su_die "the database schema did not advance ($(jq -r .dbSchemaVersion "$pre") -> $(jq -r .dbSchemaVersion "$post"))"
  su_log "synapse $(jq -r .synapseVersion "$pre") -> $(jq -r .synapseVersion "$post"), schema $(jq -r .dbSchemaVersion "$pre") -> $(jq -r .dbSchemaVersion "$post"), image ${repo}@${digest}"
}

# Records when the first container on the new image started and when Synapse
# first answered after that. Old containers answering /versions are ignored.
su_watch_synapse() {
  local expected=$1 out=$2 update_started=$3 deadline cid image running started=""
  deadline=$(($(date +%s) + SU_READY_WAIT_SECONDS))
  while [[ "$(date +%s)" -lt "$deadline" ]]; do
    cid="$(docker ps -a --filter label=com.docker.compose.service=synapse --format '{{.ID}}' 2>/dev/null | head -n 1 || true)"
    if [[ -n "$cid" ]]; then
      image="$(docker inspect --format '{{.Config.Image}}' "$cid" 2>/dev/null || true)"
      running="$(docker inspect --format '{{.State.Running}}' "$cid" 2>/dev/null || true)"
      if [[ -z "$started" && "$image" == "$expected" && "$running" == "true" ]]; then
        started="$(docker inspect --format '{{.State.StartedAt}}' "$cid" 2>/dev/null || true)"
        [[ -z "$started" ]] || su_log "new synapse container ${cid} started at ${started}"
      fi
      if [[ -n "$started" ]] && su_versions_ok; then
        jq -n --argjson u "$update_started" --arg s "$started" --argjson r "$(date +%s.%N)" \
          --arg c "$cid" '{updateStartedAt: $u, containerStartedAt: $s, readyAt: $r, containerId: $c}' >"$out"
        su_log "synapse on the new image answered /versions"
        return 0
      fi
    fi
    sleep 1
  done
  jq -n --argjson u "$update_started" --arg s "$started" '{updateStartedAt: $u, containerStartedAt: $s}' >"$out"
  return 1
}

# Runs the installed release's own `sovereign-node update`, which downloads
# install.sh over https and re-runs it with --update. The bundled install.sh
# built from this tree is served from a local https origin (the update command
# refuses plain http) because there is no published release for it yet.
su_cmd_run_update() {
  local installer=$1 source_dir=$2 bots_dir=$3 expected=$4 watch=$5
  local work port=8443 server_pid watch_pid update_started rc=0 watch_rc=0 i
  work="$(mktemp -d --tmpdir upgrade-installer.XXXXXX)"
  cp -- "$installer" "$work/install.sh"
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=127.0.0.1" \
    -addext "subjectAltName=IP:127.0.0.1" \
    -keyout "$work/key.pem" -out "$work/cert.pem" >/dev/null 2>&1
  python3 - "$work" "$port" <<'PY' >"$work/server.log" 2>&1 &
import functools, http.server, ssl, sys
root, port = sys.argv[1], int(sys.argv[2])
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=root)
server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(f"{root}/cert.pem", f"{root}/key.pem")
server.socket = ctx.wrap_socket(server.socket, server_side=True)
server.serve_forever()
PY
  server_pid=$!
  for i in $(seq 1 30); do
    curl -fsS --cacert "$work/cert.pem" -o /dev/null "https://127.0.0.1:${port}/install.sh" && break
    [[ "$i" -lt 30 ]] || su_die "the local installer origin did not come up"
    sleep 1
  done

  update_started="$(date +%s.%N)"
  su_watch_synapse "$expected" "$watch" "$update_started" &
  watch_pid=$!

  sudo env "PATH=$PATH" \
    "NODE_EXTRA_CA_CERTS=$work/cert.pem" \
    "SOVEREIGN_NODE_SOURCE_DIR=$source_dir" \
    "SOVEREIGN_BOTS_SOURCE_DIR=$bots_dir" \
    sovereign-node update --json --installer-url "https://127.0.0.1:${port}/install.sh" || rc=$?
  su_log "sovereign-node update exited ${rc} after $(su_format_duration "$(awk -v s="$update_started" -v e="$(date +%s.%N)" 'BEGIN { print e - s }')")"

  kill "$server_pid" 2>/dev/null || true
  # Synapse is up before the installer finishes, so the watcher is normally
  # done; bound the wait anyway so a failed update cannot hang the job.
  for i in $(seq 1 120); do
    kill -0 "$watch_pid" 2>/dev/null || break
    sleep 1
  done
  kill "$watch_pid" 2>/dev/null || true
  wait "$watch_pid" || watch_rc=$?
  rm -rf "$work"
  [[ "$rc" -eq 0 ]] || su_die "sovereign-node update failed (exit ${rc})"
  [[ "$watch_rc" -eq 0 ]] || su_die "synapse on ${expected} never answered after the update"
}

su_cmd_restarts() {
  local count=$1 cid before after n started_epoch elapsed
  cid="$(su_container_id synapse)"
  su_wait_healthy "$cid"
  before="$(mktemp)"
  after="$(mktemp)"
  for n in $(seq 1 "$count"); do
    docker inspect "$cid" >"$before"
    started_epoch="$(date +%s)"
    docker restart --time 60 "$cid" >/dev/null
    jq -e --arg old "$(jq -r '.[0].State.StartedAt' "$before")" \
      '.[0].State.StartedAt != $old' <(docker inspect "$cid") >/dev/null ||
      su_die "restart ${n}: the container did not restart"
    su_wait_healthy "$cid"
    elapsed=$(($(date +%s) - started_epoch))
    docker inspect "$cid" >"$before"
    sleep "$SU_SETTLE_SECONDS"
    docker inspect "$cid" >"$after"
    su_restart_stable "$before" "$after" || {
      docker logs --tail 100 "$cid" >&2 || true
      su_die "restart ${n}: synapse did not stay up (crash loop or unhealthy)"
    }
    su_log "restart ${n}/${count}: healthy after ${elapsed}s and stable for ${SU_SETTLE_SECONDS}s"
    printf 'restart_%s_seconds=%s\n' "$n" "$elapsed" >>"${GITHUB_OUTPUT:-/dev/null}"
  done
  rm -f "$before" "$after"
}

su_cmd_report() {
  local watch=$1 timeout_ms=$2 margin_s=$3 pre=$4 post=$5 durations migration total verdict
  local summary=${GITHUB_STEP_SUMMARY:-/dev/stdout}
  durations="$(su_watch_durations "$watch")" || su_die "the upgrade watcher recorded no ready Synapse on the new image"
  migration="$(jq -r '.migrationSeconds' <<<"$durations")"
  total="$(jq -r '.totalSeconds' <<<"$durations")"
  verdict="$(su_budget_verdict "$migration" "$timeout_ms" "$margin_s")"
  # shellcheck disable=SC2016 # the backticks are Markdown, not command substitution
  {
    printf '### Synapse upgrade (previous release → this change)\n\n'
    printf '| | before | after |\n|---|---|---|\n'
    printf '| Synapse | %s | %s |\n' "$(jq -r .synapseVersion "$pre")" "$(jq -r .synapseVersion "$post")"
    printf '| Image | `%s` | `%s` |\n' "$(jq -r .image "$pre")" "$(jq -r .image "$post")"
    printf '| DB schema | %s | %s |\n\n' "$(jq -r .dbSchemaVersion "$pre")" "$(jq -r .dbSchemaVersion "$post")"
    printf -- '- Migration (new Synapse container start → `/versions` answers): **%s** (%ss)\n' \
      "$(su_format_duration "$migration")" "$migration"
    printf -- '- Upgrade start (`sovereign-node update`) → Synapse ready: %s (%ss)\n' \
      "$(su_format_duration "$total")" "$total"
    printf -- '- Readiness deadline for an existing database: %s, warning margin %ss → %s\n' \
      "$(su_format_duration "$((timeout_ms / 1000))")" "$margin_s" "$verdict"
  } >>"$summary"
  printf 'migration_seconds=%s\nupgrade_to_ready_seconds=%s\n' "$migration" "$total" >>"${GITHUB_OUTPUT:-/dev/null}"
  if [[ "$verdict" == "warn" ]]; then
    printf '::warning::Synapse migration took %ss, within %ss of the %sms readiness deadline\n' \
      "$migration" "$margin_s" "$timeout_ms"
  fi
  su_log "migration ${migration}s, upgrade-to-ready ${total}s (${verdict})"
}

su_main() {
  local cmd=${1:-}
  shift || true
  case "$cmd" in
    expected-image) su_default_synapse_image "$@" ;;
    ready-timeout-ms) su_upgrade_ready_timeout_ms "$@" ;;
    image-version) su_image_version "$@" ;;
    seed) su_cmd_seed "$@" ;;
    snapshot) su_cmd_snapshot "$@" ;;
    run-update) su_cmd_run_update "$@" ;;
    verify-image) su_cmd_verify_image "$@" ;;
    verify-history) su_cmd_verify_history "$@" ;;
    verify-alert) su_cmd_verify_alert "$@" ;;
    restarts) su_cmd_restarts "$@" ;;
    report) su_cmd_report "$@" ;;
    *)
      sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' >&2
      exit 64
      ;;
  esac
}

if ! (return 0 2>/dev/null); then
  su_main "$@"
fi
