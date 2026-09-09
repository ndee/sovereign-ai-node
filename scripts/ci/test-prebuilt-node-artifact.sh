#!/usr/bin/env bash
# Contract test for the prebuilt sovereign-ai-node installer path.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK_DIR="$(mktemp -d --tmpdir node-prebuilt-runtime-test.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

# Source the orchestrator without running main so this exercises the same
# functions used by both the multi-file and bundled installers.
# shellcheck source=../install.sh
source "$REPO_ROOT/scripts/install.sh"

PACKAGE_DIR="$WORK_DIR/package"
ARTIFACT="$WORK_DIR/sovereign-ai-node-3.4.5.tgz"
MANIFEST="$WORK_DIR/component-release.json"
GOOD_ARTIFACT="$WORK_DIR/good-sovereign-ai-node-3.4.5.tgz"
GOOD_MANIFEST="$WORK_DIR/good-component-release.json"
COMMAND_LOG="$WORK_DIR/commands.log"
FAKE_BIN="$WORK_DIR/fake-bin"
ORIGINAL_PATH="$PATH"
export COMMAND_LOG

make_package() {
  rm -rf "$PACKAGE_DIR"
  mkdir -p \
    "$PACKAGE_DIR/dist/lib" \
    "$PACKAGE_DIR/public/setup-ui" \
    "$PACKAGE_DIR/deploy/ansible/playbooks" \
    "$PACKAGE_DIR/deploy/ansible/roles/sovereign_host_resources_apply/tasks" \
    "$PACKAGE_DIR/deploy/ansible/roles/sovereign_host_resources_verify/tasks" \
    "$PACKAGE_DIR/deploy/config" \
    "$PACKAGE_DIR/deploy/runtime" \
    "$PACKAGE_DIR/deploy/scripts" \
    "$PACKAGE_DIR/deploy/systemd" \
    "$PACKAGE_DIR/scripts/install"

  jq -n '{
    name:"sovereign-ai-node",
    version:"3.4.5",
    packageManager:"pnpm@10.32.1",
    dependencies:{zod:"4.3.6"},
    bin:{
      "sovereign-node":"./dist/sovereign-node.js",
      "sovereign-node-api":"./dist/sovereign-node-api.js",
      "sovereign-tool":"./dist/sovereign-tool.js"
    }
  }' > "$PACKAGE_DIR/package.json"
  printf '%s\n' "lockfileVersion: '9.0'" > "$PACKAGE_DIR/deploy/runtime/pnpm-lock.yaml"

  for entrypoint in \
    sovereign-node.js \
    sovereign-node-api.js \
    sovereign-node-onboarding-api.js \
    sovereign-tool.js; do
    printf '%s\n' '#!/usr/bin/env node' 'process.stdout.write("ok\\n");' > "$PACKAGE_DIR/dist/$entrypoint"
    chmod 0755 "$PACKAGE_DIR/dist/$entrypoint"
  done
  printf '%s\n' 'export {};' > "$PACKAGE_DIR/dist/lib/index.js"
  printf '%s\n' '<!doctype html>' > "$PACKAGE_DIR/public/setup-ui/index.html"
  printf '%s\n' '[defaults]' > "$PACKAGE_DIR/deploy/ansible/ansible.cfg"
  printf '%s\n' '---' > "$PACKAGE_DIR/deploy/ansible/playbooks/post-install-local.yml"
  printf '%s\n' '---' > "$PACKAGE_DIR/deploy/ansible/roles/sovereign_host_resources_apply/tasks/main.yml"
  printf '%s\n' '---' > "$PACKAGE_DIR/deploy/ansible/roles/sovereign_host_resources_verify/tasks/main.yml"
  printf '%s\n' '{}' > "$PACKAGE_DIR/deploy/install-request.example.json"
  printf '%s\n' 'SystemMaxUse=1G' > "$PACKAGE_DIR/deploy/config/journald-sovereign-node.conf"
  printf '%s\n' '/var/log/sovereign-node/*.log {}' > "$PACKAGE_DIR/deploy/config/logrotate-sovereign-node"
  printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$PACKAGE_DIR/deploy/scripts/sovereign-node-disk-check.sh"
  chmod 0755 "$PACKAGE_DIR/deploy/scripts/sovereign-node-disk-check.sh"
  for unit in \
    sovereign-node-api.service \
    sovereign-node-disk-check.service \
    sovereign-node-disk-check.timer \
    sovereign-node-docker-prune.service \
    sovereign-node-docker-prune.timer; do
    printf '%s\n' '[Unit]' > "$PACKAGE_DIR/deploy/systemd/$unit"
  done
  printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$PACKAGE_DIR/scripts/install-docker.sh"
  chmod 0755 "$PACKAGE_DIR/scripts/install-docker.sh"
  for lib in lib-log.sh lib-os.sh lib-runtime-deps.sh; do
    printf '%s\n' '# shellcheck shell=bash' > "$PACKAGE_DIR/scripts/install/$lib"
  done
}

pack_package() {
  tar -czf "$ARTIFACT" -C "$WORK_DIR" package
}

