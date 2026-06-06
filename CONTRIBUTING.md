# Contributing

Thanks for contributing to sovereign-ai-node.

## Workflow at a glance

- Work happens on **issues** that move through a fixed lifecycle. Before picking
  something up, read **[docs/ISSUE_LIFECYCLE.md](docs/ISSUE_LIFECYCLE.md)** — it
  describes the stages, the `lifecycle:` labels, and who sets each.
- **Branch per change.** Never commit to `main`. Open a **draft pull request** early.
- **Reference issues with `Refs #N` or `Part of #N`** in your PR — not
  `Closes`/`Fixes`/`Resolves`. Issues stay open until a human has tested and closed them.
- Keep PRs focused on a single issue.

## Before you push

- Run the repo's checks locally (lint, typecheck, tests) — see `.github/workflows/ci.yml`
  for what CI runs.
- Make sure the change is covered by tests where applicable.

## Labels and automation

The `lifecycle:` labels are managed as code and partly automated; see
[docs/ISSUE_LIFECYCLE.md](docs/ISSUE_LIFECYCLE.md) for the full state machine and the
workflows that enforce it. In short: a guard repairs illegal label states, and
`lifecycle:testing` is applied automatically when a referencing PR merges — you don't
set it by hand.
