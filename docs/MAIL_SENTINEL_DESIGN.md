# Sovereign Mail Sentinel Bot Design

## Purpose

Define the design of a reliable mail triage bot packaged as a Sovereign agent template and instantiated as a managed OpenClaw agent.

This document covers:

- Agent configuration in OpenClaw
- Read-only IMAP access design
- Reliability mechanisms
- Feedback-driven learning loop
- Optional deterministic workflow support with Lobster

## Summary

`Mail Sentinel` is a Sovereign agent template (`mail-sentinel@1.0.0`) instantiated as a managed OpenClaw agent that:

- polls mail on a schedule
- reads mail via a strictly read-only IMAP tool surface
- classifies high-signal messages
- posts alerts/summaries
- learns from user feedback over time without requiring mailbox write access
- can be installed as multiple managed instances, each with its own IMAP binding, Matrix identity, alert room, and polling schedule

The resulting Sovereign agent is designed to be:

- reliable in unattended operation
- minimally privileged
- configurable with standard OpenClaw primitives (agent workspace, skills, plugins, cron, tool policy)

Template/runtime binding in this model:

- agent template: `mail-sentinel@1.0.0`
- tool template: `imap-readonly@1.0.0`
- default single-instance IDs remain `mail-sentinel-imap` and `mail-sentinel`
- current installer-managed deployments may create multiple Mail Sentinel instances instead of a single fixed runtime binding

## Product and Packaging Decisions

### Packaging Decision: Agent, Not All-in-One Plugin

`Mail Sentinel` should remain a standard OpenClaw agent, not an all-in-one OpenClaw plugin.

Chosen boundary:

- `Mail Sentinel` behavior contract = Sovereign agent template workspace files + skills + tool policy + cron defaults
- read-only IMAP access = OpenClaw plugin tool surface (`imap-readonly`)

Why:

- OpenClaw agents are the intended place for behavior, prompts, and skills
- plugin code is the right place for reusable integrations and typed tool surfaces
- this keeps bot behavior easy to inspect and tune without rebuilding plugin code
- the IMAP plugin can be reused by other bots later

### Naming Decision: Keep `Mail Sentinel` for V1

Keep the V1 bot name as `Mail Sentinel`.

Use `Inbox Sentinel` later as a family/umbrella name when multiple inbox sources share a common design (for example mail, WhatsApp, Signal).

Naming model:

- V1 concrete bot: `Mail Sentinel`
- future family: `Inbox Sentinel`
- future variants: `Inbox Sentinel (Mail)`, `Inbox Sentinel (WhatsApp)`, `Inbox Sentinel (Signal)` or equivalent channel-specific bot names

Implementation guidance:

- Keep current agent IDs and paths mail-specific in V1 (for example `mail-sentinel`)
- Introduce a family taxonomy later without forcing an early rename

### Operator CLI Decision: `openclaw` + `sovereign-node` Side by Side

Operators should use the OpenClaw CLI directly for runtime operations.

`sovereign-node` is now part of the current operator surface and should complement OpenClaw rather than hide it.

Recommended split:

- `openclaw`: runtime-native operations (agents, plugins, channels, cron, health, security audit)
- `sovereign-node`: install/update/migration flow, bundled diagnostics, and installer-managed Mail Sentinel instance lifecycle

This preserves transparency and reduces wrapper drift while still allowing a simpler operator experience for common tasks.

## Operator Onboarding Context

This document defines the bot design, not the full operator installation journey.

Operator onboarding and bundled Matrix setup are specified in:

- `docs/OPERATIONS_ONBOARDING.md`
- `docs/MATRIX_BUNDLED_SETUP.md`
- `docs/INSTALLER_CONTRACTS.md`

### Simple Flow vs Hidden Automation

The intended operator experience is intentionally simple:

- set IMAP credentials
- install
- connect with Element to Matrix
- wait for mail alerts

This is the correct product-level UX target, but several setup steps must be automated behind it for reliability:

- IMAP validation, secret storage, and read-only plugin configuration
- OpenClaw install/profile application, plugin enablement, and managed agent/timer registration
- bundled Matrix provisioning (Synapse, database, reverse proxy/TLS)
- Matrix account bootstrap (operator + managed agent identities), private room creation, and room targeting
- post-install health checks and a test alert

This design assumes those steps are implemented by the operator surfaces described in the runbooks, while the bot itself remains a standard OpenClaw agent.

In the default Sovereign install path, Sovereign installs and configures OpenClaw on the host; operators should not run `openclaw onboard` for this bot setup.

## Design Goals

