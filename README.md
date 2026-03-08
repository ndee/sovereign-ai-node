# Sovereign AI Node

Local-first multi-agent infrastructure for sovereign digital control.

Sovereign AI Node is a self-hosted AI control plane for running multiple specialized agents on your own infrastructure.
It is not a single bot, not a SaaS wrapper, and not a cloud dashboard.

## Category

Sovereign AI Node defines a category:

- Self-Hosted AI Operating Infrastructure
- Multi-agent by design
- Matrix-based control plane
- Local-first, cloud-optional

## Core Thesis

In the AI era, the intelligence layer becomes the operating layer.
Systems that interpret information shape priorities, perception, and decisions.
Sovereign AI Node puts that layer back under local control.

## What This Repo Contains (Open Core)

`sovereign-ai-node` is the open-core foundation:

- Local runtime kernel
- Multi-agent framework contracts + runtime adapter boundary
- OpenClaw runtime adapter + curated plugin/skill gateway
- Matrix control plane integration
- Base tool connectors
- Local model + optional hybrid model adapters
- Core logic/event pipeline
- Base bots (starting with Mail Sentinel)

This repo is designed so the Pro edition can extend it without forking the core architecture.

## Core Concepts

Sovereign Node separates templates from runtime instances:

- `Sovereign Agent Template`
  - Signed, pinned manifest.
  - Defines OpenClaw workspace files (`AGENTS.md`, `TOOLS.md`, skills), Matrix localpart strategy, required/optional tool templates.
- `Sovereign Tool Template`
  - Signed, pinned manifest.
  - Defines capability contract, required config keys, required secret refs, and allowed command surface.
- `Sovereign Tool Instance`
  - Concrete, installation-local binding of a tool template.
  - Holds concrete `config` and `secretRefs` values.
  - Can be instantiated multiple times with different credentials.
- `Sovereign Agent`
  - Managed runtime agent with its own workspace and Matrix bot identity.
  - References an agent template (`templateRef`) and bound tool instances (`toolInstanceIds`).

## Core Templates (Current)

Signed core templates currently include:

- Agent templates:
  - `mail-sentinel@1.0.0`
  - `node-operator@1.0.0`
- Tool templates:
  - `imap-readonly@1.0.0`
  - `node-cli-ops@1.0.0`

Default install behavior:

- Installs/pins core templates.
- Instantiates core agents:
  - `mail-sentinel`
  - `node-operator`
- Instantiates core tool instances:
  - `node-operator-cli` (always)
  - `mail-sentinel-imap` (only when IMAP is configured)
- Sends hello messages from both core agents to the alert room.

## Optional Bot Packages

Additional installable bot packages can be added from the companion `sovereign-ai-bots` repository without changing runtime code.

Example optional package:

- `bali-compass@1.0.0`
  - Practical guide for travel, relocation, life, business, and Bitcoin in Bali and wider Indonesia

Useful commands:

- `sovereign-node bots list --json`
- `sovereign-node bots instantiate bali-compass --json`

For a non-interactive install example that includes the Bali bot, see `deploy/install-request.bali-compass.example.json`.

## Architecture Overview

### System Layers

1. `Control Plane`: Matrix homeserver + Element UI + bot identities/rooms
2. `Agent Layer`: specialized bots, isolated and stateful
3. `Tool Layer`: mail, files, calendar, APIs, local sources
4. `Logic Layer`: triggers, classification, workflows, persistent state
5. `Sovereignty Layer`: local models by default, hybrid optional, no telemetry

### Design Principles

- Local-first
- Modular
- Multi-bot
- Chat-as-interface
- Open core
- Hybrid optional
- Privacy by default
- Bitcoin-aligned optional

## Open Core vs Pro

- Open Core (`sovereign-ai-node`): functional self-hosted platform + base agents
- Pro (`sovereign-ai-node-pro`): maintained appliance, signed updates, hybrid acceleration, monitoring, support features

See:

- `docs/ARCHITECTURE.md`

## Planned Repo Architecture (Blueprint)

