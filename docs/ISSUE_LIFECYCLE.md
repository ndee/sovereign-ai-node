# Issue lifecycle

This repo tracks work as GitHub issues that move through a fixed set of stages.
A small set of `lifecycle:` labels is the **state machine** for that progression.
Conductor agents drive most transitions, automation keeps the labels honest, and
humans own the decision points: approving a plan, merging a PR, and approving a ship.

## Stages

```
(new) → analysis → elaboration → ready → implementing → merged → released
```

- **new** — an idea/need is captured as an issue. No label yet.
- **analysis** — *optional*, for issues that pose a question rather than a solution: the root
  cause is determined from evidence (logs, diagnostics, a reproduction) and the finding is
  posted on the issue.
- **elaboration** — the solution is worked out into a plan (goal, acceptance criteria, design).
- **ready** — a human has **approved the plan**; the issue is ready to implement.
- **implementing** — an open PR says `Refs #N`. There is no label for this stage: the open,
  referencing PR *is* the signal.
- **merged** — the PR has been merged by a human; the change is integrated and waits for a
  release.
- **released** — a human has approved the ship and the release automation has published it.
  The release automation **closes** the issue with a `Shipped in <version>` comment.

## Labels (the state machine)

| Label | Stage | Who sets it | Meaning |
|---|---|---|---|
| `lifecycle:analysis` | analysis | conductor agent / human | Root cause being determined from evidence; not yet designed. |
| `lifecycle:elaboration` | elaboration | conductor agent / human | Solution being elaborated into a plan; not yet approved. |
| `lifecycle:ready` | ready | **human** (plan approval) | Plan approved; ready to implement. |
| *(none)* | implementing | — | An open PR says `Refs #N`. |
| `lifecycle:merged` | merged | **automation** (on PR merge) | Merged, awaiting a release. Requires a merged PR referencing the issue. |
| *(issue closed)* | released | **release automation** (after ship approval) | Shipped; closed with a `Shipped in <version>` comment. |

An issue carries **at most one** `lifecycle:` label at a time. When implementation starts,
the `lifecycle:ready` label is removed; when the PR merges, automation applies
`lifecycle:merged`.

Retired labels (no longer part of the lifecycle): `lifecycle:dev`, `lifecycle:testing`,
`lifecycle:testing-completed`. `lifecycle:elaboration-complete` was renamed to
`lifecycle:ready`, and `lifecycle:testing` is superseded by `lifecycle:merged`.

## Rules

- **Reference issues with `Refs #N` or `Part of #N` in PRs — never `Closes`/`Fixes`/
  `Resolves`.** Issues close when the change **ships in a release**, not when the PR merges;
  closing keywords would auto-close them on merge. The merge gate rejects them.
- **`lifecycle:merged` is applied automatically** when a PR referencing the issue is
  merged — don't set it by hand. It replaces whatever stage label the issue carried, and
  reopens the issue if GitHub auto-closed it. It requires a **merged PR** referencing the
  issue. Only `Refs #N` / `Part of #N` (or a closing keyword) count as a reference; a bare
  `#N` mention does not.
- **Analysis ends with a finding, not an automatic advance.** The analysis is posted on the
  issue and the issue then moves on (to `lifecycle:elaboration`, or is closed).
- **Two human approvals gate the pipeline:** plan approval (`lifecycle:elaboration` →
  `lifecycle:ready`) and ship approval (merged → released). Humans also merge PRs.
- **Only the release automation closes** issues in the normal flow, once the change ships.
- A **guard workflow** repairs illegal label combinations (e.g. two stage labels at once, or
  `lifecycle:merged` with no merged PR) and comments explaining what it changed.

## Visual pipeline

A cross-repo board mirrors these stages as columns:
**Sovereign AI — Issue Lifecycle** (GitHub Projects, owner `ndee`).

## Automation reference

| File | What it does |
|---|---|
| `.github/labels.yml` | Canonical definition of the four `lifecycle:` labels, including rename sources (`renamed_from`). |
| `.github/workflows/sync-labels.yml` | Creates/updates/renames those labels on change. Never deletes a label. |
| `.github/workflows/keep-issue-open-until-released.yml` | On PR merge: reopens referenced issues if auto-closed and moves them to `lifecycle:merged`. |
| `.github/workflows/lifecycle-guard.yml` | Self-heals illegal `lifecycle:` label states and comments. |
| `.github/workflows/merge-ready.yml` | Merge gate: no closing keywords, and a `## Validation` section in the PR body. |
