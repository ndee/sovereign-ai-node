# shellcheck shell=bash
# Validate and install an immutable sovereign-ai-bots npm-pack artifact.
#
# Depends on lib-log (log, die). Reads BOTS_ARTIFACT,
# BOTS_ARTIFACT_MANIFEST, and BOTS_DIR.

sync_prebuilt_bots_artifact() (
  local artifact_name expected_sha actual_sha expected_size actual_size
  local manifest_version manifest_tag manifest_commit snapshot_dir archive_list package_dir
  local artifact_copy manifest_copy
  local manifest_bot_count packaged_bot_count id bot_version template_version bot_manifest
  local compiled_entries expected_compiled_entries prohibited_entry
  local packaged_bot_dir_count staged_dir previous_dir archive_problem

  artifact_name="$(basename "$BOTS_ARTIFACT")"
  snapshot_dir="$(mktemp -d --tmpdir sovereign-bots-artifact.XXXXXX)"
  chmod 0700 "$snapshot_dir"
  staged_dir=""
  previous_dir=""
  trap '
    rm -rf "$snapshot_dir" "$staged_dir"
    if [[ -n "$previous_dir" && -e "$previous_dir" && ! -e "$BOTS_DIR" ]]; then
      mv -T "$previous_dir" "$BOTS_DIR" || true
    fi
  ' EXIT
  artifact_copy="${snapshot_dir}/artifact.tgz"
  manifest_copy="${snapshot_dir}/component-release.json"
  cp -- "$BOTS_ARTIFACT" "$artifact_copy" || die "Failed to snapshot bot artifact"
  cp -- "$BOTS_ARTIFACT_MANIFEST" "$manifest_copy" || die "Failed to snapshot bot artifact manifest"

  # The manifest is fetched alongside the immutable release asset. Validate its
  # shape and bind the selected artifact name to exactly one digest record.
  jq -e --arg artifact_name "$artifact_name" '
    keys == ["assets", "bots", "commitSha", "component", "schemaVersion", "tag", "version"] and
    .schemaVersion == 1 and
    .component == "sovereign-ai-bots" and
    (.version | type == "string" and test("^[0-9]+\\.[0-9]+\\.[0-9]+([+-][0-9A-Za-z.-]+)?$")) and
    .tag == ("v" + .version) and
    (.commitSha | type == "string" and test("^[0-9a-f]{40}$")) and
    (.assets | type == "array" and length == 1) and
    .assets[0].name == ("sovereign-ai-bots-" + .version + ".tgz") and
    ([.assets[] | select(.name == $artifact_name)] | length == 1) and
    (all(.assets[];
      (keys == ["name", "sha256", "size"]) and
      (.name | type == "string" and length > 0) and
      (.size | type == "number" and . > 0 and floor == .) and
      (.sha256 | type == "string" and test("^[0-9a-f]{64}$"))
    )) and
    (.bots | type == "array" and length > 0) and
    ([.bots[].id] | unique | length) == (.bots | length) and
    (all(.bots[];
      (keys == ["id", "manifestVersion", "templateVersion"]) and
      (.id | type == "string" and test("^[a-z0-9][a-z0-9-]*$")) and
      (.manifestVersion | type == "string" and length > 0) and
      (.templateVersion | type == "string" and length > 0)
    ))
  ' "$manifest_copy" >/dev/null ||
    die "Invalid sovereign-ai-bots component release manifest: $BOTS_ARTIFACT_MANIFEST"

  expected_sha="$(jq -er --arg artifact_name "$artifact_name"     '.assets[] | select(.name == $artifact_name) | .sha256' "$manifest_copy")"
  expected_size="$(jq -er --arg artifact_name "$artifact_name"     '.assets[] | select(.name == $artifact_name) | .size' "$manifest_copy")"
  actual_sha="$(sha256sum "$artifact_copy" | awk '{print $1}')"
  actual_size="$(stat -c '%s' "$artifact_copy")"

  [[ "$actual_sha" == "$expected_sha" ]] ||
    die "Bot artifact digest mismatch for ${artifact_name}: expected ${expected_sha}, got ${actual_sha}"
  [[ "$actual_size" == "$expected_size" ]] ||
    die "Bot artifact size mismatch for ${artifact_name}: expected ${expected_size}, got ${actual_size}"

  # Inspect paths and entry types before extraction. npm pack archives have a
  # single package/ root. Reject links and special files so an archive cannot
  # escape the staging directory through a symlink even when its paths look safe.
  archive_list="${snapshot_dir}/archive.list"
  tar -tzf "$artifact_copy" > "$archive_list" ||
    die "Bot artifact is not a readable .tgz: $BOTS_ARTIFACT"
  [[ -s "$archive_list" ]] || die "Bot artifact is empty: $BOTS_ARTIFACT"
  archive_problem="$(awk '
    {
      original = $0
      path = original
      sub(/\/$/, "", path)
      count = split(path, parts, "/")
      if (count < 1 || parts[1] != "package") {
        print "unsafe:" original
        exit
      }
      canonical = ""
      for (segment_index = 1; segment_index <= count; segment_index++) {
        if (parts[segment_index] == "" || parts[segment_index] == "." || parts[segment_index] == "..") {
          print "unsafe:" original
          exit
        }
        canonical = canonical (segment_index == 1 ? "" : "/") parts[segment_index]
      }
      if (seen[canonical]++) {
        print "duplicate:" original
        exit
      }
    }
  ' "$archive_list")"
  [[ -z "$archive_problem" ]] ||
    die "Bot artifact contains an unsafe or normalized-duplicate path: $archive_problem"

  tar -tvzf "$artifact_copy" | awk '
    substr($1, 1, 1) != "-" && substr($1, 1, 1) != "d" { exit 1 }
  ' || die "Bot artifact contains a link or special file"

  tar --no-same-owner --no-same-permissions -xzf "$artifact_copy" -C "$snapshot_dir"
  package_dir="${snapshot_dir}/package"

  manifest_version="$(jq -r '.version' "$manifest_copy")"
  manifest_tag="$(jq -r '.tag' "$manifest_copy")"
  manifest_commit="$(jq -r '.commitSha' "$manifest_copy")"
  [[ "$(jq -r '.name // ""' "${package_dir}/package.json" 2>/dev/null)" == "sovereign-ai-bots" ]] ||
    die "Bot artifact package.json is missing or has the wrong package name"
  [[ "$(jq -r '.version // ""' "${package_dir}/package.json")" == "$manifest_version" ]] ||
    die "Bot artifact package version does not match component-release.json"
  [[ -f "${package_dir}/pnpm-lock.yaml" ]] || die "Bot artifact is missing pnpm-lock.yaml"
  [[ -f "${package_dir}/dist/validate-catalog.js" ]] ||
    die "Bot artifact is missing dist/validate-catalog.js"
  [[ -f "${package_dir}/dist/probe-mail-sentinel-chat-model.js" ]] ||
    die "Bot artifact is missing dist/probe-mail-sentinel-chat-model.js"
  [[ -d "${package_dir}/bots" ]] || die "Bot artifact is missing the bots directory"

  manifest_bot_count="$(jq '.bots | length' "$manifest_copy")"
  packaged_bot_dir_count="$(find "${package_dir}/bots" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d '[:space:]')"
  [[ "$packaged_bot_dir_count" == "$manifest_bot_count" ]] ||
    die "Bot artifact directory count (${packaged_bot_dir_count}) does not match component-release.json (${manifest_bot_count})"
  packaged_bot_count="$(find "${package_dir}/bots" -mindepth 2 -maxdepth 2 -type f     -name sovereign-bot.json | wc -l | tr -d '[:space:]')"
  [[ "$packaged_bot_count" == "$manifest_bot_count" ]] ||
    die "Bot artifact manifest count (${packaged_bot_count}) does not match component-release.json (${manifest_bot_count})"

  while IFS=$'\t' read -r id bot_version template_version; do
    bot_manifest="${package_dir}/bots/${id}/sovereign-bot.json"
    [[ -f "$bot_manifest" ]] || die "Bot artifact is missing manifest for $id"
    [[ "$(jq -r '.id // ""' "$bot_manifest")" == "$id" ]] ||
      die "Bot artifact manifest id does not match its path: $id"
    [[ "$(jq -r '.version // ""' "$bot_manifest")" == "$bot_version" ]] ||
      die "Bot artifact manifest version mismatch for $id"
    [[ "$(jq -r '.agentTemplate.version // ""' "$bot_manifest")" == "$template_version" ]] ||
      die "Bot artifact template version mismatch for $id"
    [[ -n "$(find "${package_dir}/bots/${id}/workspace" -type f -name '*.md' -print -quit 2>/dev/null)" ]] ||
      die "Bot artifact is missing the workspace Markdown payload for $id"
  done < <(jq -r '.bots[] | [.id, .manifestVersion, .templateVersion] | @tsv' "$manifest_copy")

  # These catalog entries currently require avatars. Additional regular avatar
  # files are forward-compatible and remain protected by the archive digest.
  [[ -f "${package_dir}/bots/mail-sentinel/avatar.png" ]] ||
    die "Bot artifact is missing mail-sentinel/avatar.png"
  [[ -f "${package_dir}/bots/node-operator/avatar.png" ]] ||
    die "Bot artifact is missing node-operator/avatar.png"

  expected_compiled_entries=$'mail-sentinel/workspace/bin/dist/mail-sentinel.js\nproject-sentinel/workspace/bin/dist/project-sentinel.js\nreality-alignment/workspace/bin/dist/reality-alignment.js'
  compiled_entries="$(
    find "${package_dir}/bots" -type f -path '*/workspace/bin/dist/*.js' -printf '%P\n' |
      LC_ALL=C sort
  )"
  [[ "$compiled_entries" == "$expected_compiled_entries" ]] ||
    die "Bot artifact compiled entrypoints do not match the required catalog contract"

  prohibited_entry="$(find "$package_dir" \
    \( -path '*/.git/*' -o -path '*/.github/*' -o -path '*/.agent-deck/*' \
       -o -path '*/__fixtures__/*' -o -path '*/src/*' -o -path '*/node_modules/*' \
       -o -name '*.test.*' -o -name '*.spec.*' -o -name '*.log' -o -name '*.map' \
    \) -print -quit)"
  [[ -z "$prohibited_entry" ]] ||
    die "Bot artifact contains prohibited development content: ${prohibited_entry#$package_dir/}"

  staged_dir="${BOTS_DIR}.staged.$$"
  previous_dir="${BOTS_DIR}.previous.$$"
  [[ ! -e "$staged_dir" && ! -e "$previous_dir" ]] ||
    die "Bot artifact staging path already exists"
  install -d -m 0755 "$staged_dir"
  cp -a "${package_dir}/." "$staged_dir/" ||
    die "Failed to stage bot artifact"
  if [[ -e "$BOTS_DIR" ]]; then
    mv -T "$BOTS_DIR" "$previous_dir" ||
      die "Failed to preserve the existing bot catalog"
  else
    previous_dir=""
  fi
  if ! mv -T "$staged_dir" "$BOTS_DIR"; then
    [[ -z "$previous_dir" ]] || mv -T "$previous_dir" "$BOTS_DIR" || true
    die "Failed to activate the staged bot catalog"
  fi
  staged_dir=""
  if [[ -n "$previous_dir" ]]; then
    rm -rf "$previous_dir"
    previous_dir=""
  fi
  log "Verified prebuilt bot catalog ${manifest_tag} (${manifest_commit}) and installed $artifact_name"
)
