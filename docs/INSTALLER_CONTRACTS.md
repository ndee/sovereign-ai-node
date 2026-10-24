# Sovereign Node Installer and Operator Contracts

## Purpose

Define the phase-B normative contracts for operator surfaces and the shared installer backend used by `sovereign-ai-node`.

This document specifies:

- `sovereign-node` CLI command contracts
- machine-readable CLI output formats
- installer backend job API endpoints and payload schemas
- Sovereign-managed OpenClaw bootstrap/install behavior
- secrets storage strategy and file locations
- default product decisions for Matrix federation, alert-room E2EE, and Element client support
- failure semantics and rollback behavior for partial installs

This is a contract/spec document. It does not imply these interfaces are already implemented.

## Scope

This document covers the installer and operator-control layer only.

It does not define:

- Mail Sentinel bot logic (see `docs/MAIL_SENTINEL_DESIGN.md`)
- bundled Matrix internals beyond installer-facing requirements (see `docs/MATRIX_BUNDLED_SETUP.md`)
- OpenClaw runtime internals (see `docs/ARCHITECTURE.md`)

## Normative Conventions

- Timestamps use RFC 3339 UTC (`YYYY-MM-DDTHH:MM:SSZ`)
- IDs are opaque strings and must be treated as stable identifiers, not parsed by clients
- JSON examples are illustrative; the field requirements in the schemas are normative
- CLI `--json` output uses UTF-8 JSON objects
- CLI `logs --json` uses NDJSON (one JSON object per line)

## Versioning

All machine-readable responses defined here include:

- `contractVersion`: semantic version for this installer/operator contract (initially `1.0.0`)

Compatibility policy:

- additive fields are allowed in minor versions
- removing/renaming required fields requires a major version

## Defaults (Decision-Complete)

These defaults are binding for the phase-B bundled install profile unless explicitly overridden by operator input or profile selection.

- deployment mode: `bundled_matrix`
- packaging mode: Docker Compose
- install privilege model: `sudo` system install
- OpenClaw installation ownership: managed by Sovereign
- OpenClaw install method: official OpenClaw `install.sh`
- OpenClaw version policy: pinned by Sovereign release/profile
- OpenClaw onboarding in Sovereign flow: disabled (`--no-onboard`)
- Matrix federation: disabled by default
- Matrix open registration: disabled by default
- alert room: private room
- alert room E2EE: disabled by default
- Element client support (phase 1):
  - Element Desktop
  - Element Mobile
  - `app.element.io` with custom homeserver
- self-hosted Element Web: optional, not required for phase 1
- template lifecycle: installer manages signed/pinned core templates
- core runtime bootstrap: installer instantiates core Sovereign agents and tool instances

## Sovereign Runtime Objects (Normative Vocabulary)

Installer- and operator-facing contracts in this document use the following model:

- `Sovereign Agent Template`
  - Signed, pinned manifest for agent behavior.
  - Defines workspace materialization and tool-template requirements.
- `Sovereign Tool Template`
  - Signed, pinned manifest for a least-privilege capability contract.
  - Defines required config keys, secret refs, and allowed command/tool surface.
- `Sovereign Tool Instance`
  - Installation-local binding of a tool template to concrete config and secret refs.
  - Multiple instances per template are allowed (for example multiple IMAP identities).
- `Sovereign Agent`
  - Managed runtime agent with its own workspace and Matrix identity.
  - References `templateRef` and bound `toolInstanceIds`.

Current core templates in the bundled profile:

- Agent templates:
  - `mail-sentinel@2.0.0`
  - `node-operator@2.0.0`
- Tool templates:
  - `mail-sentinel-tool@1.0.0`
  - `imap-readonly@1.0.0`
  - `node-cli-ops@1.0.0`

## OpenClaw Bootstrap Policy (Default Sovereign Path)

In the default install path, `sovereign-node install` is responsible for installing OpenClaw on the target machine before configuring it.

Default behavior:

- use the official OpenClaw installer script (`https://openclaw.ai/install.sh`)
- install the current Sovereign-pinned OpenClaw version `2026.3.13`
- skip OpenClaw onboarding (`--no-onboard`) because Sovereign owns the domain-specific configuration flow
- run non-interactively in the installer backend

Target internal command pattern:

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | \
  bash -s -- --version 2026.3.13 --no-onboard --no-prompt
