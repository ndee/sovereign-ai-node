# shellcheck shell=bash
# lib-log: tagged stdout/stderr logging, fatal-exit helper, and --help output.
#
# Relies on SCRIPT_NAME from the sourcing environment.

log() {
  printf '[%s] %s\n' "$SCRIPT_NAME" "$*"
}

die() {
  printf '[%s] ERROR: %s\n' "$SCRIPT_NAME" "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Options:
  --repo-url <url>         Git URL for sovereign-ai-node (default: https://github.com/ndee/sovereign-ai-node)
  --source-dir <path>      Local source directory (alternative to --repo-url)
  --ref <ref>              Git ref (default: main)
  --bots-repo-url <url>    Git URL for sovereign-ai-bots (default: https://github.com/ndee/sovereign-ai-bots)
  --bots-source-dir <path> Local bot repo source directory (alternative to --bots-repo-url)
  --bots-ref <ref>         Bot repo Git ref (default: main)
  --install-root <path>    Install root (default: /opt/sovereign-ai-node)
  --service-user <user>    systemd service user (default: sovereign-node)
  --service-group <group>  systemd service group (default: same as service user)
  --api-host <host>        API bind host (default: 127.0.0.1)
  --api-port <port>        API bind port (default: 8787)
  --request-file <path>    Install request output path (default: /etc/sovereign-node/install-request.json)
  --install                Force Install mode (new install / reconfigure)
  --update                 Force Update mode (reuse existing request/config)
  --skip-install-run       Only bootstrap host; do not run sovereign-node install
  --non-interactive        Do not prompt; use explicit or inferred action
  -h, --help               Show help
EOF
}