- Read-only mailbox access (no send/move/delete/reply)
- Deterministic polling and dedupe behavior
- Clear alert outputs with confidence and rationale
- Safe operation under restrictive tool policy
- Feedback loop that improves precision/recall over time
- Operable with OpenClaw CLI and config only

## Non-Goals

- Full email client functionality
- Auto-reply or outbound mail sending in V1
- Mailbox mutation (flagging, moving, deleting)
- Model training pipeline infrastructure in V1

## OpenClaw Agent Model

## Agent Identity and Workspace

`Mail Sentinel` is a standard OpenClaw agent with its own workspace.

It is not implemented as an all-in-one plugin. Plugins are used only for reusable capabilities (for example read-only IMAP access).

OpenClaw workspace prompt files (note the filename is `AGENTS.md`, not `AGENT.md`):

- `AGENTS.md` — role, run loop behavior, policy constraints
- `SOUL.md` — tone and decision style for alerts
- `TOOLS.md` — how to use `imap_*` tools and local state files
- `HEARTBEAT.md` — optional guidance if heartbeat-based runs are used
- `MEMORY.md` — persistent learned heuristics and operator preferences

Recommended workspace structure (inside the agent workspace):

```text
workspace/
  AGENTS.md
  SOUL.md
  TOOLS.md
  MEMORY.md
  state/
    checkpoint.json
    seen-message-ids.jsonl
    alert-history.jsonl
  feedback/
    feedback-events.jsonl
    rules.yaml
    examples.jsonl
  skills/
    mail-sentinel-triage/
      SKILL.md
    mail-sentinel-feedback/
      SKILL.md
```

## Agent Configuration (OpenClaw)

The bot should be configured as a dedicated agent entry in `openclaw.json`.

Key OpenClaw controls used:

- `agents.list[]`
- `agents.list[].skills` (per-agent skill allowlist)
- `agents.list[].tools.profile`
- `agents.list[].tools.allow` or `agents.list[].tools.alsoAllow`
- `agents.list[].sandbox.*`
- cron jobs (`openclaw cron ...`)

Related packaging controls:

- `plugins.allow`
- `plugins.entries.*`

### Recommended Agent Config (baseline)

```json5
{
  agents: {
    list: [
      {
        id: "mail-sentinel",
        workspace: "/opt/sovereign-ai-node/agents/mail-sentinel/workspace",
        skills: ["mail-sentinel-triage", "mail-sentinel-feedback"],
        tools: {
          profile: "minimal",
          allow: [
            "read",
            "write",
            "imap-readonly", // plugin id opt-in (if tools are optional)
            "imap_list_folders",
            "imap_list_messages",
            "imap_search_messages",
            "imap_get_message"
          ]
        },
        sandbox: {
          mode: "all"
        }
      }
    ]
  }
}
```

Notes:

- If attachment inspection is needed, add `imap_get_attachment` explicitly.
- If alerts are sent by the agent itself (instead of cron announce delivery), add the required outbound messaging tool (for example `message`) explicitly.
- If you use `tools.allow`, do not also set `tools.alsoAllow` in the same scope.
- `write` is included only for local bot state and feedback persistence inside the workspace.

### Plugin and Channel Config (recommended baseline)

The agent config above should be paired with an explicit plugin and channel inventory.

```json5
{
  plugins: {
    allow: ["matrix", "imap-readonly"],
    entries: {
      matrix: { enabled: true },
      "imap-readonly": {
        enabled: true,
        config: {
          accounts: {
            primary: {
              host: "imap.example.org",
              port: 993,
              secure: true,
              userEnv: "MAIL_SENTINEL_IMAP_USER",
              passwordEnv: "MAIL_SENTINEL_IMAP_PASSWORD"
            }
          },
          defaults: {
            account: "primary",
            maxMessagesPerPoll: 100,
            maxBodyBytes: 65536,
            maxAttachmentBytes: 5242880
          }
        }
      }
    }
  },
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_***",
      dm: { policy: "allowlist", allowFrom: ["@admin:example.org"] },
      groupPolicy: "allowlist",
      groups: {
        "!alertsroom:example.org": {
          users: ["@admin:example.org"]
        }
      }
    }
  }
}
```

Notes:

- Keep `plugins.allow` explicit in production.
- The exact `imap-readonly` plugin config shape is repo-defined; the structure above is the recommended contract for this bot.
- Prefer env-backed credentials over inline secrets.
- Keep plugin scope narrow: `imap-readonly` provides mail access; it does not own bot behavior, scheduling, or feedback logic.

## Tool Surface: Read-Only IMAP

