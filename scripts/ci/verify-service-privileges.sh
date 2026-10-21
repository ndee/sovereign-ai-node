#!/usr/bin/env bash
# Checks, on a host installed by scripts/install.sh, what the runtime API's
# service user may do as root: the installed sudoers fragment, the docker
# group, and each root-owned helper's accept and refuse paths. Run as root.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVICE_USER="${SERVICE_USER:-sovereign-node}"
HELPERS=/usr/local/lib/sovereign-node
SUDOERS=/etc/sudoers.d/sovereign-node-gateway
GATEWAY_UNIT=/etc/systemd/system/sovereign-openclaw-gateway.service

failed=0
pass() { printf 'PASS %s\n' "$1"; }
fail() {
  printf 'FAIL %s\n' "$1"
  failed=1
}
check() {
  local label="$1"
  shift
  if "$@"; then pass "$label"; else fail "$label"; fi
}
as_service() { sudo -u "$SERVICE_USER" -- "$@"; }
# Runs a helper the way the runtime API does and records its exit status.
helper_status() {
  local status=0
  as_service sudo -n "$@" >/dev/null 2>&1 || status=$?
  printf '%s' "$status"
}
expect_status() {
  local label="$1" expected="$2"
  shift 2
  local status
  status="$(helper_status "$@")"
  if [[ "$status" == "$expected" ]]; then
    pass "$label"
  else
    fail "$label (exit $status, expected $expected)"
  fi
}

# shellcheck source=scripts/install/lib-build.sh
source "$REPO_ROOT/scripts/install/lib-build.sh"
if diff <(render_service_sudoers "$SERVICE_USER") "$SUDOERS" >/dev/null; then
  pass "installed sudoers fragment equals the rendered golden list"
else
  fail "installed sudoers fragment differs from the rendered golden list"
fi
check "sudoers fragment validates" visudo -cf "$SUDOERS"

if id -nG "$SERVICE_USER" | tr ' ' '\n' | grep -qx docker; then
  fail "$SERVICE_USER is in the docker group"
else
  pass "$SERVICE_USER is not in the docker group"
fi
if as_service docker ps >/dev/null 2>&1; then
  fail "$SERVICE_USER can reach the docker daemon directly"
else
  pass "$SERVICE_USER cannot reach the docker daemon directly"
fi
expect_status "raw tee to a unit file is not granted" 1 tee /etc/systemd/system/ci-probe.service
expect_status "raw chown is not granted" 1 chown -R "$SERVICE_USER" /etc/sovereign-node

project_dir="$(find /var/lib/sovereign-node/bundled-matrix -mindepth 1 -maxdepth 1 -type d | head -n 1)"
if [[ -z "$project_dir" ]]; then
  fail "no bundled Matrix project directory found"
else
  docker_helper="$HELPERS/bundled-matrix-docker"
  expect_status "compose config through the helper" 0 "$docker_helper" "$project_dir" compose config
  expect_status "compose ps through the helper" 0 "$docker_helper" "$project_dir" compose ps -a
  expect_status "postgres readiness through the helper" 0 \
    "$docker_helper" "$project_dir" compose exec -T postgres pg_isready -U synapse
  expect_status "compose logs through the helper" 0 \
    "$docker_helper" "$project_dir" compose logs --no-color --tail 5 synapse
  if as_service sudo -n "$docker_helper" "$project_dir" compose ps -a --format json |
    grep -q synapse; then
    pass "compose ps output reaches the caller"
  else
    fail "compose ps output does not list synapse"
  fi
  expect_status "an arbitrary compose command is refused" 2 \
    "$docker_helper" "$project_dir" compose run --rm synapse sh
  expect_status "an arbitrary exec is refused" 2 \
    "$docker_helper" "$project_dir" compose exec -T synapse sh
  expect_status "a project outside the bundled-matrix root is refused" 2 \
    "$docker_helper" /etc compose ps -a
fi

unit_helper="$HELPERS/install-systemd-unit"
before="$(sha256sum "$GATEWAY_UNIT")"
if as_service sudo -n "$unit_helper" sovereign-openclaw-gateway.service <"$GATEWAY_UNIT" >/dev/null; then
  pass "the installed gateway unit is accepted by the unit helper"
else
  fail "the installed gateway unit is refused by the unit helper"
fi
check "gateway unit content unchanged" test "$(sha256sum "$GATEWAY_UNIT")" == "$before"
status=0
sed 's|^\[Service\]$|[Service]\nExecStartPre=+/bin/true|' "$GATEWAY_UNIT" |
  as_service sudo -n "$unit_helper" sovereign-openclaw-gateway.service >/dev/null 2>&1 || status=$?
check "a unit with a privileged command prefix is refused (exit $status)" test "$status" == 2
check "refused unit was not written" test "$(sha256sum "$GATEWAY_UNIT")" == "$before"
status=0
as_service sudo -n "$unit_helper" ssh.service <"$GATEWAY_UNIT" >/dev/null 2>&1 || status=$?
check "an unmanaged unit name is refused (exit $status)" test "$status" == 2

reclaim_helper="$HELPERS/reclaim-ownership"
expect_status "reclaiming the secrets dir" 0 "$reclaim_helper" /etc/sovereign-node/secrets
expect_status "reclaiming /etc is refused" 2 "$reclaim_helper" /etc
expect_status "reclaiming a path outside the fixed set is refused" 2 \
  "$reclaim_helper" /etc/sovereign-node

# An update takes the docker group away from a service user an earlier
# install had added to it.
usermod -aG docker "$SERVICE_USER"
(
  # shellcheck source=scripts/install/lib-runtime-paths.sh
  source "$REPO_ROOT/scripts/install/lib-runtime-paths.sh"
  # shellcheck disable=SC2034 # read by ensure_service_account
  SERVICE_GROUP="$SERVICE_USER"
  ensure_service_account
  ensure_service_account
)
if id -nG "$SERVICE_USER" | tr ' ' '\n' | grep -qx docker; then
  fail "ensure_service_account left $SERVICE_USER in the docker group"
else
  pass "ensure_service_account removes $SERVICE_USER from the docker group"
fi

exit "$failed"
