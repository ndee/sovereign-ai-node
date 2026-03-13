# AGENTS.md

This file defines mandatory working rules for Codex agents contributing to this repository.

## Branching and isolation

- Never work directly on `main`.
- For every bug fix or new feature, create and use a dedicated branch.
- Use `git worktrees` to isolate each bug fix or feature implementation.
- Keep each worktree scoped to a single feature or fix.

## Pull request workflow

- Create a pull request for every feature or bug fix.
- Every change must be pushed immediately to the branch associated with a new or existing pull request.
- Do not accumulate local-only changes for later publication when they belong in an active feature/fix branch and PR.
- Keep pull requests focused and limited to one feature or one fix.

## PR hygiene and follow-up

- Monitor every pull request you create or update.
- Process review comments immediately.
- Resolve merge conflicts immediately.
- Keep the branch rebased or otherwise merge-ready at all times.

## Testing and VM requirements

- Test every feature and bug fix end-to-end when VM validation is required.
- Use the shared launcher and VM policy from the `scripts` repo for dev/prod VM access instead of assuming a fixed known VM.
- Do not mark work complete until end-to-end validation has been performed according to the shared VM policy.

## Compliance

These rules are mandatory and apply to every feature, fix, and follow-up change.