```

After writing Sovereign-managed OpenClaw config and environment, the installer installs or repairs the gateway service via `openclaw gateway install` (using `--force` when a rewrite is required).

## Filesystem Layout and Secrets Strategy

## Directory Layout (Default)

The installer should use the following default paths on Linux:

- non-secret config: `/etc/sovereign-node/sovereign-node.json5`
- secrets directory: `/etc/sovereign-node/secrets/`
- runtime state directory: `/var/lib/sovereign-node/`
- logs directory: `/var/log/sovereign-node/`
- install job artifacts: `/var/lib/sovereign-node/install-jobs/`
- OpenClaw service home: `/var/lib/sovereign-node/openclaw-home/`

If OpenClaw is run under a dedicated service account, its effective OpenClaw home should be configured inside the service home (for example `OPENCLAW_HOME=/var/lib/sovereign-node/openclaw-home/.openclaw`).

## Secrets Storage Rules

Steady-state secrets must not be stored inline in `sovereign-node` non-secret config.

Allowed steady-state secret storage:

- file-backed secrets under `/etc/sovereign-node/secrets/`
- OS secret manager integration (future profiles), referenced by URI-like secret refs

Phase-B default (bundled profile):

- file-backed secrets with restrictive permissions

Required file ownership/permissions (default):

- directory `/etc/sovereign-node/secrets/`: `0700`
- secret files: `0600`
- owner: the `sovereign-node` service account (or root if only root reads and injects)

## Secret Reference Format

Persisted config and API responses should refer to secrets by reference, not secret value.

Supported secret ref forms (phase-B contract):

- `file:/etc/sovereign-node/secrets/<name>`
- `env:VARNAME` (allowed for advanced/manual deployments)

Transient exception:

- the install/test IMAP API may accept inline credentials for validation, but the backend must not persist them inline.

## CLI Contract (`sovereign-node`)

## Global Flags

All commands should support:

- `--config <path>` (default `/etc/sovereign-node/sovereign-node.json5`)
- `--json` (machine-readable output)
- `--verbose`

Interactive/setup commands additionally support:

- `--non-interactive`

## Common CLI Output Envelope (`--json`)

All non-streaming commands using `--json` return a single JSON object:

```json
{
  "contractVersion": "1.0.0",
  "ok": true,
  "command": "status",
  "timestamp": "2026-02-25T20:30:00Z",
  "requestId": "req_01J...",
  "result": {}
}
```

Failure envelope:

```json
{
  "contractVersion": "1.0.0",
  "ok": false,
  "command": "install",
  "timestamp": "2026-02-25T20:31:05Z",
  "requestId": "req_01J...",
  "error": {
    "code": "IMAP_AUTH_FAILED",
    "message": "IMAP authentication failed for the provided account",
    "retryable": false
  }
}
```

## CLI Exit Codes

Standard exit codes:

- `0`: success
- `1`: generic runtime error
- `2`: invalid arguments or invalid command usage
- `3`: validation/preflight failure (operator input or environment)
- `4`: dependency/service unavailable
- `5`: install job failed
- `6`: partial state requires operator repair/cleanup
- `7`: applied, but degraded (e.g. gateway not ready): used by the commands that apply a change through the install job and wait for it (`reconfigure imap`, `mail-sentinels create|update|delete`) when the job succeeded but the OpenClaw gateway was not listening by its readiness deadline (see "OpenClaw Gateway Readiness")

## Commands (Normative)

## `sovereign-node install`

Purpose:

- run the default guided installation flow (interactive by default)

Behavior:

- in interactive mode, collect missing inputs
- submit an install job to the shared installer backend
- wait for completion by default and stream progress text (non-JSON mode)
- return final `InstallResult` in `--json` mode
- install OpenClaw (default path) before configuring the runtime and bot

Required flags:

- `--non-interactive` requires all mandatory inputs via config or flags

Advanced flags (not required for the default operator path):

- `--skip-openclaw-install` (reuse existing OpenClaw install only; fail if incompatible/missing)
- `--openclaw-version <ver>` (override pinned version; advanced/debug only)
- `--force-openclaw-reinstall` (repair path)

`--json` result schema:

- `result` MUST be an `InstallResult`

## `sovereign-node status`

Purpose:

- return current platform/runtime status summary for operators

`--json` result schema:

- `result` MUST be a `SovereignStatus`
- the `openclaw` service entry carries `readiness` (`ready` | `starting` | `down`) and, when systemd reports it, `since` (see "OpenClaw Gateway Readiness")

## `sovereign-node onboarding issue`

Purpose:

- issue a new one-time Matrix onboarding code for the HTTPS onboarding page

Behavior:

- writes a fresh single-use onboarding state file
- invalidates any previously issued unused code
- returns the onboarding code, expiry, onboarding URL, and username
- MUST fail clearly when the current installation does not expose HTTPS onboarding (for example `local-dev`)

Flags:

- `--ttl-minutes <minutes>` default `21`
- `--json`

`--json` result shape:

```json
{
  "code": "ABCD-EFGH-IJKL",
  "expiresAt": "2026-03-06T12:34:56.000Z",
  "onboardingUrl": "https://node-name.sovereign-ai-node.com/onboard",
  "onboardingLink": "https://node-name.sovereign-ai-node.com/onboard#code=ABCD-EFGH-IJKL",
  "username": "@operator:node-name.sovereign-ai-node.com"
}
```

Normative onboarding rules:

- `/onboard` MUST NOT embed the operator password in static HTML or JS
- onboarding codes MUST be stored server-side as salted hashes
- onboarding codes MUST be single-use
- default TTL MUST be 21 minutes
- onboarding API responses revealing the password MUST be sent with `Cache-Control: no-store`

## `sovereign-node update`

Purpose:

- download the selected Sovereign installer and re-run the install flow in update mode using the saved install request file

Behavior:

- MUST require root privileges and instruct the operator to re-run with `sudo` when invoked as a non-root user
- MUST fail clearly when pending migrations exist
- MUST instruct the operator to run `sovereign-node migrate` first when that happens
- when no explicit installer ref/URL override is supplied, SHOULD resolve the latest GitHub release tag first, download that release's `install.sh` asset, and fall back to `main` only when that lookup fails
- explicit `--ref`, `--installer-url`, `SOVEREIGN_NODE_REF`, and `SOVEREIGN_NODE_INSTALL_SH_URL` inputs override the default latest-release lookup

## `sovereign-node migrate`

Purpose:

- inspect and apply one-off request/config migrations required before future updates

Behavior:

- `--status` shows pending migrations without applying them
- interactive mode MAY prompt for missing values required by a migration
- current migration path covers legacy single-instance Mail Sentinel installs
- when migrating a legacy single-instance Mail Sentinel install, MUST carry the current top-level IMAP host, port, TLS mode, username, mailbox, and IMAP password secret ref into the installer-managed `mail-sentinel` instance request data
- after a successful legacy Mail Sentinel migration, operators SHOULD NOT need to re-enter IMAP settings just because the install moved to installer-managed instances

## `sovereign-node mail-sentinels`

Purpose:

- manage installer-managed Mail Sentinel instances

Current subcommands:

- `list`
- `show <id>`
- `create <id>`
- `update <id>`
- `delete <id>`

`create`, `update` and `delete` apply the change through the install job and, by default, wait for it like `reconfigure imap` does: they print the per-step outcome, exit `1` when the job failed and `7` when it applied the change but the OpenClaw gateway is not listening yet. `--json` carries the terminal `job` and `gateway`. `--no-wait` returns as soon as the change is saved, with the pending `job` for polling.

## `sovereign-node doctor`

Purpose:

- run diagnostic checks across host prerequisites, bundled Matrix services, OpenClaw runtime, and bot wiring

Minimum OpenClaw-related checks in `DoctorReport.checks` should include:

- OpenClaw CLI installed and executable
- OpenClaw version matches the Sovereign pin/compatibility policy
- OpenClaw gateway service installed
- OpenClaw gateway service healthy/reachable
- OpenClaw config path and runtime environment wiring match the active Sovereign install

`--json` result schema:

- `result` MUST be a `DoctorReport`

## `sovereign-node logs`

Purpose:

- target contract: show recent logs for `sovereign-node`, bundled services, and selected components

Behavior:

- current implementation is scaffold-only
- text mode currently prints a placeholder message instead of streaming persisted logs
- `--json` currently emits scaffold NDJSON events (`status`, `log`, `end`) rather than a live log backend

NDJSON event schema:

```json
{"contractVersion":"1.0.0","type":"log","source":"synapse","timestamp":"2026-02-25T20:40:00Z","level":"info","message":"Synapse started"}
```

Allowed `type` values:

- `log`
- `status`
- `end`

## `sovereign-node test-alert`

Purpose:

- send a synthetic alert message to the configured Matrix alert room without running a full IMAP poll

`--json` result schema:

- `result` MUST be a `TestAlertResult`

## `sovereign-node reconfigure imap`

Purpose:

- replace the Mail Sentinel mail connection after install (IMAP or POP3): server, port, TLS, email address / username, password, and — for IMAP — the folder to watch

Current CLI flags:

- `--protocol imap|pop3` (defaults to the current protocol)
- `--host`, `--port`, `--tls` / `--no-tls`, `--username`, `--mailbox`
- `--password` or `--secret-ref` (one of them is required so the new connection can be tested)

Behavior:

- the order is **validate → persist → apply**: the new connection is tested with the submitted credentials first; a failed test returns a `ReconfigureResult` whose `mail-connection` check is `fail`, with `changed = []`, and leaves the previous configuration, secret file and bot bindings untouched
- only after a successful test is the password written to the managed secret store (`/etc/sovereign-node/secrets/imap-password`, mode `0600`), the saved install request and runtime config updated, and the idempotent install job re-run so the mail-sentinel bot/tool bindings are regenerated
- the CLI then waits for that job (polling every 2 s), prints each step's outcome and exits:
  - `0` when the job succeeded and the OpenClaw gateway is listening;
  - `1` when the job failed (or was still running after 30 minutes);
  - `7` when the job applied the settings but the gateway was not listening by its deadline. The message is: `Mail settings applied, but the OpenClaw gateway is not ready yet (not listening after <N> s). Bots will not reply and mail reviews will fail until it is. Check with: sovereign-node status --json`
- `--json` returns `ok: true` with the terminal `result.job` and `result.gateway` (`GatewayReadinessSummary`), with the same exit codes
- `--no-wait` keeps the earlier fire-and-forget behaviour: the command returns as soon as the change is saved, and `result.job` carries the pending job summary for polling. `POST /api/reconfigure/imap` always behaves this way
- a POP3 connection always records `mailbox = "INBOX"` (POP3 has no folders)
- switching accounts or protocols changes the tool's `uidValidity`, so Mail Sentinel drops its UID watermark and does not inherit one from the previous account
- the same implementation backs `POST /api/reconfigure/imap` (see the Settings API below)
- for the legacy/default `mail-sentinel` instance, the top-level `imap` section is the authoritative source for the instance IMAP host, port, TLS mode, username, mailbox, and password secret ref
- when the top-level `imap` section is configured, update/reconfigure flows MUST overwrite stale legacy/default per-instance IMAP values with the top-level values
- this reconciliation rule applies to the legacy/default `mail-sentinel` instance and MUST NOT be generalized to unrelated multi-instance Mail Sentinel entries without an explicit operator action

`--json` result schema:

- `result` MUST be a `ReconfigureResult` with `target = "imap"`

## `sovereign-node reconfigure matrix`

Purpose:

- toggle bundled Matrix federation for the active installation

Current CLI flags:

- `--federation`
- `--no-federation`

Behavior:

- for the legacy/default `mail-sentinel` instance, the active bundled Matrix alert room and homeserver domain are authoritative for `matrix.alertRoom` and `matrix.allowedUsers`
- when a previous migration or saved install request carries a stale legacy/default `mail-sentinel` room ID, room name, or `allowedUsers` MXID domain, update/reconfigure flows MUST rewrite that instance to the current bundled Matrix room and homeserver domain
- this reconciliation rule applies to the legacy/default `mail-sentinel` instance and MUST NOT rewrite unrelated multi-instance Mail Sentinel entries that intentionally target a different bundled Matrix room

`--json` result schema:

- `result` MUST be a `ReconfigureResult` with `target = "matrix"`

## `sovereign-node reconfigure openrouter`

Purpose:

- update OpenRouter model, API key and/or provider allow-list for the bundled deployment profile

Behavior:

- `--provider-only <slugs>` sets the OpenRouter provider allow-list (`openrouter.privacy.only`) from a comma-separated list; blank entries are dropped, and an empty value (`--provider-only ""`) clears the allow-list. The routing restrictions follow the rules of `POST /api/reconfigure/openrouter`

- a new `--api-key` is validated against OpenRouter's key endpoint (`GET /api/v1/auth/key`, no completion, no credit usage) before anything is written; a rejected key returns `changed = []` with an `openrouter-key` check of `fail` and keeps the previous key
- the key is stored at `/etc/sovereign-node/secrets/openrouter-api-key` (mode `0600`); it is never logged and never echoed in results
- the OpenClaw gateway is restarted so the new key takes effect; a gateway that is still starting at its readiness deadline does not fail the command: the `openclaw-gateway-restart` check is `warn` and `result.gateway.ready` is `false` (the same applies to `reconfigure matrix`). Only a gateway unit that failed to start is an error (`OPENCLAW_GATEWAY_RESTART_FAILED`)

`--json` result schema:

- `result` MUST be a `ReconfigureResult` with `target = "openrouter"`

## Shared Installer Backend API Contract

The CLI and Sovereign Wizard UI must use the same backend installer/provisioning implementation.

This section defines the required HTTP-style API contract (or an equivalent local RPC API with identical request/response schemas).

## Endpoints (Required)

- `POST /api/install/preflight`
- `POST /api/install/test-imap`
- `POST /api/install/test-matrix`
- `POST /api/install/run`
- `GET /api/install/jobs/:jobId`
- `POST /api/install/test-alert`
- `GET /api/status`
- `POST /api/reconfigure/imap`
- `POST /api/reconfigure/matrix`
- `POST /api/reconfigure/openrouter`

## API Response Envelope

All non-streaming API responses use:

```json
{
  "contractVersion": "1.0.0",
  "ok": true,
  "timestamp": "2026-02-25T20:45:00Z",
  "requestId": "req_01J...",
  "result": {}
}
```

Failure responses use:

```json
{
  "contractVersion": "1.0.0",
  "ok": false,
  "timestamp": "2026-02-25T20:45:03Z",
  "requestId": "req_01J...",
  "error": {
    "code": "MATRIX_TLS_ISSUE",
    "message": "Failed to obtain certificate for matrix.example.org",
    "retryable": true,
    "details": {
      "step": "matrix_tls"
    }
  }
}
```

## Core Types (Normative Schemas)

The following TypeScript-like definitions define the required fields and types.

```ts
type ISO8601 = string; // RFC3339 UTC
type ID = string;

