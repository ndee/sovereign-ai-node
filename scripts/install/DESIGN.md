# Refactor sovereign-ai-node installer into smaller modules

## Context

The installer that the upcoming "zero-input curl install + chat-driven configuration" feature needs to modify is already two oversized files:

- `sovereign-ai-node/scripts/install.sh` — **3,883 lines, 127 shell functions** in a single script. Mixes arg parsing, OS detection, apt/docker/node bootstrapping, service-account setup, source sync, build, systemd, request-file IO, request-defaults migration, secret writing, TUI primitives (progress, choice menus, confirm/prompt), bot-catalog parsing, the install wizard itself, install-runner / readiness wait / output summarisation, post-install diagnostics, onboarding guidance, and `main`.
- `sovereign-ai-node/src/installer/real-service.ts` — **10,696 lines, one class** `RealInstallerService` (line 321) that implements the entire `InstallerService` API (preflight, install/update lifecycle, doctor/status, reconfigure, matrix users, mail-sentinel CRUD, bot CRUD, template CRUD, tool-instance CRUD, managed-agent CRUD) plus thousands of lines of private helpers.

Layering the upcoming feature work — which adds a synthesis path, relaxes the OpenRouter schema, adds a redaction CLI, extends the tool allowlist, and rewires bot defaults — on top of these files in their current shape multiplies maintenance debt instead of paying it down.

This plan lands a **refactor-only PR** that reorganises both files into smaller, single-concern modules with **byte-for-byte identical behaviour**. The follow-up feature PR rebases on the merged refactor.

## Scope of this PR

In: structural refactor of `scripts/install.sh` and `src/installer/real-service.ts` (+ co-located test moves), with verification that nothing observable changed.

Out: every feature change discussed in the parent conversation (zero-input install, OpenRouter schema relaxation, bootstrap mode, default-bot flip, redact-message CLI, docs). Those land in the follow-up plan after this PR is merged. A short reminder is kept at the end of this file so context isn't lost.

## Implementation

### Part A — Split `scripts/install.sh` into a thin orchestrator + libraries

`install.sh` keeps `main()` (currently line 3804), arg parsing entry, and source-the-libs glue — target ~250 lines. Functions move to `scripts/install/lib-*.sh`, sourced in dependency order from `main`.

| New library | Functions to move | Source lines (approx) |
|---|---|---|
| `scripts/install/lib-log.sh` | `log`, `die`, `usage` | 80–112 |
| `scripts/install/lib-args.sh` | `normalize_service_identity`, `parse_args` | 114–213 |
| `scripts/install/lib-os.sh` | `require_root`, `ensure_supported_os`, `wait_for_apt_lock`, `apt_get_locked` | 214–270 |
| `scripts/install/lib-runtime-deps.sh` | `install_base_packages`, `ansible_playbook_available`, `install_ansible_if_needed`, `docker_*`, `configure_docker_apt_repo`, `install_docker_if_needed`, `node_major_version`, `install_node22_if_needed` | 237–402 |
| `scripts/install/lib-runtime-paths.sh` | `ensure_service_account`, `ensure_runtime_directories`, `resolve_source_mode`, `find_local_bots_source_dir`, `sync_app_source`, `sync_bots_source`, `write_install_provenance` | 405–630 |
| `scripts/install/lib-build.sh` | `build_app`, `build_bots`, `install_wrappers`, `install_systemd_unit`, `configure_system_hygiene`, `install_request_template`, `detect_installation_state` | 632–845 |
| `scripts/install/lib-ui.sh` | All `ui_*` functions and TTY helpers (`has_tty`, `supports_color`) | 846–1340 |
| `scripts/install/lib-prompt.sh` | `ui_choice_menu*`, `ui_confirm*`, `prompt_value`, `prompt_secret`, `prompt_required_secret`, `ui_screen_line_count` | 1342–1585 |
| `scripts/install/lib-bot-catalog.sh` | `bot_list_contains`, `append_selected_bot`, `load_available_bot_catalog`, `default_selected_bots_from_catalog`, `resolve_bot_display_name`, `describe_selected_bots`, `build_default_bot_selection_numbers`, `parse_bot_selection_input`, `build_bot_selection_from_flags`, `set_bot_selection_flags_from_list`, `prompt_bot_selection*` | 1586–2041 |
| `scripts/install/lib-request-file.sh` | `reset_request_defaults`, `migrate_legacy_openrouter_model_request`, `load_existing_defaults`, `secret_ref_path_exists`, `warn_if_missing_secret_ref`, `write_secret_file`, `write_request_file_from_env`, `review_install_request` | 2042–2779 |
| `scripts/install/lib-matrix-urls.sh` | `refresh_recommended_matrix_defaults`, `slugify_matrix_project_name`, `build_internal_matrix_ca_path`, `build_matrix_onboarding_url`, `build_matrix_ca_download_url`, `build_element_web_link`, `print_onboarding_qr`, `infer_matrix_tls_mode_from_url`, `print_matrix_client_onboarding_guidance` | 2405–3586 |
| `scripts/install/lib-wizard.sh` | `resolve_action`, `run_install_wizard`, `prepare_install_request_for_install`, `prepare_install_request_for_update`, `prepare_request_file` | 2514–3122 |
| `scripts/install/lib-runner.sh` | `parse_install_result`, `parse_runtime_readiness`, `wait_for_runtime_ready`, `summarize_*`, `run_install_command`, `run_runtime_readiness_step`, `run_post_install_diagnostics_step`, `run_post_install_ansible_step` | 3124–3802 |