## Read-Only IMAP Requirement

The bot must access mail through a dedicated read-only tool surface.

The plugin must expose only read operations such as:

- `imap_list_folders`
- `imap_list_messages`
- `imap_search_messages`
- `imap_get_message`
- `imap_get_attachment` (optional, size-limited)

The plugin must not expose any mutation verbs:

- no send/reply/forward
- no move/copy/delete
- no flag/unflag
- no archive

Plugin scope decision:

- The IMAP plugin exposes a reusable read-only mail capability surface.
- Mail triage logic, dedupe policy, and feedback learning remain agent/skill concerns.

## IMAP Reliability Constraints

The IMAP tool implementation should enforce:

- bounded timeouts
- retry with backoff for transient errors
- structured errors (auth/network/timeout/parse)
- pagination for large inboxes
- body preview size limits
- attachment size limits and MIME allowlists
- deterministic sorting (for example by received time + UID)

## Credential and Permission Model

Use a dedicated mailbox account (or app password) with server-side read-only permissions where possible.

Operational requirements:

- credentials provided via OpenClaw plugin config/env, not skill text
- no credentials in `AGENTS.md`/`SKILL.md`
- plugin config enabled only for `mail-sentinel` runtime profile

## Reliability Design

## Execution Mode

Use OpenClaw cron isolated jobs for unattended polling.

Why isolated cron runs:

- fresh run context each poll
- predictable scheduling
- no dependency on a chat heartbeat cadence
- easier failure diagnosis per run (`cron runs`)

Recommended cron pattern:

- `--session isolated`
- `--message "<poll+triage instruction>"`
- fixed poll interval (for example every 2-5 minutes)
- explicit alert delivery strategy (cron announce if supported, otherwise agent send)

### Cron Job Example (recommended V1)

Use an isolated cron run to trigger the polling/triage cycle.

If your OpenClaw release supports cron announce delivery to Matrix, use explicit delivery targeting.
Otherwise let the agent post via the channel/message tool to a fixed room target.

```bash
openclaw cron add \
  --name "mail-sentinel-poll" \
  --every "5m" \
  --session isolated \
  --message "Poll configured mailboxes using read-only IMAP tools, classify new messages into the sentinel labels, emit alerts for high-signal findings, and update local checkpoint state."
```

Notes:

- If you use Matrix delivery, prefer explicit Matrix targets (for example `room:!roomId:server`) over implicit routing.
- Start with `5m`; reduce only after observing stable runtimes and mailbox volume.
- Use `openclaw cron runs --id <job-id>` as the primary run history surface.

## Run Loop (Per Poll)

Each poll cycle should follow a deterministic sequence:

1. Load local checkpoint and suppression state from workspace files.
2. Query mailbox for messages newer than the last checkpoint (with overlap window).
3. Normalize and dedupe candidate messages.
4. Classify and extract signals.
5. Score confidence and apply thresholds.
6. Emit alerts for high-signal findings.
7. Persist updated checkpoint, seen IDs, and alert history.
8. Persist telemetry summary for debugging (counts, duration, errors).

## Checkpointing and Dedupe

To be reliable across retries/restarts, the bot must use local persisted state.

Minimum state files:

- `state/checkpoint.json`
  - last poll time
  - last UID/time processed per mailbox
- `state/seen-message-ids.jsonl`
  - message-id/UID dedupe keys
- `state/alert-history.jsonl`
  - prior alerts and dedupe hashes

Recommended behavior:

- Use an overlap window (for example last 10-15 minutes) rather than exact cursor-only polling.
- Deduplicate by stable keys (`message-id`, mailbox+UID, plus normalized subject/date fallback).
- Treat state writes as part of the end-of-run commit step.

## Failure Handling

Failure categories and handling:

- IMAP auth failure:
  - emit a high-priority operational alert
  - do not advance checkpoint
- IMAP timeout/transient network error:
  - retry bounded times in-run
  - if still failing, emit operational alert and keep checkpoint unchanged
- parsing error on one message:
  - skip message, record error, continue batch
- model/classification failure:
  - fall back to conservative rule-based heuristics
  - if no decision possible, queue “needs review” alert
- state write failure:
  - treat run as failed and avoid partial checkpoint advance

## Classification and Alerting Strategy

## Signal Classes (V1)

The bot classifies messages into at least:

- `decision_required`
- `financial_relevance`
- `risk_escalation`

Each finding should include:

- label(s)
- confidence
- short rationale
- suggested action
- message identifiers for traceability

## Reliability Through Structured Output

To reduce drift and brittle parsing:

