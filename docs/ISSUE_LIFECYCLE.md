# Issue lifecycle

This repo tracks work as GitHub issues that move through a fixed set of stages.
A small set of `lifecycle:` labels is the **state machine** for that progression.
Automation keeps the labels honest; humans own the decision points.

## Stages

```
discovery → elaboration → dev → testing → done
```

- **discovery** — an idea/need is captured as an issue.
- **elaboration** — the solution is worked out (goal, acceptance criteria, design).
- **dev** — the change is implemented; a draft PR is opened referencing the issue.
- **testing** — the merged change is exercised by end-to-end tests (authored, run,
  and recorded with screenshots/video), then reviewed.
- **done** — a human has verified it and closes the issue.

## Labels (the state machine)

| Label | Stage | Who sets it | Meaning |
|---|---|---|---|
| `lifecycle:elaboration` | elaboration | human | Being elaborated; not yet ready to build. |
| `lifecycle:elaboration-complete` | ready for dev | **human** | Elaboration done; ready to implement. |
| `lifecycle:dev` | dev | maintainer/automation | Implementation in progress; a draft PR is open. |
| `lifecycle:testing` | testing | **automation** (on PR merge) | Merged; under active e2e testing. |
| `lifecycle:testing-completed` | done-pending | **human** | Testing verified; ready to close. |

An issue should carry **at most one** `lifecycle:` label at a time.

## Rules

- **Reference issues with `Refs #N` or `Part of #N` in PRs — never `Closes`/`Fixes`/
  `Resolves`.** The issue must stay **open** through testing; closing keywords would
  auto-close it on merge.
- **`lifecycle:testing` is applied automatically** when a PR referencing the issue is
  merged — don't set it by hand. It means "there is integrated code; e2e tests should be
  authored, executed, and recorded." It requires a **merged linked PR**.
- **Only a human** applies `lifecycle:elaboration-complete` and
  `lifecycle:testing-completed`, and **only a human closes** issues.
- A **guard workflow** repairs illegal label combinations (e.g. two stage labels at once,
  `lifecycle:testing` with no merged PR, `lifecycle:testing-completed` without
  `lifecycle:testing`) and comments explaining what it changed.

## Visual pipeline

A cross-repo board mirrors these stages as columns:
**Sovereign AI — Issue Lifecycle** (GitHub Projects, owner `ndee`).

## Automation reference

| File | What it does |
|---|---|
| `.github/labels.yml` | Canonical definition of the five `lifecycle:` labels. |
| `.github/workflows/sync-labels.yml` | Creates/updates those labels (non-destructive) on change. |
| `.github/workflows/keep-issue-open-until-tested.yml` | On PR merge: reopens the referenced issue if auto-closed and applies `lifecycle:testing`. |
| `.github/workflows/lifecycle-guard.yml` | Self-heals illegal `lifecycle:` label states and comments. |
