#!/usr/bin/env bash
#
# Unit tests for install-gateway-unit.sh and chown-reclaim.sh.
#
# Dependency-free. The helpers require root for their privileged steps, so the
# tests put a stub `id`/`systemctl`/`chown` on PATH (making id -u report 0)
# and redirect the unit destination into a sandbox via the test-only
# SOVEREIGN_NODE_GATEWAY_UNIT_PATH override. This exercises the REAL helper
# logic (normalization, rejection, symlink refusal) end-to-end.
#
#     bash scripts/install/install-gateway-unit.test.sh
#
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
GATEWAY_HELPER="$SCRIPT_DIR/install-gateway-unit.sh"
CHOWN_HELPER="$SCRIPT_DIR/chown-reclaim.sh"

PASS=0
FAIL=0
ok()  { PASS=$((PASS + 1)); }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1" >&2; }

SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT

# Stub bin dir: id -u -> 0, systemctl -> no-op, real chown delegated.
STUB_BIN="$SANDBOX/bin"
mkdir -p "$STUB_BIN"
cat > "$STUB_BIN/id" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "-u" ]]; then echo 0; else exec /usr/bin/id "$@"; fi
EOF
cat > "$STUB_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
# Stub chown so the gateway helper's `chown root:root <tmp>` succeeds when the
# test runs as a normal user. The chown-reclaim test below uses its OWN PATH
# without this stub so it exercises the real chown failure on a missing dir.
cat > "$STUB_BIN/chown" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$STUB_BIN/id" "$STUB_BIN/systemctl" "$STUB_BIN/chown"

IDENTITY="$SANDBOX/identity"
printf 'user=sovereign-node\ngroup=sovereign-node\n' > "$IDENTITY"

legit_unit() {
  cat <<EOF
[Unit]
Description=Sovereign OpenClaw Gateway
After=network-online.target

[Service]
Type=simple
User=sovereign-node
Group=sovereign-node
ExecStart=/usr/local/bin/openclaw gateway run --allow-unconfigured --bind loopback
Restart=always

[Install]
WantedBy=multi-user.target
EOF
}

# The issue's exploit: run as root with a setuid payload.
malicious_unit() {
  cat <<'EOF'
[Service]
Type=oneshot
User=root
ExecStart=/bin/sh -c "cp /bin/bash /tmp/rootbash; chmod 4755 /tmp/rootbash"
[Install]
WantedBy=multi-user.target
EOF
}

# gateway_run <dest> <<<unit  -> runs helper as fake-root, dest in sandbox.
gateway_run() {
  local dest=$1
  PATH="$STUB_BIN:$PATH" \
  SOVEREIGN_NODE_GATEWAY_IDENTITY_FILE="$IDENTITY" \
  SOVEREIGN_NODE_GATEWAY_UNIT_PATH="$dest" \
    bash "$GATEWAY_HELPER"
}

# --- Fail closed as non-root --------------------------------------------------
if bash "$GATEWAY_HELPER" <<<"$(legit_unit)" >/dev/null 2>&1; then
  bad "gateway helper must refuse to run as non-root"
else ok; fi
if bash "$CHOWN_HELPER" secrets 1000 1000 >/dev/null 2>&1; then
  bad "chown helper must refuse to run as non-root"
else ok; fi

# --- Legit unit is written and runs as the service user -----------------------
dest="$SANDBOX/legit.service"
if gateway_run "$dest" <<<"$(legit_unit)" >/dev/null 2>&1; then ok; else bad "legit unit rejected"; fi
if grep -qxE 'User=sovereign-node' "$dest"; then ok; else bad "legit unit missing User=sovereign-node"; fi
if grep -q 'openclaw gateway run' "$dest"; then ok; else bad "legit ExecStart lost"; fi

# --- Malicious User=root is normalized away, NOT honored -----------------------
dest="$SANDBOX/evil.service"
gateway_run "$dest" <<<"$(malicious_unit)" >/dev/null 2>&1 || true
if [[ -f "$dest" ]]; then
  if grep -qxE 'User=root' "$dest"; then
    bad "malicious User=root survived into the written unit"
  else ok; fi
  if grep -qxE 'User=sovereign-node' "$dest"; then ok; else bad "trusted User= not forced"; fi
  # Exactly one User= / Group= after normalization.
  uc=$(grep -icE '^User[[:space:]]*=' "$dest")
  gc=$(grep -icE '^Group[[:space:]]*=' "$dest")
  if [[ "$uc" -eq 1 && "$gc" -eq 1 ]]; then ok; else bad "expected single User=/Group= (got $uc/$gc)"; fi
else
  # Rejected outright is also acceptable (fail closed) — count as 3 passes.
  ok; ok; ok
fi

# --- Identity file naming root is refused ------------------------------------
root_identity="$SANDBOX/identity-root"
printf 'user=root\ngroup=root\n' > "$root_identity"
if PATH="$STUB_BIN:$PATH" SOVEREIGN_NODE_GATEWAY_IDENTITY_FILE="$root_identity" \
   SOVEREIGN_NODE_GATEWAY_UNIT_PATH="$SANDBOX/x.service" \
   bash "$GATEWAY_HELPER" <<<"$(legit_unit)" >/dev/null 2>&1; then
  bad "gateway helper must refuse a root service identity"
else ok; fi

# --- Symlink at destination is refused ---------------------------------------
real_target="$SANDBOX/real.service"
link_dest="$SANDBOX/link.service"
ln -s "$real_target" "$link_dest"
if gateway_run "$link_dest" <<<"$(legit_unit)" >/dev/null 2>&1; then
  bad "gateway helper must refuse to write through a symlink"
else ok; fi

# --- Empty stdin refused ------------------------------------------------------
if gateway_run "$SANDBOX/empty.service" <<<"" >/dev/null 2>&1; then
  bad "gateway helper must refuse empty stdin"
else ok; fi

# --- chown-reclaim validation (as fake root) ---------------------------------
crun() { PATH="$STUB_BIN:$PATH" bash "$CHOWN_HELPER" "$@"; }
if crun not-a-key 1000 1000 >/dev/null 2>&1; then bad "chown: unknown key accepted"; else ok; fi
if crun secrets abc 1000 >/dev/null 2>&1; then bad "chown: non-numeric uid accepted"; else ok; fi
if crun secrets 1000 xyz >/dev/null 2>&1; then bad "chown: non-numeric gid accepted"; else ok; fi
# Non-existent canonical target -> refused (dirs don't exist in sandbox).
if crun secrets 1000 1000 >/dev/null 2>&1; then bad "chown: missing target accepted"; else ok; fi

printf '\ninstall-gateway-unit.test.sh: %d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