- force structured output format in prompts/skills
- keep label taxonomy fixed and versioned
- instruct the agent to separate facts from recommendations
- include a “not enough confidence” path

Recommended alert payload shape (human + machine-friendly):

```json
{
  "runId": "2026-02-25T12:00:00Z/mail-sentinel",
  "mailbox": "INBOX",
  "messageRef": {
    "messageId": "<abc@example.org>",
    "uid": 12345
  },
  "labels": ["decision_required"],
  "confidence": 0.91,
  "summary": "Vendor asks to approve contract amendment by tomorrow.",
  "rationale": [
    "Contains explicit request for approval",
    "Deadline mentioned"
  ],
  "suggestedAction": "Review contract amendment and confirm approval decision."
}
```

## Learning Through User Feedback

## Feedback Sources

User feedback should come through the same operator channel used for alerts (for example Matrix room) and be recorded locally.

Feedback patterns to support:

- confirm alert correctness
- mark false positive
- mark missed priority (false negative report)
- relabel category
- set sender/domain-specific preference (always/never important)
- tune urgency/quieting behavior

## Feedback Ingestion Model

The agent should parse feedback and write normalized feedback events to:

- `feedback/feedback-events.jsonl`

Each event should include:

- timestamp
- operator identity (if available from channel metadata)
- referenced alert/message
- action type (`confirm`, `false_positive`, `relabel`, `missed`, `rule_update`)
- old labels / new labels
- free-text explanation

## Learning Layers (Practical V1)

V1 learning should be layered and conservative:

### 1. Deterministic rule learning (fast, reliable)

Update `feedback/rules.yaml` with operator-confirmed preferences, for example:

- sender/domain importance boosts
- newsletter/vendor suppression
- keyword boosts/suppressions
- threshold overrides for specific senders/topics

These rules are applied before or after model classification as score modifiers.

### 2. Example-based prompt memory (low complexity)

Append curated examples to `feedback/examples.jsonl` and summarize recurring patterns into `MEMORY.md`.

Use these to improve future classification prompts/skills without changing the model or plugin code.

### 3. Threshold calibration (controlled)

Maintain per-label thresholds in a local config file (for example `feedback/rules.yaml`).

Adjust thresholds only when enough feedback evidence exists, and log every change.

## Reliability Rules for Learning

- Feedback updates must be append-only first (events), then derived into rules
- Derived rules should be deterministic and reviewable
- Never overwrite raw feedback history
- Keep changes versioned (or at least diffable) in workspace files
- Learning must not grant new tool capabilities

## OpenClaw Skills Design for Mail Sentinel

## Skill Set

Recommended initial skills:

- `mail-sentinel-triage`
  - label taxonomy
  - confidence rubric
  - extraction format
  - escalation heuristics
- `mail-sentinel-feedback`
  - parse operator corrections
  - map corrections to feedback event schema
  - derive/update rules safely

Use `agents.list[].skills` to restrict the bot to these curated skills.

## Skill Source Control

OpenClaw skill precedence favors workspace skills over managed/bundled skills.

Recommended production posture:

- Keep sentinel skills in the agent workspace (or a pinned shared skills dir)
- Avoid unreviewed third-party workspace skills on the production host
- Use `skills.load.extraDirs` only for explicitly curated shared skill packs

Example (shared curated skills pack, optional):

```json5
{
  skills: {
    load: {
      extraDirs: ["/opt/sovereign-ai-node/skills"]
    }
  }
}
```

## Scheduling and Delivery

## Cron vs Heartbeat

Use cron for polling.

Use heartbeat only for:

- operator reminders
- status summaries
- low-frequency maintenance prompts

Cron is the right trigger for Mail Sentinel because it decides when the poll runs; the agent then performs the triage run in an isolated session.

## Alert Delivery

Two practical delivery patterns:

- Agent sends alerts directly via a channel/message tool
- Cron isolated run uses announce delivery to a fixed target

Recommended for V1 reliability:

- prefer cron isolated runs for scheduling
- use explicit targeting for alerts (agent send or cron announce, depending on Matrix delivery support in the installed OpenClaw release)
- do not rely on “last route” for scheduled bot alerts

## Operator Workflow (CLI Policy for This Bot)

Use the OpenClaw CLI as the operational source of truth for this bot.

The simplified operator install/run flow, including the optional `sovereign-node` CLI and Wizard UI, is documented in `docs/OPERATIONS_ONBOARDING.md`.

Bundled Matrix server setup requirements and defaults are documented in `docs/MATRIX_BUNDLED_SETUP.md`.

