#!/usr/bin/env bash
set -euo pipefail

STATE_FILE="/var/lib/sovereign-node/disk-check-state.json"
WARN_THRESHOLD=90
FAIL_THRESHOLD=95

df_line="$(df -Pk / | tail -1)"
available_kb="$(echo "$df_line" | awk '{print $4}')"
used_pct="$(echo "$df_line" | awk '{print $5}' | tr -d '%')"
total_kb="$(echo "$df_line" | awk '{print $2}')"

if [[ "$used_pct" -ge "$FAIL_THRESHOLD" ]]; then
  status="fail"
elif [[ "$used_pct" -ge "$WARN_THRESHOLD" ]]; then
  status="warn"
else
  status="pass"
fi

cat > "$STATE_FILE" <<EOF
{
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "usagePercent": $used_pct,
  "availableBytes": $((available_kb * 1024)),
  "totalBytes": $((total_kb * 1024)),
  "status": "$status"
}
EOF

if [[ "$status" != "pass" ]]; then
  echo "[sovereign-node-disk-check] WARNING: Root filesystem is ${used_pct}% full (status: ${status})"
fi
