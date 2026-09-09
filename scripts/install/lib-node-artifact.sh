# shellcheck shell=bash
# Validate and install an immutable sovereign-ai-node npm-pack artifact.
#
# Depends on lib-log (log, die). Reads NODE_ARTIFACT,
# NODE_ARTIFACT_MANIFEST, and APP_DIR.

sync_prebuilt_node_artifact() (
  local artifact_name expected_name expected_sha actual_sha expected_size actual_size
  local manifest_version manifest_tag manifest_commit snapshot_dir archive_list package_dir
  local artifact_copy manifest_copy staged_dir previous_dir archive_problem prohibited_entry

  artifact_name="$(basename "$NODE_ARTIFACT")"
  snapshot_dir="$(mktemp -d --tmpdir sovereign-node-artifact.XXXXXX)"
  chmod 0700 "$snapshot_dir"
  staged_dir=""
  previous_dir=""
  trap '
    rm -rf "$snapshot_dir" "$staged_dir"
    if [[ -n "$previous_dir" && -e "$previous_dir" && ! -e "$APP_DIR" ]]; then
      mv -T "$previous_dir" "$APP_DIR" || true
    fi
  ' EXIT
  artifact_copy="${snapshot_dir}/artifact.tgz"
  manifest_copy="${snapshot_dir}/component-release.json"
  cp -- "$NODE_ARTIFACT" "$artifact_copy" || die "Failed to snapshot Node artifact"
  cp -- "$NODE_ARTIFACT_MANIFEST" "$manifest_copy" || die "Failed to snapshot Node artifact manifest"

  # Validate the complete component-release schema before trusting any field,
  # then bind the selected archive basename to its one exact digest record.
  jq -e --arg artifact_name "$artifact_name" '
    keys == ["assets", "commitSha", "component", "schemaVersion", "tag", "version"] and
    .schemaVersion == 1 and
    .component == "sovereign-ai-node" and
    (.version | type == "string" and test("^[0-9]+\\.[0-9]+\\.[0-9]+([+-][0-9A-Za-z.-]+)?$")) and
    .tag == ("v" + .version) and
    (.commitSha | type == "string" and test("^[0-9a-f]{40}$")) and
    (.assets | type == "array" and length == 2) and
    ([.assets[].name] | sort) == (["install.sh", ("sovereign-ai-node-" + .version + ".tgz")] | sort) and
    ([.assets[] | select(.name == $artifact_name)] | length == 1) and
    (all(.assets[];
      (keys == ["name", "sha256", "size"]) and
      (.name | type == "string" and length > 0) and
      (.size | type == "number" and . > 0 and floor == .) and
      (.sha256 | type == "string" and test("^[0-9a-f]{64}$"))
    ))
  ' "$manifest_copy" >/dev/null ||
    die "Invalid sovereign-ai-node component release manifest: $NODE_ARTIFACT_MANIFEST"

  manifest_version="$(jq -r '.version' "$manifest_copy")"
  manifest_tag="$(jq -r '.tag' "$manifest_copy")"
  manifest_commit="$(jq -r '.commitSha' "$manifest_copy")"
  expected_name="sovereign-ai-node-${manifest_version}.tgz"
  [[ "$artifact_name" == "$expected_name" ]] ||
    die "Node artifact filename does not match component-release.json: expected ${expected_name}, got ${artifact_name}"

  expected_sha="$(jq -er --arg artifact_name "$artifact_name" \
    '.assets[] | select(.name == $artifact_name) | .sha256' "$manifest_copy")"
  expected_size="$(jq -er --arg artifact_name "$artifact_name" \
    '.assets[] | select(.name == $artifact_name) | .size' "$manifest_copy")"
  actual_sha="$(sha256sum "$artifact_copy" | awk '{print $1}')"
  actual_size="$(stat -c '%s' "$artifact_copy")"

  [[ "$actual_sha" == "$expected_sha" ]] ||
    die "Node artifact digest mismatch for ${artifact_name}: expected ${expected_sha}, got ${actual_sha}"
  [[ "$actual_size" == "$expected_size" ]] ||
    die "Node artifact size mismatch for ${artifact_name}: expected ${expected_size}, got ${actual_size}"

  # npm pack archives have one package/ root. Reject traversal, ambiguous
  # normalized duplicates, links, devices, fifos, and every other special type
  # before extracting anything.
  archive_list="${snapshot_dir}/archive.list"
  tar -tzf "$artifact_copy" > "$archive_list" ||
    die "Node artifact is not a readable .tgz: $NODE_ARTIFACT"
  [[ -s "$archive_list" ]] || die "Node artifact is empty: $NODE_ARTIFACT"
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
    die "Node artifact contains an unsafe or normalized-duplicate path: $archive_problem"

  tar -tvzf "$artifact_copy" | awk '
    substr($1, 1, 1) != "-" && substr($1, 1, 1) != "d" { exit 1 }
  ' || die "Node artifact contains a link or special file"

  tar --no-same-owner --no-same-permissions -xzf "$artifact_copy" -C "$snapshot_dir"
  package_dir="${snapshot_dir}/package"

  [[ "$(jq -r '.name // ""' "${package_dir}/package.json" 2>/dev/null)" == "sovereign-ai-node" ]] ||
    die "Node artifact package.json is missing or has the wrong package name"
  [[ "$(jq -r '.version // ""' "${package_dir}/package.json")" == "$manifest_version" ]] ||
    die "Node artifact package version does not match component-release.json"
  jq -e '
    .bin == {
      "sovereign-node": "./dist/sovereign-node.js",
      "sovereign-node-api": "./dist/sovereign-node-api.js",
      "sovereign-tool": "./dist/sovereign-tool.js"
    } and
    (.packageManager | type == "string" and test("^pnpm@[0-9]+\\.[0-9]+\\.[0-9]+$")) and
    (.dependencies | type == "object" and length > 0)
  ' "${package_dir}/package.json" >/dev/null ||
    die "Node artifact package.json does not match the runtime contract"

  for required in \
    deploy/runtime/pnpm-lock.yaml \
    dist/sovereign-node.js \
    dist/sovereign-node-api.js \
    dist/sovereign-node-onboarding-api.js \
    dist/sovereign-tool.js \
    dist/lib/index.js \
    public/setup-ui/index.html \
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
    scripts/install/lib-runtime-deps.sh; do
    [[ -f "${package_dir}/${required}" ]] ||
      die "Node artifact is missing required runtime payload: $required"
  done

  for entrypoint in \
    dist/sovereign-node.js \
    dist/sovereign-node-api.js \
    dist/sovereign-node-onboarding-api.js \
    dist/sovereign-tool.js; do
    [[ -x "${package_dir}/${entrypoint}" ]] || die "Node artifact entrypoint is not executable: $entrypoint"
    [[ "$(head -n 1 "${package_dir}/${entrypoint}")" == '#!/usr/bin/env node' ]] ||
      die "Node artifact entrypoint has an unexpected shebang: $entrypoint"
  done

  prohibited_entry="$(find "$package_dir" \
    \( -path '*/.git/*' -o -path '*/.github/*' -o -path '*/.agent-deck/*' -o -path '*/.claude/*' \
       -o -path '*/node_modules/*' -o -path '*/src/*' -o -path '*/test/*' -o -path '*/tests/*' \
       -o -name '*.test.*' -o -name '*.spec.*' -o -name '*.log' -o -name '*.map' \
    \) -print -quit)"
  [[ -z "$prohibited_entry" ]] ||
    die "Node artifact contains prohibited development content: ${prohibited_entry#$package_dir/}"

  staged_dir="${APP_DIR}.staged.$$"
  previous_dir="${APP_DIR}.previous.$$"
  [[ ! -e "$staged_dir" && ! -e "$previous_dir" ]] ||
    die "Node artifact staging path already exists"
  install -d -m 0755 "$staged_dir"
  cp -a "${package_dir}/." "$staged_dir/" || die "Failed to stage Node artifact"
  cp "$staged_dir/deploy/runtime/pnpm-lock.yaml" "$staged_dir/pnpm-lock.yaml" ||
    die "Failed to stage the Node runtime lockfile"

  # The archive contains compiled output and its lockfile. Install only the
  # locked production graph, with lifecycle scripts disabled so this path can
  # never compile sources (including the package's own prepare script).
  (
    cd "$staged_dir"
    if command -v corepack >/dev/null 2>&1; then
      corepack pnpm install --prod --frozen-lockfile --ignore-scripts
    elif command -v pnpm >/dev/null 2>&1; then
      pnpm install --prod --frozen-lockfile --ignore-scripts
    else
      die "Prebuilt Node artifact requires corepack or pnpm for its frozen production dependency install"
    fi
  ) || die "Failed to install the prebuilt Node runtime's locked production dependencies"

  if [[ -e "$APP_DIR" ]]; then
    mv -T "$APP_DIR" "$previous_dir" || die "Failed to preserve the existing Node runtime"
  else
    previous_dir=""
  fi
  if ! mv -T "$staged_dir" "$APP_DIR"; then
    [[ -z "$previous_dir" ]] || mv -T "$previous_dir" "$APP_DIR" || true
    die "Failed to activate the staged Node runtime"
  fi
  staged_dir=""
  if [[ -n "$previous_dir" ]]; then
    rm -rf "$previous_dir"
    previous_dir=""
  fi
  log "Verified prebuilt Node runtime ${manifest_tag} (${manifest_commit}) and installed $artifact_name"
)
