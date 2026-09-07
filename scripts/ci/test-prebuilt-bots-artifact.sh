#!/usr/bin/env bash
# Contract test for the prebuilt sovereign-ai-bots installer path.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK_DIR="$(mktemp -d --tmpdir node-prebuilt-bots-test.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

# Source the orchestrator without running main so this test exercises the same
# functions used by both the multi-file and bundled installers.
# shellcheck source=../install.sh
source "$REPO_ROOT/scripts/install.sh"

PACKAGE_DIR="$WORK_DIR/package"
ARTIFACT="$WORK_DIR/sovereign-ai-bots-3.4.5.tgz"
MANIFEST="$WORK_DIR/component-release.json"
COMMAND_MARKER="$WORK_DIR/package-manager-called"
export COMMAND_MARKER

mkdir -p "$PACKAGE_DIR/dist"
printf '%s\n' '{"name":"sovereign-ai-bots","version":"3.4.5"}' > "$PACKAGE_DIR/package.json"
printf '%s\n' "lockfileVersion: '9.0'" > "$PACKAGE_DIR/pnpm-lock.yaml"
printf '%s\n' 'process.stdout.write("catalog ok\\n");' > "$PACKAGE_DIR/dist/validate-catalog.js"
printf '%s\n' 'process.stdout.write("probe ok\\n");' > "$PACKAGE_DIR/dist/probe-mail-sentinel-chat-model.js"

BOTS=(
  "bitcoin-skill-match:2.0.0:2.0.0"
  "mail-sentinel:2.0.12:2.0.12"
  "node-operator:2.0.0:2.0.0"
  "project-sentinel:2.0.0:2.0.0"
  "reality-alignment:0.1.5:0.1.5"
)

bots_json='[]'
for bot in "${BOTS[@]}"; do
  IFS=: read -r id manifest_version template_version <<< "$bot"
  bot_dir="$PACKAGE_DIR/bots/$id"
  mkdir -p "$bot_dir/workspace"
  printf '# %s workspace\n' "$id" > "$bot_dir/workspace/AGENTS.md"
  jq -n     --arg id "$id"     --arg version "$manifest_version"     --arg template_version "$template_version"     '{id:$id,version:$version,agentTemplate:{version:$template_version}}'     > "$bot_dir/sovereign-bot.json"
  bots_json="$(jq     --arg id "$id"     --arg manifest_version "$manifest_version"     --arg template_version "$template_version"     '. + [{id:$id,manifestVersion:$manifest_version,templateVersion:$template_version}]'     <<< "$bots_json")"
done

printf 'png\n' > "$PACKAGE_DIR/bots/mail-sentinel/avatar.png"
printf 'png\n' > "$PACKAGE_DIR/bots/node-operator/avatar.png"

for id in mail-sentinel project-sentinel reality-alignment; do
  mkdir -p "$PACKAGE_DIR/bots/$id/workspace/bin/dist"
  printf '%s\n' 'process.stdout.write("bot ok\\n");'     > "$PACKAGE_DIR/bots/$id/workspace/bin/dist/$id.js"
done

tar -czf "$ARTIFACT" -C "$WORK_DIR" package
write_manifest() {
  artifact_sha="$(sha256sum "$ARTIFACT" | awk '{print $1}')"
  artifact_size="$(stat -c '%s' "$ARTIFACT")"
  jq -n     --arg version "3.4.5"     --arg tag "v3.4.5"     --arg commit_sha "0123456789abcdef0123456789abcdef01234567"     --arg asset_name "$(basename "$ARTIFACT")"     --arg sha256 "$artifact_sha"     --argjson size "$artifact_size"     --argjson bots "$bots_json"     '{
      schemaVersion:1,
      component:"sovereign-ai-bots",
      version:$version,
      tag:$tag,
      commitSha:$commit_sha,
      assets:[{name:$asset_name,size:$size,sha256:$sha256}],
      bots:$bots
    }' > "$MANIFEST"
}
write_manifest
GOOD_ARTIFACT="$WORK_DIR/good-sovereign-ai-bots.tgz"
GOOD_MANIFEST="$WORK_DIR/good-component-release.json"
cp -- "$ARTIFACT" "$GOOD_ARTIFACT"
cp -- "$MANIFEST" "$GOOD_MANIFEST"

BOTS_ARTIFACT="$ARTIFACT"
BOTS_ARTIFACT_MANIFEST="$MANIFEST"
BOTS_SOURCE_DIR=""
BOTS_DIR="$WORK_DIR/installed-bots"

