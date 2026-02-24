# Open Core Boundary (Core vs Pro)

## Purpose

Define what remains in the open-core repository (`sovereign-ai-node`) and what belongs in the commercial repository (`sovereign-ai-node-pro`).

The goal is a clean product boundary without weakening the sovereignty value of the open-core platform.

## Principles

- Core must be useful and complete for self-hosting
- Pro extends operations, packaging, and maintained distribution
- Pro should integrate through stable interfaces, not patch core internals
- Sovereignty-critical functionality remains in core

## Open Core Includes (`sovereign-ai-node`)

- Node Kernel (event bus, scheduler, state, policy, audit)
- Matrix control plane integration
- Agent SDK and plugin contracts
- OpenClaw runtime adapter + sidecar integration contracts
- Plugin/skill governance policy (allowlists, capability scopes, audit hooks)
- Base connector framework
- Local model adapters
- Optional hybrid model adapter interfaces (and possibly community adapters)
- Base bots (starting with Mail Sentinel)
- Local deployment manifests/examples
- Self-hosted configuration and CLI

## Pro Includes (`sovereign-ai-node-pro`)

- Maintained appliance distributions/builds
- Signed release channels and compatibility manifests
- Zero-drift update orchestration
- Curated stable version bundles
- Read-only monitoring and diagnostics packages
- Hybrid acceleration services/policies (commercial packaged mode)
- Support bundle tooling and operational support workflows
- Team edition extensions (later)

## Feature Matrix

| Capability | Open Core | Pro |
|---|---|---|
| Self-hosted runtime | Yes | Yes (packaged) |
| Matrix control plane | Yes | Yes |
| Base bots | Yes | Yes |
| Mail Sentinel V1 | Yes | Yes (maintained) |
| OpenClaw runtime adapter | Yes | Yes (maintained packaging/integration) |
| Local models | Yes | Yes |
| Hybrid model support | Optional adapter support | Curated acceleration / managed policy bundles |
| Appliance images | Community/self-built | Maintained curated builds |
| Signed upgrade channels | No | Yes |
| Zero-drift updates | No | Yes |
| Read-only monitoring bundle | Basic local logs only | Yes |
| Commercial support workflows | No | Yes |
| Team edition features | Future (limited foundations only) | Planned |

## Boundary Guardrails

- Do not move core runtime primitives into Pro to force lock-in
- Do not make Matrix control plane a Pro-only feature
- Do not make local inference a Pro-only feature
- Do not move plugin/skill policy enforcement into Pro-only components
- Prefer Pro features that reduce operational burden, not user sovereignty

## Packaging Contract

Pro consumes:

- Tagged releases from core
- Stable extension interfaces
- Versioned event schemas

Core should publish:

- Semantic versioning for extension interfaces
- Compatibility notes for Pro integration
