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
- Multi-agent framework contracts
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
- `docs/OPEN_CORE_BOUNDARY.md`
- `docs/ADR-0001-AGENT-RUNTIME.md`

## Planned Repo Architecture (Blueprint)

```text
sovereign-ai-node/
  docs/
  packages/
    core-kernel/
    control-plane-matrix/
    agent-sdk/
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

## Framework Note (OpenClaw)

OpenClaw can be used as the initial agent execution framework, but the core architecture keeps a runtime adapter boundary to avoid framework lock-in.

That means:

- Sovereignty-critical concerns stay in the core kernel (state, policy, audit, scheduling)
- Agent execution frameworks plug in behind a stable interface
- OpenClaw can be replaced or supplemented later without redesigning the platform

