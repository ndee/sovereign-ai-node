# OpenClaw Plugin + Skill Governance (Architecture Policy)

## Purpose

Define how `sovereign-ai-node` can reuse as much OpenClaw functionality as possible without weakening sovereignty, auditability, or safety.

This document treats OpenClaw plugin/skill usage as an architectural concern (core runtime policy), not a convenience feature.

## Scope

This policy applies to:

- OpenClaw runtime usage behind `AgentRuntimeAdapter`
- OpenClaw plugins (official and community)
- OpenClaw skill loading (system/user/project/plugin-provided skills)
- Bot-specific allowlists and rollout controls

This policy does not replace:

- Kernel policy enforcement
- Connector-level security controls
- OS/container hardening

## Architecture Position

OpenClaw is the default bot execution engine for V1/V2, but `sovereign-ai-node` keeps control of:

- Scheduling and event dispatch
- Policy decisions
- Audit logs
- Durable state
- Secrets authority
- Capability brokerage for high-risk tools

OpenClaw plugins and skills are accelerators for bot behavior, not the platform authority.

## OpenClaw Reuse Strategy (What We Intend to Reuse)

Use OpenClaw aggressively for:

- Agent execution loop
- Tool invocation orchestration
- Bot behavior specialization via skill packs
- Selected integrations via curated plugins

Do not delegate these to OpenClaw as system-of-record responsibilities:

- Kernel state/audit persistence
- Unbounded file/mail/network access
- Permission policy enforcement
- Cross-bot lifecycle control

## Trust Model

### Trust Levels

- `Trusted`: core connectors, kernel broker tools, reviewed in-repo skill packs
- `Restricted`: curated/pinned OpenClaw plugins approved for a specific bot and scope
- `Blocked`: unreviewed community plugins, broad shell access, arbitrary local/project skill loading in production

### Core Rules

- Deny by default for plugins and skills in production
- Approve per bot, not globally
- Pin versions before rollout
- Log plugin loads, skill sources, and tool calls
- Route high-risk operations through the kernel `Capability Broker`

## Recommended OpenClaw Plugin/Skill Usage for Sovereign AI Node

Status definitions:

- `Adopt`: good fit for early use with normal controls
- `Restricted`: useful, but only with explicit scope/isolation
- `Avoid in Core`: can be used for prototypes or future bots, but not as a core dependency

| OpenClaw Capability | Status | Why / Usage Guidance |
|---|---|---|
| OpenClaw runtime (agent loop) | Adopt | Fastest path to V1/V2 bot behavior while keeping kernel invariants in core |
| In-repo OpenClaw skill packs (`packages/openclaw-skillpacks`) | Adopt | Best fit for bot-specific behavior with code review + version control |
| Plugin-provided skills (from approved plugins) | Restricted | Allow only if parent plugin is approved and pinned |
| User home/project auto-loaded skills | Restricted (dev), Blocked (prod default) | Great for iteration, risky for unattended production |
| `@openclaw/plugin-memory` | Restricted | Useful as agent-local scratchpad/cache, not durable source of truth |
| `@openclaw/plugin-shell` | Restricted (dev only) | High host access risk; use only in disposable sandbox/dev contexts |
| `@openclaw/plugin-github` | Restricted | Good for future Ops/Dev bots with scoped tokens and audit |
| `@openclaw/plugin-jira`, `@openclaw/plugin-notion`, `@openclaw/plugin-slack`, `@openclaw/plugin-discord` | Restricted | Useful for collaboration bots; require per-bot scopes and outbound allowlists |
| `@openclaw/plugin-gmail` | Avoid in Core | Prototype-only convenience; production mail path should use kernel IMAP connector for sovereignty/audit |
| `@openclaw/plugin-playwright`, `@openclaw/plugin-puppeteer`, `@openclaw/plugin-firecrawl` | Restricted | Useful for Researchbot/docs ingestion; isolate in dedicated sidecar/container |
| `@openclaw/plugin-context7`, `@openclaw/plugin-jina`, `@openclaw/plugin-exa` | Restricted | Useful for research/enrichment; outbound networking must be explicitly enabled |
| `@openclaw/plugin-redis`, `@openclaw/plugin-mongodb`, `@openclaw/plugin-neon`, `@openclaw/plugin-supabase`, `@openclaw/plugin-chromadb` | Avoid in Core | Optional integration adapters only; kernel storage remains primary system of record |
| `@openclaw/plugin-obsidian`, `@openclaw/plugin-figma` | Avoid in Core | Valuable for future user workflows, not V1 Mail Sentinel dependencies |
| Community plugins (ClawHub) | Restricted/Blocked by default | Require manual review, pinning, and staged rollout before production |

