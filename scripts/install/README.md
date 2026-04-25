# Installer

The Sovereign Node installer is split into a thin orchestrator (`scripts/install.sh`) and topical libraries under `scripts/install/lib-*.sh` that the orchestrator sources at runtime.

## Layout

```
scripts/
├── install.sh                  # orchestrator (~210 lines): globals, source-the-libs, main()
└── install/
    ├── README.md               # this file
    ├── DESIGN.md               # design rationale for the split
    ├── build.sh                # concatenate libs → standalone install.sh for release artefact
    ├── baseline-snapshot.sh    # capture behavioural baseline
    ├── verify-baseline.sh      # diff current vs committed baseline
    ├── baseline/               # committed reference output (--help + request-file fixtures)
    ├── lib-log.sh              # log, die, usage
    ├── lib-args.sh             # parse_args, normalize_service_identity
    ├── lib-os.sh               # OS detection, apt helpers
    ├── lib-runtime-deps.sh     # apt/docker/node bootstrap
    ├── lib-runtime-paths.sh    # service account, runtime dirs, source sync, provenance
    ├── lib-build.sh            # app/bot package build, systemd unit, CLI wrappers, hygiene
    ├── lib-ui.sh               # TUI primitives (progress, banner, log capture)
    ├── lib-prompt.sh           # choice menus, confirm, value/secret prompts
    ├── lib-bot-catalog.sh      # bot catalog loading and selection prompts
    ├── lib-matrix-urls.sh      # onboarding/element URL builders, QR, post-install guidance
    ├── lib-request-file.sh     # request JSON IO, defaults migration, secret writing
    ├── lib-wizard.sh           # resolve_action, interactive install wizard, prepare_request_file
    └── lib-runner.sh           # install runner, readiness wait, output summarisation
```

## Install paths

**Released installer (curl-pipe).** Each tagged release has a `dist/install.sh` asset built from the orchestrator + libraries by `scripts/install/build.sh`. Users install with:

```bash
curl -fsSL https://github.com/ndee/sovereign-ai-node/releases/latest/download/install.sh | sudo bash
```

To pin a specific version, replace `latest` with the tag (e.g. `v1.2.3`).

The previous `raw.githubusercontent.com/.../main/scripts/install.sh` URL no longer works because the orchestrator on `main` cannot run via curl-pipe — it sources the lib files at runtime, and the curl pipe only fetches one file. This is documented as a deliberate breaking change in the release notes.

**Local checkout.** Run the orchestrator directly; it finds `scripts/install/lib-*.sh` next to itself:

```bash
sudo bash scripts/install.sh --source-dir "$(pwd)"
```

CI exercises this path on every PR (`.github/workflows/ci.yml` E2E install jobs).

**Building the bundle locally.** To verify the release artefact looks right, or to test changes without cutting a release:

```bash
scripts/install/build.sh /tmp/install.sh
sudo bash /tmp/install.sh --source-dir "$(pwd)"
```

`build.sh` validates the bundled output (syntactically valid bash, no leftover `source` statements) before writing.

## Verifying behaviour preservation

```
scripts/install/verify-baseline.sh
```

Drives `install.sh --help` and `write_request_file_from_env` against four fixtures (fresh direct, mail-sentinel + IMAP, LAN-only, relay) and diffs against `scripts/install/baseline/`. Fails on any drift. Any PR touching the installer must keep this green.

If a change is intentional, regenerate the baseline:

```
scripts/install/baseline-snapshot.sh scripts/install/baseline
```

and include the baseline diff in the PR.
