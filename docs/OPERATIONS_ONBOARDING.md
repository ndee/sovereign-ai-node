# Sovereign Node Operator Onboarding

## Purpose

Define the operator-facing install and run flow for `sovereign-ai-node`.

This is the phase-A documentation contract for:

- a CLI-first install experience
- a Sovereign Wizard UI (web UI) built on the same backend logic
- a bundled Matrix stack default
- side-by-side use of `openclaw` for runtime inspection and troubleshooting

If the `sovereign-node` CLI or Wizard UI is not implemented yet in your build, this document defines the intended operator flow and command contract.

## Audience

- Self-hosting operators who want the easiest possible setup path
- Engineers implementing the `sovereign-node` CLI and Wizard UI
- Operators who need a concise runbook for first install and verification

## Default Operator Promise (Simple UX)

The target operator experience is intentionally simple:

1. Set IMAP credentials
2. Install
3. Connect Element to Matrix
4. Wait for mail alerts

This is the right UX goal.

## Simple Flow vs Hidden Automation

The simple 4-step promise is only possible if the installer automates the setup work behind it.

The operator should not need to manually do these steps in the default path, but the platform still must do them:

- Validate IMAP connectivity, TLS, and credentials
- Store secrets securely and configure the read-only IMAP plugin
- Install and configure OpenClaw with pinned plugins and agent config
- Register the `mail-sentinel` agent and cron polling job
- Provision the bundled Matrix stack (Synapse, Postgres, reverse proxy, TLS)
- Create Matrix operator and bot accounts
- Create a private alert room and store the room target
- Run health checks and send a test alert

Details of the bundled Matrix setup are defined in `docs/MATRIX_BUNDLED_SETUP.md`.

## Default Deployment Mode

Phase-A documentation assumes the default path is:

- single Linux host
- bundled Matrix stack (Synapse + Postgres + reverse proxy)
- Docker Compose deployment for the bundled services
- `Mail Sentinel` as a standard OpenClaw agent
- external Element client (Element Desktop, mobile, or `app.element.io`)

Default operational posture for the bundled profile:

- Matrix federation disabled unless explicitly enabled
- Matrix open registration disabled
- private alert room by default
- alert room encryption disabled by default until bot/plugin E2EE support is validated for the profile

## Install Surfaces (How Operators Interact)

`sovereign-ai-node` supports multiple operator surfaces for the same system.

- `sovereign-node` CLI: easiest happy-path install and reconfigure flows
- Sovereign Wizard UI: guided web setup and status flow
- `openclaw` CLI: runtime-native inspection, debugging, and break-glass operations

Core rule:

- The CLI and Wizard UI must call the same installer/provisioning backend logic.

## CLI-First Happy Path

### Prerequisites (Operator Inputs)

The default bundled install still needs a few real inputs:

- A Linux host you control
- A public domain or subdomain for Matrix (for example `matrix.example.org`)
- DNS access for that domain
- IMAP server hostname, port, TLS mode, username, and password or app password
- Outbound network access to IMAP host, model provider(s), and Matrix endpoints

### Primary Command (Target Contract)

The main operator command should be:

```bash
sovereign-node install
```

This command is interactive by default and should complete the full default setup.

### What `sovereign-node install` Must Do

In the default bundled mode, the installer should perform these steps in order:

1. Run preflight checks (ports, disk, DNS resolution, container runtime, clock).
2. Collect and test IMAP credentials.
3. Collect Matrix domain settings and apply safe defaults.
4. Provision the bundled Matrix stack.
5. Create Matrix operator account and bot account.
6. Create a private alert room and invite both accounts.
7. Install/configure OpenClaw and required plugins.
8. Register `mail-sentinel` agent config, skills, and cron polling job.
9. Run health checks and a synthetic test alert.
10. Print Element connection details and next steps.

### CLI Commands for Ongoing Operations (Target Contract)

Recommended operator command set:

- `sovereign-node status`
- `sovereign-node doctor`
- `sovereign-node logs`
- `sovereign-node test-alert`
- `sovereign-node reconfigure imap`
- `sovereign-node reconfigure matrix`

`openclaw` remains fully supported for runtime-native operations:

- `openclaw health`
- `openclaw status --deep`
- `openclaw plugins doctor`
- `openclaw cron list`
- `openclaw cron runs --id <job-id>`
- `openclaw security audit --deep`

## Element Connection (Operator Step 3)

After install, the operator connects an Element client to the provisioned Matrix homeserver.

Phase-1 supported client paths:

- Element Desktop
- Element Mobile
- `app.element.io` with a custom homeserver

The installer output should provide:

- Matrix homeserver URL
- operator username (Matrix user ID or localpart)
- password or password-reset instructions
- expected alert room name and room ID
- a quick check command (`sovereign-node test-alert`)

## Wait for Mail Alerts (Operator Step 4)

Before the operator “just waits,” the system must prove the path works.

Required post-install verification:

- Run a synthetic test alert to the Matrix room
- Confirm the `mail-sentinel` cron job exists and is enabled
- Confirm OpenClaw health is green
- Confirm last IMAP credential test succeeded

Minimum runtime signals the operator should be able to inspect:

- last poll time
- last alert time
- last error
- consecutive failure count

## Sovereign Wizard UI (Web UI, Same Backend Logic)

The Wizard UI is a guided alternative to the CLI-first flow and must reuse the same installer/provisioning backend.

Recommended Wizard flow:

1. Preflight
2. IMAP Credentials
3. Matrix Setup (Bundled)
4. Install and Provision
5. Element Connect
6. Send Test Alert
7. Status

Wizard design constraints:

- Do not duplicate provisioning logic in frontend code
- Show step-level progress and failures for long-running installs
- Surface the same defaults as the CLI
- Keep `openclaw` visible for advanced troubleshooting

## Troubleshooting (First Response)

If the simple flow fails, the operator should check these first:

- `sovereign-node doctor`
- `openclaw health`
- `openclaw status --deep`
- Matrix service health and reverse proxy status
- IMAP connectivity test and credential validity
- alert room target and bot membership

## Related Docs

- `docs/ARCHITECTURE.md`
- `docs/MAIL_SENTINEL_DESIGN.md`
- `docs/MATRIX_BUNDLED_SETUP.md`
