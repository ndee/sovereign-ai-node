# ADR-0001: Agent Runtime Strategy (OpenClaw + Adapter Boundary)

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

Adopt an adapter-first runtime strategy:

- Use OpenClaw as the initial agent execution engine (subject to fit during implementation)
- Keep sovereignty-critical orchestration in the Node Kernel
- Integrate OpenClaw through a stable `AgentRuntimeAdapter` interface

## Rationale

This balances speed and control:

- Fast path: leverage an existing agent framework for bot behavior
- Safe path: keep scheduling, policy, state, and audit independent of framework internals
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
- Structured action outputs back to the kernel

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
- Enables cleaner open-core/pro integration

Tradeoff:

- Requires careful interface design up front
- Some duplicated abstractions may exist between kernel and runtime framework

## Next Validation Steps

1. Prototype `Mail Sentinel` classification flow behind `AgentRuntimeAdapter`
2. Validate long-running state + restart behavior
3. Validate Matrix round-trip latency and reliability
4. Confirm OpenClaw can operate within explicit policy and audit constraints

