# Bundled Matrix Setup for Sovereign Node

## Purpose

Define the bundled Matrix deployment model used by the default `sovereign-ai-node` operator flow.

This document explains:

- what the installer must provision for Matrix
- what the operator must still provide in each connectivity mode
- safe defaults for the bundled profile
- how Element connects to the provisioned homeserver

This document focuses on the bundled setup path only. It does not define generic Matrix hosting beyond the `sovereign-ai-node` default profile.

Normative installer request/response schemas, defaults, and rollback semantics are defined in `docs/INSTALLER_CONTRACTS.md`.

## Scope and Defaults

The default bundled Matrix profile is:

- Synapse homeserver
- Postgres database
- reverse proxy with TLS termination
- private operator + managed-agent accounts
- private alert room for managed-agent notifications

Connectivity can run in one of two access modes:

- `direct`: node exposes Matrix endpoint itself (public domain or LAN/internal TLS)
- `relay`: node keeps Matrix local and publishes a public URL through a managed relay tunnel

Default posture (bundled mode):

- federation disabled unless explicitly enabled
- open registration disabled
- private room for alerts
- room encryption disabled by default until bot/plugin E2EE support is validated for the profile

## Why Matrix Setup Is a Real Setup Task (Even in a “Simple” UX)

The operator-facing UX should stay simple, but Matrix setup still has real infrastructure requirements:

- DNS and TLS
- reverse proxy routing for Matrix endpoints
- homeserver configuration
- account bootstrap
- room bootstrap and access control

The `sovereign-node` CLI and Wizard UI should automate these tasks for the default path instead of exposing them as manual steps.

## Recommended Install Ordering (Relative to OpenClaw Bootstrap)

Bundled Matrix provisioning is one phase inside the larger Sovereign install flow.

Recommended ordering in the default path:

1. Preflight checks
2. OpenClaw CLI bootstrap/install (official OpenClaw `install.sh`, pinned version, `--no-onboard`)
3. IMAP validation
4. Bundled Matrix provisioning and bootstrap (the sequence defined below)
5. Write Sovereign-managed OpenClaw config using the Matrix outputs (homeserver URL, mapped Matrix identities/tokens, alert room ID)
6. Install/repair OpenClaw gateway service (`openclaw gateway install`)
7. Register core agents/cron and run smoke checks

Why this order:

- OpenClaw must be present before Sovereign can reliably install/repair the gateway service.
- Matrix must be provisioned before final OpenClaw channel config can be written because Matrix outputs are needed for plugin/channel configuration.
- This keeps failure boundaries and retries aligned with `docs/INSTALLER_CONTRACTS.md`.

## Required Components (Bundled Stack)

The bundled Matrix stack should include:

- Synapse (Matrix homeserver)
- Postgres (Synapse database)
- reverse proxy (for example Caddy, Nginx, or Traefik)
- persistent volumes for database and Synapse data/media

Operator-facing implementation note:

- Docker Compose is the recommended default packaging for the bundled stack.

## Operator Inputs Required for Bundled Matrix

The installer cannot infer these values safely and must ask for them (CLI or Wizard).

`direct` mode requires:

- Matrix public domain/subdomain (for example `matrix.example.org`) or LAN host/IP for internal mode
- DNS control for public automatic TLS (not needed for LAN internal TLS)
- TLS mode (`auto`, `internal`, or `local-dev`)
- operator username for Element login
- whether federation should be enabled

`relay` mode requires:

- relay control URL
- relay enrollment token only for non-Sovereign/custom relays
- optional requested node name; leave it empty to keep the default random assignment

`relay` mode does not require a user-managed domain or inbound port forwarding.
Node hostname assignment in relay mode defaults to a Sovereign-generated random name. The installer can optionally request a specific node name and checks availability during enrollment.
The default managed relay is `https://relay.sovereign-ai-node.com`; the guided installer uses it automatically and does not prompt for an enrollment token in that path.

The installer should generate or provision:

- required core agent accounts
- operator/bootstrap credential reveal flow
- private alert room

## Bundled Provisioning Sequence (What the Installer Must Automate)

This is the Matrix-specific sub-sequence inside the recommended overall install ordering above.

The default install flow should provision Matrix in this order:

1. Validate domain resolves to the host (or warn before continuing).
2. Start Postgres and initialize database storage.
3. Start/configure Synapse with the selected `server_name` and public URL.
4. Start/configure reverse proxy with TLS and Matrix endpoint routing.
5. Verify Synapse health through the public endpoint.
6. Create operator account and required core agent accounts.
7. Create private alert room and invite operator + required core agents.
8. Persist homeserver URL, mapped Matrix identities/tokens, and alert room ID into Sovereign/OpenClaw config.
9. Run a Matrix send test before enabling core agent cron/background flows.

## Domain, TLS, and Discovery

### Simplest Path (Direct Mode)

Use a dedicated Matrix subdomain as both the homeserver name and public endpoint.

Example:

- homeserver domain: `matrix.example.org`
- public homeserver URL: `https://matrix.example.org`

Why this is simplest:

- fewer moving parts
- no required delegation for the default Element setup flow
- easier TLS and reverse proxy configuration