write_manifest() {
  local artifact_sha artifact_size
  artifact_sha="$(sha256sum "$ARTIFACT" | awk '{print $1}')"
  artifact_size="$(stat -c '%s' "$ARTIFACT")"
  jq -n \
    --arg sha256 "$artifact_sha" \
    --argjson size "$artifact_size" \
    '{
      schemaVersion:1,
      component:"sovereign-ai-node",
      version:"3.4.5",
      tag:"v3.4.5",
      commitSha:"0123456789abcdef0123456789abcdef01234567",
      assets:[
        {name:"install.sh",size:1,sha256:"0000000000000000000000000000000000000000000000000000000000000000"},
        {name:"sovereign-ai-node-3.4.5.tgz",size:$size,sha256:$sha256}
      ]
    }' > "$MANIFEST"
}

restore_good_inputs() {
  cp -- "$GOOD_ARTIFACT" "$ARTIFACT"
  cp -- "$GOOD_MANIFEST" "$MANIFEST"
}

assert_rejected_and_preserved() {
  local label="$1"
  local expected="$2"
  local output
  if output="$(PATH="$FAKE_BIN:$ORIGINAL_PATH" sync_app_source 2>&1)"; then
    printf '%s unexpectedly passed validation\n' "$label" >&2
    exit 1
  fi
  [[ "$output" == *"$expected"* ]] || {
    printf '%s failed for the wrong reason:\n%s\n' "$label" "$output" >&2
    exit 1
  }
  [[ -f "$APP_DIR/preserved.txt" ]] || {
    printf '%s replaced the existing Node runtime\n' "$label" >&2
    exit 1
  }
}

mkdir -p "$FAKE_BIN"
for command_name in git npm pnpm; do
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'printf "%s %s\\n" "$(basename "$0")" "$*" >> "$COMMAND_LOG"' \
    'exit 97' > "$FAKE_BIN/$command_name"
  chmod 0755 "$FAKE_BIN/$command_name"
done
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf "corepack %s\\n" "$*" >> "$COMMAND_LOG"' \
  '[[ "$*" == "pnpm install --prod --frozen-lockfile --ignore-scripts" ]] || exit 98' \
  'mkdir -p node_modules' \
  'printf "installed\\n" > node_modules/.installed-production' > "$FAKE_BIN/corepack"
chmod 0755 "$FAKE_BIN/corepack"

make_package
pack_package
write_manifest
cp -- "$ARTIFACT" "$GOOD_ARTIFACT"
cp -- "$MANIFEST" "$GOOD_MANIFEST"

NODE_ARTIFACT="$ARTIFACT"
NODE_ARTIFACT_MANIFEST="$MANIFEST"
SOURCE_DIR=""
APP_DIR="$WORK_DIR/installed-app"
BOTS_SOURCE_DIR="$WORK_DIR/bots-source"
mkdir -p "$BOTS_SOURCE_DIR"

resolve_source_mode
PATH="$FAKE_BIN:$ORIGINAL_PATH" sync_app_source
build_log="$(PATH="$FAKE_BIN:$ORIGINAL_PATH" build_app 2>&1)"
[[ "$build_log" == *"skipping source dependency install and application build"* ]]
[[ -f "$APP_DIR/dist/sovereign-node.js" ]]
[[ -f "$APP_DIR/node_modules/.installed-production" ]]
[[ "$(<"$COMMAND_LOG")" == "corepack pnpm install --prod --frozen-lockfile --ignore-scripts" ]] || {
  printf 'prebuilt Node mode invoked an unexpected command:\n' >&2
  sed -n '1,20p' "$COMMAND_LOG" >&2
  exit 1
}

REPO_URL="https://github.com/ndee/sovereign-ai-node"
REF="main"
BOTS_ARTIFACT=""
BOTS_ARTIFACT_MANIFEST=""
BOTS_REPO_URL="https://github.com/ndee/sovereign-ai-bots"
BOTS_REF="main"
PROVENANCE_FILE="$WORK_DIR/install-provenance.json"
SERVICE_USER="$(id -un)"
SERVICE_GROUP="$(id -gn)"
write_install_provenance
artifact_sha="$(sha256sum "$ARTIFACT" | awk '{print $1}')"
jq -e \
  --arg artifact "$(basename "$ARTIFACT")" \
  --arg sha256 "$artifact_sha" '
    .nodeRepoUrl == "release-artifact" and
    .nodeRef == "v3.4.5" and
    .nodeVersion == "3.4.5" and
    .nodeCommitSha == "0123456789abcdef0123456789abcdef01234567" and
    .nodeArtifact == $artifact and
    .nodeArtifactSha256 == $sha256 and
    .installSource == "release-artifact"
  ' "$PROVENANCE_FILE" >/dev/null

if (SOURCE_DIR=""; NODE_ARTIFACT=""; NODE_ARTIFACT_MANIFEST=""; ACTION=""; \
  parse_args --node-artifact-manifest "$MANIFEST" >/dev/null 2>&1); then
  printf '%s\n' '--node-artifact-manifest unexpectedly worked without --node-artifact' >&2
  exit 1
