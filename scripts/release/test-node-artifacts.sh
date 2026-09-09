#!/usr/bin/env bash
# Validate the exact sovereign-ai-node files that will be uploaded to GitHub.

set -euo pipefail

if [[ $# -lt 1 || $# -gt 3 ]]; then
  printf 'usage: %s <artifact-dir> [expected-tag] [expected-commit-sha]\n' "$0" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ARTIFACT_DIR="$1"
VERSION="$(node -p "require('${REPO_ROOT}/package.json').version")"
EXPECTED_TAG="${2:-v$VERSION}"
EXPECTED_COMMIT="${3:-$(git -C "$REPO_ROOT" rev-parse HEAD)}"
ARCHIVE_NAME="sovereign-ai-node-${VERSION}.tgz"
ARCHIVE="${ARTIFACT_DIR}/$ARCHIVE_NAME"
INSTALLER="${ARTIFACT_DIR}/install.sh"
MANIFEST="${ARTIFACT_DIR}/component-release.json"
WORK_DIR="$(mktemp -d --tmpdir node-release-contract.XXXXXX)"
api_pid=""
onboarding_pid=""

cleanup() {
  if [[ -n "$api_pid" ]]; then
    kill "$api_pid" 2>/dev/null || true
    wait "$api_pid" 2>/dev/null || true
  fi
  if [[ -n "$onboarding_pid" ]]; then
    kill "$onboarding_pid" 2>/dev/null || true
    wait "$onboarding_pid" 2>/dev/null || true
  fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

fail() {
  printf 'node release artifact contract: %s\n' "$*" >&2
  exit 1
}

for file in "$ARCHIVE" "$INSTALLER" "$MANIFEST"; do
  [[ -s "$file" ]] || fail "missing or empty asset: $file"
done

jq -e \
  --arg version "$VERSION" \
  --arg tag "$EXPECTED_TAG" \
  --arg commit "$EXPECTED_COMMIT" \
  --arg archive "$ARCHIVE_NAME" \
  '
    keys == ["assets", "commitSha", "component", "schemaVersion", "tag", "version"] and
    .schemaVersion == 1 and
    .component == "sovereign-ai-node" and
    .version == $version and
    .tag == $tag and
    .commitSha == $commit and
    (.assets | type == "array" and length == 2) and
    ([.assets[].name] | sort) == (["install.sh", $archive] | sort) and
    (all(.assets[];
      keys == ["name", "sha256", "size"] and
      (.size | type == "number" and . > 0 and floor == .) and
      (.sha256 | type == "string" and test("^[0-9a-f]{64}$"))
    ))
  ' "$MANIFEST" >/dev/null || fail "component-release.json does not match the release contract"

while IFS=$'\t' read -r name expected_size expected_sha; do
  asset_path="${ARTIFACT_DIR}/$name"
  [[ -f "$asset_path" ]] || fail "manifest names a missing asset: $name"
  actual_size="$(stat -c '%s' "$asset_path")"
  actual_sha="$(sha256sum "$asset_path" | awk '{print $1}')"
  [[ "$actual_size" == "$expected_size" ]] ||
    fail "size mismatch for $name: expected $expected_size, got $actual_size"
  [[ "$actual_sha" == "$expected_sha" ]] ||
    fail "SHA-256 mismatch for $name: expected $expected_sha, got $actual_sha"
done < <(jq -r '.assets[] | [.name, .size, .sha256] | @tsv' "$MANIFEST")

ARCHIVE_LIST="$WORK_DIR/archive.list"
tar -tzf "$ARCHIVE" > "$ARCHIVE_LIST" || fail "package archive is not a readable .tgz"
[[ -s "$ARCHIVE_LIST" ]] || fail "package archive is empty"
duplicate_entry="$(awk 'seen[$0]++ { print; exit }' "$ARCHIVE_LIST")"
[[ -z "$duplicate_entry" ]] || fail "package archive contains duplicate entry: $duplicate_entry"
while IFS= read -r entry; do
  [[ "$entry" == "package" || "$entry" == "package/" || "$entry" == package/* ]] ||
    fail "package archive entry is outside package/: $entry"
  [[ "/$entry/" != *"/../"* ]] || fail "package archive contains parent traversal: $entry"
done < "$ARCHIVE_LIST"
tar -tvzf "$ARCHIVE" | awk '
  substr($1, 1, 1) != "-" && substr($1, 1, 1) != "d" { exit 1 }
' || fail "package archive contains a link or special file"

tar -xzf "$ARCHIVE" -C "$WORK_DIR"
PACKAGE_DIR="$WORK_DIR/package"
[[ "$(jq -r '.name // ""' "$PACKAGE_DIR/package.json" 2>/dev/null)" == "sovereign-ai-node" ]] ||
  fail "packed package.json has the wrong name"
[[ "$(jq -r '.version // ""' "$PACKAGE_DIR/package.json")" == "$VERSION" ]] ||
  fail "packed package.json has the wrong version"
[[ "$(jq -cS '.dependencies' "$PACKAGE_DIR/package.json")" == "$(jq -cS '.dependencies' "$REPO_ROOT/package.json")" ]] ||
  fail "packed production dependency metadata differs from source"
jq -e '((.bundledDependencies // .bundleDependencies // []) | length) == 0' \
  "$PACKAGE_DIR/package.json" >/dev/null ||
  fail "package unexpectedly bundles dependency trees"

for required in \
  package.json \
  deploy/runtime/pnpm-lock.yaml \
  README.md \
  CHANGELOG.md \
  dist/sovereign-node.js \
  dist/sovereign-node-api.js \
  dist/sovereign-node-onboarding-api.js \
  dist/sovereign-tool.js \
  dist/lib/index.js \
  deploy/ansible/ansible.cfg \
  deploy/ansible/playbooks/post-install-local.yml \
  deploy/ansible/roles/sovereign_host_resources_apply/tasks/main.yml \
  deploy/ansible/roles/sovereign_host_resources_verify/tasks/main.yml \
  deploy/install-request.example.json \
  deploy/config/journald-sovereign-node.conf \
  deploy/config/logrotate-sovereign-node \
  deploy/scripts/sovereign-node-disk-check.sh \
  deploy/systemd/sovereign-node-api.service \
  deploy/systemd/sovereign-node-disk-check.service \
  deploy/systemd/sovereign-node-disk-check.timer \
  deploy/systemd/sovereign-node-docker-prune.service \
  deploy/systemd/sovereign-node-docker-prune.timer \
  scripts/install-docker.sh \
  scripts/install/lib-log.sh \
  scripts/install/lib-os.sh \
  scripts/install/lib-runtime-deps.sh \
  public/setup-ui/index.html; do
  [[ -f "$PACKAGE_DIR/$required" ]] || fail "required package payload is missing: $required"
done

jq -e '
  .bin == {
    "sovereign-node": "./dist/sovereign-node.js",
    "sovereign-node-api": "./dist/sovereign-node-api.js",
    "sovereign-tool": "./dist/sovereign-tool.js"
  }
' "$PACKAGE_DIR/package.json" >/dev/null || fail "packed package.json has an unexpected bin mapping"

for entrypoint in \
  dist/sovereign-node.js \
  dist/sovereign-node-api.js \
  dist/sovereign-node-onboarding-api.js \
  dist/sovereign-tool.js; do
  [[ -x "$PACKAGE_DIR/$entrypoint" ]] || fail "$entrypoint is not executable"
  [[ "$(head -n 1 "$PACKAGE_DIR/$entrypoint")" == '#!/usr/bin/env node' ]] ||
    fail "$entrypoint does not have the expected Node shebang"
done

prohibited_entry="$(find "$PACKAGE_DIR" \
  \( -path '*/.git/*' -o -path '*/.github/*' -o -path '*/.agent-deck/*' -o -path '*/.claude/*' -o -path '*/node_modules/*' \
     -o -path '*/src/*' -o -path '*/test/*' -o -path '*/tests/*' \
     -o -name '*.test.*' -o -name '*.spec.*' -o -name '*.log' -o -name '*.map' \
  \) -print -quit)"
[[ -z "$prohibited_entry" ]] ||
  fail "package contains prohibited development content: ${prohibited_entry#$PACKAGE_DIR/}"

if grep -rIEn \
  -e '-----BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----' \
  -e 'sk-or-v1-[A-Za-z0-9_-]{20,}' \
  -e 'syt_[A-Za-z0-9._-]{20,}' \
  -e 'github_pat_[A-Za-z0-9_]{20,}' \
  -e 'gh[pousr]_[A-Za-z0-9]{20,}' \
  -e 'AKIA[0-9A-Z]{16}' \
  "$PACKAGE_DIR" "$INSTALLER" "$MANIFEST" >/dev/null; then
  fail "secret-like material found in release assets"
fi

[[ -x "$INSTALLER" ]] || fail "install.sh is not executable"
bash -n "$INSTALLER"
bash "$INSTALLER" --help >/dev/null

# Exercise the packed entrypoints with the archive's own locked production graph.
cp "$PACKAGE_DIR/deploy/runtime/pnpm-lock.yaml" "$PACKAGE_DIR/pnpm-lock.yaml"
pnpm --dir "$PACKAGE_DIR" install --prod --frozen-lockfile --ignore-scripts
[[ ! -e "$PACKAGE_DIR/node_modules/typescript" ]] || fail "packed runtime installed a development dependency"
"$PACKAGE_DIR/dist/sovereign-node.js" --help >/dev/null
"$PACKAGE_DIR/dist/sovereign-tool.js" --version >/dev/null

free_port() {
  node -e '
    const server = require("node:net").createServer();
    server.listen(0, "127.0.0.1", () => {
      process.stdout.write(String(server.address().port));
      server.close();
    });
  '
}

api_port="$(free_port)"
SOVEREIGN_NODE_API_HOST=127.0.0.1 SOVEREIGN_NODE_API_PORT="$api_port" \
  "$PACKAGE_DIR/dist/sovereign-node-api.js" >"$WORK_DIR/api.log" 2>&1 &
api_pid=$!
api_ready=0
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${api_port}/healthz" 2>/dev/null | grep -q '"ok":true'; then
    api_ready=1
    break
  fi
  if ! kill -0 "$api_pid" 2>/dev/null; then
    break
  fi
  sleep 0.1
done
if [[ "$api_ready" != "1" ]]; then
  sed -n '1,80p' "$WORK_DIR/api.log" >&2
  fail "packed sovereign-node-api did not answer /healthz"
fi
kill "$api_pid"
wait "$api_pid" 2>/dev/null || true
api_pid=""

onboarding_port="$(free_port)"
SOVEREIGN_ONBOARDING_BIND_HOST=127.0.0.1 \
SOVEREIGN_ONBOARDING_BIND_PORT="$onboarding_port" \
SOVEREIGN_ONBOARDING_STATE_PATH="$WORK_DIR/missing-onboarding-state.json" \
SOVEREIGN_ONBOARDING_ALLOWED_SECRETS_DIR="$WORK_DIR" \
  "$PACKAGE_DIR/dist/sovereign-node-onboarding-api.js" >"$WORK_DIR/onboarding-api.log" 2>&1 &
onboarding_pid=$!
onboarding_ready=0
for _ in $(seq 1 30); do
  status="$(curl -sS -o "$WORK_DIR/onboarding-response.json" -w '%{http_code}' \
    "http://127.0.0.1:${onboarding_port}/" 2>/dev/null || true)"
  if [[ "$status" == "404" ]] &&
    jq -e '.error == "not_found"' "$WORK_DIR/onboarding-response.json" >/dev/null 2>&1; then
    onboarding_ready=1
    break
  fi
  if ! kill -0 "$onboarding_pid" 2>/dev/null; then
    break
  fi
  sleep 0.1
done
if [[ "$onboarding_ready" != "1" ]]; then
  sed -n '1,80p' "$WORK_DIR/onboarding-api.log" >&2
  fail "packed sovereign-node-onboarding-api did not return its expected 404 response"
fi
kill "$onboarding_pid"
wait "$onboarding_pid" 2>/dev/null || true
onboarding_pid=""

printf 'Node release artifact contract passed.\n'
