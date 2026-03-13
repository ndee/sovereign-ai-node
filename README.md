# Sovereign AI Node

Open-core, local-first multi-bot infrastructure for sovereign digital control.

Sovereign AI Node is a self-hosted AI control plane for running specialized bots on your own infrastructure. It is not a single bot, not a SaaS wrapper, and not a cloud dashboard.

## Install

Run the guided installer on a fresh Ubuntu VM:

```bash
curl -fsSL https://raw.githubusercontent.com/ndee/sovereign-ai-node/main/scripts/install.sh | sudo bash
````

If you are working from a local checkout instead:

```bash
sudo bash scripts/install.sh --source-dir "$(pwd)"
```

## What it is

Sovereign AI Node is:

* local-first
* multi-bot by design
* Matrix-controlled
* open core
* cloud-optional
* privacy-first

It provides a self-hosted runtime for specialized bots, with Matrix as the operator-facing control plane.

## Current status

**Current focus:** Mail Sentinel on a single self-hosted Linux node.

Today, the project is centered on:

* Sovereign AI Node
* OpenClaw as the default runtime backend
* a bundled Matrix stack
* external Element clients
* Mail Sentinel as the first concrete module

The broader multi-bot system is the platform direction.
Mail Sentinel is the first real wedge.

## Why Matrix

Matrix is the control plane because it gives the system:

* rooms as natural operator surfaces
* bot-native interaction
* local or self-hosted deployment options
* a clean path to multi-bot coordination

## Core model

Sovereign AI Node separates **templates** from **runtime instances**:

* **Sovereign Agent Template** — defines workspace files, runtime expectations, and required tools
* **Sovereign Tool Template** — defines capability contracts and configuration requirements
* **Sovereign Tool Instance** — a concrete local binding with real config and credentials
* **Sovereign Agent** — a managed runtime bot with its own workspace and Matrix identity

## Current templates

### Agent templates

* `mail-sentinel@1.0.0`
* `node-operator@1.0.0`

### Tool templates

* `mail-sentinel-tool@1.0.0`
* `imap-readonly@1.0.0`
* `node-cli-ops@1.0.0`

## Mail Sentinel

Mail Sentinel is the first real module on Sovereign AI Node.

It:

* monitors a mailbox locally
* classifies incoming signals
* routes what matters into Matrix

Current signal categories:

* **Decision Required**
* **Financial Relevance**
* **Risk / Escalation**

Mail Sentinel does not train a model locally.
It becomes quieter and more accurate by adapting local runtime configuration and scoring behavior from feedback.

## Runtime strategy

Sovereign AI Node is **OpenClaw-first, adapter-safe**.

OpenClaw is the default execution framework today, but it sits behind a stable runtime boundary so the platform does not become permanently coupled to one runtime.

## Planned direction

The long-term direction is a modular bot system.

Planned bot families include:

* Mailbot
* Docsbot
* Calendarbot
* Opsbot
* Securitybot
* Financebot
* Researchbot

These are platform directions, not all currently shipped modules.

## Docs

See:

* `docs/ARCHITECTURE.md`
* `deploy/`
* `docs/MAIL_SENTINEL_DESIGN.md`
