# Sovereign Node Operator Onboarding

## Purpose

Define the operator-facing install and run flow for `sovereign-ai-node`.

This is the phase-A documentation contract for:

- a CLI-first install experience
- a Sovereign Wizard UI (web UI) built on the same backend logic
- a bundled Matrix stack default
- side-by-side use of `openclaw` for runtime inspection and troubleshooting

If the `sovereign-node` CLI or Wizard UI is not implemented yet in your build, this document defines the intended operator flow and command contract.

Normative command and API schemas are defined in `docs/INSTALLER_CONTRACTS.md`.

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
- Install OpenClaw itself (pinned version) using the official OpenClaw installer and skip OpenClaw onboarding
- Install/repair the OpenClaw gateway service after Sovereign writes the runtime config
- Configure OpenClaw with pinned plugins and agent config
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

Contract note:

- CLI JSON output formats and backend job API schemas are defined in `docs/INSTALLER_CONTRACTS.md`

## CLI-First Happy Path

### Prerequisites (Operator Inputs)

The default bundled install still needs a few real inputs:

- A Linux host you control
- `sudo`/root access on that host (default system install path)
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

For a fresh machine, the target two-command operator flow is:

```bash
curl -fsSL <sovereign-node-installer-url> | sudo bash
sudo sovereign-node install
```

Notes:

- `sovereign-node install` owns OpenClaw installation in the default path.
- Operators should not run `openclaw onboard` in the default Sovereign flow.

### What `sovereign-node install` Must Do

In the default bundled mode, the installer should perform these steps in order:

1. Run preflight checks (ports, disk, DNS resolution, container runtime, clock).
2. Install OpenClaw CLI using the official OpenClaw installer script (pinned version, `--no-onboard`, non-interactive).
3. Verify the installed OpenClaw version is the Sovereign-pinned compatible version.
4. Collect and test IMAP credentials.
5. Collect Matrix domain settings and apply safe defaults.
6. Provision the bundled Matrix stack.
7. Create Matrix operator account and bot account.
8. Create a private alert room and invite both accounts.
9. Write Sovereign-managed OpenClaw config/profile and secrets references.
10. Install/repair the OpenClaw gateway service and start it.
11. Install/configure required OpenClaw plugins.
12. Register `mail-sentinel` agent config, skills, and cron polling job.
13. Run health checks and a synthetic test alert.
14. Print Element connection details and next steps.

### OpenClaw Bootstrap in the Default Sovereign Flow

Sovereign installs OpenClaw on the machine as part of `sovereign-node install`.

Default bootstrap behavior:

- use the official OpenClaw installer script (`install.sh`)
- install a Sovereign-pinned OpenClaw version (not floating `latest`)
- skip OpenClaw onboarding (`--no-onboard`)
- run non-interactively in the installer backend

The default internal command pattern is:

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | \
  bash -s -- --version <sovereign-pinned-openclaw-version> --no-onboard --no-prompt
```

Sovereign then installs the gateway service after writing Sovereign-managed config:

```bash
openclaw gateway install
```

Use `openclaw gateway install --force` when the installer needs to rewrite an existing service entry.

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

### Advanced / Manual OpenClaw Path (Supported, Not Default)

If OpenClaw is already installed on the host, `sovereign-node install` should:

- detect the existing OpenClaw CLI
- reuse it when it matches the Sovereign-pinned compatible version
- repair/reinstall only when incompatible or broken

Even in this path, operators should not run `openclaw onboard` for the default Sovereign install flow.

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
- OpenClaw CLI/version install sanity (bootstrap script reachability, version pin match)
- Matrix service health and reverse proxy status
- IMAP connectivity test and credential validity
- alert room target and bot membership

## Related Docs

- `docs/ARCHITECTURE.md`
- `docs/MAIL_SENTINEL_DESIGN.md`
- `docs/MATRIX_BUNDLED_SETUP.md`
- `docs/INSTALLER_CONTRACTS.md`
