# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Commits follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).
From this point forward, GitHub Release notes are auto-generated from commit history
by the `.github/workflows/release.yml` workflow.

## [Unreleased]

## [2.3.5] - 2026-07-02

Patch hardening ARM (aarch64) relay-passthrough installs so they succeed without manual intervention.

- **Pin the passthrough Caddy image by digest and pull images before starting the stack.** v2.3.4 published the `sovereign-caddy-desec` image as multi-arch, but the image was still referenced by tag and the installer's `docker compose up` never re-pulls a cached tag — so an ARM node that had cached the old amd64-only image kept crash-looping the reverse-proxy (`exec format error`) and never obtained its TLS cert. `DEFAULT_CADDY_DESEC_IMAGE` is now pinned to the multi-arch index digest (a digest reference cannot be satisfied by a stale cached tag), and `ensureStackRunning` now runs a best-effort `docker compose pull` before `up` (non-fatal: an offline/registry hiccup never blocks a node that already has its images). ([#213](https://github.com/ndee/sovereign-ai-node/pull/213))

See the [v2.3.5 GitHub Release](https://github.com/ndee/sovereign-ai-node/releases/tag/v2.3.5) for the full commit list.

## [2.3.4] - 2026-07-01

Patch release fixing ARM (aarch64) relay-passthrough installs, Mail Sentinel's semantic reviewer, and managed Matrix bots crash-looping over E2EE on fresh installs.

- **Publish the passthrough Caddy image as a multi-arch manifest (add `linux/arm64`).** `ghcr.io/ndee/sovereign-caddy-desec` was published amd64-only, so on ARM nodes (e.g. Raspberry Pi) the reverse-proxy container crash-looped with `exec format error` — the passthrough node never obtained its own TLS cert and the install failed at smoke checks. CI now builds with QEMU + `platforms: linux/amd64,linux/arm64`. ([#211](https://github.com/ndee/sovereign-ai-node/pull/211))
- **Reach the lobster CLI as the service user and drop the reasoning-on default model.** Fixes Mail Sentinel's "semantic reviewer unavailable" (#208): the lobster CLI was installed under the wrong `HOME` (root's npm prefix, mode 0700) so the scan service running as the service user could not find it. The installer now resolves the configured service user's home via `getent passwd` and probes lobster by absolute path (no sudo delegation, which had broken under a cleaned sudo `PATH`). ([#209](https://github.com/ndee/sovereign-ai-node/pull/209), [#210](https://github.com/ndee/sovereign-ai-node/pull/210))
- **Make the Matrix crypto runtime dir writable for the service user.** On a fresh install the OpenClaw Matrix extension downloads its E2EE crypto runtime binary on demand at gateway startup into a root-owned package dir; the gateway runs as the service user and could not write there, so E2EE never bootstrapped and managed Matrix bots crash-looped (scanning IMAP but never replying in Matrix, while status still reported them healthy). ([#209](https://github.com/ndee/sovereign-ai-node/pull/209))

See the [v2.3.4 GitHub Release](https://github.com/ndee/sovereign-ai-node/releases/tag/v2.3.4) for the full commit list.

## [2.3.3] - 2026-06-26

Patch refining the relay-passthrough onboarding flow: the installers no longer reveal an onboarding URL/QR before the page is actually serving.

- **Gate the onboarding URL/QR reveal on page readiness.** Since the relay moved to TLS passthrough (deSEC DNS-01), a relay-passthrough node terminates its own HTTPS and its onboarding page is unreachable for the minutes its Let's Encrypt certificate takes to issue. Both installers previously revealed the onboarding URL/QR immediately on install success, handing operators a link/QR that did not load yet. A new readiness gate is now polled before the reveal: a single fast GET of the public onboarding URL (`getMatrixOnboardingReadiness()` → `{ ready, url, mode, status?, reason? }`, exposed as `GET /api/onboarding/ready` and the `sovereign-node onboarding ready [--wait]` subcommand), with per-mode TLS handling and a per-mode timeout that reveals-with-warning rather than blocking. The deadline grows as the real mode is learned, so an early config-not-found reading does not cap a relay-passthrough wait at the short default; the CLI exits 0 even on timeout so `set -e` install scripts never abort. ([#205](https://github.com/ndee/sovereign-ai-node/pull/205))

See the [v2.3.3 GitHub Release](https://github.com/ndee/sovereign-ai-node/releases/tag/v2.3.3) for the full commit list.

## [2.3.2] - 2026-06-25

Patch fixing a deSEC-token **trap** that could leave a node fail-closed while refreshing to TLS passthrough on upgrade.

- **Force a fresh deSEC token mint on the passthrough refresh.** When a legacy node refreshes to passthrough on upgrade, it now sends `rotateDns01: true`. This path only runs for a node that is still legacy (no `dns01` yet), so it has no deSEC token secret. Previously, if a prior refresh attempt minted a token (so the relay assignment carried a `desecTokenId`) but then failed downstream before the node persisted the secret (e.g. a bundled-Matrix `:8008` port conflict), every later refresh hit the relay's `needsMint=false` path and got the token id back **without** the secret — so the node could never obtain it and the enroll failed closed (`RELAY_ENROLL_INVALID`) on every retry. Sending `rotateDns01` makes the relay always re-mint and return the secret inline, breaking the trap. ([#203](https://github.com/ndee/sovereign-ai-node/pull/203))

## [2.3.1] - 2026-06-24

Patch enabling the TLS-passthrough **upgrade flip** for nodes that are already enrolled on a managed relay. Before this, an enrolled node stuck in legacy `http` mode (e.g. one enrolled before the relay gained passthrough support) could never move to passthrough through the installer: the enrollment step reused the persisted legacy assignment and never re-contacted the relay, and a forced fresh enroll would mint a new random slug, changing the node's public hostname.

- **Refresh an enrolled managed-relay node to TLS passthrough on upgrade.** When an upgrade finds an existing relay enrollment that is still legacy (`http`, no `dns01`), the installer re-contacts the relay with the node's **existing slug** plus `capabilities: ["tls-passthrough"]`, using a **stable `/etc/machine-id`-derived installation id** so the relay recognises the existing assignment and upgrades it in place. The relay only acts when it holds a deSEC owner token (the kill switch is unchanged); otherwise the node stays legacy. The refresh **fails closed** — it keeps the working legacy enrollment (never changing the public hostname, never breaking a working node) when the relay returns a different slug, returns `http`, or the request fails. Fresh installs, custom relays, already-passthrough nodes, and the deSEC kill switch are unaffected. ([#201](https://github.com/ndee/sovereign-ai-node/pull/201))

See the [v2.3.1 GitHub Release](https://github.com/ndee/sovereign-ai-node/releases/tag/v2.3.1) for the full commit list.

## [2.3.0] - 2026-06-24

Minor release introducing **node-side TLS passthrough**: a node can terminate its own TLS (Let's Encrypt via deSEC DNS-01) so the managed relay forwards only ciphertext and can no longer read node traffic. Passthrough stays dormant until the relay grants it (the relay's deSEC owner token is the kill switch); without it, nodes continue to enroll in legacy `http` mode where the relay terminates TLS. Mode is decided per node at enroll/re-enroll time, not by node version.

- **Node-side TLS passthrough.** When the relay returns a `dns01` block at enrollment, the node builds a Caddy image carrying the `caddy-dns/desec` plugin, obtains its own certificate via deSEC DNS-01, and registers a `type=https` SNI-passthrough proxy on the relay. The installer advertises `capabilities: ["tls-passthrough"]`; the relay only honors it when it holds a deSEC owner token. ([#194](https://github.com/ndee/sovereign-ai-node/pull/194))
- CI builds and publishes the `sovereign-caddy-desec` image (the passthrough Caddy build with the deSEC DNS-01 provider). ([#195](https://github.com/ndee/sovereign-ai-node/pull/195))
- Fix passthrough Caddy config: emit the **block form** of the deSEC `tls` directive (`tls { dns desec { token … } }`) and add DNS-01 `propagation_delay`/`propagation_timeout`/`resolvers`. The previous inline form was rejected by the caddy-dns/desec plugin (crash-looping config adaptation), and the missing propagation settings raced deSEC's TTL so the certificate never issued in the smoke window. ([#196](https://github.com/ndee/sovereign-ai-node/pull/196))
- Fix relay **re-enroll/upgrade** dropping the `dns01` block: an already-enrolled passthrough node no longer silently re-renders to a legacy plaintext `:80` site on re-install. The reuse path now preserves `dns01`, and the post-install probe fails **closed** on a passthrough→legacy downgrade instead of skipping. ([#197](https://github.com/ndee/sovereign-ai-node/pull/197))
- Document the relay TLS-passthrough vs. legacy-http enrollment story in `docs/INSTALLER_CONTRACTS.md`, and align the documented `InstallRequest.relay` schema with the real contract (`tunnel.type`, `relay.dns01`). Mode is gated by the relay's deSEC token and applied per node on enroll/re-enroll — node version does not gate the mode. ([#198](https://github.com/ndee/sovereign-ai-node/pull/198))
- Widen the passthrough install smoke-check window to account for DNS-01 propagation, so a node that correctly obtains its certificate after deSEC propagation no longer fails with a spurious `SMOKE_CHECKS_FAILED`. Fail-closed semantics are unchanged. ([#199](https://github.com/ndee/sovereign-ai-node/pull/199))

See the [v2.3.0 GitHub Release](https://github.com/ndee/sovereign-ai-node/releases/tag/v2.3.0) for the full commit list.

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
