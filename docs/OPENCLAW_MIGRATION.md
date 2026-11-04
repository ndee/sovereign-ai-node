# Staged OpenClaw migration

`scripts/openclaw-migrate.sh` moves an installed node from the OpenClaw version it runs to the version its node package locks (`deploy/openclaw-runtime/`). It is the only path that changes the OpenClaw version of an installed node. Every install job keeps the installed version (see "Keeping the installed OpenClaw version" in [INSTALLER_CONTRACTS.md](INSTALLER_CONTRACTS.md)).

The script ships in the node package (`package.json` `files`). The node artifact installer refuses an artifact without it.

## Entry point

A root update stage calls it in this fixed form:

```
env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  bash <root-owned copy of scripts/openclaw-migrate.sh> \
    --target pinned \
    --out <root-owned result dir> \
    --node-package <installed node package dir> \
    --bots-dir <installed bot catalog dir> \
    --budget <seconds left of the caller's own timeout>
```

| Argument | Meaning |
|---|---|
| `--target <version\|pinned>` | Target OpenClaw version. `pinned` reads it from `<node-package>/deploy/openclaw-runtime/package.json`. An explicit version must equal that one: the node CLI installs nothing else. |
| `--out <dir>` | Receives `migration.log` (secrets redacted), `result.json` and `npm-shrinkwrap.json`. |
| `--node-package <dir>` | The installed node package whose CLI installs the runtime and refreshes the gateway. Default: the package the script ships in (`<dir>/scripts/openclaw-migrate.sh`). |
| `--bots-dir <dir>` | The installed bot catalog, which the node CLI reconciles against. The CLI gets it as `SOVEREIGN_BOTS_REPO_DIR`, as the installed `sovereign-node` wrapper would export it. Default: `sovereign-ai-bots` next to the node package (`<install root>/app` → `<install root>/sovereign-ai-bots`). Preflight fails without it. |
| `--budget <seconds>` | Wall-clock budget for the whole run, default 1500. Every step's timeout is clamped to what is left minus a 240 s recovery reserve, so a failure still has time to roll back and restart. With less than 600 s left after the reserve, the run stops nothing and exits 1. |
| `--dry-run` | Prints the plan. Changes and writes nothing. |

The caller should copy the script from the verified release to a root-owned path and run that copy, not a file the service user can write. The script must run as root. It takes the lock `/run/sovereign-openclaw-migrate.lock` for its whole run.

## Exit codes

| Exit | `outcome` | State the node is left in |
|---|---|---|
| 0 | `migrated` | Runs the target. The node rendered its config and gateway unit for it, the gateway is healthy, and the scan timers run. |
| 0 | `already-current` | The target was already installed and no earlier run is unfinished. Nothing was stopped or changed. |
| 1 | `unchanged` | A step failed before anything changed, for example preflight, the Node upgrade or the prefetch (offline). The units that were stopped run again. |
| 1 | `rolled-back` | A step failed after the tree changed but before a new version ran its gateway. The backup was restored and the old gateway is healthy. |
| 2 | — | Usage error or not root. No `result.json`. |
| 3 | `rolled-back` | As above, but the restored gateway did not come up healthy. |
| 3 | `rollback-failed` | The restore failed. The gateway stays blocked by the start guard. `message` gives the manual restore commands. |
| 3 | `fix-forward` | A step failed after the target's gateway had started. The node stays on the target with its gateway started, and a rerun resumes from `doctor`. |
| 3 | `resume-required` | A step failed after the stage release's gateway ran, and the target is not completely installed. The gateway stays blocked; a rerun resumes at the target install. |
| 4 | `busy` | Another migration holds the lock. Nothing was done. |

A caller treats 0 as success and anything else as a failed update step. 1 means the node runs its previous OpenClaw; 3 means it needs a rerun or attention.

## When it rolls back and when it fixes forward

- **Restart.** Nothing has changed yet (preflight, Node, prefetch, guard, stop or backup failed). The units that were stopped start again.
- **Roll back.** The tree changed, but no new OpenClaw version has run its gateway. The script restores the package (only if it was overwritten), the `<prefix>/bin/openclaw` link, the state dir, an OpenClaw config outside the state dir, and the gateway unit file, and starts the old gateway. Up to that point the gateway has been stopped since the backup was taken, so the backup is exact.
- **Fix forward.** Once a new version's gateway has started, it has synced with the homeserver, written new state and may have uploaded new encryption keys. Restoring the backup then would hand the old gateway state the homeserver has already moved past, for example a stale sync position or one-time keys that peers have already used. From that point the script never restores. It stays on the new version, and a rerun resumes. This applies both to the target's first start and to the one start of the stage release (see below).
- **Release versions only move forward.** The script runs from the release being installed, and an update never goes back to an older release. A rollback therefore restores only the OpenClaw package and its state, never the node package, and the node release that called the script must keep working with the previous OpenClaw. Its install jobs keep that version, and its renderer handles both config shapes. Node.js is never downgraded either, not even by a rollback.

## Start guard

Before it stops anything, the script writes the drop-in `/etc/systemd/system/sovereign-openclaw-gateway.service.d/zz-openclaw-migrate-guard.conf` with `ConditionPathExists=!<backup root>/gateway.guard`, creates that guard file and reloads systemd. While the file exists, every start of the gateway is a no-op: `systemctl start`, the node's own helpers, and boot. A power loss mid-migration therefore never boots a half-migrated tree. The guard file lives in the root-only backup root, so the service user cannot lift it.

The guard is lifted:
- for the stage release's one gateway start;
- before the node starts the target's gateway (the tree is then complete and validated);
- on every exit that leaves a consistent tree (`unchanged`, `rolled-back`, `fix-forward`).

