#!/usr/bin/env bash
# Checks, on an installed node, the two hardening settings of the bundled
# OpenClaw runtime:
#   - every undici the gateway can load is at least 8.12.2;
#   - the hosted model catalog refresh is off and the gateway still replies:
#     model-catalog-refresh-probe.mjs runs the installed OpenClaw on a copy of
#     the rendered config, once as rendered and once with the refresh on.
# The probe runs as the service user with the gateway's own node binary.
# Run as root. An optional argument names the chat model the rendered config
# must now use (after a model change).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
gateway_unit=sovereign-openclaw-gateway.service
service_user="${SERVICE_USER:-sovereign-node}"
openclaw_home="${OPENCLAW_SERVICE_HOME:-/var/lib/sovereign-node/openclaw-home}"
openclaw_config="$openclaw_home/.openclaw/openclaw.json5"
expected_model="${1:-}"
min_undici="8.12.2"

pid="$(systemctl show -p MainPID --value "$gateway_unit")"
if [[ -z "$pid" || "$pid" == "0" ]]; then
  echo "::error::$gateway_unit has no main process"
  exit 1
fi
node_bin="$(readlink -f "/proc/$pid/exe")"
# The unit runs <node> <openclaw.mjs> gateway run ...
openclaw_entry="$(tr '\0' '\n' <"/proc/$pid/cmdline" | sed -n 2p)"
openclaw_entry="$(readlink -f "$openclaw_entry")"
package_root="$(dirname "$openclaw_entry")"
echo "gateway: $node_bin $openclaw_entry"

failed=0
versions="$(find "$(dirname "$package_root")" "$openclaw_home/.openclaw/extensions" \
  -path '*/node_modules/undici/package.json' -exec jq -r '"\(.version) \(input_filename)"' {} \; 2>/dev/null || true)"
echo "${versions:-<no undici found>}"
if [[ -z "$versions" ]]; then
  echo "::error::no undici package found next to $package_root"
  failed=1
fi
while read -r version path; do
  [[ -n "$version" ]] || continue
  if [[ "$(printf '%s\n%s\n' "$min_undici" "$version" | sort -V | head -n 1)" != "$min_undici" ]]; then
    echo "::error::undici $version at $path is older than $min_undici"
    failed=1
  fi
done <<<"$versions"
(cd "$(dirname "$(dirname "$package_root")")" && npm ls undici --all) || {
  echo "::error::npm ls undici failed in the OpenClaw runtime project"
  failed=1
}

if [[ -n "$expected_model" ]]; then
  model="$(jq -r '.agents.defaults.model' "$openclaw_config")"
  if [[ "$model" != "openrouter/$expected_model" ]]; then
    echo "::error::the rendered default model is $model, expected openrouter/$expected_model"
    failed=1
  fi
fi

# The checkout sits under /home, which the service user may not read.
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
for name in model-catalog-refresh-probe.mjs model-catalog-probe-preload.mjs; do
  install -m 0644 "$here/$name" "$scratch/$name"
done
install -m 0600 "$openclaw_config" "$scratch/openclaw.json5"
mkdir "$scratch/work"
chown -R "$service_user:" "$scratch"
chmod 0700 "$scratch"
probe_rc=0
(cd "$scratch" && sudo -u "$service_user" -- env -i PATH=/usr/local/bin:/usr/bin:/bin \
  "$node_bin" "$scratch/model-catalog-refresh-probe.mjs" \
  "$openclaw_entry" "$scratch/openclaw.json5" "$scratch/work") >"$scratch/summary.json" || probe_rc=$?
jq . "$scratch/summary.json" || cat "$scratch/summary.json"
if [[ "$probe_rc" -ne 0 ]]; then
  for log in "$scratch"/work/*/gateway.log; do
    [[ -f "$log" ]] || continue
    echo "=== $log ==="
    tail -n 80 "$log"
  done
  failed=1
fi
exit "$failed"
