# Architecture

## Purpose

This is the single architecture document for `sovereign-ai-node`.
It captures the essential system design, runtime boundary, governance constraints, and open-core product boundary.

## What This Repo Is

Sovereign AI Node is a self-hosted, local-first, modular multi-agent runtime with Matrix as the primary operator interface.

Defaults:

- Local-first execution
- Always-on, event-driven bots
- Explicit permissions and auditability
- No mandatory telemetry
- Optional hybrid/cloud adapters behind policy controls

Initial non-goals:

- Multi-tenant SaaS control plane
- Cloud-hosted default mode
- Closed-source core orchestration

## System Overview

### Main Layers

1. Matrix control plane (operator chat interface)
2. Node Kernel (sovereign orchestration authority)
3. Agent layer (specialized bots)
4. Agent runtime sidecar (`OpenClaw` via `AgentRuntimeAdapter`)
5. Tool/connectors (mail, files, calendar, APIs)
6. Intelligence layer (classifiers + model routing)
7. Local persistence (DB/files/index)

### Core Event Flow

1. Matrix or connectors emit events into the kernel event bus.
2. Kernel schedules and dispatches work to a bot.
3. Bot behavior executes through `AgentRuntimeAdapter` into the OpenClaw sidecar.
4. Tool access is brokered by the kernel (policy + scoped capabilities).
5. Results and decisions are audited/persisted by the kernel.
6. Alerts/responses are delivered back to Matrix rooms.

## Component Responsibilities

### Matrix Control Plane

- Bot identities and rooms
- Operator command interface
- Incoming command/event translation
- Outbound alerts and summaries

### Node Kernel (System Authority)

The kernel must remain framework-independent and sovereignty-critical.

Owns:

- Event ingestion and dispatch
- Trigger scheduling
- Policy/permissions evaluation
- Capability registration and brokering
- Audit/event logging
- Durable state and checkpoints
- Bot lifecycle management

### Agent Layer

Bots are modular, independently auditable, and disable-able.

Per-bot contract (conceptual):

- `identity`
- `subscriptions`
- `capabilities`
- `handlers`
- `state`
- `policies`

Rule: no monolithic super-agent in core.

### Agent Runtime Strategy (`OpenClaw`-first, adapter-safe)

Use `OpenClaw` as the default bot execution engine for V1/V2, but keep platform authority in the kernel.

Required integration shape:

- Stable `AgentRuntimeAdapter`
- Sidecar/runtime boundary by default when plugins/skills are enabled
- Structured action/results returned to the kernel

Kernel-owned (must not move into OpenClaw):

- Scheduling and event dispatch
- Final policy decisions
- Audit/system-of-record state
- Secrets authority
- Capability enforcement

OpenClaw-owned (within kernel policy):

- Agent execution loop
- Tool orchestration and reasoning steps
- Curated skill packs
- Curated plugins for bounded integrations

## Tools, Models, and Storage

### Connectors / Tools (initial)

- Mail (`IMAP`, optional `SMTP`, Proton Bridge path)
- Files (local FS / mounted volumes)
- Calendar (`CalDAV` / `ICS`)
- External APIs (explicit allowlist only)

Connector requirements:

- Typed capability declarations
- Scoped credentials (no blanket env exposure)
- Timeouts and rate limits
- Structured errors
- Audit hooks
- Kernel brokering for high-risk capabilities

### Intelligence Layer

- Semantic classifiers / extraction pipelines
- Model router (local-first)
- Optional hybrid model adapters

### Storage

- Metadata/state DB (SQLite acceptable for V1)
- Local files/object storage
- Optional search/vector index

Authoritative state remains in kernel-managed storage even if runtime plugins provide memory/cache features.

## Plugin and Skill Governance (Essential Policy)

Plugin/skill usage is an architectural concern, not only an ops concern.

Production defaults:

- Deny-by-default allowlists per bot
- Version pinning and reviewed upgrades
- Per-bot capability scopes enforced by kernel policy/broker
- Sidecar isolation to reduce plugin blast radius
- Audit logging for plugin loads, skill sources, and tool calls
- Disable unreviewed user/project skill auto-loading

Trust model:

- `Trusted`: core connectors, kernel-brokered tools, reviewed in-repo skills
- `Restricted`: curated/pinned OpenClaw plugins with explicit scopes
- `Blocked by default`: unreviewed community plugins and broad host-access plugins in production

V1 Mail Sentinel posture:

- Use OpenClaw runtime + in-repo skill pack(s)
- Keep IMAP and Matrix delivery kernel-owned
- No `plugin-shell` in production
- No community plugins in production
- No plugin-managed durable state as source of truth

## V1 Reference Bot: Mail Sentinel

### Goal

Continuously evaluate inbound email and alert on high-signal items.

### Initial Trigger Classes

- `decision_required`
- `financial_relevance`
- `risk_escalation`

### Simplified V1 Flow

1. Mail connector ingests message and emits `mail.received`.
2. Kernel dispatches to `Mail Sentinel`.
3. Sentinel runs classification/extraction via `AgentRuntimeAdapter` -> OpenClaw.
4. Model router selects local or explicitly enabled hybrid model.
5. Sentinel posts proactive alert to Matrix room.
6. User feedback returns through Matrix and updates bot heuristics/state.

### V1 Storage Needs

- Message metadata index
- Classification results
- Alert history
- Feedback corrections
- Bot checkpoints/state

## Open Core vs Pro Boundary (Essential)

Principle: open core must remain fully useful for self-hosting; Pro adds packaging and operational convenience without weakening sovereignty.

### Open Core (`sovereign-ai-node`)

- Node Kernel (event bus, scheduler, policy, audit, state, capability broker)
- Matrix control plane integration
- Agent SDK/contracts
- OpenClaw runtime adapter + sidecar integration contracts
- Plugin/skill governance enforcement hooks
- Base connector framework
- Local model adapters (+ optional hybrid adapter interfaces)
- Base bots (starting with Mail Sentinel)
- Self-hosted config/CLI and example deployment manifests

### Pro (`sovereign-ai-node-pro`)

- Maintained appliance builds/distributions
- Signed release/update channels
- Curated compatibility bundles
- Zero-drift update orchestration
- Read-only monitoring/diagnostics bundles
- Support workflows / operational tooling
- Future team/commercial extensions

Guardrails:

- Do not move core runtime primitives into Pro
- Do not make Matrix control plane Pro-only
- Do not make local inference Pro-only
- Do not move plugin/skill policy enforcement into Pro-only components

## Stable Interfaces (Prioritize Early)

- `AgentRuntimeAdapter`
- Capability broker contract
- Connector capability adapters
- Model provider adapters
- Event schemas
- Policy hook interface
- Audit/event sink interface
- Plugin/skill policy manifest schema
- Adapter boundary protocol (embedded API or sidecar RPC)

## Deployment Topologies (Initial)

### Single-node local (V1)

- Matrix homeserver + client
- Sovereign AI Node kernel
- OpenClaw sidecar (same host)
- Local DB
- Optional local model service

### Hybrid-optional local

Same as V1 plus explicitly enabled outbound hybrid model adapter.

## Open Questions (Implementation)

- Primary implementation stack (TS / Python / Rust / mixed)
- Event bus transport (in-process first vs Redis/NATS)
- Adapter transport (stdio/socket/RPC)
- Local indexing strategy (SQLite FTS / Tantivy / pgvector / etc.)
- Matrix homeserver recommendation
- Plugin/skill curation workflow (manual review vs signed registry)