### When `.well-known` Matters

If you separate the user-facing domain from the actual Matrix host, discovery files may be required.

Client discovery (`/.well-known/matrix/client`) matters when you want Matrix clients (including Element) to discover the homeserver automatically from a different domain.

Server discovery (`/.well-known/matrix/server`) matters when federation is enabled and the Matrix server name is delegated to another host/port.

Bundled profile guidance:

- default bundled mode avoids delegation complexity
- enable delegation only when you need custom branding/domain topology
- if delegation is enabled, the installer should generate and validate the required `.well-known` JSON payloads

The requirement flags for client/server discovery checks are exposed by the `TestMatrixResult` schema in `docs/INSTALLER_CONTRACTS.md`.

## Reverse Proxy Requirements

The reverse proxy is part of the bundled stack and is not optional for public installs.

It must:

- terminate TLS
- route Matrix HTTP traffic to Synapse
- expose the Matrix endpoints required by the selected client/federation posture
- preserve request headers as required by Synapse deployment guidance

Use a reverse proxy configuration aligned with Synapse deployment guidance and test the public Matrix paths before bootstrapping accounts.

In `relay` mode, the node-side reverse proxy runs loopback-only and the public TLS endpoint is terminated on the managed relay.

## Synapse Configuration Defaults (Bundled Profile)

The bundled profile should set conservative defaults:

- closed registration (no public sign-up)
- federation disabled unless explicitly enabled
- explicit public base URL
- media and upload limits appropriate for alert-room usage
- logs enabled and persisted

The installer should avoid leaving bootstrap registration enabled after account creation.

## Account and Room Bootstrap

The bundled install must create a working operator channel, not just a homeserver.

Required bootstrap actions:

- create operator account (for Element login)
- create required core-agent accounts (for OpenClaw Matrix channel accounts)
- create private alert room
- invite operator and required core agents to the room
- persist room ID and mapped agent identities in config for alert delivery

Recommended access defaults:

- room is private/non-public
- operator account has admin/power required to manage the room
- each agent account has only the permissions needed for its role

## Element Connection Expectations

Phase-1 operator path uses an external Element client.

Supported paths:

- Element Desktop
- Element Mobile
- `app.element.io` using the provided homeserver URL

The installer must print or display:

- homeserver URL
- operator username
- one-time bootstrap code instructions for `/onboard` when HTTPS onboarding is enabled
- alert room name and room ID

## Onboarding Security Model

For HTTPS-backed bundled installs, `/onboard` is an onboarding helper page, not a password dump.

Current behavior:

- `/onboard` never embeds the operator password in HTML or JavaScript
- the installer issues a short-lived one-time onboarding code
- the operator enters that code into `/onboard`
- the onboarding API reveals the password once and then invalidates the code
- default TTL is 10 minutes
- operators can issue a fresh code with:

```bash
sudo sovereign-node onboarding issue
```

Bundled security rules:

- codes are single-use
- codes are stored server-side as salted hashes, not plaintext
- onboarding API responses must be `Cache-Control: no-store`
- local-dev (`http://...:8008`) installs do not expose the onboarding password flow

## Encryption (E2EE) Default for Alert Room

Encryption is a product/security choice, but it can reduce bot reliability if bot/plugin encryption support is not fully validated in the deployed profile.

Bundled default:

- private alert room without E2EE

Profile override:

- enable E2EE only in profiles where bot delivery and device verification behavior are tested end to end

## Security Baseline (Bundled Matrix)

Minimum bundled Matrix controls:

- TLS for public installs
- open registration disabled
- private alert room
- admin/bootstrap credentials rotated or constrained after setup
- persistent storage permissions restricted to the service runtime
- backups for Synapse DB and media

If federation is enabled:

- validate `.well-known` configuration
- restrict exposure to only required public endpoints
- document additional operational responsibilities (abuse handling, upgrades, federation diagnostics)

Failure and rollback behavior for partial bundled Matrix installs is defined in `docs/INSTALLER_CONTRACTS.md` and should be treated as part of the operator contract.

Relay v1 note:

- federation is intentionally disabled in relay mode

## Operations and Backup Expectations

Bundled Matrix is part of the platform and must be operated as a stateful service.

Minimum expectations:

- health check for Synapse public endpoint
- health check for database connectivity
- backup and restore procedure for Postgres and Synapse media/data
- upgrade runbook and rollback notes

## References (Checked February 25, 2026)

- Synapse installation: https://element-hq.github.io/synapse/latest/setup/installation.html
- Synapse reverse proxy guidance: https://element-hq.github.io/synapse/latest/reverse_proxy.html
- Synapse delegation (`.well-known`) guidance: https://element-hq.github.io/synapse/latest/delegate.html
- Matrix client-server spec (`.well-known` discovery): https://spec.matrix.org/latest/client-server-api/#well-known-uri
- Element Web install docs: https://web-docs.element.dev/Element%20Web/install.html
- Element Web config docs: https://web-docs.element.dev/Element%20Web/config.html
- Element account/login docs: https://web-docs.element.dev/Element%20Web/create-account.html