fi
if (SOURCE_DIR=""; NODE_ARTIFACT=""; NODE_ARTIFACT_MANIFEST=""; ACTION=""; \
  parse_args --node-artifact "$ARTIFACT" --source-dir "$REPO_ROOT" >/dev/null 2>&1); then
  printf '%s\n' '--node-artifact unexpectedly worked with --source-dir' >&2
  exit 1
fi

printf 'preserve\n' > "$APP_DIR/preserved.txt"
printf 'tampered\n' >> "$ARTIFACT"
assert_rejected_and_preserved "tampered Node artifact" "digest mismatch"

restore_good_inputs
jq '.component = "sovereign-ai-bots"' "$MANIFEST" > "$WORK_DIR/bad-manifest.json"
cp -- "$WORK_DIR/bad-manifest.json" "$MANIFEST"
assert_rejected_and_preserved "wrong-component manifest" "Invalid sovereign-ai-node component release manifest"

restore_good_inputs
make_package
jq '.version = "9.9.9"' "$PACKAGE_DIR/package.json" > "$WORK_DIR/bad-package.json"
cp -- "$WORK_DIR/bad-package.json" "$PACKAGE_DIR/package.json"
pack_package
write_manifest
assert_rejected_and_preserved "package version mismatch" "package version does not match"

restore_good_inputs
make_package
mkdir -p "$PACKAGE_DIR/src"
printf 'source\n' > "$PACKAGE_DIR/src/index.ts"
pack_package
write_manifest
assert_rejected_and_preserved "development content" "prohibited development content"

restore_good_inputs
printf 'escape\n' > "$WORK_DIR/escape.txt"
tar -czf "$ARTIFACT" --transform='s#^escape.txt$#package/../escape.txt#' -C "$WORK_DIR" escape.txt
write_manifest
assert_rejected_and_preserved "path traversal archive" "unsafe or normalized-duplicate path"

restore_good_inputs
rm -rf "$PACKAGE_DIR"
mkdir -p "$PACKAGE_DIR"
ln -s /etc/passwd "$PACKAGE_DIR/linked-passwords"
pack_package
write_manifest
assert_rejected_and_preserved "symlink archive" "link or special file"

# A failed frozen install must leave the previous runtime active and clean up
# both staging paths.
restore_good_inputs
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf "corepack %s\\n" "$*" >> "$COMMAND_LOG"' \
  'exit 91' > "$FAKE_BIN/corepack"
chmod 0755 "$FAKE_BIN/corepack"
assert_rejected_and_preserved "dependency install failure" "locked production dependencies"
if compgen -G "${APP_DIR}.staged.*" >/dev/null || compgen -G "${APP_DIR}.previous.*" >/dev/null; then
  printf 'failed install left a staging or rollback directory behind\n' >&2
  exit 1
fi

# The standalone release installer inlines the same validator and supports the
# same public flags. Exercise an independent install through that generated file.
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf "corepack %s\\n" "$*" >> "$COMMAND_LOG"' \
  '[[ "$*" == "pnpm install --prod --frozen-lockfile --ignore-scripts" ]] || exit 98' \
  'mkdir -p node_modules' \
  'printf "installed\\n" > node_modules/.installed-production' > "$FAKE_BIN/corepack"
chmod 0755 "$FAKE_BIN/corepack"
restore_good_inputs
BUNDLED_INSTALLER="$WORK_DIR/install.sh"
bash "$REPO_ROOT/scripts/install/build.sh" "$BUNDLED_INSTALLER" >/dev/null
bash "$BUNDLED_INSTALLER" --help | grep -q -- '--node-artifact-manifest'
(
  export SOVEREIGN_NODE_ARTIFACT="$ARTIFACT"
  export SOVEREIGN_NODE_ARTIFACT_MANIFEST="$MANIFEST"
  export SOVEREIGN_NODE_INSTALL_ROOT="$WORK_DIR/standalone-install"
  # shellcheck source=/dev/null
  source "$BUNDLED_INSTALLER"
  PATH="$FAKE_BIN:$ORIGINAL_PATH" sync_app_source
  PATH="$FAKE_BIN:$ORIGINAL_PATH" build_app
  [[ -f "$APP_DIR/node_modules/.installed-production" ]]
)

# The local-source path still removes stale build output exactly as before.
SOURCE_FIXTURE="$WORK_DIR/source-node"
mkdir -p "$SOURCE_FIXTURE/dist" "$SOURCE_FIXTURE/node_modules"
printf '%s\n' '{"name":"sovereign-ai-node"}' > "$SOURCE_FIXTURE/package.json"
printf 'keep\n' > "$SOURCE_FIXTURE/runtime.txt"
printf 'remove\n' > "$SOURCE_FIXTURE/dist/stale.js"
NODE_ARTIFACT=""
NODE_ARTIFACT_MANIFEST=""
SOURCE_DIR="$SOURCE_FIXTURE"
APP_DIR="$WORK_DIR/source-installed-app"
sync_app_source
[[ -f "$APP_DIR/runtime.txt" ]]
[[ ! -e "$APP_DIR/dist" ]]
[[ ! -e "$APP_DIR/node_modules" ]]

printf 'Prebuilt Node installer contract passed.\n'