type ErrorDetail = {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
};

type CheckStatus = "pass" | "warn" | "fail" | "skip";

type CheckResult = {
  id: string;
  name: string;
  status: CheckStatus;
  message: string;
  details?: Record<string, unknown>;
};

type JobState = "pending" | "running" | "succeeded" | "failed" | "canceled";

type StepState = "pending" | "running" | "succeeded" | "failed" | "canceled" | "skipped" | "warned";

type JobStep = {
  id:
    | "preflight"
    | "openclaw_bootstrap_cli"
    | "openclaw_bundled_plugin_tools"
    | "imap_validate"
    | "relay_enroll"
    | "matrix_provision"
    | "matrix_bootstrap_accounts"
    | "matrix_bootstrap_room"
    | "openclaw_gateway_service_install"
    | "openclaw_configure"
    | "gateway_ready"
    | "bots_configure"
    | "mail_sentinel_scan_timer"
    | "mail_sentinel_register"
    | "smoke_checks"
    | "test_alert";
  label: string;
  state: StepState;
  startedAt?: ISO8601;
  endedAt?: ISO8601;
  error?: ErrorDetail;
  details?: Record<string, unknown>;
};
```

### `InstallRequest`

```ts
type InstallRequest = {
  mode: "bundled_matrix";
  connectivity?: {
    mode?: "direct" | "relay";
  };
  relay?: {
    controlUrl: string;
    enrollmentToken?: string;
    requestedSlug?: string; // optional preferred relay slug for seeded/automated relay enrollment; installer may fall back to a generated slug if unavailable
    hostname?: string; // when pre-enrolled, installer skips relay enrollment
    publicBaseUrl?: string; // when pre-enrolled, installer skips relay enrollment
    tunnel?: {
      serverAddr: string;
      serverPort?: number;
      token: string;
      proxyName: string;
      subdomain?: string;
      type?: "http" | "https"; // "http": relay terminates TLS (legacy). "https": relay passes the encrypted stream through by SNI and the node terminates its own TLS (passthrough). Installer-managed; populated from the relay enroll response.
    };
    dns01?: { // present only for TLS-passthrough enrollments; the node obtains its own Let's Encrypt cert via deSEC DNS-01 and terminates TLS itself
      provider: "desec";
      apiBase: string;
      zone: string;
      subname: string;
      acmeEmail?: string;
      token?: string; // per-node scoped deSEC secret; returned only on first mint or rotation
    };
  };
  openclaw?: {
    manageInstallation?: boolean; // default true
    installMethod?: "install_sh"; // phase-B default and only supported value
    version?: string; // normally provided by Sovereign pin/profile
    skipIfCompatibleInstalled?: boolean; // default true
    forceReinstall?: boolean; // default false
    runOnboard?: false; // default false; Sovereign flow skips onboarding
  };
  openrouter: {
    model?: string;
    // Exactly one of the following should be provided:
    apiKey?: string; // transient only
    secretRef?: string; // file:... or env:...
    // OpenRouter provider routing / privacy controls (strict by default):
    privacy?: {
      zdr?: boolean; // default true: only zero-data-retention endpoints
      dataCollection?: "deny" | "allow"; // default "deny": exclude providers that retain/train
      allowFallbacks?: boolean; // default false: never fall back outside the filtered set
      only?: string[]; // optional provider allowlist (OpenRouter provider slugs)
    };
  };
  imap?: {
    host: string;
    port: number;
    tls: boolean;
    username: string;
    // Exactly one of the following should be provided:
    password?: string; // transient only
    secretRef?: string; // file:... or env:...
    mailbox?: string; // default "INBOX"
  };
  matrix: {
    homeserverDomain: string; // e.g. matrix.example.org
    publicBaseUrl: string; // e.g. https://matrix.example.org
    federationEnabled?: boolean; // default false
    tlsMode?: "auto" | "internal" | "manual" | "local-dev"; // default auto for public installs
    alertRoomName?: string; // default "Sovereign Alerts"
  };
  operator: {
    username: string; // localpart or full matrix user id
    password?: string; // optional if backend generates one
  };
  bots?: {
    selected?: string[];
    config?: Record<string, Record<string, string | number | boolean>>;
    instances?: Array<{
      id: string;
      packageId: string;
      workspace?: string;
      config?: Record<string, string | number | boolean>;
      secretRefs?: Record<string, string>;
      matrix?: {
        localpart?: string;
        alertRoom?: {
          roomId?: string;
          roomName?: string;
        };
        allowedUsers?: string[];
      };
    }>;
  };
  advanced?: {
    rollbackPolicy?: "safe_partial" | "manual" | "aggressive_non_destructive";
    skipPreflight?: boolean; // default false
    nonInteractive?: boolean; // mirrors CLI mode
  };
};
```

Constraints:

- `imap.protocol` is optional and defaults to `"imap"`; `"pop3"` selects the read-only POP3 backend (the surrounding `imap` key is kept for compatibility with existing saved requests and runtime configs)
- `mode` is required and must be `bundled_matrix` in phase B
- `openclaw.manageInstallation` defaults to `true`
- `openclaw.installMethod` defaults to `"install_sh"`
- `openclaw.runOnboard` defaults to `false` and should remain `false` in the default Sovereign flow
- `openrouter` is required
- `openrouter.apiKey` or `openrouter.secretRef` is required
- `openrouter.privacy` is optional; omitted fields default to the strict profile
  (`zdr: true`, `dataCollection: "deny"`, `allowFallbacks: false`). The resolved
  block is persisted as `openrouter.privacy` in `sovereign-node.json5`, rendered into
  the managed OpenClaw config as
  `agents.defaults.models["openrouter/<model>"].params.provider`
  (`{ data_collection, zdr, allow_fallbacks, only? }`) for every OpenRouter model in
  use (the default `openrouter.model` and each `agents.list[].model`, once per
  distinct model; other params on those entries are kept, non-OpenRouter models get
  none) and sent by OpenClaw as the `provider` routing block of every OpenRouter
  request, including `llm-task` mail classification. Weakening it is an explicit
  opt-out. Each of those models must have at least one endpoint matching the profile (see
  `https://openrouter.ai/api/v1/endpoints/zdr`), otherwise OpenRouter returns no
  eligible provider. The managed OpenClaw config also sets `agents.defaults.workspace`
  to a dedicated empty directory (`<service home>/llm-task-workspace`, `0750`,
  service-owned) so `llm-task` calls never carry agent bootstrap files
  (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `USER.md`, `MEMORY.md`).
