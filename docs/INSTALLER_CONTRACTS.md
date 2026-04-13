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

- re-run the install flow using the saved install request file

Behavior:

- MUST require root privileges and instruct the operator to re-run with `sudo` when invoked as a non-root user
- MUST fail clearly when pending migrations exist
- MUST instruct the operator to run `sovereign-node migrate` first when that happens

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

- show recent logs for `sovereign-node`, bundled services, and selected components

Behavior:

- text mode is human-readable
- `--json` emits NDJSON log events

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

- update IMAP settings/credentials and validate them before persisting

Behavior:

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

`--json` result schema:

- `result` MUST be a `ReconfigureResult` with `target = "matrix"`

## `sovereign-node reconfigure openrouter`

Purpose:

- update OpenRouter model and/or secret reference for the bundled deployment profile

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
    requestedSlug?: string;
    hostname?: string; // when pre-enrolled, installer skips relay enrollment
    publicBaseUrl?: string; // when pre-enrolled, installer skips relay enrollment
    tunnel?: {
      serverAddr: string;
      serverPort?: number;
      token: string;
      proxyName: string;
      subdomain?: string;
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

- `mode` is required and must be `bundled_matrix` in phase B
- `openclaw.manageInstallation` defaults to `true`
- `openclaw.installMethod` defaults to `"install_sh"`
- `openclaw.runOnboard` defaults to `false` and should remain `false` in the default Sovereign flow
- `openrouter` is required
- `openrouter.apiKey` or `openrouter.secretRef` is required
- `imap.password` MUST NOT be persisted if provided
- `imap` may be omitted (pending IMAP mode)
- `connectivity.mode = "relay"` requires a valid `relay` object
- `relay.enrollmentToken` is optional only for the default Sovereign managed relay (`https://relay.sovereign-ai-node.com`)
- custom relays must provide `relay.enrollmentToken`
- relay enrollment is skipped when `relay.hostname`, `relay.publicBaseUrl`, and `relay.tunnel` are already populated
- relay hostname selection is installer-managed; user-provided relay slugs are not part of the public contract
- `matrix.federationEnabled` defaults to `false`

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
  error?: ErrorDetail; // present when state === "failed"
};
```

### `SovereignStatus`

```ts
type ComponentHealth = "healthy" | "degraded" | "unhealthy" | "unknown";

type ServiceStatus = {
  name: string;
  kind: "sovereign-node" | "openclaw" | "synapse" | "postgres" | "reverse-proxy" | "relay-tunnel";
  health: ComponentHealth;
  state: "running" | "stopped" | "failed" | "unknown";
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
};
```

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

- validate IMAP connectivity/auth and optional mailbox access before persisting configuration

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
  host: string;
  port: number;
  tls: boolean;
  auth: "ok" | "failed";
  mailbox?: string;
  capabilities?: string[];
  error?: ErrorDetail;
};
```

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

- update OpenRouter model and/or secret reference for the active installation

Request body:

```ts
type ReconfigureOpenrouterRequest = {
  openrouter: {
    model?: string;
    apiKey?: string; // transient only
    secretRef?: string;
  };
};
```

Constraints:

- at least one of `model`, `apiKey`, or `secretRef` is required
- `apiKey` and `secretRef` must not both be set in the same request

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
