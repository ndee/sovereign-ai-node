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

## V1 Entry Module: Mail Sentinel

Version 1 starts with a single bot, `Mail Sentinel`, to prove the platform:

- `Decision Required`
- `Financial Relevance`
- `Risk / Escalation`
- Proactive alerts
- Local feedback-based improvement

Mail is the entry point, not the end state.

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

## Ubuntu VM Install (WIP)

This repo now includes a guided bootstrap installer for a fresh Ubuntu VM:

```bash
sudo bash scripts/install.sh --source-dir "$(pwd)"
```

For remote bootstrap (`curl | bash`), pass a repo URL:

```bash
curl -fsSL https://raw.githubusercontent.com/ndee/sovereign-ai-node/main/scripts/install.sh | sudo bash
```

The guided flow now:

1. Prompts for OpenRouter API key + model
2. Provisions Sovereign Node + OpenClaw + bundled Matrix
3. Installs/registers Mail Sentinel
4. Sends a hello alert message to the Matrix room
5. Lets you keep IMAP pending (configure now or later)

Manual verify:

- `sovereign-node status --json`
- `sovereign-node doctor --json`
