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
- Operator install surfaces (CLI and wizard)
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

### Sovereign Template and Instance Model

Sovereign Node introduces a signed, pinned catalog on top of OpenClaw runtime primitives.

Core entities:

- `Sovereign Agent Template` (`kind: sovereign-agent-template`)
  - Signed manifest.
  - Defines agent workspace files, Matrix localpart prefix policy, and tool-template requirements.
- `Sovereign Tool Template` (`kind: sovereign-tool-template`)
  - Signed manifest.
  - Defines capability contract, required config keys, required secret refs, and allowed command surface.
- `Sovereign Tool Instance`
  - Installation-local instance of a tool template with concrete config and secret references.
  - Supports multiple instances per template for multi-account/service scenarios.
- `Sovereign Agent` (managed runtime agent)
  - OpenClaw agent entry with:
    - `templateRef`
    - `toolInstanceIds`
    - dedicated workspace
    - dedicated Matrix bot identity

Default core templates currently shipped by this repo:

- Agent templates:
  - `mail-sentinel@1.0.0`
  - `node-operator@1.0.0`
- Tool templates:
  - `imap-readonly@1.0.0`
  - `node-cli-ops@1.0.0`

### Agents and Workspaces

Agents are standard OpenClaw agents instantiated from Sovereign agent templates.

Each agent uses a dedicated OpenClaw workspace and prompt files (for example `AGENTS.md`, `SOUL.md`, `TOOLS.md`) plus curated skills.

Core rules:

- One workspace per agent role
- Per-agent tool policy is explicit
- Per-agent skill allowlist is explicit
- Agent behavior lives in signed, versioned template workspace files and skill packs

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

Additionally, Sovereign runtime config persists:

- installed/pinned template inventory (`templates.installed`)
- managed tool instances (`sovereignTools.instances`)
- managed agent topology with template/tool bindings (`openclawProfile.agents[]`)

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

- Default operator path: `sovereign-node install` bootstraps OpenClaw (official `install.sh`, pinned version, `--no-onboard`)
- Install/repair the OpenClaw gateway service (`openclaw gateway install`) after Sovereign writes the runtime config
- Install and enable required plugins
- Install/pin templates (`sovereign-node templates ...`)
- Create/configure tool instances (`sovereign-node tools ...`)
- Create/configure agents (`sovereign-node agents ...`)
- Apply runtime profile config
- Configure channels (for example Matrix plugin + channel config)
- Configure cron jobs
- Run health and security checks (`openclaw health`, `openclaw status`, `openclaw security audit`)

Repo helper scripts may automate repeated CLI sequences, but the runtime remains standard OpenClaw.

## Operator Install Surfaces (CLI and Wizard)

`sovereign-ai-node` may expose operator-friendly install and onboarding surfaces on top of the OpenClaw runtime, but these do not replace OpenClaw itself.

Supported surface model:

- `sovereign-node` CLI for opinionated install, reconfigure, status, and diagnostics workflows
- Sovereign Wizard UI (web UI) for guided onboarding and day-1 operations
- `openclaw` CLI for runtime-native inspection, debugging, and break-glass operations

Core rules:

- `openclaw` remains available and documented
- The default Sovereign install path owns host bootstrap, including OpenClaw installation
- Sovereign uses the official OpenClaw installer flow and skips `openclaw onboard` in the default path
- CLI and Wizard should use the same installer/provisioning backend logic (no duplicated provisioning implementations)
- The wizard is an operator setup/status UI, not a replacement for Element or other end-user chat clients
- Operator flows may simplify setup (for example bundled Matrix), but must preserve explicit configuration and auditability

Related docs define the operator journey, deployment defaults, and installer contracts:

- `docs/OPERATIONS_ONBOARDING.md`
- `docs/MATRIX_BUNDLED_SETUP.md`
- `docs/INSTALLER_CONTRACTS.md`

## Core Repo Artifacts

The core repo should contain:

- OpenClaw runtime profile templates
- Plugin inventory and governance docs
- Agent workspace templates
- Curated skill packs
- First-party OpenClaw plugins/tools (when needed)
- Optional helper CLI/wrappers that compose OpenClaw CLI (not replace it)
- Security and operations runbooks
- Operator onboarding runbook (`docs/OPERATIONS_ONBOARDING.md`)
- Bundled Matrix setup runbook (`docs/MATRIX_BUNDLED_SETUP.md`)
- Installer/API/CLI contract doc (`docs/INSTALLER_CONTRACTS.md`)

## Stable Contracts (Core)

The following contracts should be kept stable and versioned in this repo:

- OpenClaw runtime profile template schema conventions (repo-defined structure and defaults)
- Plugin inventory/allowlist policy and pinning rules
- Agent workspace pack layout conventions
- Skill pack naming and activation conventions
- Agent-vs-plugin packaging conventions (bot behavior vs reusable capability plugins)
- Operator CLI coexistence policy (`openclaw` + optional `sovereign-node`)
- CLI/Wizard backend reuse policy (one provisioning implementation, multiple operator surfaces)
- Sovereign-managed OpenClaw bootstrap policy (official installer usage, pinning, `--no-onboard`)
- Installer/CLI/API schema contracts and failure semantics (`docs/INSTALLER_CONTRACTS.md`)
- Bot output schemas (defined in bot-specific design docs)
- Operational runbook commands and validation checklist

## Bot-Specific Designs

Bot behavior and domain logic are specified in separate design documents.

Example:

- `docs/MAIL_SENTINEL_DESIGN.md`
