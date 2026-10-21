#!/usr/bin/env bash
# Checks, on a freshly installed node, that the OpenClaw gateway and the Mail
# Sentinel scan unit run inside their systemd sandbox. The gateway is probed
# from inside its live mount namespace; the scan unit runs the probe in place
# of its ExecStart through a temporary drop-in. Run as root.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
gateway_unit=sovereign-openclaw-gateway.service
scan_unit=sovereign-mail-sentinel-scan.service
service_user="${SERVICE_USER:-sovereign-node}"
state_dir=/var/lib/sovereign-node
openclaw_home="$state_dir/openclaw-home"
workspace="$state_dir/mail-sentinel/workspace"
lobster_bin="$state_dir/.npm-global/bin/lobster"
docker_sock=/run/docker.sock
# The probe must live where both units can read it: the checkout sits under
# /home, which the units cannot see.
probe="$openclaw_home/tmp/systemd-sandbox-probe.mjs"
lobster_input="$workspace/.sandbox-probe-input.json"
dropin_dir="/etc/systemd/system/${scan_unit}.d"
dropin="$dropin_dir/ci-sandbox-probe.conf"

cleanup() {
  rm -f "$probe" "$lobster_input" "$dropin"
  systemctl daemon-reload || true
}
trap cleanup EXIT

install -o "$service_user" -g "$service_user" -m 0644 "$here/systemd-sandbox-probe.mjs" "$probe"
uid="$(id -u "$service_user")"
gid="$(id -g "$service_user")"
docker_present=false
[[ -S "$docker_sock" ]] && docker_present=true

echo "== $gateway_unit =="
pid="$(systemctl show -p MainPID --value "$gateway_unit")"
if [[ -z "$pid" || "$pid" == "0" ]]; then
  echo "::error::$gateway_unit has no main process"
  exit 1
fi
node_bin="$(readlink -f "/proc/$pid/exe")"
grep -E '^(NoNewPrivs|CapEff|CapBnd):' "/proc/$pid/status"
grep -Eq '^NoNewPrivs:[[:space:]]+1$' "/proc/$pid/status"
grep -Eq '^CapEff:[[:space:]]+0+$' "/proc/$pid/status"
grep -Eq '^CapBnd:[[:space:]]+0+$' "/proc/$pid/status"

# Positive control outside the sandbox: the same checks can see a program
# start and the container runtime answer.
"$node_bin" "$probe" "$(jq -nc --arg sock "$docker_sock" --argjson docker "$docker_present" '{
  allowed: [["/usr/bin/curl", "--version"]],
  reachable: (if $docker then [$sock] else [] end)
}')"

# As root inside the namespace, refusals come from the sandbox, not from file
# ownership.
nsenter --target "$pid" --mount -- "$node_bin" "$probe" "$(jq -nc \
  --arg sock "$docker_sock" --argjson docker "$docker_present" '{
  readOnly: ["/etc/sovereign-node", "/usr/local/bin", "/opt"],
  refused: [["/usr/bin/curl", "--version"], ["/usr/bin/cat", "/dev/null"]],
  unreachable: (if $docker then [$sock] else [] end)
}')"
nsenter --target "$pid" --mount --setuid "$uid" --setgid "$gid" -- "$node_bin" "$probe" "$(jq -nc \
  --arg home "$openclaw_home" --arg tmp "$openclaw_home/tmp" --arg data "$workspace/data" \
  --arg node "$node_bin" '{
  writable: [$home, $tmp, $data],
  allowed: [[$node, "-e", "0"], ["/usr/local/bin/sovereign-tool", "--version"]]
}')"

echo "== $scan_unit =="
printf '{"probe":true}\n' >"$lobster_input"
chown "$service_user:$service_user" "$lobster_input"
lobster_checks='[]'
if [[ -x "$lobster_bin" ]]; then
  # The classification path: lobster runs its exec stage through cat.
  lobster_checks="$(jq -nc --arg input "$lobster_input" \
    '[["lobster", "--version"], ["lobster", ("exec --json=true cat " + $input + " | json")]]')"
else
  echo "::notice::lobster is not installed at $lobster_bin; skipping the lobster checks"
fi
scan_spec="$(jq -nc --arg home "$openclaw_home" --arg ws "$workspace" --arg sock "$docker_sock" \
  --argjson docker "$docker_present" --argjson lobster "$lobster_checks" '{
  writable: [$ws, ($ws + "/data"), $home],
  readOnly: ["/etc/sovereign-node", "/usr/local/bin"],
  refused: [["/usr/bin/curl", "--version"]],
  allowed: ([["/usr/local/bin/sovereign-tool", "--version"], ["cat", "/dev/null"]] + $lobster),
  unreachable: (if $docker then [$sock] else [] end),
  noNewPrivs: true
}')"
mkdir -p "$dropin_dir"
# Single-quoted for systemd; the spec holds no quote, "$" or "%".
printf "[Service]\nExecStart=\nExecStart=/usr/bin/env node %s '%s'\n" "$probe" "$scan_spec" >"$dropin"
systemctl daemon-reload
since="$(date '+%Y-%m-%d %H:%M:%S')"
scan_rc=0
systemctl start "$scan_unit" || scan_rc=$?
journalctl -u "$scan_unit" --since "$since" --no-pager -o cat
if [[ "$scan_rc" -ne 0 ]]; then
  echo "::error::the sandbox probe failed inside $scan_unit (exit $scan_rc)"
  exit 1
fi

echo "== systemd-analyze security =="
for unit in "$gateway_unit" "$scan_unit"; do
  systemd-analyze security --no-pager "$unit" | tail -n 1
done
