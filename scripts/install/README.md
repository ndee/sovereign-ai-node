# Installer refactor — working directory

This directory scaffolds the split of `scripts/install.sh` (currently 3,883 lines,
127 shell functions) into a small orchestrator plus topical libraries. The
feature work that motivates the split — a zero-input curl installer with
DM-driven post-install configuration — lands in a follow-up PR.

## Scope of this PR

In:

- Baseline snapshot tooling (`baseline-snapshot.sh`, `verify-baseline.sh`) and
  committed baseline fixtures (`baseline/`) that the follow-up extraction PRs
  must keep byte-identical.
- A tiny sourceable guard in `scripts/install.sh` so the baseline tooling can
  call functions without triggering `main`. Single 3-line change, behaviour
  identical when invoked normally.
- This README and the design doc in `DESIGN.md`.

Out (deferred to follow-up PRs):

- Actual extraction of functions into `scripts/install/lib-*.sh`. One library
  per PR, each verified green by `verify-baseline.sh`.
- The `real-service.ts` module split (PR-2 in the refactor series).
- Every behaviour change discussed in the design doc (zero-input install,
  default-bot flip, OpenRouter key via DM, mail-sentinel chat setup, secret
  redaction CLI). These land in a feature PR on top of the merged refactor.

## Layout (target state once extractions land)

```
scripts/
├── install.sh                  # thin orchestrator (~250 lines): args, main, source-the-libs
└── install/
    ├── README.md               # this file
    ├── DESIGN.md               # approved plan (context + design decisions)
    ├── baseline-snapshot.sh    # capture behavioural baseline
    ├── verify-baseline.sh      # diff current vs committed baseline
    ├── baseline/               # committed reference output
    ├── build.sh                # concatenate libs → install.sh for release artefact (future)
    ├── lib-log.sh              # log, die, usage
    ├── lib-args.sh             # parse_args, normalize_service_identity
    ├── lib-os.sh               # OS detection, apt helpers
    ├── lib-runtime-deps.sh     # apt/docker/node bootstrap
    ├── lib-runtime-paths.sh    # service account, runtime dirs, source sync
    ├── lib-build.sh            # app build, systemd unit install
    ├── lib-ui.sh               # TUI primitives (progress, banner, log capture)
    ├── lib-prompt.sh           # choice menus, confirm, value/secret prompts
    ├── lib-bot-catalog.sh      # bot selection parsing
    ├── lib-request-file.sh     # request JSON IO and defaults migration
    ├── lib-matrix-urls.sh      # onboarding/element URL builders, QR
    ├── lib-wizard.sh           # interactive install wizard
    └── lib-runner.sh           # install runner, readiness wait, summarisation
```

## Release-artefact model

Today `install.sh` is served from `raw.githubusercontent.com/.../main/scripts/install.sh`.
After the refactor lands, the repo will no longer contain a monolithic
`scripts/install.sh`; the release workflow will concatenate libraries into an
`install.sh` artefact attached to the GitHub Release, and the README's curl
command will change to
`https://github.com/ndee/sovereign-ai-node/releases/latest/download/install.sh`.

Local-checkout installs (`sudo bash scripts/install.sh --source-dir "$(pwd)"`)
continue to work because a minimal `scripts/install.sh` wrapper sources the
libs directly when present in the tree.

## Verifying behaviour preservation

```
scripts/install/verify-baseline.sh
```

Runs `--help` and a matrix of `write_request_file_from_env` fixtures, diffs
against the committed baseline. Fails on any drift. Extraction PRs MUST keep
this green.

If a change is intentional (e.g. the feature PR adding zero-input synthesis),
regenerate the baseline:

```
scripts/install/baseline-snapshot.sh scripts/install/baseline
```

and include the baseline diff as part of the PR that changes behaviour.
