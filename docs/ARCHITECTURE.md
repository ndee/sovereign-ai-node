# Architecture

## Purpose

This is the single architecture document for `sovereign-ai-node`.
It defines the current architecture after reviewing the OpenClaw codebase and revising the OpenClaw integration strategy.

## Core Decision (Updated)

Sovereign AI Node uses OpenClaw with maximum leverage, but not as the sovereignty authority.

- OpenClaw Gateway is the primary runtime substrate for agent execution, sessions, cron, skills, tools catalog, and Matrix channel integration.
- Sovereign Node Kernel remains the authority for policy, secrets, audit, and product state.
- OpenClaw plugins/hooks/skills are treated as trusted code (governed and isolated), not as capability-sandboxed components.

## What This Repo Is

Sovereign AI Node is a self-hosted, local-first, modular multi-agent platform for personal/small-team operations.

Defaults:

- Local-first execution
- Always-on event processing
- Explicit permissions and auditability
- No mandatory telemetry
- Optional hybrid/cloud adapters behind policy

Non-goals (initial):

- Multi-tenant SaaS control plane
- Cloud-hosted default mode
- Closed-source core orchestration

## Architecture Model

### Main Layers

1. Sovereign Kernel (policy, audit, secrets, state, connector authority)
2. OpenClaw Gateway runtime (agent/session/cron/gateway substrate)
3. OpenClaw plugins/hooks/skills (curated, pinned, trusted extensions)
4. Sovereign connectors and classifiers (high-assurance and domain-specific logic)
5. Local persistence (Sovereign system of record + OpenClaw runtime state)

### Why This Model

OpenClaw already implements a large amount of stable runtime complexity (gateway methods, sessions, cron, auth scopes, channel plugins, hooks).
Sovereign should reuse that instead of re-implementing it in the kernel.

Sovereign still keeps product invariants and sovereignty-critical controls outside OpenClaw.

## Component Responsibilities

### Sovereign Kernel (System Authority)

Owns:

- Final policy decisions
- Secrets authority and credential issuance
- High-risk connector authority (especially production mail/files)
- Durable audit/event log (system of record)
- Product state and bot checkpoints
- Runtime profile compilation/validation for OpenClaw deployments

Does not own (by default):

- Generic chat gateway protocol implementation
- Generic session runtime and agent loop orchestration
- Generic cron scheduler implementation for V1

### OpenClaw Gateway Runtime (Execution Substrate)

Used as the default runtime substrate for V1/V2.

Owns (reused from OpenClaw):

- Agent runs and session lifecycle (`agent`, `agent.wait`, `sessions.*`)
- Cron scheduling/execution (`cron.*`, `wake`) for single-node V1
- Skills status/update surfaces (`skills.*`)
- Tool catalog and plugin tool registration (`tools.catalog`)
- Gateway auth/scopes and typed request/response protocol
- Matrix channel integration via the Matrix plugin (default path)

Does not own in Sovereign architecture:

- Final policy authority
- Sovereign audit system of record
- Sovereign secrets authority
- Sovereign durable business state

### OpenClaw Plugins, Hooks, and Skills (Trust Boundary)

This is a critical architectural clarification.

- Plugins/hooks/skills are trusted code once loaded into OpenClaw.
- Governance (allowlists, pins, provenance, reviews) reduces risk.
- Process/container isolation reduces blast radius.
- This is not a fine-grained capability sandbox.

Sovereign policy can strongly constrain kernel-owned connectors/tools, but it cannot fully constrain arbitrary plugin internals after load.

## Integration Strategy (Concrete)

### Primary Integration Seam: `OpenClawGatewayAdapter`

Sovereign integrates with OpenClaw primarily through the OpenClaw Gateway protocol (WebSocket request/response + events).

This replaces an overly abstract "agent sidecar RPC" assumption.

The adapter wraps OpenClaw methods such as:

- `agent`, `agent.wait`
- `sessions.*`
- `cron.*`, `wake`
- `skills.status`, `skills.update`
- `tools.catalog`
- `health`, `logs.tail` (ops)

Adapter requirements:

- Idempotency keys on mutating calls
- Error mapping into Sovereign error taxonomy
- Auth/scope-aware client credentials
- Versioned compatibility against tested OpenClaw releases

### ACP Usage (Optional)

ACP (`openclaw acp`) is useful for IDE/operator interactive workflows.
It is not the primary Sovereign runtime control protocol.

### Explicit Non-Decision

Do not depend on undocumented or unstable CLI-only modes as the core adapter seam.
Prefer the Gateway protocol and ACP surfaces.

## OpenClaw Runtime Profile (Sovereign-Owned)

Sovereign compiles a validated production runtime profile for OpenClaw instead of hand-editing OpenClaw config in production.

### `OpenClawRuntimeProfile` (conceptual)

The profile compiler controls:

- Gateway bind/auth/origin policy
- Plugin allowlist, pins, install provenance, plugin config
- Skills defaults and per-skill entries
- Hooks enablement and token/session routing policy
- Channel/plugin policy (including Matrix)
- Tool/exec/fs restrictions by agent
- Deployment assumptions (service user, workspace, mounts)

### Why It Is Core

This is where Sovereign turns OpenClaw from a flexible framework into a reproducible, policy-constrained runtime deployment.

## Production Security Baseline (Required)

### Gateway

- Bind to loopback by default
- Require auth for non-loopback exposure
- Require explicit allowed origins for non-loopback Control UI
- Use trusted-proxy mode only with explicit trusted proxy CIDRs