## Skill Policy (OpenClaw Skills)

OpenClaw skills are powerful, but they must be treated as trusted code/content in production contexts.

Production defaults:

- Load only reviewed in-repo skill packs for the assigned bot
- Disable automatic loading of user-local skills
- Disable project skill loading unless the project directory is trusted and pinned in deployment
- Allow plugin-provided skills only when the plugin itself is approved

Development defaults:

- Project skill loading can be enabled for fast iteration
- User-local skills can be enabled on developer machines only
- All dev/test skill usage should be visible in logs and disabled in CI/prod

## Plugin Policy (OpenClaw Plugins)

### Approval Requirements

Each plugin must have:

- Justification (which bot needs it and why)
- Version pin
- Capability map (files, network, secrets, APIs)
- Runtime isolation mode (dev sidecar, restricted sidecar, dedicated container)
- Rollback plan

### Runtime Controls

- Run OpenClaw in a sidecar process by default when plugins are enabled
- Use a dedicated OS user/container profile for high-risk plugins
- Restrict filesystem mounts to required paths only
- Restrict outbound network egress to approved hosts
- Pass short-lived scoped credentials where possible
- Prefer kernel broker wrappers over direct plugin host access for mail/files/secrets

## Safe Defaults (Deployment Configuration)

Suggested production posture (adapt to actual OpenClaw config format/version):

```jsonc
{
  "openclaw": {
    "mode": "sidecar",
    "plugins": {
      "allowlistOnly": true,
      "pinned": true
    },
    "skills": {
      "disableAutoLoad": true,
      "ignoreProjectSkills": true,
      "allowPluginProvidedSkills": false
    }
  },
  "runtime": {
    "trustedDirectories": [
      "/opt/sovereign-ai-node"
    ]
  }
}
```

For development:

- `ignoreProjectSkills` can be relaxed for the active repo
- `allowPluginProvidedSkills` can be enabled for approved plugins under test
- `plugin-shell` should still run only in a disposable/sandboxed environment

## Bot Capability Manifest (Recommended)

Define plugin/skill approvals per bot in a versioned manifest.

Example shape:

```yaml
bot: mail-sentinel
runtime:
  engine: openclaw
  isolation: sidecar
openclaw:
  plugins:
    - name: "@openclaw/plugin-memory"
      version: "x.y.z"
      status: restricted
  skills:
    - source: repo
      path: "packages/openclaw-skillpacks/mail-sentinel"
policy:
  capabilities:
    allow:
      - mail.read_metadata
      - mail.read_body
      - matrix.post_alert
      - state.read_bot
      - state.write_bot
    deny:
      - shell.exec
      - fs.write_host
      - api.outbound_unlisted
audit:
  log_plugin_loads: true
  log_skill_sources: true
  log_tool_calls: true
```

## Rollout Workflow (Required for New Plugins/Skills)

1. Review plugin/skill source and maintenance status
2. Classify capabilities and risk (host access, secrets, outbound network)
3. Add bot-scoped allowlist entry with version pin
4. Test in isolated sidecar/container with audit enabled
5. Promote to staging with real policy enforcement
6. Promote to production only after logs/policy behavior are validated

## V1 Mail Sentinel Policy

For V1 `Mail Sentinel`, default to:

- OpenClaw runtime + in-repo skill pack(s)
- Kernel-owned IMAP connector
- Kernel-owned Matrix delivery
- No `plugin-shell` in production
- No community plugins in production
- No plugin-managed durable state as source of truth

This maximizes OpenClaw reuse for bot behavior while keeping the sovereignty-critical perimeter in `sovereign-ai-node`.
