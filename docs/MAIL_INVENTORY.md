# Mail inventory and integrity counts

A quiet mailbox and a mailbox whose mail was never checked look the same from
the outside. Two pieces let an operator tell them apart without any mail
content leaving the device:

1. `sovereign-tool mail-inventory` lists the identifiers of every message in
   the watched mailbox, independently of the search the scan uses.
2. The support bundle and the install diagnostics carry `mail-integrity.json`:
   Mail Sentinel's own per-day counts of what happened to each inventoried
   message, as counts only.

## `sovereign-tool mail-inventory`

```
sovereign-tool mail-inventory --instance <tool-instance-id>
  [--after-uid <uid> --uid-validity <value>]
  [--timeout-ms <ms>] [--config-path <path>] [--json]
```

Read-only, like the other `imap-readonly` commands: the IMAP mailbox is opened
with `EXAMINE`, POP3 never issues `DELE`, and nothing is written to disk.

It shares nothing with `imap-search-mail` that could make both miss the same
message: no result limit, no `since:` date window, no watermark and no POP3
header walk.

### Deadline

The command runs inside a caller's scan budget, so it carries its own wall-clock
deadline: `--timeout-ms`, default 20000, clamped to 1000–60000. When the
deadline passes, the connection is dropped and the command exits 1 with the
retryable error `MAIL_INVENTORY_TIMEOUT`.

### IMAP: a UID-range census

- Without `--after-uid`, every UID in the mailbox is listed (a **full census**,
  `afterUid: 0`).
- With `--after-uid <n> --uid-validity <v>`, only UIDs above `n` are listed. A
  caller that records the highest inventoried UID therefore lists every arrival
  since its previous run, however long the device was off, as long as the
  message is still in the mailbox.
- If the server's UIDVALIDITY is no longer `<v>`, the old UIDs mean nothing:
  the command ignores `--after-uid`, takes a full census and reports
  `uidValidityChanged: true`. Treat that as a new key space.
- `--after-uid` without `--uid-validity` is refused
  (`MAIL_INVENTORY_INVALID_ARGUMENT`).

`--json` result (`protocol: "imap"`):

| Field | Meaning |
|---|---|
| `uidValidity` | The mailbox's UIDVALIDITY (absent if the server reports none). |
| `uidValidityChanged` | The caller's `--uid-validity` no longer matches. |
| `afterUid` | Lower bound actually used; `0` is a full census. |
| `uidNext` | The server's UIDNEXT, when reported. |
| `messageCount` | The server's own count (`STATUS MESSAGES`; `EXISTS` if STATUS is refused). |
| `count` | Number of UIDs listed. |
| `highestUid` | Highest UID listed. |
| `uidRanges` | Listed UIDs as ascending, inclusive `[first, last]` runs. |
| `uidGaps` | UIDs inside the census range that the server no longer lists. On a continuation this covers every UID assigned after `afterUid` (up to UIDNEXT − 1); on a full census only the holes between listed UIDs. Informational: a message expunged before it was seen, or a server that skips UIDs. |

### POP3: a full UIDL listing

POP3 has no ranges and no gap signal, so every call lists all UIDLs plus the
`STAT` count. `--after-uid` and `--uid-validity` are not used.

Each UIDL is mapped through the message index the POP3 search keeps under
`/var/lib/sovereign-node/pop3-index/<instance>.json`. The inventory only reads
that index: it never creates, repairs or rewrites it and never assigns a uid,
so it cannot race the search, which owns the file (the search replaces it by
rename, so a reader never sees a half-written index).

`--json` result (`protocol: "pop3"`):

| Field | Meaning |
|---|---|
| `uidValidity` | The same `<account>:<generation>` value the search reports; absent while the index is absent or corrupt. |
| `index` | `present`, `absent` (no search ran yet) or `corrupt` (the next search replaces it). |
| `messageCount` | `STAT` count. |
| `count` | Number of UIDLs listed. |
| `messages` | In server order: `{ uidlHash, uid?, baseline? }`. `uid` is the search's synthetic uid once the index has the message; `baseline: true` marks a message the search recorded without reporting it. |
| `unindexedCount` | Messages the index has not seen yet; the next search assigns their uid. |

The UIDL itself is never printed, only `uidlHash` (the first 12 hex digits of
its SHA-256), because some servers build UIDLs from host or file names.

## `mail-integrity.json`

Mail Sentinel can record an `integrity` block at the top level of its state
file (`/var/lib/sovereign-node/mail-sentinel/workspace/data/mail-sentinel-state.json`):

```json
{
  "integrity": {
    "version": 1,
    "updatedAt": "2026-10-19T08:00:00.000Z",
    "coverage": "full",
    "inventory": "available",
    "residual": 0,
    "unaccounted": 0,
    "inFlight": 1,
    "days": {
      "2026-10-19": {
        "coverage": "full",
        "inventory": 41,
        "states": { "red": 1, "amber": 3, "gray": 36, "pending": 1 },
        "outageAffected": 0,
        "residual": 0,
        "seenNotInventoried": 0,
        "uidGaps": 0,
        "unaccounted": 0,
        "inFlight": 1,
        "flags": []
      }
    }
  }
}
```

`sovereign-node support-bundle` and the install diagnostics archive
(`files/mail-integrity.json`) reduce that block with one shared allowlist
(`mailIntegrityCounts` in `src/support/collectors.ts`):

- Only the fields shown above are read, and only as counts, timestamps or
  known names. Anything else in the block is dropped, never copied.
- `states` keys outside the known outcome states are added up under `other`:
  `red`, `amber`, `gray`, `no-verdict:reviewer-unavailable`,
  `no-verdict:refused`, `no-verdict:defaulted`, `read-failed`,
  `read-failed:timeout`, `read-failed:other`, `too-large`, `not-returned`,
  `not-returned:truncated`, `not-returned:baseline`,
  `not-returned:outside-window`, `not-returned:below-watermark`, `pending`,
  `deferred`.
- `flags` outside `inventory-gap`, `coverage-break`, `search-truncated` and
  `ledger-reset` become `other`.
- A day key that is not a `YYYY-MM-DD` date is dropped and counted in
  `ignoredDays`; only the newest 62 days are kept (`omittedDays` counts the
  rest).
- A day's total is reported as `inventory` only when that day's `coverage` is
  `full` (a successful inventory ran that day). Otherwise it is reported as
  `recorded`, because it then comes from Mail Sentinel's own records and is not
  an independent census.
- `residual` may be negative; every other count is a non-negative integer or
  `null`.

There are no identifiers, subjects, senders, recipients, Message-IDs or UIDLs
in the block's contract, and the allowlist would drop them if a producer added
them, so the diagnostics privacy notice ("no subjects, senders, recipients or
message bodies") is unchanged.

Absent data is normal:

| Situation | `mail-integrity.json` |
|---|---|
| No state file (Mail Sentinel not installed) | Install diagnostics: listed as not present on this device. Support bundle: unavailable, like `mail-sentinel-summary.json`. |
| State file without an `integrity` block (an older Mail Sentinel) | Collected: `{ "available": false, "reason": "…" }`. The bundle stays complete. |
| Partial block | Collected; missing counts are `null`. |

An integrator that builds its own install-diagnostics source list adds the file
with `mailIntegrityDiagnosticsSource(statePath, { owner })` from
`sovereign-ai-node/support`.