```text
sovereign-ai-node/
  docs/
  packages/
    core-kernel/
    control-plane-matrix/
    agent-sdk/
    runtime-openclaw/
    openclaw-skillpacks/
    tool-connectors/
      mail-imap/
      files-local/
      calendar-caldav/
    intelligence/
      classifiers/
      model-router/
    storage/
    bot-mail-sentinel/
    cli/
  deploy/
    compose/
    systemd/
  examples/
    configs/
```

The exact implementation language/runtime can evolve. The architecture emphasizes interfaces and isolation boundaries first.

## Multi-Bot Roadmap

- Phase 1: Mail Sentinel
- Phase 2: Docs + Calendar
- Phase 3: Multi-user / SMB edition foundations
- Phase 4: Sovereign AI Appliance product line

Planned bot families:

- Mailbot
- Docsbot
- Calendarbot
- Opsbot
- Securitybot
- Financebot
- Researchbot

## Runtime Strategy (OpenClaw-First, Adapter-Safe)

OpenClaw is the default agent execution framework for V1/V2, while the core architecture keeps a runtime adapter boundary to avoid lock-in.

That means:

- Sovereignty-critical concerns stay in the core kernel (state, policy, audit, scheduling)
- OpenClaw runs behind a stable `AgentRuntimeAdapter` (recommended as a sidecar/runtime boundary)
- OpenClaw plugins/skills are curated and policy-gated before production use
- High-risk capabilities (mail, files, secrets, outbound APIs) should be brokered by the kernel, not granted directly to arbitrary plugins
- OpenClaw can be replaced or supplemented later without redesigning the platform

## Ubuntu VM Install

Use the guided installer on a fresh Ubuntu VM:

```bash
sudo bash scripts/install.sh --source-dir "$(pwd)"
```

For remote bootstrap (`curl | bash`), pass a repo URL:

```bash
curl -fsSL https://raw.githubusercontent.com/ndee/sovereign-ai-node/main/scripts/install.sh | sudo bash
```

In interactive mode, the installer starts with an explicit action menu:

1. `Install (new / reconfigure)`
2. `Update (keep current settings)`
3. `Exit`

Default selection:

- fresh host: `Install`
- existing host: `Update`

The guided install flow then:

1. collects or reuses OpenRouter settings (default model: `openai/gpt-5-nano`)
2. provisions Sovereign Node + OpenClaw + bundled Matrix
3. installs and instantiates core templates/agents/tools
4. registers Mail Sentinel cron workflow
5. runs smoke checks and sends hello alerts from both core agents
6. prints a one-time Matrix onboarding code for the HTTPS onboarding page
7. keeps IMAP as pending unless you configure it

For HTTPS-backed Matrix installs (`direct` with `tlsMode=auto|internal` or `relay`):

- the onboarding page is `https://.../onboard`
- the operator password is not embedded in that page
- the installer prints a single-use bootstrap code valid for 10 minutes
- the user enters that code on `/onboard` to reveal the password once
- re-onboarding later requires `sudo sovereign-node onboarding issue`

After install, manage this model directly via CLI:

- `sovereign-node templates list --json`
- `sovereign-node templates install <id>@<version> --json`
- `sovereign-node tools list --json`
- `sovereign-node tools create <id> --template <id>@<version> --config k=v --secret-ref k=ref --json`
- `sovereign-node agents list --json`
- `sovereign-node agents create <id> --template <id>@<version> --tool-instance <id> --json`

### Connectivity Modes

Bundled Matrix supports:

- `direct`: public DNS/domain path
- `direct` + `tlsMode=internal`: LAN-only HTTPS with Caddy local CA
- `relay`: managed relay path (no user domain and no port forwarding)
  - default managed relay: `https://relay.sovereign-ai-node.com`
  - no enrollment token prompt on the default managed path
  - custom relays still require an enrollment token

Use `sovereign-node status --json` to confirm the active mode and relay state.

### Non-Interactive Action Control

For automation:

- `--install` forces install/reconfigure mode
- `--update` forces update mode
- `SOVEREIGN_NODE_ACTION=install|update` env override
- `--non-interactive` disables prompts

Manual verify:

- `sovereign-node status --json`
- `sovereign-node doctor --json`
- `sovereign-node logs --json`
- `sovereign-node onboarding issue --json`