sync_bots_source

for required in   dist/validate-catalog.js   dist/probe-mail-sentinel-chat-model.js   bots/mail-sentinel/workspace/bin/dist/mail-sentinel.js   bots/project-sentinel/workspace/bin/dist/project-sentinel.js   bots/reality-alignment/workspace/bin/dist/reality-alignment.js   bots/mail-sentinel/avatar.png   bots/node-operator/avatar.png   pnpm-lock.yaml; do
  [[ -f "$BOTS_DIR/$required" ]] || {
    printf 'missing installed artifact payload: %s\n' "$required" >&2
    exit 1
  }
done

for entrypoint in \
  dist/validate-catalog.js \
  dist/probe-mail-sentinel-chat-model.js \
  bots/mail-sentinel/workspace/bin/dist/mail-sentinel.js \
  bots/project-sentinel/workspace/bin/dist/project-sentinel.js \
  bots/reality-alignment/workspace/bin/dist/reality-alignment.js; do
  cmp "$PACKAGE_DIR/$entrypoint" "$BOTS_DIR/$entrypoint"
  node "$BOTS_DIR/$entrypoint" >/dev/null
done

FAKE_BIN="$WORK_DIR/fake-bin"
mkdir -p "$FAKE_BIN"
for command_name in corepack pnpm npm; do
  printf '%s\n'     '#!/usr/bin/env bash'     'printf "%s\\n" "$0 $*" >> "$COMMAND_MARKER"'     'exit 99' > "$FAKE_BIN/$command_name"
  chmod +x "$FAKE_BIN/$command_name"
done

build_log="$(PATH="$FAKE_BIN:$PATH" build_bots 2>&1)"
[[ ! -e "$COMMAND_MARKER" ]] || {
  printf 'prebuilt bot mode invoked a package manager:\n' >&2
  sed -n '1,20p' "$COMMAND_MARKER" >&2
  exit 1
}
[[ "$build_log" == *"skipping dependency install and bot build"* ]] || {
  printf 'prebuilt bot mode did not report its build skip\n' >&2
  exit 1
}

SOURCE_DIR="$REPO_ROOT"
APP_DIR="$REPO_ROOT"
REPO_URL="https://github.com/ndee/sovereign-ai-node"
REF="main"
BOTS_REPO_URL="https://github.com/ndee/sovereign-ai-bots"
BOTS_REF="main"
PROVENANCE_FILE="$WORK_DIR/install-provenance.json"
SERVICE_USER="$(id -un)"
SERVICE_GROUP="$(id -gn)"
write_install_provenance
jq -e   --arg artifact "$(basename "$ARTIFACT")"   --arg sha256 "$artifact_sha"   '
    .botsRepoUrl == "release-artifact" and
    .botsRef == "v3.4.5" and
    .botsVersion == "3.4.5" and
    .botsCommitSha == "0123456789abcdef0123456789abcdef01234567" and
    .botsArtifact == $artifact and
    .botsArtifactSha256 == $sha256
  ' "$PROVENANCE_FILE" >/dev/null

# A changed archive must fail digest verification before replacing the working
# installation.
printf 'tampered\n' >> "$ARTIFACT"
if (sync_bots_source >/dev/null 2>&1); then
  printf 'tampered bot artifact unexpectedly passed verification\n' >&2
  exit 1
fi
[[ -f "$BOTS_DIR/dist/validate-catalog.js" ]] || {
  printf 'digest failure replaced the existing bot installation\n' >&2
  exit 1
}

# The legacy local-source path still strips build output exactly as before.
SOURCE_FIXTURE="$WORK_DIR/source-bots"
mkdir -p "$SOURCE_FIXTURE/dist" "$SOURCE_FIXTURE/node_modules"
printf '%s\n' '{"name":"sovereign-ai-bots"}' > "$SOURCE_FIXTURE/package.json"
printf 'keep\n' > "$SOURCE_FIXTURE/catalog.txt"
printf 'remove\n' > "$SOURCE_FIXTURE/dist/stale.js"
BOTS_ARTIFACT=""
BOTS_ARTIFACT_MANIFEST=""
BOTS_SOURCE_DIR="$SOURCE_FIXTURE"
BOTS_DIR="$WORK_DIR/source-installed-bots"
sync_bots_source
[[ -f "$BOTS_DIR/catalog.txt" ]]
[[ ! -e "$BOTS_DIR/dist" ]]
[[ ! -e "$BOTS_DIR/node_modules" ]]

printf 'Prebuilt Bots installer contract passed.\n'