Each `recoverJsonObject` JS heredoc (currently at lines 3170, 3246, 3348, 3411, 3472) moves with its caller.

Top-level global-variable declarations and `DEFAULT_*` constants (lines 1–79 ish) stay in `install.sh` because they are read by multiple libraries; document them in a short comment block.

**Curl-pipe — release-artefact model.** The repo holds `scripts/install.sh` (a thin orchestrator) and `scripts/install/lib-*.sh` (the libraries it sources at runtime). For curl-pipe installs, `release.yml` runs `scripts/install/build.sh` on tag push to concatenate the orchestrator + libraries into a self-contained `install.sh` that ships as the GitHub Release asset.

- README's curl command points at `https://github.com/ndee/sovereign-ai-node/releases/latest/download/install.sh` (tag-pinned). The previous `raw.githubusercontent.com/.../main/scripts/install.sh` URL is intentionally broken — the orchestrator on `main` cannot run via curl-pipe because the libs aren't reachable that way. Migration is documented in release notes.
- Local-checkout installs (`sudo bash scripts/install.sh --source-dir "$(pwd)"`) keep working unchanged — the orchestrator finds `scripts/install/lib-*.sh` next to itself.
- CI (`ci.yml` E2E jobs) runs the orchestrator from a local checkout, exercising the multi-file path. The release workflow validates the bundled output is syntactically valid bash and that the bundled file contains no leftover `source` statements.

Benefits: no committed-bundle freshness check (no sync risk on `main`), release workflow already has tag-pinning, users get a versioned install URL. Cost: any third-party scripts/automation pinned to the old `main`-served URL break; this is documented and accepted.

### Part B — Split `src/installer/real-service.ts` along its natural boundaries

`RealInstallerService` already groups its public methods topically. Extract each group into its own module that exports a free function taking a small context (file system, clock, config paths, collaborator services). `RealInstallerService` becomes a thin facade that constructs the context in its constructor and delegates each method; target **under 1,500 lines**.

| New module | Methods extracted |
|---|---|
| `src/installer/install-lifecycle.ts` | `preflight`, `startInstall`, `getInstallJob`, `testImap`, `testMatrix`, `testAlert` (lines 948–1099) |
| `src/installer/status.ts` | `getStatus`, `getDoctorReport` (1100–1545) |
| `src/installer/reconfigure.ts` | `reconfigureImap`, `reconfigureMatrix`, `reconfigureOpenrouter` (1546–1750) |
| `src/installer/matrix-users.ts` | `issueMatrixOnboardingCode`, `inviteMatrixUser`, `removeMatrixUser` (1751–1869) |
| `src/installer/mail-sentinels-service.ts` | `getPendingMigrations`, `migrateLegacyMailSentinel`, `listMailSentinelInstances`, `createMailSentinelInstance`, `updateMailSentinelInstance`, `deleteMailSentinelInstance` (1870–2144). File suffixed `-service` to avoid collision with the existing `src/cli/commands/mail-sentinels.ts`. |
| `src/installer/sovereign-bots.ts` | `listSovereignBots`, `instantiateSovereignBot` (2152–2233) |
| `src/installer/sovereign-templates.ts` | `listSovereignTemplates`, `installSovereignTemplate` (2234–3701) — includes the long helper cluster that lives between these two methods; split that cluster into topical helpers during the extraction, don't preserve the 1,400-line blob. |
| `src/installer/sovereign-tools.ts` | `listSovereignToolInstances`, `createSovereignToolInstance`, `updateSovereignToolInstance`, `deleteSovereignToolInstance` (3702–3800 ish) |
| `src/installer/managed-agents.ts` | `listManagedAgents`, `createManagedAgent`, `updateManagedAgent`, `deleteManagedAgent` (2145–2151 + 4695–4720) |
| `src/installer/tool-allowlist.ts` | `listDocumentedSovereignToolCommands`, `listDocumentedSovereignToolNotes` (lines 4042–4092) — isolated surface the feature PR will extend. |
| `src/installer/openclaw-runtime.ts` | `writeOpenClawRuntimeArtifacts` and the secret-ref / env-file emission helpers (the cluster around lines 9825, 10180, 10195, 10199) |
| `src/installer/secrets.ts` | `resolveOpenRouterSecretRef` and the other secret-file write helpers currently interleaved in the class |

