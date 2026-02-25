# Architecture

## Purpose

This document defines the current core architecture of `sovereign-ai-node`.

It describes the platform as an OpenClaw-native, self-hosted runtime package:

- OpenClaw Gateway is the runtime substrate
- Sovereign AI Node provides reproducible configuration, curated extensions, and bot packs
- Bot-specific designs are documented separately

## Scope

This document covers the core platform only:

- Runtime substrate
- Core extension model
- Security baseline
- Operational model
- Stable repo-owned contracts

This document does not include bot-specific design details.

## Core Principles

- Local-first operation
- OpenClaw-native runtime usage (configure and run)
- CLI-first operations
- Explicit allowlists and least privilege
- Reproducible deployments (pinned config, plugins, skills)
- No mandatory telemetry

## Core Runtime Model

### Runtime Substrate: OpenClaw Gateway

OpenClaw Gateway is the primary runtime for `sovereign-ai-node`.

Core capabilities reused directly from OpenClaw:

- Agent execution and session lifecycle
- Multi-agent routing and isolated workspaces
- Cron scheduling and background jobs
- Skills loading and per-agent skill allowlists
- Tool catalog and plugin tool registration
- Channel integrations (including Matrix via plugin)
- Gateway auth/scopes and CLI/API control surfaces

`sovereign-ai-node` does not replace these capabilities. It standardizes and constrains how they are configured and used.

### Agents and Workspaces

Agents are standard OpenClaw agents.

Each agent uses a dedicated OpenClaw workspace and prompt files (for example `AGENTS.md`, `SOUL.md`, `TOOLS.md`) plus curated skills.

Core rules:

- One workspace per agent role
- Per-agent tool policy is explicit
- Per-agent skill allowlist is explicit
- Agent behavior lives in versioned workspace templates and skill packs

Packaging rule:

- Domain bot behavior belongs in agents (workspace + skills + tool policy)
- Reusable integrations and capability surfaces belong in plugins/tools
- Do not package a full bot as an all-in-one plugin by default

### Plugins, Hooks, and Skills (Trust Model)

OpenClaw plugins, hooks, and skills are treated as trusted code once loaded.

Operational implications:

- Use explicit plugin allowlists (`plugins.allow`)
- Pin plugin versions and install provenance
- Curate skills and restrict load locations
- Review changes before rollout
- Use process/container isolation to reduce blast radius

This architecture does not assume plugins/skills are capability-sandboxed after load.

## Core Configuration Model

### Sovereign Runtime Profiles (OpenClaw Config Templates)

The core configuration artifact is a versioned OpenClaw config profile (JSON/JSON5), not a separate runtime service.

A profile defines:

- Gateway bind/auth/origin policy
- Plugin inventory and plugin config (`plugins.allow`, `plugins.entries.*`)
- Channel configuration and allowlists
- Agent list, workspaces, identities, and routing bindings
- Per-agent tool policy (`tools.profile`, `agents.list[].tools.*`)
- Per-agent skill allowlists (`agents.list[].skills`)
- Sandbox settings (`agents.defaults.sandbox`, `agents.list[].sandbox`)
- Cron enablement and scheduling defaults
- Diagnostics/logging settings

### Skills Configuration and Source Control

OpenClaw supports bundled, managed (`~/.openclaw/skills`), and workspace skills, plus `skills.load.extraDirs`.

Core deployment policy:

- Prefer curated workspace or managed skills
- Keep skill source locations explicit
- Avoid unreviewed mutable skill sources in production
- Use `agents.list[].skills` to constrain which skills a bot may use

## Core Security Baseline

### Gateway

- Bind to loopback by default
- Require auth for non-loopback access
- Set explicit allowed origins for Control UI when exposed
- Keep privileged gateway access tokens scoped and rotated

### Plugins

- Set `plugins.allow` explicitly in controlled environments
- Enable only required plugins
- Pin plugin versions/packages
- Avoid broad mutable plugin load paths in production
- Run plugin-bearing runtimes under a dedicated service account

### Skills

- Curate skill sources and load paths
- Restrict per-agent skill usage with `agents.list[].skills`
- Treat third-party skills as reviewed code, not “just prompts”
- Keep secrets out of skill text and use config/env injection where needed

### Tool Policy and Sandbox

- Use restrictive per-agent tool policy by default
- Use explicit allowlists for sensitive agents
- Deny shell/exec/edit tools unless intentionally required
- Use OpenClaw sandboxing for agents that process untrusted content
- Restrict sandbox mounts and network egress

### Channels and Access Control

- Use channel-level allowlists and pairing/default-safe policies
- Restrict group/room participation explicitly
- Prefer provider-native stable IDs over display names in allowlists

## Core Persistence and State

OpenClaw stores runtime state locally (config, sessions, cron, credentials, workspaces).

`sovereign-ai-node` treats these as core operational assets and manages them through:

- Versioned profile templates
- Deployment runbooks
- Backups and restore procedures
- Security audits and config validation

Core expectations:

- Persist `~/.openclaw` and agent workspaces
- Back up config, credentials, cron state, and workspaces
- Keep workspace content under version control where appropriate (private repos)

## Operational Model (CLI-First)

OpenClaw CLI remains the primary runtime/operator interface.

If `sovereign-ai-node` adds its own CLI, it should live next to `openclaw` rather than hiding it.

CLI policy:

- `openclaw` handles runtime-native operations (agents, plugins, channels, cron, health, security audit)
- `sovereign-node` (optional) handles profile application, bot pack install/sync, and opinionated helper workflows
- OpenClaw CLI remains available for debugging, advanced operations, and break-glass use

Typical lifecycle:

- Install/OpenClaw onboarding (`openclaw setup` / `openclaw onboard`)
- Install and enable required plugins
- Create/configure agents (`openclaw agents ...`)
- Apply runtime profile config
- Configure channels (for example Matrix plugin + channel config)
- Configure cron jobs
- Run health and security checks (`openclaw health`, `openclaw status`, `openclaw security audit`)

Repo helper scripts may automate repeated CLI sequences, but the runtime remains standard OpenClaw.

## Core Repo Artifacts

The core repo should contain:

- OpenClaw runtime profile templates
- Plugin inventory and governance docs
- Agent workspace templates
- Curated skill packs
- First-party OpenClaw plugins/tools (when needed)
- Optional helper CLI/wrappers that compose OpenClaw CLI (not replace it)
- Security and operations runbooks

## Stable Contracts (Core)

The following contracts should be kept stable and versioned in this repo:

- OpenClaw runtime profile template schema conventions (repo-defined structure and defaults)
- Plugin inventory/allowlist policy and pinning rules
- Agent workspace pack layout conventions
- Skill pack naming and activation conventions
- Agent-vs-plugin packaging conventions (bot behavior vs reusable capability plugins)
- Operator CLI coexistence policy (`openclaw` + optional `sovereign-node`)
- Bot output schemas (defined in bot-specific design docs)
- Operational runbook commands and validation checklist

## Bot-Specific Designs

Bot behavior and domain logic are specified in separate design documents.

Example:

- `docs/MAIL_SENTINEL_DESIGN.md`