- The managed OpenClaw config denies generic tools by default. Every
  `agents.list[]` entry carries `tools.deny` with `exec`, `process`, `lobster`,
  `browser`, `web_fetch` and `web_search`, minus the tools that agent opts into
  (agents with a closed tool policy, below, never opt into any of them).
  An agent opts in only through its bound tool templates: `allowedCommands`
  grants `exec` (gateway host, allowlist security, no prompt; `process` stays
  denied), and `openclawToolNames` grants the named tools (plus
  `session_status`) in `tools.allow`. Top-level `tools.deny` holds the
  default-denied tools that no agent opts into, because a top-level deny cannot be
  re-allowed per agent. The config also sets `tools.elevated.enabled: false`
  (no agent entry sets `elevated`), `tools.fs.workspaceOnly: true`,
  `browser.enabled: false` (no browser control server) and
  `discovery.mdns.mode: "off"` (the gateway does not advertise itself on the LAN;
  the host's own `<hostname>.local` is unaffected).
- `imap.password` MUST NOT be persisted if provided
- `imap` may be omitted (pending IMAP mode)
- `connectivity.mode = "relay"` requires a valid `relay` object
- `relay.enrollmentToken` is optional only for the default Sovereign managed relay (`https://relay.sovereign-ai-node.com`)
- custom relays must provide `relay.enrollmentToken`
- relay enrollment is skipped when `relay.hostname`, `relay.publicBaseUrl`, and `relay.tunnel` are already populated
- relay hostname selection is installer-managed; user-provided relay slugs are not part of the public contract
- `matrix.federationEnabled` defaults to `false`

#### Agent tool surface: typed tools, scan agents and exec pinning

A bot tool template opts an agent into tools in one of three ways. The managed
OpenClaw config is rendered from these declarations on every configure and
update.

- **Typed tool** (`openclawTypedTool`): `{ name, description, script,
  operations[] }`. Node generates the `sovereign-typed-tools` OpenClaw plugin
  (`<openclaw home>/extensions/sovereign-typed-tools`, loaded through
  `plugins.load.paths`) and registers one tool per typed tool name. Each
  operation declares `name`, `description`, `effect` (`read` | `change`), a fixed
  `argv` (where `<tool-instance-id>` is the bound instance), optional `params`
  (`type` `string` | `boolean`, `description`, optional `enum`, `pattern`,
  `maxLength` ≤ 500, and the `argv` fragment `["--flag", "{value}"]` or
  `["--flag"]`), `required`, `exactlyOneOf`, `confirm` (`"always"` or
  `{ param, values }`) and `confirmPreviewArgv` (flags appended for a
  side-effect-free preview of a change that needs confirmation).
  - The plugin never starts a shell. It copies `script` from the bot package
    into its own extension directory, outside every agent workspace, and runs it
    with the gateway's node binary, a fixed argv, a fixed `PATH` and
    `SOVEREIGN_NODE_CONFIG`. String values are length-limited, may not contain
    control characters or start with `-`, and are always passed as a single
    argv element after their flag.
  - A `change` operation runs only when the runtime-supplied requester of the
    turn is the node operator (`matrix.operator.userId`). Turns that no Matrix
    user started, and turns started by anyone else, are refused.
  - A `change` operation with a matching `confirm` only records a pending change
    (`<openclaw home>/state/sovereign-typed-tools/pending.json`, `0600`) and
    returns a six-character code, plus the CLI's own preview when the operation
    declares `confirmPreviewArgv` (a failing preview records nothing). Nothing changes until the same operator sends
    `/confirm <code>` within 15 minutes. That command is an OpenClaw plugin
    command, handled before any model turn, so a model can neither propose and
    confirm in one turn nor confirm at all.
  - An agent bound to a typed tool gets a closed tool policy:
    `tools.allow` holds the typed tool names, any plugin tools from
    `openclawToolNames`, and `session_status` as the core anchor OpenClaw needs to
    keep an allow list. `tools.deny` holds every core tool group (`group:fs`,
    `group:runtime`, `group:web`, `group:memory`, `group:sessions`, `group:ui`,
    `group:messaging`, `group:automation`, `group:nodes`, `group:agents`,
    `group:media`) plus the default-denied tools `exec`, `process`, `lobster`,
    `browser`, `web_fetch` and `web_search`. Deny wins over allow, so the
    agent is offered exactly its typed and named plugin tools; neither those nor
    `llm-task` are ever in a deny list. No `allowedCommands` of any template bound to that agent are
    allowlisted for exec, and `TOOLS.md` documents only the OpenClaw tools.
- **Scan agent** (`openclawScanAgent`): `{ toolNames }`, plugin tools only. Node
  adds an agent `<agent id>-scan` to `agents.list` with the `llm-task` workspace,
  no channel binding and the closed tool policy for `toolNames`. The bound tool
  instance's config gets `scanAgentId`, so the bot's own scan can use that
  agent's session instead of the chat agent's. A scan agent also makes the
  installer provide the lobster CLI.
- **Shell commands** (`allowedCommands`, for templates without a typed tool):
  each command is pinned by a root-owned wrapper
  (`/usr/local/lib/sovereign-node/exec-wrappers/<agent id>/<command>-<hash>`,
  `0755`) that fixes the full argv, takes exactly the declared placeholders as
  arguments and refuses arguments starting with `-`. The exec allowlist holds
  only those wrapper paths, and `TOOLS.md` documents the wrapper together with
  the command it runs. A command is not allowlisted when the service user can
  modify the executable or the wrapper (it owns, or may write, the path or any
  directory above it), or when the wrapper is missing or outdated and the
  installer is not running as root. Executables inside an agent workspace are
  therefore never allowlisted.
- The exec approvals store is reconciled to exactly that set on every
  configure and update (`openclaw approvals get --json`, then
  `approvals allowlist remove` / `add`). Entries from earlier versions, from
  removed tools and for the wildcard agent (`*`) are removed. If the store cannot
  be read, the step fails instead of leaving unknown entries in place.

#### Relay TLS mode (legacy http vs. TLS-passthrough)

The relay tunnel runs in one of two modes. The mode is **not** selected by the
node and is **not** a function of the node version — it is decided by the relay
at enrollment time and reflected back in the enroll response:

- **Legacy http** — the relay terminates TLS at its edge and forwards plaintext
  to the node over the tunnel. The enroll response carries `tunnel.type: "http"`
  (or omits `type`) and no `dns01` block.
- **TLS-passthrough** — the relay passes the encrypted stream through by SNI and
  the node terminates its own TLS using a Let's Encrypt certificate obtained via
  deSEC DNS-01. The enroll response carries `tunnel.type: "https"` and a `dns01`
  block.

Normative behaviour:

- the installer MUST advertise `capabilities: ["tls-passthrough"]` on enroll/re-enroll; advertising the capability does NOT by itself put the node into passthrough mode
- the relay grants passthrough ONLY when it has a deSEC owner token configured; otherwise it enrolls the node in legacy http mode, and a node advertising the capability against such a relay stays legacy
- the **kill switch for passthrough is the relay's deSEC owner token, not the node version**: removing the token from the relay makes all subsequent enrollments fall back to legacy http
- mode changes apply **per node on its next enroll/re-enroll**: an already-installed node keeps its current mode until it re-enrolls. After the relay gains a deSEC token, existing nodes flip to passthrough on their next re-enroll; they do not flip merely because a newer node version is released or installed
- a passthrough enrollment (`tunnel.type: "https"` or `mode: "https-passthrough"`) MUST carry a usable `dns01` block; the installer fails closed (`RELAY_ENROLL_FAILED`) otherwise rather than silently serving plaintext
- on re-enroll/upgrade the installer MUST preserve an existing `dns01` block; dropping it while the tunnel still advertises `https` is a fail-closed condition surfaced at the post-install passthrough probe (the node would otherwise forward plaintext under an https tunnel)

### `PreflightResult`

```ts
type PreflightResult = {
  mode: "bundled_matrix";
  overall: "pass" | "warn" | "fail";
  checks: CheckResult[];
  recommendedActions: string[];
};
```

### `InstallJobSummary`

```ts
type InstallJobSummary = {
  jobId: ID;
  state: JobState;
  createdAt: ISO8601;
  startedAt?: ISO8601;
  endedAt?: ISO8601;
  steps: JobStep[];
  currentStepId?: JobStep["id"];
};
```

### `InstallResult`

```ts
type InstallResult = {
  installationId: ID;
  job: InstallJobSummary;
  mode: "bundled_matrix";
  matrix: {
    homeserverUrl: string;
    federationEnabled: boolean;
    operatorUserId: string;
    botUserId: string; // primary alert bot user id (mail-sentinel)
    alertRoomId: string;
    alertRoomName: string;
    e2eeEnabled: boolean;
  };
  relay?: {
    enabled: boolean;
    hostname: string;
    publicBaseUrl: string;
    serviceInstalled: boolean;
    serviceState?: "running" | "stopped" | "failed" | "unknown";
    connected: boolean;
  };
  openclaw: {
    installManagedBySovereign: boolean;
    installMethod: "install_sh";
    version: string;
    binaryPath: string;
    configPath: string;
    openclawHome: string;
    gatewayServiceInstalled: boolean;
    gatewayServiceName?: string;
    agentId: "mail-sentinel"; // compatibility field for primary polling agent
    cronJobId: string; // compatibility field for primary polling cron
    pluginIds: string[]; // e.g. ["matrix", "imap-readonly"]
  };
  paths: {
    configPath: string;
    secretsDir: string;
    stateDir: string;
    logsDir: string;
  };
  checks: {
    preflight: PreflightResult;
    smoke: CheckResult[];
    testAlert: TestAlertResult;
  };
  nextSteps: {
    elementHomeserverUrl: string;
    operatorUsername: string;
    roomId: string;
    roomName: string;
    notes: string[];
  };
};
```

### `InstallJobStatusResponse`

`GET /api/install/jobs/:jobId` result schema:

```ts
type InstallJobStatusResponse = {
  job: InstallJobSummary;
  result?: InstallResult; // present when state === "succeeded"
  gateway?: GatewayReadinessSummary; // present once the gateway_ready step ran
  error?: ErrorDetail; // present when state === "failed"
};

type GatewayReadinessSummary = {
  ready: boolean; // the OpenClaw gateway answered on its port
  readyAt?: ISO8601; // when it was first seen listening
  waitedMs: number;
  deadlineMs: number;
};
```

A job that applied its configuration but whose gateway was not listening by the deadline still ends `succeeded`; its `gateway_ready` step is `warned` with `error.code = "OPENCLAW_GATEWAY_NOT_READY"` and `error.details = { unit, unitStarted, waitedMs, deadlineMs, lastProbe }`, and `gateway.ready` is `false`. The `smoke_checks` step then records an `openclaw-gateway` check with status `warn` in `details.checks` instead of skipping the gateway checks silently.

### `SovereignStatus`

```ts
type ComponentHealth = "healthy" | "degraded" | "unhealthy" | "unknown";

type ServiceStatus = {
  name: string;
  kind: "sovereign-node" | "openclaw" | "synapse" | "postgres" | "reverse-proxy" | "relay-tunnel";
  health: ComponentHealth;
  state: "running" | "stopped" | "failed" | "unknown";
  readiness?: "ready" | "starting" | "down"; // openclaw only
  since?: ISO8601; // openclaw only: when the gateway unit last started
  message?: string;
};

type SovereignStatus = {
  installationId?: ID;
  mode: "bundled_matrix";
  services: ServiceStatus[];
  relay?: {
    enabled: boolean;
    controlUrl?: string;
    hostname?: string;
    publicBaseUrl?: string;
    connected: boolean;
    serviceInstalled: boolean;
    serviceState?: "running" | "stopped" | "failed" | "unknown";
  };
  matrix: {
    homeserverUrl?: string;
    health: ComponentHealth;
    roomReachable: boolean;
    federationEnabled: boolean;
    alertRoomId?: string;
  };
  openclaw: {
    managedBySovereign: boolean;
    cliInstalled: boolean;
    binaryPath?: string;
    version?: string;
    health: ComponentHealth;
    serviceInstalled: boolean;
    serviceState?: "running" | "stopped" | "failed" | "unknown";
    configPath?: string;
    agentPresent: boolean; // primary runtime/cron agents present
    cronPresent: boolean; // primary runtime cron present
    pluginIds?: string[];
  };
  mailSentinel: {
    agentId: "mail-sentinel";
    lastPollAt?: ISO8601;
    lastAlertAt?: ISO8601;
    lastError?: ErrorDetail;
    consecutiveFailures: number;
  };
  imap: {
    lastCredentialTestAt?: ISO8601;
    authStatus: "ok" | "failed" | "unknown";
    host?: string;
    mailbox?: string;
  };
  version: {
    sovereignNode?: string;
    contractVersion: string;
    openclaw?: string;
    plugins?: Record<string, string>;
    provenance?: {
      nodeRepoUrl: string;
      nodeRef: string;
      nodeVersion?: string;
      nodeCommitSha: string;
      botsRepoUrl: string;
      botsRef: string;
      botsVersion?: string;
      botsCommitSha: string;
      installedAt: string;
      installSource: "curl-installer" | "local-copy" | "git-clone";
    };
  };
};
```

### `DoctorReport`

```ts
type DoctorReport = {
  overall: "pass" | "warn" | "fail";
  checks: CheckResult[];
  suggestedCommands: string[];
};
```

### `TestAlertResult`

```ts
type TestAlertResult = {
  delivered: boolean;
  target: {
    channel: "matrix";
    roomId: string;
  };
  messageId?: string;
  sentAt?: ISO8601;
  error?: ErrorDetail;
};
```

### `ReconfigureResult`

```ts
type ReconfigureResult = {
  target: "imap" | "matrix" | "openrouter";
  changed: string[]; // field paths
  restartRequiredServices: string[];
  validation: CheckResult[];
  job?: InstallJobSummary; // when applied through the install job
  gateway?: GatewayReadinessSummary; // when the gateway was restarted
};
```

## OpenClaw Gateway Readiness

A cold OpenClaw gateway start loads and transpiles its bundled plugins before it opens its port, which can take minutes on a small ARM board. Readiness is therefore defined as, and waited for with:

- **signal:** any HTTP response from `GET http://127.0.0.1:18789/` (2 s per attempt). The `openclaw` CLI is never spawned while waiting; `openclaw health` runs once after the port answers, with a 60 s timeout, and its failure only marks the gateway `degraded`
- **wait:** poll every 2 s until the port answers or the deadline passes, returning as soon as it answers. The deadline defaults to 300 s and can be set with `SOVEREIGN_NODE_GATEWAY_READY_TIMEOUT_MS` (clamped to 30 s–900 s)
- **fail fast:** the wait stops early when systemd reports the unit `failed`, or when its `NRestarts` grows during the wait (crash loop); that outcome is "unit failed to start", not "not ready yet"
- **status:** `services[kind=openclaw].readiness` is `ready` when the port answers, `starting` when the unit is up but the port does not answer yet (health `degraded`, message `gateway starting (not listening yet)`), and `down` otherwise; `since` is the unit's `ActiveEnterTimestamp`

## Gateway and Bot Unit Sandboxing

The system-level gateway unit (`sovereign-openclaw-gateway.service`) and every bot-declared service unit (for example `sovereign-mail-sentinel-scan.service`) carry the same systemd sandbox, rendered by `src/installer/systemd-sandbox.ts`. The units are rewritten on install, update and reconfigure, so an upgraded node picks the sandbox up without manual steps. The OpenClaw user-unit path (`openclaw-gateway.service`) is not covered.

- **privileges:** `NoNewPrivileges=yes`, `CapabilityBoundingSet=` (empty), `RestrictSUIDSGID=yes`, `LockPersonality=yes`, `RestrictNamespaces=yes`. `sudo` and other setuid programs cannot raise privileges from inside these units
- **kernel and devices:** `PrivateDevices=yes`, `ProtectKernelTunables=yes`, `ProtectKernelModules=yes`, `ProtectKernelLogs=yes`, `ProtectControlGroups=yes`
- **network:** `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK`. `AF_NETLINK` is required: the gateway enumerates network interfaces when it loads, and Node throws when netlink sockets are denied
- **filesystem:** `ProtectSystem=strict`, `PrivateTmp=yes`, and `ProtectHome=yes` (`read-only` when a needed path lies under `/home`, `/root` or `/run/user`, for example a root service user's npm prefix). `InaccessiblePaths=` hides `/run/docker.sock` and `/run/containerd/containerd.sock`
- **writable (`ReadWritePaths=`):** the state dir, the OpenClaw service home and its managed temp dir, every agent workspace (workspaces outside the state dir included), and, for the gateway, the Matrix extension's native crypto package dir under each candidate OpenClaw package root (the extension downloads its native module there at start). Bot units get the state dir, the OpenClaw service home, the agent workspace and the unit's working directory
- **pinned read-only (`ReadOnlyPaths=`):** the service user's npm prefix, which sits inside the writable state dir, so a unit cannot change the trees it may execute from. OpenClaw package roots outside it are read-only through `ProtectSystem=strict`. The Matrix crypto package dir stays writable inside either
- **execution (`NoExecPaths=/`, `ExecPaths=`):** nothing may be executed or mapped as code except the library dirs (`/usr/lib`, `/usr/lib64`, `/lib`, `/lib64`), the node runtime resolved on the unit's `PATH`, `/usr/bin/env`, `bash` (the interpreter of the root-owned `/usr/local/bin/sovereign-tool` wrapper), `/usr/local/bin/sovereign-tool`, the `bin` and `lib` dirs of the service user's npm prefix (lobster, and openclaw on unprivileged installs) and the OpenClaw package roots (native addons included). Bot units add `cat`, which lobster's exec stage runs. The gateway adds, only while some agent has an exec allowlist, `sh` and `/bin/sh` (the exec tool runs commands through a shell, and each exec wrapper is a `#!/bin/sh` script), the agents' exec wrappers and the executables those wrappers run. While some agent is bound to a typed tool, it also adds the node runtime the typed tool starts its CLI with, as resolved on the unit's `PATH` and with symlinks resolved (what `process.execPath` reports); the CLI script itself is only read, from the OpenClaw home, and is not executable
- **not set:** `MemoryDenyWriteExecute`, which breaks the V8 JIT

Every path is rendered with systemd's `-` prefix, so a path missing on a given host is skipped rather than failing the unit. systemd keeps one mode per path, the most restrictive, so no path is listed both read-only and writable or executable; access is combined by nesting (the npm prefix read-only, its `bin` and `lib` executable inside it), and the renderer drops a read-only entry that repeats a writable or executable path. The gateway's local-Matrix `ExecStartPre=` wait runs on the unit's node runtime, not a shell with `curl`, because `ExecPaths=` applies to every command in the unit.

**Program lookup.** The gateway unit does not inherit the environment the installer runs in. Its `Environment=PATH=` is the service user's npm prefix `bin` dir followed by the fixed system search path `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`, and its node runtime (`ExecStartPre=` and the `openclaw` interpreter) is the first `node` on that system path that every user can execute: the binary and every directory leading to it, symlinks resolved, carry the execute bit for other users. When no such `node` exists, the install fails before the unit is written or restarted with `OPENCLAW_GATEWAY_NODE_UNAVAILABLE`, naming the search path and, for each `node` found, the path that blocks the service user. `ExecStart=` runs the `openclaw` found on that PATH, or else the one a root install left in the installing npm's global prefix (`npm root -g`). The OpenClaw CLI runs started as the service user (`sudo -u`) use the same system `node`, falling back to the installer's own runtime only when no usable system `node` exists.

**Extension point.** A change that lets the gateway start a new host program (a typed tool's CLI, an exec wrapper directory) must add that program to the gateway's program list (`listGatewaySandboxAgentPrograms` in `src/installer/real-service.ts`, which feeds `GatewaySandboxInput.programs`), or the program will fail to start with `EACCES`. Bot units take their program list from `resolveBotServiceSandboxPrograms`. The directive contract is pinned by `src/installer/systemd-sandbox.test.ts`, and CI's non-interactive install job checks the live units from inside their mount namespaces (`scripts/ci/verify-systemd-sandbox.sh`).

**Behaviour changes.** The gateway's own file log (`/tmp/openclaw` by default) now lands in the unit's private `/tmp`, so it is gone after a restart; the journal is unaffected. Chat-driven node administration through the `sovereign-node` CLI (the non-default node-operator bot) can no longer change `/etc/sovereign-node` or use `sudo` from the gateway. OpenClaw plugins installed by hand under `~/.openclaw/extensions` cannot load native addons.

## Endpoint Request/Response Contracts

## `POST /api/install/preflight`

Purpose:

- run environment checks before install

Request body:

- optional partial `InstallRequest` for mode-specific checks and defaults

Response:

- `result` MUST be `PreflightResult`

## `POST /api/install/test-imap`

Purpose:

- validate mail connectivity/auth (IMAP or POP3, per `imap.protocol`) and optional mailbox access before persisting configuration; POP3 tests authenticate and run `STAT` only — nothing is fetched or deleted

Request body:

```ts
type TestImapRequest = {
  imap: NonNullable<InstallRequest["imap"]>;
};
```

Response:

- `result` MUST be:

```ts
type TestImapResult = {
  ok: boolean;
  protocol?: "imap" | "pop3";
  host: string;
  port: number;
  tls: boolean;
  auth: "ok" | "failed";
  mailbox?: string;
  capabilities?: string[];
  error?: ErrorDetail;
};
```

## `POST /api/install/test-openrouter`

Purpose:

- check an OpenRouter API key before it is persisted (install wizard and post-install key replacement)

Request body: `{ openrouter: { apiKey: string } }`

Response:

- `result` MUST be `TestOpenrouterResult = { ok: boolean; label?: string; error?: ErrorDetail }`
- the key is forwarded once in an `Authorization` header to `https://openrouter.ai/api/v1/auth/key` and never logged or echoed; `label` is OpenRouter's own free-form key label
- responses carry `Cache-Control: no-store`

## Settings API (post-install reconfiguration)

- `GET /api/reconfigure/settings` → `SettingsSummary`: the non-secret view of installer-entered settings. Secrets are reported only as presence flags (`mail.passwordSet`, `openrouter.apiKeySet`); the existing values are never returned. `matrix` (homeserver identity) and `relay` (node name / slug) are reported with `editable: false` and a `reason`, because the homeserver identity, relay assignment and TLS certificate are all keyed to them — changing them is a migration, not a setting.
- `POST /api/reconfigure/imap` → `ReconfigureResult` (see `sovereign-node reconfigure imap`); the body is `{ imap: InstallRequest["imap"] }` including the new password.
- `POST /api/reconfigure/openrouter` → `ReconfigureResult` (see `sovereign-node reconfigure openrouter`).
- All three are gated by the same operator authentication as the rest of `/api/`; secrets travel only in JSON request bodies, never in URLs.

## `POST /api/install/test-matrix`

Purpose:

- validate bundled Matrix domain/TLS/reverse-proxy reachability after provisioning or reconfiguration

Request body:

```ts
type TestMatrixRequest = {
  publicBaseUrl: string;
  federationEnabled?: boolean;
};
```

Response:

- `result` MUST be:

```ts
type TestMatrixResult = {
  ok: boolean;
  homeserverUrl: string;
  clientDiscovery?: {
    required: boolean;
    ok: boolean;
  };
  serverDiscovery?: {
    required: boolean;
    ok: boolean;
  };
  checks: CheckResult[];
};
```

## `POST /api/install/run`

Purpose:

- start an install job

Request body:

- `InstallRequest`

Response:

- `result` MUST be:

```ts
type StartInstallResult = {
  job: InstallJobSummary;
};
```

The job should start in state `pending` or `running`.

## `GET /api/install/jobs/:jobId`

Purpose:

- poll job progress and final outcome

Response:

- `result` MUST be `InstallJobStatusResponse`

## `POST /api/install/test-alert`

Purpose:

- send a synthetic alert without a full mail poll

Request body:

```ts
type TestAlertRequest = {
  channel?: "matrix"; // default matrix
  roomId?: string; // default configured alert room
  text?: string; // optional custom test message
};
```

Response:

- `result` MUST be `TestAlertResult`

## `GET /api/status`

Purpose:

- return current system status snapshot

Response:

- `result` MUST be `SovereignStatus`

## `POST /api/reconfigure/imap`

Purpose:

- validate and persist updated IMAP configuration/secrets references for the active installation

Request body:

```ts
type ReconfigureImapRequest = {
  imap: NonNullable<InstallRequest["imap"]>;
};
```

Response:

- `result` MUST be `ReconfigureResult` with `target = "imap"`

## `POST /api/reconfigure/matrix`

Purpose:

- validate and persist updated bundled Matrix settings (for example homeserver URL, room target, federation flag)

Behavior:

- for the legacy/default `mail-sentinel` instance, the active bundled Matrix alert room and homeserver domain are authoritative for `matrix.alertRoom` and `matrix.allowedUsers`
- when the request is applied after a homeserver or alert-room rotation, the installer MUST rewrite stale legacy/default `mail-sentinel` room IDs, room names, and `allowedUsers` MXIDs to the current bundled Matrix outputs before persisting runtime state

Request body:

```ts
type ReconfigureMatrixRequest = {
  matrix: Partial<InstallRequest["matrix"]>;
  operator?: Partial<InstallRequest["operator"]>;
};
```

Response:

- `result` MUST be `ReconfigureResult` with `target = "matrix"`

## `POST /api/reconfigure/openrouter`

Purpose:

- update OpenRouter model, secret reference and/or routing restrictions for the active installation

Request body:

```ts
type ReconfigureOpenrouterRequest = {
  openrouter: {
    model?: string;
    apiKey?: string; // transient only
    secretRef?: string;
    // OpenRouter routing restrictions; can only be narrowed here (see below):
    privacy?: {
      zdr?: true;
      dataCollection?: "deny";
      allowFallbacks?: false;
      only?: string[]; // provider allowlist (OpenRouter provider slugs); [] clears it
    };
  };
};
```

Constraints:

- at least one of `model`, `apiKey`, `secretRef`, or `privacy` is required
- `apiKey` and `secretRef` must not both be set in the same request
- `privacy` is the install contract's `openrouter.privacy` block, but this path can only
  narrow it. `zdr: false`, `dataCollection: "allow"` and `allowFallbacks: true` are
  rejected with a validation error (HTTP 400; `OPENROUTER_PRIVACY_INVALID` when the
  installer service is called directly) and nothing is written. Re-asserting the strict
  values (`zdr: true`, `dataCollection: "deny"`, `allowFallbacks: false`) is accepted
- unknown keys in `privacy` are rejected, as are empty or blank `only` entries; entries
  are trimmed and de-duplicated
- the block is merged onto the current one: a field the request omits keeps its current
  value, so changing only the model (or only the key) keeps an existing allow-list, and an
  allow-list can be set without a model change. `only: []` clears the allow-list. An
  install-time opt-out from the strict profile is kept unless the request re-asserts the
  strict value; weakening the profile stays an install-time decision (`openrouter.privacy`
  in the install request, whose validation is unchanged)
- a changed block is written to `openrouter.privacy` in `sovereign-node.json5`, rendered into
  `agents.defaults.models["openrouter/<model>"].params.provider` for every OpenRouter model
  in use (as at install), and synced into the saved install request
  (`request.openrouter.privacy`), and the OpenClaw gateway is restarted. `changed` reports
  `openrouter.privacy` and `request.openrouter.privacy`; asking for the block already in
  place changes and restarts nothing

Response:

- `result` MUST be `ReconfigureResult` with `target = "openrouter"`

## Failure Semantics and Rollback (Normative)

## Install Phases and Commit Boundaries

Install is a phased workflow, not a single atomic transaction.

The installer must track phases and commit points in the install job state.

Commit boundaries:

1. host preflight checks
2. OpenClaw CLI bootstrap/install
3. IMAP validation (when configured; no persistent state change yet unless secrets persisted)
4. relay enrollment (relay mode only)
5. bundled Matrix provisioning
6. Matrix account and room bootstrap
7. OpenClaw configuration + gateway service install
8. core agent registration (managed agents + cron)
9. smoke checks and test alert

## Default Rollback Policy

Default rollback policy is:

- `safe_partial`

Meaning:

- stop or disable partially configured components when safe to do so
- preserve data volumes and logs
- preserve generated config and secrets for operator repair
- do not delete Matrix accounts/rooms automatically
- do not delete OpenClaw state automatically

Rationale:

- safest default for debugging and recovery
- avoids destructive cleanup of stateful services (Synapse/Postgres/OpenClaw)

## Supported Rollback Policies

- `safe_partial` (default)
- `manual`
- `aggressive_non_destructive`

Policy semantics:

- `manual`: no automatic compensation beyond marking the job failed
- `safe_partial`: apply safe compensating actions and leave repairable state
- `aggressive_non_destructive`: stop/remove transient containers/networks and temporary generated files, but never delete persisted volumes/secrets without an explicit purge command

## Required Behavior on Failure

If any step fails:

1. Mark the current step as `failed` with structured `ErrorDetail`.
2. Mark the overall job state as `failed`.
3. Persist partial install artifacts and step logs.
4. Record which commit boundaries were completed.
5. Return actionable remediation guidance (`suggestedCommands` in `DoctorReport` and/or error details).

## Phase-Specific Failure Rules

### Failure before OpenClaw bootstrap completes

- Mark the install failed with an OpenClaw bootstrap error (for example installer download/install failure).
- No Matrix provisioning should have occurred yet in the default flow.
- Preserve preflight results and installer logs.

### Failure after OpenClaw bootstrap but before Matrix provisioning completes

- Keep the OpenClaw CLI install in place.
- Do not run `openclaw onboard` as a fallback in the Sovereign flow.
- Mark install as partially prepared and retryable.

### Failure before Matrix provisioning completes (after IMAP validation)

- The installer may clean up transient files/containers created during the failed attempt.
- No persistent Matrix accounts/rooms should exist yet.

### Failure after Matrix provisioning but before OpenClaw registration

- Keep Synapse/Postgres volumes and configuration.
- Keep created Matrix accounts/room unless the operator explicitly requests cleanup.
- Mark install as partially provisioned and repairable.

### Failure after OpenClaw configuration or gateway service install

- Keep OpenClaw CLI, config/state, service files, and Matrix state.
- If the gateway service entry is stale or broken, retries should repair it using `openclaw gateway install --force`.
- Mark install as partially provisioned and repairable.

### Failure after core agent registration

- Keep OpenClaw config/state and Matrix state.
- Disable the newly created cron job if smoke checks fail after registration, when supported by the installed OpenClaw release.
- Emit a `PARTIAL_INSTALL_REQUIRES_REPAIR` error code or equivalent failure marker.

### Failure during test alert

- Treat as install failure for the happy-path workflow.
- Preserve all prior state.
- Report exact failing path (Matrix room targeting, bot membership, token, channel send path).

## Idempotency and Resume Requirements

The installer backend should support safe retry/resume behavior for the same target host/profile.

Required behavior:

- detect existing bundled services and reconcile instead of blindly recreating
- detect existing OpenClaw CLI installation and reuse it when compatible with the Sovereign pin
- repair/upgrade OpenClaw when an incompatible version is installed (unless an explicit advanced override disables this)
- detect existing OpenClaw gateway service and reconcile/repair instead of duplicating it
- detect existing Matrix operator/core-agent accounts and room when they match configured identifiers
- detect existing OpenClaw agent/cron registration and update in place when possible
- produce stable resource identifiers in `InstallResult` after successful reconciliation

The initial phase-B contract does not require a separate `resume` endpoint. Re-running `install` with the same configuration is the required recovery path.

## Related Docs

- `docs/ARCHITECTURE.md`
- `docs/OPERATIONS_ONBOARDING.md`
- `docs/MATRIX_BUNDLED_SETUP.md`
- `docs/MAIL_SENTINEL_DESIGN.md`
