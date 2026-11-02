#!/usr/bin/env bash
# test-synapse-prepull.sh — Guard the Synapse image the CI E2E jobs pre-pull.
#
# The install E2E jobs warm the Docker cache with the Synapse image before the
# installer runs. If that pull drifts from the image the product pins in
# src/system/matrix.ts, the warm-up silently stops helping and the jobs pull
# the real image a second time. Only the upgrade E2E job may hold an older
# Synapse image: it installs the previous release first.
#
# Asserts against .github/workflows/ci.yml (or the file given as $1):
#   1. every "E2E Install (...)" job has a "Pre-pull Docker images" step whose
#      script, run with a stub `docker`, pulls exactly one Synapse image, and
#      that image equals DEFAULT_SYNAPSE_IMAGE from src/system/matrix.ts;
#   2. no job other than the upgrade job mentions the retired
#      matrixdotorg/synapse:v1.125.0 image.
# Without an argument it also proves, on mutated copies of the workflow, that
# both checks fail when broken.
#
# Dependencies: bash, node (with the repo's `yaml` dependency installed).
# Exit 0 = the pre-pulls match the pinned image, 1 = drift detected.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HELPER="$REPO_ROOT/scripts/e2e/synapse-upgrade-e2e.sh"
MATRIX_TS="$REPO_ROOT/src/system/matrix.ts"
UPGRADE_JOB="e2e_upgrade"
RETIRED_IMAGE="matrixdotorg/synapse:v1.125.0"

WORK_DIR="$(mktemp -d --tmpdir synapse-prepull.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

mkdir -p "$WORK_DIR/bin"
cat >"$WORK_DIR/bin/docker" <<'EOF'
#!/usr/bin/env bash
[[ "${1:-}" == "pull" ]] || { printf 'unexpected docker call: %s\n' "$*" >&2; exit 64; }
printf '%s\n' "$2" >>"$DOCKER_PULL_LOG"
EOF
chmod 0755 "$WORK_DIR/bin/docker"

# Emits one NUL-terminated record per job: id, name, the pre-pull script (empty
# when the job has none), and the job serialised back to YAML for text checks.
jobs_of() {
  (cd "$REPO_ROOT" && node --input-type=module - "$1") <<'EOF'
import { readFileSync } from "node:fs";
import { parse, stringify } from "yaml";

const workflow = parse(readFileSync(process.argv[2], "utf8"));
for (const [id, job] of Object.entries(workflow.jobs ?? {})) {
  const prepull = (job.steps ?? []).find((step) => step.name === "Pre-pull Docker images");
  for (const field of [id, job.name ?? "", prepull?.run ?? "", stringify(job)]) {
    process.stdout.write(`${field}\0`);
  }
}
EOF
}

# check_workflow <ci.yml> — prints every violation and returns 1 if any.
check_workflow() {
  local workflow=$1 pinned id name script text pulled install_jobs=0 bad=0
  pinned="$(bash "$HELPER" expected-image "$MATRIX_TS")"

  while IFS= read -r -d '' id && IFS= read -r -d '' name &&
    IFS= read -r -d '' script && IFS= read -r -d '' text; do
    if [[ "$id" != "$UPGRADE_JOB" && "$text" == *"$RETIRED_IMAGE"* ]]; then
      printf 'FAIL: job %s references %s; only %s may hold the old image\n' \
        "$id" "$RETIRED_IMAGE" "$UPGRADE_JOB" >&2
      bad=1
    fi
    [[ "$name" == "E2E Install ("* ]] || continue
    install_jobs=$((install_jobs + 1))
    if [[ -z "$script" ]]; then
      printf 'FAIL: job %s has no "Pre-pull Docker images" step\n' "$id" >&2
      bad=1
      continue
    fi
    : >"$WORK_DIR/pulls"
    if ! (cd "$REPO_ROOT" && PATH="$WORK_DIR/bin:$PATH" DOCKER_PULL_LOG="$WORK_DIR/pulls" \
      bash -euo pipefail -c "$script") >/dev/null 2>"$WORK_DIR/stderr"; then
      printf 'FAIL: job %s pre-pull script failed: %s\n' "$id" "$(cat "$WORK_DIR/stderr")" >&2
      bad=1
      continue
    fi
    pulled="$(grep -E '(^|/)synapse[:@]' "$WORK_DIR/pulls" || true)"
    if [[ "$pulled" != "$pinned" ]]; then
      printf 'FAIL: job %s pre-pulls Synapse [%s], expected the pinned [%s]\n' \
        "$id" "${pulled//$'\n'/, }" "$pinned" >&2
      bad=1
    fi
  done < <(jobs_of "$workflow")

  if ((install_jobs == 0)); then
    printf 'FAIL: no "E2E Install (...)" jobs found in %s\n' "$workflow" >&2
    bad=1
  fi
  return "$bad"
}

if [[ $# -gt 0 ]]; then
  check_workflow "$1"
  exit
fi

failures=0
CI_WORKFLOW="$REPO_ROOT/.github/workflows/ci.yml"
check_workflow "$CI_WORKFLOW" || failures=$((failures + 1))

# The guard must reject the drift it exists for.
expect_rejected() {
  local label=$1 file=$2
  if check_workflow "$file" 2>/dev/null; then
    printf 'FAIL: guard accepted %s\n' "$label" >&2
    failures=$((failures + 1))
  fi
}

# shellcheck disable=SC2016 # matches the literal "$synapse_image" in the workflow
sed -E 's#docker pull "\$synapse_image"#docker pull matrixdotorg/synapse:v1.99.0#' \
  "$CI_WORKFLOW" >"$WORK_DIR/stale.yml"
cmp -s "$CI_WORKFLOW" "$WORK_DIR/stale.yml" &&
  { printf 'FAIL: stale-image mutation did not apply\n' >&2; failures=$((failures + 1)); }
expect_rejected "an install job pre-pulling a stale Synapse image" "$WORK_DIR/stale.yml"

sed -E "0,/docker pull postgres:16-alpine &/s##docker pull postgres:16-alpine \&\n          docker pull $RETIRED_IMAGE \&#" \
  "$CI_WORKFLOW" >"$WORK_DIR/retired.yml"
cmp -s "$CI_WORKFLOW" "$WORK_DIR/retired.yml" &&
  { printf 'FAIL: retired-image mutation did not apply\n' >&2; failures=$((failures + 1)); }
expect_rejected "the retired image outside the upgrade job" "$WORK_DIR/retired.yml"

if ((failures > 0)); then
  printf '%d Synapse pre-pull check(s) failed\n' "$failures" >&2
  exit 1
fi
printf 'Synapse pre-pull guard: install E2E jobs pull the pinned image\n'