### Plugins

- `plugins.allow` must be explicit and non-empty in production when plugins are enabled
- Pin plugin versions/install provenance
- Treat OpenClaw loader provenance/path warnings as deployment errors in Sovereign
- Avoid mutable `plugins.load.paths` in production unless explicitly approved and immutable

### Skills

- Run OpenClaw under a dedicated service account/home directory
- Control workspace mounts to avoid unreviewed project/user skill sources
- Use curated in-repo or managed skills by default
- Do not assume skill config alone fully disables source classes; enforce via runtime environment and deployment layout

### Hooks

- Disable external hooks unless needed
- If enabled: require token, restrict agent routing, restrict session key prefixes
- Treat internal hook handlers as trusted code (same class as plugins)

### Isolation

- Run OpenClaw in a dedicated process/container profile
- Restrict filesystem mounts
- Restrict outbound network egress to approved destinations
- Split higher-risk plugins into separate runtimes when needed

## Stable Interfaces (Prioritize Early)

### Sovereign -> OpenClaw

- `OpenClawGatewayAdapter` (gateway method wrapper)
- OpenClaw version/protocol compatibility matrix
- Runtime profile compiler input/output schema

### Sovereign Internal

- Policy decision interface
- Audit/event sink interface
- Connector capability broker contract
- Model provider adapter interface
- Mail/event schemas

### Observability / Audit

- OpenClaw hook event mapping into Sovereign audit sink
- Tool/LLM lifecycle event schema normalization

## V1 Reference Architecture: Mail Sentinel

### Goal

Continuously evaluate inbound mail and alert on high-signal items.

### Key Boundary Decision

Production mail ingestion remains kernel-owned.
OpenClaw is used for agent execution/classification and operator-facing delivery/runtime surfaces.

### V1 Flow (Revised)

1. Sovereign mail connector ingests inbound message (`mail.received`).
2. Sovereign kernel applies policy and routing.
3. Kernel dispatches classification/extraction work via `OpenClawGatewayAdapter` (`agent`).
4. OpenClaw agent executes with curated skills/tools under a Sovereign-managed runtime profile.
5. Sovereign persists authoritative state/results and audit records.
6. Alert is delivered through OpenClaw Matrix plugin by default (or a kernel-owned Matrix path in high-assurance mode).
7. User feedback returns through Matrix/OpenClaw and is mirrored into Sovereign state/audit.

### V1 Trigger Classes

- `decision_required`
- `financial_relevance`
- `risk_escalation`

### V1 Storage Authority

Sovereign storage is authoritative for:

- Message metadata index
- Classification results
- Alert history
- Feedback corrections
- Bot state/checkpoints
- Sovereign audit logs

OpenClaw memory/plugins/transcripts are runtime accelerators or working state, not the source of truth.

## Matrix Control Plane Strategy (V1 Default)

Default: reuse OpenClaw Matrix plugin.

Why:

- OpenClaw already provides a Matrix channel plugin and gateway/channel runtime plumbing.
- This removes a large amount of early integration complexity.

Alternative (later / high-assurance mode):

- Sovereign-owned Matrix bridge for stricter separation or specialized policy requirements.

## Open Core vs Pro Boundary (Revised)

Principle: open core remains self-hostable and sovereignty-complete; Pro adds packaging, validation, and operational reliability.

### Open Core (`sovereign-ai-node`)

Includes:

- Sovereign Kernel (policy, audit, secrets, state, connectors)
- OpenClaw Gateway adapter and compatibility matrix
- OpenClaw runtime profile compiler + validators
- Plugin/skill/hook governance policy and deployment checks
- Base connector framework (including production mail path)
- Base bots (starting with Mail Sentinel)
- Self-hosted config/CLI/manifests

### Pro (`sovereign-ai-node-pro`)

Adds:

- Maintained appliance builds and runtime bundles
- Signed compatibility bundles (core + OpenClaw + profile schema)
- Zero-drift update orchestration and validation
- Read-only monitoring/diagnostics/support workflows
- Optional hybrid acceleration packages

Guardrails:

- Do not move policy/audit/secrets authority into Pro
- Do not make local-first runtime or Matrix control plane Pro-only
- Do not make runtime profile enforcement a Pro-only feature

## Deployment Topologies (Initial)

### Single-node Local (V1)

- Sovereign kernel service
- OpenClaw Gateway runtime (same host, loopback-bound)
- OpenClaw Matrix plugin enabled (default)
- Local DB/object storage
- Optional local model service

### Hardened Single-node Local (Production)

Same as V1 plus:

- Dedicated OpenClaw service account
- Restricted filesystem mounts
- Restricted egress
- Pinned plugin installs and curated skills/hooks
- Signed/validated runtime profile

## Assumptions and Defaults

- OpenClaw cron is accepted for single-node V1 scheduling; Sovereign may replace/supplement later for distributed requirements.
- OpenClaw Gateway protocol is the primary adapter seam.
- OpenClaw plugins/hooks/skills are governed as trusted code, not sandboxed capabilities.
- Sovereign remains the system of record for audit and durable product state.
- OpenClaw versions must be pinned and tested against a compatibility matrix.

## Open Questions (Implementation)

- Primary implementation stack (TS / Python / Rust / mixed)
- Exact `OpenClawGatewayAdapter` client implementation language/runtime
- Runtime profile schema/versioning strategy
- Sovereign audit mirror granularity from OpenClaw hooks/events
- When to introduce a separate high-assurance Matrix path (if ever)
