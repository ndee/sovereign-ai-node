#!/usr/bin/env bash
# Build the exact assets attached to an immutable sovereign-ai-node release.

set -euo pipefail

if [[ $# -lt 1 || $# -gt 3 ]]; then
  printf 'usage: %s <output-dir> [tag] [commit-sha]\n' "$0" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="$1"
VERSION="$(node -p "require('${REPO_ROOT}/package.json').version")"
TAG="${2:-v$VERSION}"
COMMIT_SHA="${3:-$(git -C "$REPO_ROOT" rev-parse HEAD)}"
ARCHIVE_NAME="sovereign-ai-node-${VERSION}.tgz"
ARCHIVE_PATH="${OUT_DIR}/${ARCHIVE_NAME}"
INSTALLER_PATH="${OUT_DIR}/install.sh"
MANIFEST_PATH="${OUT_DIR}/component-release.json"

[[ "$TAG" == "v$VERSION" ]] || {
  printf 'tag %s does not match package version %s\n' "$TAG" "$VERSION" >&2
  exit 1
}
[[ "$COMMIT_SHA" =~ ^[0-9a-f]{40}$ ]] || {
  printf 'invalid release commit SHA: %s\n' "$COMMIT_SHA" >&2
  exit 1
}

install -d -m 0755 "$OUT_DIR"
rm -f "$ARCHIVE_PATH" "$INSTALLER_PATH" "$MANIFEST_PATH"

(
  cd "$REPO_ROOT"
  SOURCE_COMMIT="$COMMIT_SHA" pnpm run build
  packed_name="$(npm pack --pack-destination "$OUT_DIR" --silent)"
  [[ "$packed_name" == "$ARCHIVE_NAME" ]] || {
    printf 'npm pack produced %s; expected %s\n' "$packed_name" "$ARCHIVE_NAME" >&2
    exit 1
  }
)

bash "$REPO_ROOT/scripts/install/build.sh" "$INSTALLER_PATH"
node "$REPO_ROOT/scripts/release/create-component-release.mjs"   "$MANIFEST_PATH"   sovereign-ai-node   "$VERSION"   "$TAG"   "$COMMIT_SHA"   "$ARCHIVE_PATH"   "$INSTALLER_PATH"

printf 'Release assets written to %s\n' "$OUT_DIR"