It stays in place for `rollback-failed` and `resume-required`, and after an interruption.

## Interrupted runs

`<backup root>/state.json` records the target, the source version, the phase reached, whether restoring is still safe, and the backup. A rerun with the same target reads it:

| Phase reached | Rerun |
|---|---|
| `backup`, `stage`, `upgrade`, safe to restore | `restore`: restore the backup, then migrate as if for the first time |
| `stage-started`, `upgrade`, not safe to restore | `upgrade`: skip the stage and install the target |
| `upgraded` or `started` (target completely installed) | `resume`: carry on from `doctor`. A resumed run whose new gateway has not started yet still rolls back on failure. |

An unfinished run for another target that cannot be restored fails preflight with exit 3.

The scan timers are stopped, not disabled, so a reboot starts them again. Every exit path of the script starts them too, whatever happened to the gateway. A rerun on an already migrated node is a no-op that also starts a timer an interrupted run left stopped.

## Steps

| Step | Gateway | What it does |
|---|---|---|
| preflight | up | Versions, Node range, node package and target, prefix layout, budget, disk space (backup plus twice the package) |
| node | up | When Node is below `22.22.3`: `apt-get install --only-upgrade nodejs`. It fails before anything stops, with the apt candidate in the detail, when the repositories carry no Node in `>=22.22.3 <23` |
| prefetch | up | `npm ci --omit=dev --ignore-scripts` of the locked runtime in a scratch dir, as the prefix owner, so the npm cache holds every package. Offline fails here. |
| guard | up | Installs the start guard |
| stop | down | Scan timers, scan services, gateway |
| backup | down | Tar of the state dir and the package, a copy of the gateway unit (and of the OpenClaw config when it is outside the state dir) |
| stage | once | Only for a legacy Matrix store: `2026.6.35`, doctor, Matrix plugin, one gateway start |
| upgrade | down | `sovereign-node openclaw-migration install-runtime --target <v> --json` as the prefix owner, with `npm_config_prefer_offline=true` |
| shrinkwrap | down | `npm-shrinkwrap.json` of the installed tree, as evidence |
| doctor, web-search, matrix-plugin, doctor-matrix, config-validate, matrix-verify | down | As the service user from its home, stdin closed |
| start | up | `sovereign-node reconcile --refresh-runtime --json` as the identity the node was installed with (the prefix owner: root on a root install, the service user on an unprivileged one): the node renders config and unit for the installed version and starts the gateway. This is the point of no return. |
| health | up | The unit is active, has not restarted, and answers HTTP on loopback |
| lobster | up | `commands.list`, a `/tools/invoke` probe with the gateway token, and `llm-task` on `agent:mail-sentinel-scan:main` with a trivial prompt. The `llm-task` answer is recorded in `llm_task`, not gated on. |

The gateway unit's sandbox lets it execute only the package it was rendered for. That is why the start goes through the node's runtime refresh and not through a bare `systemctl start`.

## The node CLI step

`sovereign-node openclaw-migration install-runtime --target <version> [--json]` is internal. It calls the bootstrapper's install with `allowVersionChange: true`; that is the only caller of the flag. Before it does, it checks that:

1. `/run/sovereign-openclaw-migrate.lock` exists and another process holds it (`flock -n -s` exits 1);
2. `sovereign-openclaw-gateway.service` is not running;
3. the target is the version this build locks.

Otherwise it exits 1 with `OPENCLAW_MIGRATION_NOT_STAGED` or `OPENCLAW_MIGRATION_TARGET_MISMATCH`. Success prints the CLI envelope with `result: {version, binaryPath, installMethod, reinstalled}` on stdout. Failure prints the error envelope on stderr.

## result.json

Schema 2. These fields are stable for callers:

| Field | Meaning |
|---|---|
| `ok`, `outcome`, `exit_code` | As in the exit-code table |
| `target`, `from` | Versions |
| `failed_step`, `message` | The failing step and a one-line explanation ending in `Failure: <detail>` |
| `steps[]` | `{name, ok, seconds, skipped?, detail?}` in run order |
| `node` | `{version, ok, upgraded}` of the gateway's Node at the end |
| `backup` | `{path, bytes, source_bytes, package_path}` |
| `rollback` | `{performed, ok, detail}` |
| `recovery` | `null`, `restore`, `upgrade` or `resume` |
| `phase`, `started_on_target`, `guard_engaged`, `scan_units_started` | Where the run ended |
| `prefetch`, `budget` | `budget` is `{seconds, remaining_seconds}` |
| `lobster` | `{version, ok, detail}` |
| `llm_task` | `{session, status, ok}` |
| `doctor` | `{interactive_prompt_seen, runs[]}` |
| `gateway` | The unit's state and journal tail when it failed to start or stay up, else `null` |
| `shrinkwrap`, `already_migrated`, `resumed`, `units_restarted_on_old_version`, `node_package`, `started_at`, `finished_at` | As named |

Without a usable Node, the script writes a minimal result with `ok`, `outcome`, `exit_code`, `target`, `failed_step` and `message`.

## Tests

`scripts/install/js/openclaw-migrate.test.mjs` runs the real script against stubs of every program it drives. The cases cover:
- each failure path: restart, roll back, fix forward and resume;
- a power loss mid-install and mid-doctor (the whole process group killed) followed by a boot and a rerun;
- a service-timeout `SIGTERM`;
- offline prefetch, Node below the floor (first run and resume), the budget clamp, and lock contention.

`src/openclaw/staged-migration.test.ts` covers the node CLI step and checks that `allowVersionChange: true` appears in exactly one place.
