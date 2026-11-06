#!/usr/bin/env bash
# Checks, on a freshly installed node, that the typed-tool plugin answers
# /version from the Mail Sentinel CLI without a model: the probe loads the
# installed plugin inside the gateway's mount namespace, as the service user,
# with the gateway's own node binary. Run as root.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
gateway_unit=sovereign-openclaw-gateway.service
service_user="${SERVICE_USER:-sovereign-node}"
openclaw_home=/var/lib/sovereign-node/openclaw-home
extension_dir="$openclaw_home/.openclaw/extensions/sovereign-typed-tools"
# The checkout sits under /home, which the gateway's namespace cannot see.
probe="$openclaw_home/tmp/typed-tool-slash-command-probe.mjs"

if [[ ! -f "$extension_dir/index.js" ]]; then
  echo "::notice::no typed-tool plugin is installed; skipping the slash command check"
  exit 0
fi
trap 'rm -f "$probe"' EXIT
install -o "$service_user" -g "$service_user" -m 0644 "$here/typed-tool-slash-command-probe.mjs" "$probe"
pid="$(systemctl show -p MainPID --value "$gateway_unit")"
if [[ -z "$pid" || "$pid" == "0" ]]; then
  echo "::error::$gateway_unit has no main process"
  exit 1
fi
nsenter --target "$pid" --mount --setuid "$(id -u "$service_user")" --setgid "$(id -g "$service_user")" -- \
  "$(readlink -f "/proc/$pid/exe")" "$probe" \
  "$extension_dir" "$openclaw_home/.openclaw/openclaw.json5" "$openclaw_home/tmp"