Normative CLI/API contracts for installer and operator commands are documented in `docs/INSTALLER_CONTRACTS.md`.

In the default Sovereign flow, `openclaw` is installed by Sovereign and then used as the runtime/operator CLI alongside `sovereign-node`.

Typical operator commands for `Mail Sentinel`:

- `openclaw agents ...` to inspect/configure the agent
- `openclaw plugins ...` to manage `matrix` and `imap-readonly`
- `openclaw cron ...` to manage polling jobs
- `openclaw status`, `openclaw health`, `openclaw security audit` for runtime checks

If a `sovereign-node` CLI exists, it should wrap common setup flows (profile apply, workspace sync, cron bootstrap) but leave OpenClaw CLI visible and supported.

## Static Workflow Option: Lobster (Evaluation)

## Does Lobster make sense here?

Yes, but as an optional reliability enhancement, not a requirement for the first working version.

Lobster is useful when the Mail Sentinel run becomes a multi-step workflow that benefits from:

- deterministic step order
- resumable execution
- explicit approval checkpoints for side effects
- structured JSON envelopes

This aligns well with mail triage pipelines, especially once the bot manages more than one mailbox or more complex post-processing.

## Where Lobster Helps

Lobster is a good fit for deterministic parts of the pipeline:

- collect messages
- normalize and dedupe
- call a structured classification step
- aggregate findings
- write state/checkpoint
- emit a single structured result

This reduces repeated LLM orchestration over many tool calls.

It also helps if you later add approval-gated actions (for example ticket creation or downstream notifications beyond the primary alert channel).

## Where Lobster Does Not Help Much (Initially)

Lobster adds operational dependency and configuration:

- Lobster CLI must be installed on the same host as OpenClaw Gateway
- the optional `lobster` tool must be enabled
- workflow files must be authored and maintained

For a minimal V1 with one mailbox and simple triage, a normal agent loop is easier to start with.

## Recommended Decision

- V1 bootstrap: **without Lobster** (simpler to ship)
- V1.1+ reliability profile: **optional Lobster mode** for deterministic polling/classification pipeline

## Lobster Integration Design (Optional Profile)

If enabled:

- install Lobster CLI on the Gateway host (`lobster` on `PATH`)
- enable the optional Lobster plugin tool additively
- allow Lobster only for `mail-sentinel`, not globally
- keep IMAP read-only tools and file/state tools restricted

Example (per-agent additive enablement):

```json5
{
  agents: {
    list: [
      {
        id: "mail-sentinel",
        tools: {
          profile: "minimal",
          alsoAllow: ["lobster", "imap_get_message", "imap_search_messages", "read", "write"]
        }
      }
    ]
  }
}
```

Notes:

- Use `alsoAllow` only in additive mode; do not combine with `allow` in the same scope.
- If you want a restrictive allowlist mode, use `allow` and enumerate all needed core and plugin tools.

## Lobster + LLM Step (Optional)

If the workflow needs strict JSON classification inside Lobster:

- consider OpenClaw’s `llm-task` plugin tool for schema-constrained JSON output
- keep schema fixed and versioned
- treat this as an advanced profile because it adds another plugin/tool dependency

## Security Baseline (Mail Sentinel Specific)

- read-only IMAP tool surface only
- restrictive per-agent tool policy
- sandbox enabled for the agent
- no shell/exec tools for the bot
- pinned plugin inventory
- explicit channel allowlists for operator room/DMs
- secrets injected via config/env, not prompt files

## Observability and Operations

Minimum operational checks:

- `openclaw health`
- `openclaw status --deep`
- `openclaw plugins doctor`
- `openclaw cron list`
- `openclaw cron runs --id <job-id>`
- `openclaw security audit --deep`

Bot-level observability artifacts (workspace-local):

- run summary log (`state/run-history.jsonl` optional)
- alert history (`state/alert-history.jsonl`)
- feedback history (`feedback/feedback-events.jsonl`)
- checkpoint state (`state/checkpoint.json`)

## Acceptance Criteria

The Mail Sentinel design is considered implemented successfully when:

- the agent runs as a standard OpenClaw agent with a dedicated workspace
- the bot logic is agent/skill-based and not packaged as an all-in-one plugin
- mailbox access is strictly read-only through `imap_*` tools
- scheduled isolated cron runs poll reliably and do not duplicate alerts after restart
- user feedback changes future classifications via rules/examples
- the bot remains functional with transient IMAP/model failures and preserves checkpoint correctness
- Lobster mode (if enabled) can be added without changing the read-only IMAP or feedback model