The existing siblings (`real-service-shared.ts`, `real-service-lobster.ts`, `real-service-relay.ts`, `real-service-relay-enrollment.ts`, `real-service-utils.ts`, `real-service-guarded-json-state-plugin.ts`) stay where they are. The anonymous `export default function (api)` at line 4359 also stays in `real-service.ts` until we understand its call sites — treat it as orchestrator wiring and leave it alone in this PR.

**Test moves.** `src/installer/real-service.test.ts` is ~6,400 lines. Split alongside the module split: each extracted module gets a co-located `*.test.ts` containing the tests that exercise its surface. Most tests already group by concern (`describe` blocks), so this is mostly file-moves plus updating imports and the `RealInstallerService` fixture setup. No `expect(...)` assertions change.

### Part C — Verification (no behaviour change)

Before the PR is marked ready, every one of these must hold:

1. `bash scripts/install.sh --help` — output byte-identical to pre-refactor. Capture a snapshot on `main`, diff against the PR branch.
2. `bash scripts/install.sh --request-file <fixture> --non-interactive` — generated request file byte-identical for a matrix of fixtures: (a) fresh install defaults, (b) LAN-only mode, (c) relay mode, (d) existing-install reconfigure. Diff = empty for each.
3. `pnpm -C sovereign-ai-node test` — full TypeScript test suite green. No assertion text edited; only imports and fixture setup.
4. `pnpm -C sovereign-ai-node run typecheck` and `pnpm -C sovereign-ai-node run lint` green.
5. End-to-end smoke on an ephemeral Proxmox dev VM (per project policy, no production):
   - `proxmox-pool-vm dev create`
   - Run the curl installer from the PR branch (via a tagged pre-release or a locally-served bundle).
   - Diff `runtime-config.json` and `install-request.json` between baseline (`main`) and PR. Diff = empty.
   - `sovereign-node status --json` and `sovereign-node doctor --json` identical shape between baseline and PR.
   - `proxmox-pool-vm dev delete`.
6. CI live-e2e workflow on the PR — green (per project memory, CI covers this without a dev-VM step when changes don't affect e2e behaviour; here we still run the dev VM because the installer is the change).

## Critical files

- `sovereign-ai-node/scripts/install.sh` — becomes a thin orchestrator.
- `sovereign-ai-node/scripts/install/lib-*.sh` — new library files listed above.
- `sovereign-ai-node/src/installer/real-service.ts` — becomes a thin facade.
- `sovereign-ai-node/src/installer/{install-lifecycle,status,reconfigure,matrix-users,mail-sentinels-service,sovereign-bots,sovereign-templates,sovereign-tools,managed-agents,tool-allowlist,openclaw-runtime,secrets}.ts` — new modules.
- `sovereign-ai-node/src/installer/*.test.ts` — co-located tests, split from the existing mega-suite.

## Out of scope for this PR (tracked for the follow-up)

After this PR merges, the next plan covers the originally-requested behaviour change. Keep this list as a hand-off:

- Zero-input curl installer: auto-detect matrix defaults from hostname, no OpenRouter prompt, no IMAP wizard; synthesise a `node-operator`-only install request when no TTY.
- Make OpenRouter optional in `src/contracts/install.ts` and downstream in the now-split `secrets.ts` / `openclaw-runtime.ts` modules (omit `OPENROUTER_API_KEY=` from env when ref is empty).
- Flip `defaultInstall`: `mail-sentinel` → `false`, `node-operator` → `true`.
- Node-operator **bootstrap mode** (no-LLM scripted DM) that collects + validates the OpenRouter key, writes the secret file, runs `sovereign-node reconfigure --target openrouter`. Pending: confirm OpenClaw can run a tool-only / scripted agent; otherwise fall back to a hardcoded built-in bootstrap key.
- Extend `tool-allowlist.ts` (the new module) so node-operator's LLM agent can call `sovereign-node bots install`, the full `mail-sentinels` CRUD, `reconfigure --target openrouter`, and the new `redact-message` CLI.
- New `src/cli/commands/redact-message.ts` for `m.room.redaction` — called after node-operator captures any IMAP password in DM.
- Multi-turn mail-sentinel create flow in node-operator's AGENTS.md / SKILL.md — multi-instance via `sovereign-node mail-sentinels create`, password goes to `/etc/sovereign-node/secrets/imap-password-<instance>`, message is redacted, reply is masked summary.
- E2E test `scripts/e2e/zero-input-install.sh` and updates to `scripts/e2e/mail-sentinel-e2e.sh` for the opt-in flow.
- README / CLAUDE.md rewrites for the new flow.
