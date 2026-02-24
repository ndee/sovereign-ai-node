# ADR-0001: Agent Runtime Strategy (OpenClaw-First + Adapter Boundary)

## Status

Proposed

## Context

Sovereign AI Node needs an agent execution framework to accelerate implementation of specialized bots (starting with Mail Sentinel).

The user preference is to use OpenClaw, but the product has requirements that exceed a typical agent framework:

- Local-first operation
- Always-on stateful bots
- Explicit auditability
- Durable triggers/workflows
- Strict sovereignty and policy boundaries
- Future commercial extensions without architectural lock-in

## Decision

Adopt an OpenClaw-first, adapter-safe runtime strategy:

- Use OpenClaw as the default agent execution engine for V1/V2 bots
- Keep sovereignty-critical orchestration in the Node Kernel
- Integrate OpenClaw through a stable `AgentRuntimeAdapter` interface
- Prefer running OpenClaw as a sidecar/runtime boundary (not in the kernel process) to reduce plugin blast radius
- Require curated plugin/skill governance before enabling OpenClaw plugins/skills in production bots

## Rationale

This balances speed and control:

- Fast path: leverage an existing agent framework, plugin ecosystem, and skill system for bot behavior
- Safe path: keep scheduling, policy, state, audit, and secrets independent of framework internals
- Future path: replace or supplement OpenClaw without breaking bot-facing platform contracts

## What Stays in the Node Kernel

- Event ingestion and dispatch
- Trigger scheduling
- Policy/permissions evaluation
- Audit/event logging
- State persistence/checkpoints
- Capability registration and enforcement

## What the Agent Runtime (OpenClaw) Can Own

- Agent execution loop
- Prompt/tool invocation orchestration (within policy limits)
- Agent-local reasoning steps
- Curated skill packs for bot behavior specialization
- Curated plugins for low/medium-trust integrations and local tooling
- Structured action outputs back to the kernel

## What OpenClaw Must Not Own Directly

- Kernel authority (scheduling, event dispatch, policy decisions)
- Sovereign system-of-record state (audit log, durable checkpoints, core bot state)
- Unbounded secrets access
- Unreviewed plugin/skill loading in production contexts
- Direct access to high-risk capabilities when a kernel broker is available

## Alternatives Considered

### 1. Full OpenClaw-Centric Architecture

Pros:

- Faster initial development

Cons:

- Higher lock-in risk
- Harder to enforce sovereignty-specific invariants
- Kernel concerns become framework-coupled

### 2. Fully Custom Runtime from Day 1

Pros:

- Maximum control

Cons:

- Slower time to V1
- Higher implementation risk before product validation

### 3. Graph/Workflow Framework First (without agent framework)

Pros:

- Strong orchestration guarantees

Cons:

- Slower bot behavior iteration
- May require separate agent abstraction later

## Consequences

Positive:

- Preserves modularity and long-term maintainability
- Maximizes reuse of OpenClaw capabilities for faster V1/V2 delivery
- Enables cleaner open-core/pro integration

Tradeoff:

- Requires careful interface design up front
- Some duplicated abstractions may exist between kernel and runtime framework
- Adds an operational boundary (sidecar + policy manifests + plugin/skill curation)

## Next Validation Steps

1. Prototype `Mail Sentinel` classification flow behind `AgentRuntimeAdapter`
2. Validate sidecar crash isolation and restart behavior (kernel remains healthy)
3. Validate Matrix round-trip latency and reliability through the adapter boundary
4. Confirm plugin/skill allowlisting, capability scoping, and audit hooks work end-to-end
5. Confirm OpenClaw can operate within explicit policy and audit constraints without bypasses
