# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Commits follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).
From this point forward, GitHub Release notes are auto-generated from commit history
by the `.github/workflows/release.yml` workflow.

## [Unreleased]

- Document the relay TLS-passthrough vs. legacy-http enrollment story in `docs/INSTALLER_CONTRACTS.md`, and bring the documented `InstallRequest.relay` schema in line with the real contract (`tunnel.type`, `relay.dns01`). The relay tunnel mode is decided by the relay at enrollment time, not by the node version: the installer advertises `capabilities: ["tls-passthrough"]`, but the relay only grants passthrough when it has a deSEC owner token; otherwise the node enrolls in legacy http. The kill switch for passthrough is therefore the relay's deSEC token, and mode changes apply per node on its next enroll/re-enroll — an already-installed node does not flip mode just because a newer node version exists. This corrects any impression that "existing/older nodes are legacy until re-installed": node version does not gate the mode.

## [2.2.3] - 2026-06-12

Patch fixing a relay-mode install failure where the managed relay tunnel never starts.

- Fix relay-mode `SMOKE_CHECKS_FAILED` ("Managed relay tunnel service is not running"): the runtime API service runs unprivileged, but the relay tunnel installer wrote its systemd unit to root-owned `/etc/systemd/system/` with a plain write and ran `systemctl` directly — so the write failed with `EACCES`, the error was swallowed, and the install only failed later at smoke checks with a misleading message. The relay path now reuses the gateway installer's privileged pattern (`sudo -n tee` on `EACCES`/`EPERM`, `sudo -n systemctl` on polkit interactive-auth), honors `SOVEREIGN_NODE_SYSTEMD_UNIT_DIR`, and surfaces a failed install at the `openclaw_configure` step as `RELAY_TUNNEL_INSTALL_FAILED` instead of as a vague smoke-check failure. ([#191](https://github.com/ndee/sovereign-ai-node/pull/191))

See the [v2.2.3 GitHub Release](https://github.com/ndee/sovereign-ai-node/releases/tag/v2.2.3) for the full commit list.

## [2.2.2] - 2026-06-04

Patch fixing a bundled-Matrix install failure on hosts with leftover containers from prior install attempts.

- Fix [#179](https://github.com/ndee/sovereign-ai-node/issues/179): when a different compose project's Synapse already owns `127.0.0.1:8008`, the install no longer silently bootstraps against the wrong homeserver (which surfaced as `MATRIX_LOGIN_FAILED` / 500 `M_UNKNOWN` at `matrix_bootstrap_accounts`). The installer now validates actual container state after `docker compose up` (instead of trusting its exit code), detects the cross-project port conflict — including when the failure is only in the container's `.State.Error` after a `compose up` that exited 0 — and fails fast with an actionable `BUNDLED_MATRIX_PORT_CONFLICT` naming the conflicting container/project. It also verifies the responding Synapse's `server_name` matches the provisioned homeserver before bootstrapping (`MATRIX_FOREIGN_SYNAPSE_ON_PORT`).

See the [v2.2.2 GitHub Release](https://github.com/ndee/sovereign-ai-node/releases/tag/v2.2.2) for the full commit list.

## [2.2.1] - 2026-05-11

Patch on top of v2.2.0 so downstream consumers can install this package directly from GitHub.

- Add a `prepare` script that runs `npm run build` when `dist/lib/` is missing, so `npm install github:ndee/sovereign-ai-node#vX.Y.Z` produces a fully built tree (the GitHub Release tarball ships sources only). Local checkouts with an existing `dist/` are skipped to avoid redundant rebuilds.

See the [v2.2.1 GitHub Release](https://github.com/ndee/sovereign-ai-node/releases/tag/v2.2.1) for the full commit list.

## [2.2.0] - 2026-05-11

Library-friendly distribution: the package now exposes its installer pipeline, API server building blocks, and supporting helpers as importable entry-points so downstream consumers can build on top of this codebase without reaching into deep internal paths.

- Build splits into binaries (flat under `dist/`) and library modules (under `dist/lib/`) via a new `tsup.config.ts`.
- `package.json` declares `files` and `exports` for `./installer`, `./api`, `./app`, `./system`, `./contracts`, plus passthrough access to `./public/setup-ui/*` wizard assets.
- Thin re-export barrels live under `src/lib/`. No runtime behavior changes; CLI/API binary paths are preserved.

See the [v2.2.0 GitHub Release](https://github.com/ndee/sovereign-ai-node/releases/tag/v2.2.0) for the full commit list.

## [2.1.0] - 2026-04-25

Installer refactor: `scripts/install.sh` is now a 207-line orchestrator that sources 13 topical libraries from `scripts/install/lib-*.sh` (down from a 3,883-line monolith). The release workflow concatenates the orchestrator + libraries via `scripts/install/build.sh` and uploads the bundled file as the GitHub Release asset.

**Breaking change for curl-pipe installs.** The README's install command now points at `https://github.com/ndee/sovereign-ai-node/releases/latest/download/install.sh`. The previous `https://raw.githubusercontent.com/ndee/sovereign-ai-node/main/scripts/install.sh` URL no longer works because the orchestrator on `main` cannot run via curl-pipe — it sources the libraries at runtime, and only one file is fetched. Any third-party scripts/automation pinned to the old URL must update.

Local-checkout installs (`sudo bash scripts/install.sh --source-dir "$(pwd)"`) continue to work unchanged.

See the [v2.1.0 GitHub Release](https://github.com/ndee/sovereign-ai-node/releases/tag/v2.1.0) for the full commit list.

## [2.0.0] - 2026-04-14

Bootstrap release formalizing the semantic versioning scheme for this project.
See the [v2.0.0 GitHub Release](https://github.com/ndee/sovereign-ai-node/releases/tag/v2.0.0)
for details.

[Unreleased]: https://github.com/ndee/sovereign-ai-node/compare/v2.2.1...HEAD
[2.2.1]: https://github.com/ndee/sovereign-ai-node/releases/tag/v2.2.1
[2.2.0]: https://github.com/ndee/sovereign-ai-node/releases/tag/v2.2.0
[2.1.0]: https://github.com/ndee/sovereign-ai-node/releases/tag/v2.1.0
[2.0.0]: https://github.com/ndee/sovereign-ai-node/releases/tag/v2.0.0
