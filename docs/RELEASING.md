# Releasing

Releases are automated. Every release is built and published from one commit,
and that commit has to be the current `main` with a successful CI push run.
This page describes the chain, the checks between its steps, and what to do
when the chain stops on purpose.

## The chain

```
merge to main ─▶ CI (push) ─▶ Release Please workflow ─▶ release PR
                                                            │ auto-merge
                                                            ▼
published release ◀─ build + test + attach ◀─ draft + tag ◀─ CI on the merge commit
```

1. A pull request merges into `main`. CI runs on the push (`.github/workflows/ci.yml`).
2. When that CI run succeeds, `.github/workflows/release.yml` starts. Before it
   changes anything, it checks that the run passed every required job and that
   its commit is still the head of `main`
   (`scripts/release/require-successful-main-ci.sh`).
3. Release Please opens or refreshes the release PR, `chore: release X.Y.Z`
   (`release-please-config.json`). `always-update` makes it rebuild the PR on
   every validated `main`, so the PR always sits on the newest `main`.
4. `.github/workflows/auto-merge-release-pr.yml` arms GitHub's auto-merge on
   the release PR. The ruleset's required checks still decide when it merges.
5. CI runs on the release PR's merge commit. The next Release Please run creates
   a draft release and its tag at that commit. The workflow then builds and
   tests the release assets, attaches them, and publishes the immutable release.
   The CI check from step 2 runs again right before the upload and before the
   publish.

## Checks

### The release PR must be up to date with `main`

The release notes come from the commits Release Please saw when it built the
release PR. If the PR merged after newer commits landed on `main`, the tag would
include those commits but the notes would not list them.

`scripts/release/auto-merge-release-pr.sh` arms auto-merge only while the
release PR is exactly one commit, Release Please's, on top of the current
`main`. The merge is also pinned to that head commit. The workflow runs again on
every push to `main` and disarms a release PR that has fallen behind. Release
Please rebuilds the PR after the new `main` passes CI, and that rebuild re-arms
it. Merging `main` into the release branch ("Update branch") does not count as
up to date, because the notes would still be from the older `main`.

A push to `main` can still land while the release PR's last required check is
finishing, before the disarm runs. Only the ruleset setting "Require branches to
be up to date before merging" closes that window, and it applies to every PR.

### The release commit must be the validated `main`

Release Please tags and drafts a merged release PR at that PR's merge commit.
Every later step only accepts the CI-validated head of `main`. If Release Please
ran while `main` was already past the merge commit, it would create the tag and
draft first and then the workflow would fail, leaving them stuck.

`scripts/release/check-pending-release-pr.sh` runs before Release Please. If a
merged release PR still labelled `autorelease: pending` was merged at any other
commit than the validated `main`, Release Please does not run. The run ends
successfully with a "Release held" warning, and no tag or draft is created.

### Retry of the CI jobs read

The CI check reads the jobs of the CI run from the GitHub API. Right after a run
finishes, that read can still report a finished job as `in_progress`, or miss
it. The check reads up to five times, waiting 2, 4, 8 and 16 seconds between
reads, and logs every retry with each required job's state. It retries only
reads that are not final: a failed API call, or a required job that is missing
or not completed. A completed job that did not succeed, or a duplicate job
entry, fails at once.

## Held release

A "Release held" warning means a release PR was merged and a newer commit landed
on `main` before the release run for the merge commit. The release stays
pending. The workflow does not change labels, tags or releases, so resolving it
is a maintainer decision.

To avoid it, merge nothing into `main` from the moment the release PR merges
until its release is published.

## Changelog corrections

`CHANGELOG.md` is the record of what each version contains. If an entry is
missing, fix it with a pull request to `main` that edits `CHANGELOG.md`. Do not
edit the body of a published release.
