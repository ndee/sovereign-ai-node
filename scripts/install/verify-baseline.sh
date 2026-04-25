#!/usr/bin/env bash
# Diff the current installer's output against the committed baseline.
#
# Fails (exit 1) if any observable output has drifted. Run this at every
# extraction step of the refactor.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASELINE_DIR="${REPO_ROOT}/scripts/install/baseline"
WORK_DIR="$(mktemp -d --tmpdir installer-baseline-verify.XXXXXX)"

trap 'rm -rf "${WORK_DIR}"' EXIT

bash "${REPO_ROOT}/scripts/install/baseline-snapshot.sh" "${WORK_DIR}" >/dev/null

fail=0
while IFS= read -r -d '' committed; do
  rel="${committed#${BASELINE_DIR}/}"
  current="${WORK_DIR}/${rel}"
  if [[ ! -f "${current}" ]]; then
    echo "::error::missing in current run: ${rel}" >&2
    fail=1
    continue
  fi
  if ! diff -u "${committed}" "${current}"; then
    echo "::error::drift in ${rel}" >&2
    fail=1
  fi
done < <(find "${BASELINE_DIR}" -type f -print0)

if [[ ${fail} -ne 0 ]]; then
  echo "Baseline drift detected. If intentional, re-run baseline-snapshot.sh to refresh the committed fixtures." >&2
  exit 1
fi

echo "Baseline matches."
