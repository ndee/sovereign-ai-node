# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Commits follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).
From this point forward, GitHub Release notes are auto-generated from commit history
by the `.github/workflows/release.yml` workflow.

## [Unreleased]

## [2.1.0] - 2026-04-25

Installer refactor: `scripts/install.sh` is now a 207-line orchestrator that sources 13 topical libraries from `scripts/install/lib-*.sh` (down from a 3,883-line monolith). The release workflow concatenates the orchestrator + libraries via `scripts/install/build.sh` and uploads the bundled file as the GitHub Release asset.

**Breaking change for curl-pipe installs.** The README's install command now points at `https://github.com/ndee/sovereign-ai-node/releases/latest/download/install.sh`. The previous `https://raw.githubusercontent.com/ndee/sovereign-ai-node/main/scripts/install.sh` URL no longer works because the orchestrator on `main` cannot run via curl-pipe — it sources the libraries at runtime, and only one file is fetched. Any third-party scripts/automation pinned to the old URL must update.

Local-checkout installs (`sudo bash scripts/install.sh --source-dir "$(pwd)"`) continue to work unchanged.

See the [v2.1.0 GitHub Release](https://github.com/ndee/sovereign-ai-node/releases/tag/v2.1.0) for the full commit list.

## [2.0.0] - 2026-04-14

Bootstrap release formalizing the semantic versioning scheme for this project.
See the [v2.0.0 GitHub Release](https://github.com/ndee/sovereign-ai-node/releases/tag/v2.0.0)
for details.

[Unreleased]: https://github.com/ndee/sovereign-ai-node/compare/v2.1.0...HEAD
[2.1.0]: https://github.com/ndee/sovereign-ai-node/releases/tag/v2.1.0
[2.0.0]: https://github.com/ndee/sovereign-ai-node/releases/tag/v2.0.0
