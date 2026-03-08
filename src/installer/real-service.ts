import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, chown, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { FilesystemBotCatalog } from "../bots/catalog.js";
import type {
  BotCatalog,
  BotConfigRecord,
  BotConfigValue,
  LoadedBotPackage,
} from "../bots/catalog.js";
import { CONTRACT_VERSION, type CheckResult, type ComponentHealth } from "../contracts/common.js";
import {
  installJobStatusResponseSchema,
  installRequestSchema,
  type DoctorReport,
  type InstallJobStatusResponse,
  type InstallRequest,
  type MatrixOnboardingIssueResult,
  type PreflightResult,
  type ReconfigureResult,
  type SovereignStatus,
  type StartInstallResult,
  type TestAlertResult,
  type TestImapResult,
  type TestMatrixResult,
} from "../contracts/index.js";
import type {
  PreflightRequest,
  ReconfigureImapRequest,
  ReconfigureMatrixRequest,
  ReconfigureOpenrouterRequest,
  TestAlertRequest,
  TestImapRequest,
  TestMatrixRequest,
} from "../contracts/api.js";
import type { Logger } from "../logging/logger.js";
import type { SovereignPaths } from "../config/paths.js";
import {
  buildMatrixOnboardingUrl,
  issueMatrixOnboardingState,
} from "../onboarding/bootstrap-code.js";
import {
  resolveRequestedOpenClawVersion,
  type OpenClawBootstrapper,
} from "../openclaw/bootstrap.js";
import type { OpenClawGatewayServiceManager } from "../openclaw/gateway-service.js";
import type {
  ManagedAgentRegistrationResult,
  OpenClawManagedAgentRegistrar,
} from "../openclaw/managed-agent.js";
import type { ImapTester } from "../system/imap.js";
import type {
  BundledMatrixAccountsResult,
  BundledMatrixProvisionResult,
  BundledMatrixProvisioner,
  BundledMatrixRoomBootstrapResult,
} from "../system/matrix.js";
import type { HostPreflightChecker } from "../system/preflight.js";
import type { ExecResult, ExecRunner } from "../system/exec.js";
import {
  JobRunner,
  type InstallContext,
  type InstallStep,
  type JobRunnerSnapshot,
} from "./job-runner.js";
import {
  CORE_TEMPLATE_MANIFESTS,
  CORE_TRUSTED_TEMPLATE_KEYS,
  findCoreTemplateManifest,
  formatTemplateRef,
  parseTemplateRef,
  type AgentTemplateManifest,
  type SovereignTemplateManifest,
  type ToolTemplateManifest,
  verifySignedTemplateManifest,
} from "../templates/catalog.js";
import type {
  InstallerService,
  ManagedAgent,
  ManagedAgentDeleteResult,
  ManagedAgentListResult,
  ManagedAgentUpsertResult,
  SovereignBotInstantiateResult,
  SovereignBotListResult,
  SovereignTemplateInstallResult,
  SovereignTemplateListResult,
  SovereignToolInstanceDeleteResult,
  SovereignToolInstanceListResult,
  SovereignToolInstanceUpsertResult,
} from "./service.js";
import { StubInstallerService } from "./stub-service.js";
import {
  buildManagedAgentWorkspaceReadme,
  renderTemplateWorkspaceContent,
} from "./workspace-documents.js";
import {
  DEFAULT_INSTALL_REQUEST_FILE,
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_SERVICE_GROUP,
  DEFAULT_SERVICE_USER,
  INSTALLER_EXEC_TIMEOUT_MS,
  MAIL_SENTINEL_AGENT_ID,
  RELAY_LOCAL_EDGE_PORT,
  RELAY_TUNNEL_DEFAULT_IMAGE,
  RELAY_TUNNEL_SYSTEMD_UNIT,
  RESERVED_AGENT_IDS,
  SOVEREIGN_GATEWAY_SYSTEMD_UNIT,
  areMatrixIdentitiesEqual,
  areStringListsEqual,
  areStringRecordsEqual,
  buildSuggestedCommands,
  check,
  defaultFetch,
  delay,
  deriveOpenClawHealth,
  describeError,
  describeVersionPin,
  generateAgentPassword,
  ensureCoreManagedAgents,
  ensureTrailingSlash,
  isAlreadyExistsOutput,
  isAlreadyJoinedOrInvitedRoomError,
  isCoreAgentBindingBestEffortSkippable,
  isGatewayUserSystemdUnavailableError,
  isMailSentinelGatewayUnavailableError,
  isMissingBinaryError,
  isNodeError,
  isRateLimitedMatrixLoginFailure,
  isRecord,
  isStructuredError,
  looksLikeMissingGateway,
  mapHealthToServiceState,
  normalizeOpenClawAgentModel,
  normalizeStringRecord,
  normalizeTestAlertError,
  now,
  parseEnvFile,
  parseGatewayState,
  parseJsonDocument,
  parseJsonSafely,
  parseRuntimeConfigDocument,
  resolveVersionPinStatus,
  sanitizeExpectedMatrixLocalpart,
  sanitizeManagedAgentId,
  sanitizeManagedAgentLocalpart,
  sanitizeManagedWorkspace,
  sanitizeMatrixLocalpartFromAgentId,
  sanitizeOptionalTemplateRef,
  sanitizeOptionalToolInstanceIds,
  sanitizeToolInstanceId,
  stripSingleTrailingNewline,
  summarizeChecksOverall,
  summarizeText,
  summarizeUnknown,
  textContainsId,
  truncateText,
  type FetchLike,
  type GatewayState,
  type RelayRuntimeConfig,
  type RelayTunnelConfig,
  type RuntimeAgentEntry,
  type RuntimeConfig,
} from "./real-service-shared.js";

type PersistedInstallJobRecord = {
  version: 1;
  installationId: string;
  request: InstallRequest;
  response: InstallJobStatusResponse;
  updatedAt: string;
};

type RelayEnrollmentResult = {
  controlUrl: string;
  hostname: string;
  publicBaseUrl: string;
  tunnel: RelayTunnelConfig;
};

const OPENCLAW_EXEC_TOOL_ID = "exec";
const OPENCLAW_STATUS_PROBE_TIMEOUT_MS = 5_000;
const SOVEREIGN_EXECUTABLE_PATHS: Record<string, string> = {
  "sovereign-node": "/usr/local/bin/sovereign-node",
  "sovereign-node-api": "/usr/local/bin/sovereign-node-api",
  "sovereign-node-onboarding-api": "/usr/local/bin/sovereign-node-onboarding-api",
  "sovereign-tool": "/usr/local/bin/sovereign-tool",
};

const DEFAULT_MANAGED_RELAY_CONTROL_URL = "https://relay.sovereign-ai-node.com";

const RELAY_NAME_THEMES = [
  "satoshi",
  "freedom",
  "privacy",
  "liberty",
  "cipher",
  "anon",
  "hodl",
  "sovereign",
  "bitcoin",
];

const RELAY_NAME_MOODS = [
  "stealthy",
  "mighty",
  "brave",
  "silent",
  "wild",
  "sunny",
  "cosmic",
  "fuzzy",
  "nimble",
];

const RELAY_NAME_MASCOTS = [
  "badger",
  "fox",
  "otter",
  "owl",
  "falcon",
  "lynx",
  "yak",
  "raven",
  "wolf",
];

type RealInstallerServiceDeps = {
  openclawBootstrapper: OpenClawBootstrapper;
  openclawGatewayServiceManager: OpenClawGatewayServiceManager;
  managedAgentRegistrar?: OpenClawManagedAgentRegistrar;
  mailSentinelRegistrar?: OpenClawManagedAgentRegistrar;
  botCatalog?: BotCatalog;
  preflightChecker: HostPreflightChecker;
  imapTester: ImapTester;
  matrixProvisioner: BundledMatrixProvisioner;
  execRunner?: ExecRunner;
  fetchImpl?: FetchLike;
};

export class RealInstallerService implements InstallerService {
  private readonly stubService: StubInstallerService;

  private readonly jobRunner = new JobRunner();

  private resolvedInstallJobsDir: string | null = null;
  private resolvedSecretsDir: string | null = null;
  private resolvedRuntimeOwnership: { uid: number; gid: number } | null | undefined = undefined;
  private managedOpenClawEnv: Record<string, string> | null | undefined = undefined;

  private readonly openclawBootstrapper: OpenClawBootstrapper;

  private readonly openclawGatewayServiceManager: OpenClawGatewayServiceManager;

  private readonly managedAgentRegistrar: OpenClawManagedAgentRegistrar;

  private readonly botCatalog: BotCatalog;

  private readonly preflightChecker: HostPreflightChecker;

  private readonly imapTester: ImapTester;

  private readonly matrixProvisioner: BundledMatrixProvisioner;

  private readonly execRunner: ExecRunner | null;

  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly logger: Logger,
    private readonly paths: SovereignPaths,
    deps: RealInstallerServiceDeps,
  ) {
    this.stubService = new StubInstallerService(logger);
    this.openclawBootstrapper = deps.openclawBootstrapper;
    this.openclawGatewayServiceManager = deps.openclawGatewayServiceManager;
    this.managedAgentRegistrar = deps.managedAgentRegistrar ?? deps.mailSentinelRegistrar!;
    this.botCatalog = deps.botCatalog ?? new FilesystemBotCatalog();
    this.preflightChecker = deps.preflightChecker;
    this.imapTester = deps.imapTester;
    this.matrixProvisioner = deps.matrixProvisioner;
    this.execRunner = deps.execRunner ?? null;
    this.fetchImpl = deps.fetchImpl ?? defaultFetch;
  }

  private async listBotPackages(): Promise<LoadedBotPackage[]> {
    return await this.botCatalog.listPackages();
  }

  private async getBotPackage(id: string): Promise<LoadedBotPackage> {
    return await this.botCatalog.getPackage(id);
  }

  private async findBotPackageByTemplateRef(
    templateRef: string | undefined,
  ): Promise<LoadedBotPackage | null> {
    if (templateRef === undefined) {
      return null;
    }
    return await this.botCatalog.findPackageByTemplateRef(templateRef);
  }

  private async resolveRequestedBots(req: InstallRequest): Promise<{
    packages: LoadedBotPackage[];
    configById: Record<string, BotConfigRecord>;
  }> {
    const defaultBotIds = await this.botCatalog.getDefaultSelectedIds();
    const selectedBotIds = this.resolveRequestedBotIds(req, defaultBotIds);
    const packages = await Promise.all(selectedBotIds.map(async (id) => await this.getBotPackage(id)));
    const defaultsById = Object.fromEntries(
      packages.map((entry) => [entry.manifest.id, { ...entry.manifest.configDefaults }] as const),
    );
    const configuredByRequest = isBotConfigRecordMap(req.bots?.config)
      ? req.bots.config
      : {};
    const mergedById = Object.fromEntries(
      packages.map((entry) => [
        entry.manifest.id,
        {
          ...defaultsById[entry.manifest.id],
          ...(configuredByRequest[entry.manifest.id] ?? {}),
        },
      ] satisfies [string, BotConfigRecord]),
    );
    if (req.mailSentinel !== undefined && mergedById["mail-sentinel"] !== undefined) {
      mergedById["mail-sentinel"] = {
        ...mergedById["mail-sentinel"],
        ...compactBotConfigRecord({
          pollInterval: req.mailSentinel.pollInterval,
          lookbackWindow: req.mailSentinel.lookbackWindow,
          e2eeAlertRoom: req.mailSentinel.e2eeAlertRoom,
        }),
      };
    }
    return {
      packages,
      configById: mergedById,
    };
  }

  private resolveSharedServiceBotLocalpart(packages: LoadedBotPackage[]): string | undefined {
    return packages.find((entry) => entry.manifest.matrixIdentity.mode === "service-account")
      ?.manifest.matrixIdentity.localpartPrefix;
  }

  private resolveRequestedBotIds(req: InstallRequest, defaultBotIds: string[]): string[] {
    const selected = req.bots?.selected
      ?.map((entry: string) => entry.trim())
      .filter((entry: string) => entry.length > 0)
      ?? [];
    if (selected.length > 0) {
      return dedupeStrings(selected);
    }
    if (req.mailSentinel !== undefined) {
      return ["mail-sentinel"];
    }
    return dedupeStrings(defaultBotIds);
  }

  async preflight(input?: PreflightRequest): Promise<PreflightResult> {
    return this.preflightChecker.run(input);
  }

  async testImap(req: TestImapRequest): Promise<TestImapResult> {
    return this.imapTester.test(req);
  }

  async testMatrix(req: TestMatrixRequest): Promise<TestMatrixResult> {
    return this.matrixProvisioner.test(req);
  }

  async startInstall(req: InstallRequest): Promise<StartInstallResult> {
    const installationId = `inst_${randomUUID()}`;
    const jobId = `job_${randomUUID()}`;
    const ctx: InstallContext = {
      installationId,
      jobId,
    };

    const runResult = await this.jobRunner.run(
      ctx,
      this.buildInstallSteps(req),
      async (snapshot) => {
        await this.persistJobSnapshot({
          installationId,
          request: req,
          snapshot,
        });
      },
    );

    return {
      job: runResult.job,
    };
  }

  async getInstallJob(jobId: string): Promise<InstallJobStatusResponse> {
    const record = await this.readJobRecord(jobId);
    if (record === null) {
      throw new Error(`Install job not found: ${jobId}`);
    }

    return record.response;
  }

  async testAlert(req: TestAlertRequest): Promise<TestAlertResult> {
    const channel = req.channel ?? "matrix";
    const unknownRoom = req.roomId ?? "!unknown:local";
    if (channel !== "matrix") {
      return {
        delivered: false,
        target: {
          channel: "matrix",
          roomId: unknownRoom,
        },
        error: {
          code: "TEST_ALERT_CHANNEL_UNSUPPORTED",
          message: "Only Matrix test alerts are currently supported",
          retryable: false,
          details: { requestedChannel: channel },
        },
      };
    }

    try {
      const config = await this.readRuntimeConfig();
      const roomId = req.roomId ?? config.matrix.alertRoom.roomId;
      const accessToken = await this.resolveSecretRef(config.matrix.bot.accessTokenSecretRef);
      const transactionId = `sovereign_${Date.now()}_${randomUUID().slice(0, 8)}`;
      const endpoint = new URL(
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(
          transactionId,
        )}`,
        ensureTrailingSlash(config.matrix.adminBaseUrl),
      ).toString();

      const response = await this.fetchImpl(endpoint, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          msgtype: "m.text",
          body: req.text ?? `Sovereign test alert (${now()})`,
        }),
      });

      const rawBody = await response.text();
      const parsed = parseJsonSafely(rawBody);
      if (!response.ok) {
        return {
          delivered: false,
          target: {
            channel: "matrix",
            roomId,
          },
          error: {
            code: "TEST_ALERT_FAILED",
            message: "Matrix test alert delivery failed",
            retryable: true,
            details: {
              status: response.status,
              body: summarizeUnknown(parsed),
            },
          },
        };
      }

      const messageId =
        isRecord(parsed) && typeof parsed.event_id === "string" ? parsed.event_id : undefined;

      return {
        delivered: true,
        target: {
          channel: "matrix",
          roomId,
        },
        ...(messageId === undefined ? {} : { messageId }),
        sentAt: now(),
      };
    } catch (error) {
      return {
        delivered: false,
        target: {
          channel: "matrix",
          roomId: unknownRoom,
        },
        error: normalizeTestAlertError(error),
      };
    }
  }

  async getStatus(): Promise<SovereignStatus> {
    const runtimeConfig = await this.tryReadRuntimeConfig();
    const detectedOpenClaw = await this.safeDetectOpenClaw();
    const expectedAgentIds = runtimeConfig?.openclawProfile.agents.map((entry) => entry.id) ?? [];
    const expectedCronIds = runtimeConfig?.openclawProfile.crons.map((entry) => entry.id) ?? [];

    const gateway = await this.inspectGatewayService();
    const relay = runtimeConfig?.relay?.enabled === true
      ? await this.inspectRelayTunnelService()
      : {
          installed: false,
          state: "unknown" as GatewayState,
          message: undefined,
        };
    const healthProbe = await this.probeOpenClawHealth();
    const agentProbes = await Promise.all(
      expectedAgentIds.map(async (id) => await this.inspectOpenClawListContains(["agents", "list"], id)),
    );
    const cronProbes = await Promise.all(
      expectedCronIds.map(async (id) => await this.inspectOpenClawListContains(["cron", "list"], id)),
    );
    const matrixStatus = await this.inspectMatrixStatus(runtimeConfig);

    const cliInstalled = detectedOpenClaw !== null;
    const managedBySovereign = runtimeConfig?.openclaw.managedInstallation ?? true;
    const pluginIds = runtimeConfig?.openclawProfile.plugins.allow;
    const agentPresent = agentProbes.every((probe) => !probe.verified || probe.present);
    const cronPresent = cronProbes.every((probe) => !probe.verified || probe.present);
    const openclawHealth = deriveOpenClawHealth({
      cliInstalled,
      gatewayState: gateway.state,
      healthProbeOk: healthProbe.ok,
      agentPresent,
      cronPresent,
    });
    const relayServiceHealth: ComponentHealth =
      relay.installed && relay.state === "running"
        ? "healthy"
        : relay.installed
          ? "degraded"
          : "unhealthy";
    const sovereignHealth: ComponentHealth =
      runtimeConfig === null ? "degraded" : "healthy";

    return {
      mode: "bundled_matrix",
      services: [
        {
          name: "sovereign-node",
          kind: "sovereign-node",
          health: sovereignHealth,
          state: "running",
          ...(runtimeConfig === null
            ? { message: "Sovereign runtime config is not readable" }
            : {}),
        },
        {
          name: "openclaw-gateway",
          kind: "openclaw",
          health: openclawHealth,
          state: gateway.state,
          ...(gateway.message === undefined ? {} : { message: gateway.message }),
        },
        {
          name: "synapse",
          kind: "synapse",
          health: matrixStatus.health,
          state: mapHealthToServiceState(matrixStatus.health),
          ...(matrixStatus.message === undefined ? {} : { message: matrixStatus.message }),
        },
        ...(runtimeConfig?.relay?.enabled === true
          ? [
              {
                name: "matrix-relay-tunnel",
                kind: "relay-tunnel" as const,
                health: relayServiceHealth,
                state: relay.state,
                ...(relay.message === undefined ? {} : { message: relay.message }),
              },
            ]
          : []),
      ],
      ...(runtimeConfig?.relay === undefined
        ? {}
        : {
            relay: {
              enabled: runtimeConfig.relay.enabled,
              controlUrl: runtimeConfig.relay.controlUrl,
              hostname: runtimeConfig.relay.hostname,
              publicBaseUrl: runtimeConfig.relay.publicBaseUrl,
              connected: relay.installed && relay.state === "running",
              serviceInstalled: relay.installed,
              ...(relay.state === "unknown" ? {} : { serviceState: relay.state }),
            },
          }),
      matrix: {
        ...(runtimeConfig?.matrix.publicBaseUrl === undefined
          ? {}
          : { homeserverUrl: runtimeConfig.matrix.publicBaseUrl }),
        health: matrixStatus.health,
        roomReachable: matrixStatus.roomReachable,
        federationEnabled: runtimeConfig?.matrix.federationEnabled ?? false,
        ...(runtimeConfig?.matrix.alertRoom.roomId === undefined
          ? {}
          : { alertRoomId: runtimeConfig.matrix.alertRoom.roomId }),
      },
      openclaw: {
        managedBySovereign,
        cliInstalled,
        ...(detectedOpenClaw?.binaryPath === undefined
          ? {}
          : { binaryPath: detectedOpenClaw.binaryPath }),
        ...(detectedOpenClaw?.version === undefined ? {} : { version: detectedOpenClaw.version }),
        health: openclawHealth,
        serviceInstalled: gateway.installed,
        ...(gateway.state === "unknown" ? {} : { serviceState: gateway.state }),
        ...(runtimeConfig?.openclaw.runtimeConfigPath === undefined
          ? {}
          : { configPath: runtimeConfig.openclaw.runtimeConfigPath }),
        agentPresent,
        cronPresent,
        ...(pluginIds === undefined ? {} : { pluginIds }),
      },
      mailSentinel: {
        agentId: MAIL_SENTINEL_AGENT_ID,
        consecutiveFailures: 0,
      },
      imap: {
        authStatus: "unknown",
        ...(runtimeConfig?.imap.status !== "configured" || runtimeConfig.imap.host === undefined
          ? {}
          : { host: runtimeConfig.imap.host }),
        ...(runtimeConfig?.imap.status !== "configured" || runtimeConfig.imap.mailbox === undefined
          ? {}
          : { mailbox: runtimeConfig.imap.mailbox }),
      },
      version: {
        sovereignNode: process.env.npm_package_version ?? "0.1.0",
        contractVersion: CONTRACT_VERSION,
        ...(detectedOpenClaw?.version === undefined ? {} : { openclaw: detectedOpenClaw.version }),
        ...(pluginIds === undefined
          ? {}
          : {
              plugins: Object.fromEntries(
                pluginIds.map((pluginId) => [pluginId, "managed-by-sovereign"]),
              ),
            }),
      },
    };
  }

  async getDoctorReport(): Promise<DoctorReport> {
    const checks: CheckResult[] = [];
    const runtimeConfig = await this.tryReadRuntimeConfig();
    const detectedOpenClaw = await this.safeDetectOpenClaw();
    const gateway = await this.inspectGatewayService();
    const relay = runtimeConfig?.relay?.enabled === true
      ? await this.inspectRelayTunnelService()
      : null;
    const healthProbe = await this.probeOpenClawHealth();
    const expectedAgentIds = runtimeConfig?.openclawProfile.agents.map((entry) => entry.id) ?? [];
    const expectedCronIds = runtimeConfig?.openclawProfile.crons.map((entry) => entry.id) ?? [];
    const agentProbes = await Promise.all(
      expectedAgentIds.map(async (id) => await this.inspectOpenClawListContains(["agents", "list"], id)),
    );
    const cronProbes = await Promise.all(
      expectedCronIds.map(async (id) => await this.inspectOpenClawListContains(["cron", "list"], id)),
    );
    const agentPresent = agentProbes.every((probe) => !probe.verified || probe.present);
    const cronPresent = cronProbes.every((probe) => !probe.verified || probe.present);
    const wiringCheck = await this.inspectOpenClawRuntimeWiring(runtimeConfig);

    checks.push(
      check(
        "openclaw-cli",
        "OpenClaw CLI",
        detectedOpenClaw === null ? "fail" : "pass",
        detectedOpenClaw === null
          ? "OpenClaw CLI is not detectable"
          : `OpenClaw CLI detected (${detectedOpenClaw.version})`,
      ),
    );

    checks.push(
      check(
        "openclaw-version-pin",
        "OpenClaw version pin",
        resolveVersionPinStatus(runtimeConfig, detectedOpenClaw),
        describeVersionPin(runtimeConfig, detectedOpenClaw),
        {
          expectedVersion: runtimeConfig?.openclaw.requestedVersion,
          detectedVersion: detectedOpenClaw?.version,
        },
      ),
    );

    checks.push(
      check(
        "gateway-service-install",
        "OpenClaw gateway service install",
        gateway.installed ? "pass" : "fail",
        gateway.installed
          ? "OpenClaw gateway service appears installed"
          : "OpenClaw gateway service is not installed or not detectable",
        gateway.message === undefined ? undefined : { message: gateway.message },
      ),
    );

    checks.push(
      check(
        "gateway-service-health",
        "OpenClaw gateway service health",
        !gateway.installed
          ? "fail"
          : gateway.state === "running" && healthProbe.ok
            ? "pass"
            : gateway.state === "failed" || !healthProbe.ok
              ? "fail"
              : "warn",
        gateway.state === "running" && healthProbe.ok
          ? "OpenClaw gateway service is running and health probe succeeded"
          : "OpenClaw gateway service health probe failed or service is not running",
        {
          state: gateway.state,
          healthProbe: healthProbe.message,
        },
      ),
    );

    if (relay !== null) {
      checks.push(
        check(
          "relay-tunnel-service",
          "Managed relay tunnel service",
          relay.installed && relay.state === "running"
            ? "pass"
            : relay.installed
              ? "warn"
              : "fail",
          relay.installed && relay.state === "running"
            ? "Managed relay tunnel service is connected"
            : "Managed relay tunnel service is not running",
          relay.message === undefined
            ? undefined
            : {
                state: relay.state,
                message: relay.message,
              },
        ),
      );
    }

    checks.push(wiringCheck);

    checks.push(
      check(
        "managed-bot-registration",
        "Managed bot registration",
        agentProbes.some((probe) => probe.verified) || cronProbes.some((probe) => probe.verified)
          ? agentPresent && cronPresent
            ? "pass"
            : "fail"
          : "warn",
        agentProbes.some((probe) => probe.verified) || cronProbes.some((probe) => probe.verified)
          ? agentPresent && cronPresent
            ? "Managed bot agents and cron entries are present in OpenClaw"
            : "One or more managed bot agents or cron entries are missing in OpenClaw"
          : "Could not fully verify managed bot registration via OpenClaw CLI",
      ),
    );

    const matrixStatus = await this.inspectMatrixStatus(runtimeConfig);
    checks.push(
      check(
        "matrix-runtime-health",
        "Matrix runtime health",
        matrixStatus.health === "healthy"
          ? "pass"
          : matrixStatus.health === "unknown"
            ? "warn"
            : "fail",
        matrixStatus.health === "healthy"
          ? "Matrix homeserver probe succeeded"
          : matrixStatus.message ?? "Matrix homeserver probe failed",
      ),
    );

    return {
      overall: summarizeChecksOverall(checks),
      checks,
      suggestedCommands: buildSuggestedCommands({
        runtimeConfig,
        gateway,
        healthProbe,
        cliDetected: detectedOpenClaw !== null,
        agentPresent,
        cronPresent,
        wiringCheck,
      }),
    };
  }

  async reconfigureImap(req: ReconfigureImapRequest): Promise<ReconfigureResult> {
    return this.stubService.reconfigureImap(req);
  }

  async reconfigureMatrix(req: ReconfigureMatrixRequest): Promise<ReconfigureResult> {
    return this.stubService.reconfigureMatrix(req);
  }

  async reconfigureOpenrouter(req: ReconfigureOpenrouterRequest): Promise<ReconfigureResult> {
    const runtimeConfig = await this.readRuntimeConfig();
    const raw = await readFile(this.paths.configPath, "utf8");
    const parsed = parseJsonDocument(raw);
    if (!isRecord(parsed)) {
      throw {
        code: "CONFIG_INVALID",
        message: "Sovereign runtime config does not match expected shape",
        retryable: false,
        details: {
          configPath: this.paths.configPath,
        },
      };
    }

    const requestedModel = req.openrouter.model?.trim();
    const nextModel =
      requestedModel !== undefined && requestedModel.length > 0
        ? requestedModel
        : runtimeConfig.openrouter.model;
    const modelChanged = nextModel !== runtimeConfig.openrouter.model;

    let nextSecretRef = runtimeConfig.openrouter.apiKeySecretRef;
    let credentialsChanged = false;
    if (req.openrouter.apiKey !== undefined) {
      nextSecretRef = await this.writeManagedSecretFile(
        "openrouter-api-key",
        req.openrouter.apiKey,
      );
      credentialsChanged = true;
    } else if (req.openrouter.secretRef !== undefined) {
      nextSecretRef = req.openrouter.secretRef;
      credentialsChanged = nextSecretRef !== runtimeConfig.openrouter.apiKeySecretRef;
    }

    const runtimeChanged = modelChanged || credentialsChanged;
    const changed: string[] = [];
    if (modelChanged) {
      changed.push("openrouter.model");
    }
    if (credentialsChanged) {
      changed.push("openrouter.apiKeySecretRef");
    }

    let gatewayRestarted = false;
    if (runtimeChanged) {
      const openrouterConfig = isRecord(parsed.openrouter) ? parsed.openrouter : {};
      openrouterConfig["provider"] = "openrouter";
      openrouterConfig["model"] = nextModel;
      openrouterConfig["apiKeySecretRef"] = nextSecretRef;
      delete openrouterConfig["apiKey"];
      parsed["openrouter"] = openrouterConfig;
      parsed["generatedAt"] = now();
      await this.writeInstallerJsonFile(this.paths.configPath, parsed, 0o644);

      const nextRuntimeConfig: RuntimeConfig = {
        ...runtimeConfig,
        openrouter: {
          model: nextModel,
          apiKeySecretRef: nextSecretRef,
        },
      };
      await this.writeOpenClawRuntimeArtifacts(nextRuntimeConfig);
      this.setManagedOpenClawEnv(nextRuntimeConfig);
      await this.refreshGatewayAfterRuntimeConfig(nextRuntimeConfig);
      gatewayRestarted = true;
    }

    const requestUpdate = await this.updateInstallRequestOpenrouter({
      model: nextModel,
      secretRef: nextSecretRef,
      modelChanged,
      credentialsChanged,
    });
    changed.push(...requestUpdate.changed);

    return {
      target: "openrouter",
      changed,
      restartRequiredServices: gatewayRestarted ? ["openclaw-gateway"] : [],
      validation: [
        check(
          "openrouter-runtime",
          "OpenRouter runtime config",
          "pass",
          runtimeChanged
            ? "OpenRouter runtime config updated"
            : "OpenRouter runtime config already matched the requested values",
        ),
        ...(gatewayRestarted
          ? [
              check(
                "openclaw-gateway-restart",
                "OpenClaw gateway restart",
                "pass",
                "OpenClaw gateway restarted with updated OpenRouter settings",
              ),
            ]
          : []),
        ...requestUpdate.validation,
      ],
    };
  }

  async issueMatrixOnboardingCode(req?: {
    ttlMinutes?: number;
  }): Promise<MatrixOnboardingIssueResult> {
    const runtimeConfig = await this.readRuntimeConfig();
    if (
      runtimeConfig.matrix.accessMode !== "relay"
      && !runtimeConfig.matrix.publicBaseUrl.startsWith("https://")
    ) {
      throw {
        code: "MATRIX_ONBOARDING_UNAVAILABLE",
        message:
          "Matrix onboarding is unavailable because this installation does not expose the HTTPS onboarding page",
        retryable: false,
        details: {
          publicBaseUrl: runtimeConfig.matrix.publicBaseUrl,
          accessMode: runtimeConfig.matrix.accessMode,
        },
      };
    }
    const statePath = this.getMatrixOnboardingStatePath(runtimeConfig);
    const operatorPasswordSecretRef = runtimeConfig.matrix.operator.passwordSecretRef;
    if (operatorPasswordSecretRef === undefined || operatorPasswordSecretRef.length === 0) {
      throw {
        code: "MATRIX_ONBOARDING_UNAVAILABLE",
        message: "Matrix onboarding is unavailable because the operator password secret is missing",
        retryable: false,
      };
    }

    const issued = issueMatrixOnboardingState({
      operatorPasswordSecretRef,
      username: runtimeConfig.matrix.operator.userId,
      homeserverUrl: runtimeConfig.matrix.publicBaseUrl,
      ...(req?.ttlMinutes === undefined ? {} : { ttlMinutes: req.ttlMinutes }),
    });
    await this.writeInstallerJsonFile(statePath, issued.state, 0o600);
    return {
      code: issued.code,
      expiresAt: issued.state.expiresAt,
      onboardingUrl: buildMatrixOnboardingUrl(runtimeConfig.matrix.publicBaseUrl),
      username: runtimeConfig.matrix.operator.userId,
    };
  }

  async listManagedAgents(): Promise<ManagedAgentListResult> {
    const runtimeConfig = await this.readRuntimeConfig();
    return {
      agents: runtimeConfig.openclawProfile.agents.map((entry) =>
        this.toManagedAgentOutput(entry)),
    };
  }

  async listSovereignBots(): Promise<SovereignBotListResult> {
    const runtimeConfig = await this.tryReadRuntimeConfig();
    const installedTemplateRefs = new Set(
      runtimeConfig?.templates.installed.map((entry) => formatTemplateRef(entry.id, entry.version)) ?? [],
    );
    const botPackages = await this.listBotPackages();
    const bots = await Promise.all(botPackages.map(async (botPackage) => {
      const agent = runtimeConfig?.openclawProfile.agents.find(
        (entry) => entry.templateRef === botPackage.templateRef || entry.botId === botPackage.manifest.id,
      );
      const cronJobIds = runtimeConfig?.openclawProfile.crons
        .filter((entry) => entry.botId === botPackage.manifest.id || entry.agentId === botPackage.manifest.id)
        .map((entry) => entry.id)
        .sort((left, right) => left.localeCompare(right));
      return {
        id: botPackage.manifest.id,
        version: botPackage.manifest.version,
        displayName: botPackage.manifest.displayName,
        description: botPackage.manifest.description,
        defaultInstall: botPackage.manifest.defaultInstall === true,
        templateRef: botPackage.templateRef,
        installed: installedTemplateRefs.has(botPackage.templateRef),
        instantiated: agent !== undefined,
        ...(agent === undefined ? {} : { agentId: agent.id }),
        ...(cronJobIds === undefined || cronJobIds.length === 0 ? {} : { cronJobIds }),
      };
    }));
    return {
      bots: bots.sort((left, right) => left.id.localeCompare(right.id)),
    };
  }

  async instantiateSovereignBot(req: {
    id: string;
    workspace?: string;
  }): Promise<SovereignBotInstantiateResult> {
    const runtimeConfig = await this.readRuntimeConfig();
    const botPackage = await this.getBotPackage(req.id);
    const changedTemplate = await this.ensureBotTemplateInstalled(runtimeConfig, botPackage);
    if (changedTemplate) {
      await this.persistManagedAgentTopologyDocument(runtimeConfig);
    }
    const toolInstanceIds = await this.ensureBotToolInstances(runtimeConfig, botPackage);
    const agentResult = await this.upsertManagedAgent(
      {
        id: botPackage.manifest.id,
        ...(req.workspace === undefined ? {} : { workspace: req.workspace }),
        botId: botPackage.manifest.id,
        templateRef: botPackage.templateRef,
        toolInstanceIds,
      },
      "create",
    );
    const bot = (await this.listSovereignBots()).bots.find((entry) => entry.id === botPackage.manifest.id);
    return {
      bot: bot ?? {
        id: botPackage.manifest.id,
        version: botPackage.manifest.version,
        displayName: botPackage.manifest.displayName,
        description: botPackage.manifest.description,
        defaultInstall: botPackage.manifest.defaultInstall === true,
        templateRef: botPackage.templateRef,
        installed: true,
        instantiated: true,
        agentId: agentResult.agent.id,
      },
      agent: agentResult.agent,
      changed: changedTemplate || agentResult.changed,
      restartRequiredServices: agentResult.restartRequiredServices,
    };
  }

  async listSovereignTemplates(): Promise<SovereignTemplateListResult> {
    const runtimeConfig = await this.tryReadRuntimeConfig();
    const installedByRef = new Map(
      (runtimeConfig?.templates.installed ?? []).map((entry) => [
        formatTemplateRef(entry.id, entry.version),
        entry,
      ]),
    );
    const coreTemplates: SovereignTemplateListResult["templates"] = CORE_TEMPLATE_MANIFESTS.map((manifest) => {
      const verified = verifySignedTemplateManifest(manifest, CORE_TRUSTED_TEMPLATE_KEYS);
      const ref = formatTemplateRef(manifest.id, manifest.version);
      const installed = installedByRef.get(ref);
      return {
        kind: "tool",
        id: manifest.id,
        version: manifest.version,
        description: manifest.description,
        trusted: verified.trusted,
        installed: installed !== undefined,
        pinned: installed?.pinned ?? false,
        keyId: verified.keyId,
        manifestSha256: verified.manifestSha256,
      };
    });
    const botTemplates: SovereignTemplateListResult["templates"] = (await this.listBotPackages()).map((botPackage) => {
      const installed = installedByRef.get(botPackage.templateRef);
      return {
        kind: "agent" as const,
        id: botPackage.template.id,
        version: botPackage.template.version,
        description: botPackage.template.description,
        trusted: true,
        installed: installed !== undefined,
        pinned: installed?.pinned ?? false,
        keyId: botPackage.keyId,
        manifestSha256: botPackage.manifestSha256,
      };
    });
    const templates = [...coreTemplates, ...botTemplates].sort((left, right) => `${left.kind}:${left.id}:${left.version}`.localeCompare(
      `${right.kind}:${right.id}:${right.version}`,
    ));
    return { templates };
  }

  async installSovereignTemplate(req: {
    ref: string;
  }): Promise<SovereignTemplateInstallResult> {
    const manifest = findCoreTemplateManifest(req.ref);
    const runtimeConfig = await this.readRuntimeConfig();
    if (manifest !== undefined) {
      const existing = runtimeConfig.templates.installed.find(
        (entry) => formatTemplateRef(entry.id, entry.version) === req.ref,
      );
      if (existing !== undefined) {
        return {
          template: {
            kind: existing.kind,
            id: existing.id,
            version: existing.version,
            description: existing.description,
            trusted: existing.trusted,
            installed: true,
            pinned: existing.pinned,
            keyId: existing.keyId,
            manifestSha256: existing.manifestSha256,
          },
          changed: false,
        };
      }
      const installed = this.buildInstalledTemplateEntryFromCore(manifest);
      runtimeConfig.templates.installed = sortInstalledTemplates([
        ...runtimeConfig.templates.installed,
        installed,
      ]);
      await this.persistManagedAgentTopologyDocument(runtimeConfig);
      return {
        template: {
          kind: installed.kind,
          id: installed.id,
          version: installed.version,
          description: installed.description,
          trusted: installed.trusted,
          installed: true,
          pinned: installed.pinned,
          keyId: installed.keyId,
          manifestSha256: installed.manifestSha256,
        },
        changed: true,
      };
    }

    const botPackage = await this.botCatalog.findPackageByTemplateRef(req.ref);
    if (botPackage === null) {
      throw {
        code: "TEMPLATE_NOT_FOUND",
        message: `Template '${req.ref}' was not found in the trusted catalog`,
        retryable: false,
      };
    }
    const changed = await this.ensureBotTemplateInstalled(runtimeConfig, botPackage);
    if (changed) {
      await this.persistManagedAgentTopologyDocument(runtimeConfig);
    }
    return {
      template: {
        kind: "agent",
        id: botPackage.template.id,
        version: botPackage.template.version,
        description: botPackage.template.description,
        trusted: true,
        installed: true,
        pinned: true,
        keyId: botPackage.keyId,
        manifestSha256: botPackage.manifestSha256,
      },
      changed,
    };
  }

  private buildInstalledTemplateEntryFromCore(
    manifest: SovereignTemplateManifest,
  ): RuntimeConfig["templates"]["installed"][number] {
    const verified = verifySignedTemplateManifest(manifest, CORE_TRUSTED_TEMPLATE_KEYS);
    return {
      kind: "tool",
      id: manifest.id,
      version: manifest.version,
      description: manifest.description,
      trusted: true,
      pinned: true,
      keyId: verified.keyId,
      manifestSha256: verified.manifestSha256,
      installedAt: now(),
      source: "core",
    };
  }

  private buildInstalledTemplateEntryFromBot(
    botPackage: LoadedBotPackage,
  ): RuntimeConfig["templates"]["installed"][number] {
    return {
      kind: "agent",
      id: botPackage.template.id,
      version: botPackage.template.version,
      description: botPackage.template.description,
      trusted: true,
      pinned: true,
      keyId: botPackage.keyId,
      manifestSha256: botPackage.manifestSha256,
      installedAt: now(),
      source: "bot-repo",
    };
  }

  private upsertInstalledBotTemplateEntry(
    existing: RuntimeConfig["templates"]["installed"],
    botPackage: LoadedBotPackage,
  ): {
    installed: RuntimeConfig["templates"]["installed"];
    changed: boolean;
  } {
    const ref = botPackage.templateRef;
    const current = existing.find((entry) => formatTemplateRef(entry.id, entry.version) === ref);
    const next = this.buildInstalledTemplateEntryFromBot(botPackage);
    if (
      current !== undefined
      && current.description === next.description
      && current.trusted === next.trusted
      && current.pinned === next.pinned
      && current.keyId === next.keyId
      && current.manifestSha256 === next.manifestSha256
      && current.source === next.source
    ) {
      return {
        installed: existing,
        changed: false,
      };
    }

    return {
      installed: sortInstalledTemplates([
        ...existing.filter((entry) => formatTemplateRef(entry.id, entry.version) !== ref),
        current === undefined
          ? next
          : {
              ...next,
              installedAt: current.installedAt,
            },
      ]),
      changed: true,
    };
  }

  private async ensureBotTemplateInstalled(
    runtimeConfig: RuntimeConfig,
    botPackage: LoadedBotPackage,
  ): Promise<boolean> {
    const updated = this.upsertInstalledBotTemplateEntry(runtimeConfig.templates.installed, botPackage);
    if (!updated.changed) {
      return false;
    }
    runtimeConfig.templates.installed = updated.installed;
    return true;
  }

  private withRequiredCoreTemplates(
    existing: RuntimeConfig["templates"]["installed"],
    refs: string[],
  ): RuntimeConfig["templates"]["installed"] {
    const byRef = new Map(
      existing.map((entry) => [formatTemplateRef(entry.id, entry.version), entry] as const),
    );
    for (const ref of refs) {
      const manifest = findCoreTemplateManifest(ref);
      if (manifest === undefined) {
        throw {
          code: "TEMPLATE_NOT_FOUND",
          message: `Template '${ref}' was not found in the trusted core catalog`,
          retryable: false,
        };
      }
      if (byRef.has(ref)) {
        continue;
      }
      byRef.set(ref, this.buildInstalledTemplateEntryFromCore(manifest));
    }
    return sortInstalledTemplates(Array.from(byRef.values()));
  }

  private async ensureBotToolInstances(
    runtimeConfig: RuntimeConfig,
    botPackage: LoadedBotPackage,
  ): Promise<string[]> {
    const requiredCoreTemplateRefs = botPackage.manifest.toolInstances
      .map((entry: LoadedBotPackage["manifest"]["toolInstances"][number]) => entry.templateRef)
      .filter((ref: string) => findCoreTemplateManifest(ref) !== undefined);
    if (requiredCoreTemplateRefs.length > 0) {
      runtimeConfig.templates.installed = this.withRequiredCoreTemplates(
        runtimeConfig.templates.installed,
        dedupeStrings(requiredCoreTemplateRefs),
      );
      await this.persistManagedAgentTopologyDocument(runtimeConfig);
    }
    const toolInstanceIds: string[] = [];
    for (const tool of botPackage.manifest.toolInstances) {
      if (!this.isBotToolInstanceEnabled(runtimeConfig, tool.enabledWhen)) {
        continue;
      }
      const bindings = this.resolveBotToolBindings(runtimeConfig, tool);
      await this.upsertSovereignToolInstance(
        {
          id: tool.id,
          templateRef: tool.templateRef,
          config: bindings.config,
          secretRefs: bindings.secretRefs,
        },
        "create",
      );
      toolInstanceIds.push(tool.id);
    }
    return toolInstanceIds;
  }

  private buildManagedBotToolInstance(input: {
    runtimeConfig: RuntimeConfig;
    tool: LoadedBotPackage["manifest"]["toolInstances"][number];
    existing: RuntimeConfig["sovereignTools"]["instances"][number] | undefined;
  }): RuntimeConfig["sovereignTools"]["instances"][number] {
    const template = this.resolveToolTemplateManifest(input.tool.templateRef);
    const bindings = this.resolveBotToolBindings(input.runtimeConfig, input.tool);
    return {
      id: input.tool.id,
      templateRef: input.tool.templateRef,
      capabilities: [...template.capabilities],
      config: bindings.config,
      secretRefs: bindings.secretRefs,
      createdAt: input.existing?.createdAt ?? now(),
      updatedAt: now(),
    };
  }

  private isBotToolInstanceEnabled(
    runtimeConfig: RuntimeConfig,
    enabledWhen: LoadedBotPackage["manifest"]["toolInstances"][number]["enabledWhen"],
  ): boolean {
    if (enabledWhen === undefined) {
      return true;
    }
    return this.resolveBotPathValue(runtimeConfig, enabledWhen.path) === enabledWhen.equals;
  }

  private resolveBotToolBindings(
    runtimeConfig: RuntimeConfig,
    tool: LoadedBotPackage["manifest"]["toolInstances"][number],
  ): {
    config: Record<string, string>;
    secretRefs: Record<string, string>;
  } {
    return {
      config: Object.fromEntries(
        (Object.entries(tool.config) as Array<[string, typeof tool.config[string]]>).map(([key, binding]) => [
          key,
          this.stringifyBotBindingValue(
            this.resolveRequiredBotPathValue(runtimeConfig, binding.from),
            binding.stringify === true,
          ),
        ]),
      ),
      secretRefs: Object.fromEntries(
        (Object.entries(tool.secretRefs) as Array<[string, typeof tool.secretRefs[string]]>).map(([key, binding]) => [
          key,
          this.stringifyBotBindingValue(this.resolveRequiredBotPathValue(runtimeConfig, binding.from), true),
        ]),
      ),
    };
  }

  private resolveRequiredBotPathValue(runtimeConfig: RuntimeConfig, path: string): BotConfigValue {
    const value = this.resolveBotPathValue(runtimeConfig, path);
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return value;
    }
    throw {
      code: "BOT_BINDING_RESOLUTION_FAILED",
      message: `Runtime value '${path}' is unavailable for managed bot binding`,
      retryable: false,
      details: {
        path,
      },
    };
  }

  private resolveBotPathValue(runtimeConfig: RuntimeConfig, path: string): unknown {
    return path.split(".").reduce<unknown>((current, segment) => {
      if (!isRecord(current) || !(segment in current)) {
        return undefined;
      }
      return current[segment];
    }, runtimeConfig);
  }

  private stringifyBotBindingValue(value: BotConfigValue, forceString: boolean): string {
    if (typeof value === "string") {
      return value;
    }
    if (forceString || typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    return "";
  }

  private resolveToolTemplateManifest(ref: string): ToolTemplateManifest {
    const manifest = findCoreTemplateManifest(ref);
    if (manifest === undefined || manifest.kind !== "sovereign-tool-template") {
      throw {
        code: "TEMPLATE_NOT_FOUND",
        message: `Tool template '${ref}' was not found in the trusted core catalog`,
        retryable: false,
      };
    }
    return manifest;
  }

  async listSovereignToolInstances(): Promise<SovereignToolInstanceListResult> {
    const runtimeConfig = await this.readRuntimeConfig();
    return {
      tools: runtimeConfig.sovereignTools.instances
        .map((entry) => ({
          id: entry.id,
          templateRef: entry.templateRef,
          capabilities: [...entry.capabilities],
          config: { ...entry.config },
          secretRefs: { ...entry.secretRefs },
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    };
  }

  async createSovereignToolInstance(req: {
    id: string;
    templateRef: string;
    config?: Record<string, string>;
    secretRefs?: Record<string, string>;
  }): Promise<SovereignToolInstanceUpsertResult> {
    return this.upsertSovereignToolInstance(req, "create");
  }

  async updateSovereignToolInstance(req: {
    id: string;
    templateRef?: string;
    config?: Record<string, string>;
    secretRefs?: Record<string, string>;
  }): Promise<SovereignToolInstanceUpsertResult> {
    return this.upsertSovereignToolInstance(req, "update");
  }

  async deleteSovereignToolInstance(req: { id: string }): Promise<SovereignToolInstanceDeleteResult> {
    const runtimeConfig = await this.readRuntimeConfig();
    const id = sanitizeToolInstanceId(req.id);
    const existing = runtimeConfig.sovereignTools.instances.find((entry) => entry.id === id);
    if (existing === undefined) {
      return {
        id,
        deleted: false,
      };
    }
    const referencedBy = runtimeConfig.openclawProfile.agents
      .filter((entry) => (entry.toolInstanceIds ?? []).includes(id))
      .map((entry) => entry.id);
    if (referencedBy.length > 0) {
      throw {
        code: "TOOL_INSTANCE_IN_USE",
        message: `Tool instance '${id}' is still referenced by one or more agents`,
        retryable: false,
        details: {
          toolInstanceId: id,
          referencedBy,
        },
      };
    }

    runtimeConfig.sovereignTools.instances = runtimeConfig.sovereignTools.instances.filter(
      (entry) => entry.id !== id,
    );
    await this.persistManagedAgentTopologyDocument(runtimeConfig);
    return {
      id,
      deleted: true,
    };
  }

  private async upsertSovereignToolInstance(
    req: {
      id: string;
      templateRef?: string;
      config?: Record<string, string>;
      secretRefs?: Record<string, string>;
    },
    mode: "create" | "update",
  ): Promise<SovereignToolInstanceUpsertResult> {
    const runtimeConfig = await this.readRuntimeConfig();
    const id = sanitizeToolInstanceId(req.id);
    const existing = runtimeConfig.sovereignTools.instances.find((entry) => entry.id === id);
    if (mode === "update" && existing === undefined) {
      throw {
        code: "TOOL_INSTANCE_NOT_FOUND",
        message: `Sovereign tool instance '${id}' does not exist`,
        retryable: false,
      };
    }
    const nextTemplateRef = sanitizeOptionalTemplateRef(req.templateRef) ?? existing?.templateRef;
    if (nextTemplateRef === undefined) {
      throw {
        code: "TOOL_TEMPLATE_REQUIRED",
        message: "Tool template ref is required (example: imap-readonly@1.0.0)",
        retryable: false,
      };
    }
    const toolTemplate = this.resolveInstalledToolTemplate(runtimeConfig, nextTemplateRef);
    const nextConfig = normalizeStringRecord(req.config ?? existing?.config ?? {});
    const nextSecretRefs = normalizeStringRecord(req.secretRefs ?? existing?.secretRefs ?? {});
    this.validateToolInstanceBindings({
      template: toolTemplate,
      config: nextConfig,
      secretRefs: nextSecretRefs,
    });
    const nextTool = {
      id,
      templateRef: nextTemplateRef,
      capabilities: [...toolTemplate.capabilities],
      config: nextConfig,
      secretRefs: nextSecretRefs,
      createdAt: existing?.createdAt ?? now(),
      updatedAt: now(),
    };
    const changed = existing === undefined
      || existing.templateRef !== nextTool.templateRef
      || !areStringListsEqual(existing.capabilities, nextTool.capabilities)
      || !areStringRecordsEqual(existing.config, nextTool.config)
      || !areStringRecordsEqual(existing.secretRefs, nextTool.secretRefs);
    if (!changed) {
      return {
        tool: {
          id: existing.id,
          templateRef: existing.templateRef,
          capabilities: [...existing.capabilities],
          config: { ...existing.config },
          secretRefs: { ...existing.secretRefs },
        },
        changed: false,
      };
    }

    runtimeConfig.sovereignTools.instances = [
      ...runtimeConfig.sovereignTools.instances.filter((entry) => entry.id !== id),
      nextTool,
    ].sort((left, right) => left.id.localeCompare(right.id));
    await this.persistManagedAgentTopologyDocument(runtimeConfig);

    return {
      tool: {
        id: nextTool.id,
        templateRef: nextTool.templateRef,
        capabilities: [...nextTool.capabilities],
        config: { ...nextTool.config },
        secretRefs: { ...nextTool.secretRefs },
      },
      changed: true,
    };
  }

  private toManagedAgentOutput(entry: RuntimeAgentEntry): ManagedAgent {
    return {
      id: entry.id,
      workspace: entry.workspace,
      ...(entry.matrix?.userId === undefined ? {} : { matrixUserId: entry.matrix.userId }),
      ...(entry.templateRef === undefined ? {} : { templateRef: entry.templateRef }),
      ...(entry.toolInstanceIds === undefined || entry.toolInstanceIds.length === 0
        ? {}
        : { toolInstanceIds: [...entry.toolInstanceIds] }),
    };
  }

  private resolveInstalledToolTemplate(
    runtimeConfig: RuntimeConfig,
    ref: string,
  ): ToolTemplateManifest {
    const parsed = parseTemplateRef(ref);
    const installed = runtimeConfig.templates.installed.find(
      (entry) => entry.id === parsed.id && entry.version === parsed.version,
    );
    if (installed === undefined) {
      throw {
        code: "TEMPLATE_NOT_INSTALLED",
        message: `Template '${ref}' is not installed`,
        retryable: false,
      };
    }
    if (installed.kind !== "tool") {
      throw {
        code: "TEMPLATE_KIND_MISMATCH",
        message: `Template '${ref}' is not a tool template`,
        retryable: false,
      };
    }
    if (!installed.pinned) {
      throw {
        code: "TEMPLATE_NOT_PINNED",
        message: `Template '${ref}' must be pinned before use`,
        retryable: false,
      };
    }
    const manifest = findCoreTemplateManifest(ref);
    if (manifest === undefined || manifest.kind !== "sovereign-tool-template") {
      throw {
        code: "TEMPLATE_MANIFEST_UNAVAILABLE",
        message: `Trusted manifest for '${ref}' is unavailable`,
        retryable: false,
      };
    }
    const verified = verifySignedTemplateManifest(manifest, CORE_TRUSTED_TEMPLATE_KEYS);
    if (verified.manifestSha256 !== installed.manifestSha256 || verified.keyId !== installed.keyId) {
      throw {
        code: "TEMPLATE_PIN_MISMATCH",
        message: `Pinned metadata does not match trusted manifest for '${ref}'`,
        retryable: false,
      };
    }
    return manifest;
  }

  private async resolveInstalledAgentTemplate(
    runtimeConfig: RuntimeConfig,
    ref: string,
  ): Promise<AgentTemplateManifest> {
    const parsed = parseTemplateRef(ref);
    const installed = runtimeConfig.templates.installed.find(
      (entry) => entry.id === parsed.id && entry.version === parsed.version,
    );
    if (installed === undefined) {
      throw {
        code: "TEMPLATE_NOT_INSTALLED",
        message: `Template '${ref}' is not installed`,
        retryable: false,
      };
    }
    if (installed.kind !== "agent") {
      throw {
        code: "TEMPLATE_KIND_MISMATCH",
        message: `Template '${ref}' is not an agent template`,
        retryable: false,
      };
    }
    if (!installed.pinned) {
      throw {
        code: "TEMPLATE_NOT_PINNED",
        message: `Template '${ref}' must be pinned before use`,
        retryable: false,
      };
    }
    const botPackage = await this.botCatalog.findPackageByTemplateRef(ref);
    if (botPackage === null) {
      throw {
        code: "TEMPLATE_MANIFEST_UNAVAILABLE",
        message: `Trusted manifest for '${ref}' is unavailable`,
        retryable: false,
      };
    }
    if (
      botPackage.manifestSha256 !== installed.manifestSha256
      || botPackage.keyId !== installed.keyId
    ) {
      throw {
        code: "TEMPLATE_PIN_MISMATCH",
        message: `Pinned metadata does not match trusted manifest for '${ref}'`,
        retryable: false,
      };
    }
    return botPackage.template;
  }

  private resolveBoundToolInstances(
    runtimeConfig: RuntimeConfig,
    toolInstanceIds: string[],
  ): RuntimeConfig["sovereignTools"]["instances"] {
    return toolInstanceIds
      .map((id) => runtimeConfig.sovereignTools.instances.find((entry) => entry.id === id))
      .filter((entry): entry is RuntimeConfig["sovereignTools"]["instances"][number] => entry !== undefined);
  }

  private renderSovereignToolCommand(toolInstanceId: string, command: string): string {
    const rendered = command.replaceAll("<tool-instance-id>", toolInstanceId);
    const [executable, ...rest] = rendered.split(" ");
    const resolvedExecutable =
      executable === undefined ? "" : (SOVEREIGN_EXECUTABLE_PATHS[executable] ?? executable);
    return [resolvedExecutable, ...rest].filter((part) => part.length > 0).join(" ");
  }

  private listAgentExecAllowlistPatterns(
    runtimeConfig: RuntimeConfig,
    toolInstanceIds: string[],
  ): string[] {
    const patterns = new Set<string>();
    for (const tool of this.resolveBoundToolInstances(runtimeConfig, toolInstanceIds)) {
      const manifest = this.resolveInstalledToolTemplate(runtimeConfig, tool.templateRef);
      for (const command of manifest.allowedCommands) {
        const rendered = this.renderSovereignToolCommand(tool.id, command);
        const [executable] = rendered.split(" ");
        if (executable !== undefined && executable.startsWith("/")) {
          patterns.add(executable);
        }
      }
    }
    return Array.from(patterns);
  }

  private buildOpenClawAgentToolPolicy(
    runtimeConfig: RuntimeConfig,
    toolInstanceIds: string[],
  ): {
    allow: string[];
    exec: {
      host: "gateway";
      security: "allowlist";
      ask: "off";
    };
  } | null {
    const execPatterns = this.listAgentExecAllowlistPatterns(runtimeConfig, toolInstanceIds);
    if (execPatterns.length === 0) {
      return null;
    }
    return {
      allow: [OPENCLAW_EXEC_TOOL_ID],
      exec: {
        host: "gateway",
        security: "allowlist",
        ask: "off",
      },
    };
  }

  private validateToolInstanceBindings(input: {
    template: ToolTemplateManifest;
    config: Record<string, string>;
    secretRefs: Record<string, string>;
  }): void {
    const missingConfigKeys = input.template.requiredConfigKeys.filter(
      (key) => input.config[key] === undefined || input.config[key].trim().length === 0,
    );
    const missingSecretRefs = input.template.requiredSecretRefs.filter(
      (key) => input.secretRefs[key] === undefined || input.secretRefs[key].trim().length === 0,
    );
    if (missingConfigKeys.length > 0 || missingSecretRefs.length > 0) {
      throw {
        code: "TOOL_INSTANCE_BINDINGS_INVALID",
        message: "Tool instance is missing required config or secret refs",
        retryable: false,
        details: {
          templateRef: formatTemplateRef(input.template.id, input.template.version),
          missingConfigKeys,
          missingSecretRefs,
        },
      };
    }
  }

  private async validateAgentTemplateAndTools(input: {
    runtimeConfig: RuntimeConfig;
    templateRef?: string;
    toolInstanceIds: string[];
  }): Promise<{ templateRef: string | undefined; toolInstanceIds: string[] }> {
    const toolInstanceIds = input.toolInstanceIds;
    const unknownToolInstanceIds = toolInstanceIds.filter(
      (id) => !input.runtimeConfig.sovereignTools.instances.some((entry) => entry.id === id),
    );
    if (unknownToolInstanceIds.length > 0) {
      throw {
        code: "TOOL_INSTANCE_NOT_FOUND",
        message: "One or more tool instance ids do not exist",
        retryable: false,
        details: {
          unknownToolInstanceIds,
        },
      };
    }

    if (input.templateRef === undefined) {
      return {
        templateRef: undefined,
        toolInstanceIds,
      };
    }

    const template = await this.resolveInstalledAgentTemplate(input.runtimeConfig, input.templateRef);
    const boundRefs = new Set(
      toolInstanceIds.flatMap((id) => {
        const tool = input.runtimeConfig.sovereignTools.instances.find((entry) => entry.id === id);
        return tool === undefined ? [] : [tool.templateRef];
      }),
    );
    const requiredRefs = template.requiredToolTemplates.map((entry) =>
      formatTemplateRef(entry.id, entry.version));
    const missingRequiredRefs = requiredRefs.filter((ref) => !boundRefs.has(ref));
    const allowedRefs = new Set(
      [
        ...requiredRefs,
        ...template.optionalToolTemplates.map((entry) => formatTemplateRef(entry.id, entry.version)),
      ],
    );
    const disallowedBindings = Array.from(boundRefs).filter((ref) => !allowedRefs.has(ref));
    if (missingRequiredRefs.length > 0 || disallowedBindings.length > 0) {
      throw {
        code: "AGENT_TEMPLATE_TOOL_BINDINGS_INVALID",
        message: "Agent tool bindings do not satisfy template requirements",
        retryable: false,
        details: {
          templateRef: input.templateRef,
          missingRequiredRefs,
          disallowedBindings,
        },
      };
    }
    return {
      templateRef: input.templateRef,
      toolInstanceIds,
    };
  }

  private async resolveManagedAgentMatrixLocalpartFallback(
    runtimeConfig: RuntimeConfig,
    entry: RuntimeAgentEntry,
    agentId: string,
  ): Promise<string> {
    const fallback = sanitizeMatrixLocalpartFromAgentId(agentId);
    if (entry.templateRef === undefined) {
      return fallback;
    }
    try {
      const template = await this.resolveInstalledAgentTemplate(runtimeConfig, entry.templateRef);
      const templatePrefix = sanitizeManagedAgentLocalpart(template.matrix.localpartPrefix, fallback);
      const agentLocalpart = sanitizeManagedAgentLocalpart(agentId, fallback);
      if (agentLocalpart === templatePrefix || agentLocalpart.startsWith(`${templatePrefix}-`)) {
        return agentLocalpart;
      }
      return sanitizeManagedAgentLocalpart(`${templatePrefix}-${agentId}`, fallback);
    } catch {
      return fallback;
    }
  }

  async createManagedAgent(req: {
    id: string;
    workspace?: string;
    templateRef?: string;
    toolInstanceIds?: string[];
  }): Promise<ManagedAgentUpsertResult> {
    return this.upsertManagedAgent(req, "create");
  }

  async updateManagedAgent(req: {
    id: string;
    workspace?: string;
    templateRef?: string;
    toolInstanceIds?: string[];
  }): Promise<ManagedAgentUpsertResult> {
    return this.upsertManagedAgent(req, "update");
  }

  async deleteManagedAgent(req: { id: string }): Promise<ManagedAgentDeleteResult> {
    const runtimeConfig = await this.readRuntimeConfig();
    const id = sanitizeManagedAgentId(req.id);
    if (RESERVED_AGENT_IDS.has(id)) {
      throw {
        code: "AGENT_DELETE_FORBIDDEN",
        message: `Managed core agent '${id}' cannot be deleted`,
        retryable: false,
      };
    }

    const existing = runtimeConfig.openclawProfile.agents.find((entry) => entry.id === id);
    if (existing === undefined) {
      return {
        id,
        deleted: false,
        restartRequiredServices: [],
      };
    }

    runtimeConfig.openclawProfile.agents = runtimeConfig.openclawProfile.agents.filter(
      (entry) => entry.id !== id,
    );
    runtimeConfig.openclawProfile.agents = ensureCoreManagedAgents(
      runtimeConfig.openclawProfile.agents,
    );
    await this.persistManagedAgentTopology(runtimeConfig);
    return {
      id,
      deleted: true,
      restartRequiredServices: ["openclaw-gateway"],
    };
  }

  private async upsertManagedAgent(
    req: {
      id: string;
      workspace?: string;
      botId?: string;
      templateRef?: string;
      toolInstanceIds?: string[];
    },
    mode: "create" | "update",
  ): Promise<ManagedAgentUpsertResult> {
    const runtimeConfig = await this.readRuntimeConfig();
    const id = sanitizeManagedAgentId(req.id);
    const workspace = sanitizeManagedWorkspace(
      req.workspace,
      join(this.paths.stateDir, id, "workspace"),
    );
    const requestedTemplateRef = sanitizeOptionalTemplateRef(req.templateRef);
    const requestedToolInstanceIds = sanitizeOptionalToolInstanceIds(req.toolInstanceIds);
    const existing = runtimeConfig.openclawProfile.agents.find((entry) => entry.id === id);

    if (mode === "create" && existing !== undefined) {
      const nextTemplateRef = requestedTemplateRef ?? existing.templateRef;
      const nextToolInstanceIds = requestedToolInstanceIds ?? existing.toolInstanceIds ?? [];
      const validated = await this.validateAgentTemplateAndTools(
        nextTemplateRef === undefined
          ? {
              runtimeConfig,
              toolInstanceIds: nextToolInstanceIds,
            }
          : {
              runtimeConfig,
              templateRef: nextTemplateRef,
              toolInstanceIds: nextToolInstanceIds,
            },
      );
      const changed = existing.workspace !== workspace
        || existing.botId !== req.botId
        || existing.templateRef !== nextTemplateRef
        || !areStringListsEqual(existing.toolInstanceIds ?? [], validated.toolInstanceIds);
      if (changed) {
        existing.workspace = workspace;
        if (req.botId === undefined) {
          delete existing.botId;
        } else {
          existing.botId = req.botId;
        }
        if (nextTemplateRef === undefined) {
          delete existing.templateRef;
        } else {
          existing.templateRef = nextTemplateRef;
        }
        existing.toolInstanceIds = validated.toolInstanceIds;
        runtimeConfig.openclawProfile.agents = ensureCoreManagedAgents(
          runtimeConfig.openclawProfile.agents,
        );
        await this.ensureManagedAgentWorkspace({
          id,
          workspace,
          runtimeConfig,
        });
        await this.persistManagedAgentTopology(runtimeConfig);
      }
      const ensured = await this.ensureManagedAgentMatrixIdentity(runtimeConfig, id);
      if (ensured.changed) {
        await this.persistManagedAgentTopology(ensured.runtimeConfig);
      }
      const agent = ensured.runtimeConfig.openclawProfile.agents.find((entry) => entry.id === id);
      return {
        agent: this.toManagedAgentOutput(agent ?? existing),
        changed: changed || ensured.changed,
        restartRequiredServices: changed || ensured.changed ? ["openclaw-gateway"] : [],
      };
    }

    if (mode === "update" && existing === undefined) {
      throw {
        code: "AGENT_NOT_FOUND",
        message: `Managed agent '${id}' does not exist`,
        retryable: false,
      };
    }

    if (existing !== undefined) {
      const nextTemplateRef = requestedTemplateRef ?? existing.templateRef;
      const nextToolInstanceIds = requestedToolInstanceIds ?? existing.toolInstanceIds ?? [];
      const validated = await this.validateAgentTemplateAndTools(
        nextTemplateRef === undefined
          ? {
              runtimeConfig,
              toolInstanceIds: nextToolInstanceIds,
            }
          : {
              runtimeConfig,
              templateRef: nextTemplateRef,
              toolInstanceIds: nextToolInstanceIds,
            },
      );
      const changed = existing.workspace !== workspace
        || (req.botId !== undefined && existing.botId !== req.botId)
        || existing.templateRef !== nextTemplateRef
        || !areStringListsEqual(existing.toolInstanceIds ?? [], validated.toolInstanceIds);
      if (changed) {
        existing.workspace = workspace;
        if (req.botId !== undefined) {
          existing.botId = req.botId;
        }
        if (nextTemplateRef === undefined) {
          delete existing.templateRef;
        } else {
          existing.templateRef = nextTemplateRef;
        }
        existing.toolInstanceIds = validated.toolInstanceIds;
        runtimeConfig.openclawProfile.agents = ensureCoreManagedAgents(
          runtimeConfig.openclawProfile.agents,
        );
        await this.ensureManagedAgentWorkspace({
          id,
          workspace,
          runtimeConfig,
        });
        await this.persistManagedAgentTopology(runtimeConfig);
      }
      const ensured = await this.ensureManagedAgentMatrixIdentity(runtimeConfig, id);
      if (ensured.changed) {
        await this.persistManagedAgentTopology(ensured.runtimeConfig);
      }
      const agent = ensured.runtimeConfig.openclawProfile.agents.find((entry) => entry.id === id);
      return {
        agent: this.toManagedAgentOutput(agent ?? existing),
        changed: changed || ensured.changed,
        restartRequiredServices: changed || ensured.changed ? ["openclaw-gateway"] : [],
      };
    }

    const validated = await this.validateAgentTemplateAndTools(
      requestedTemplateRef === undefined
        ? {
            runtimeConfig,
            toolInstanceIds: requestedToolInstanceIds ?? [],
          }
        : {
            runtimeConfig,
            templateRef: requestedTemplateRef,
            toolInstanceIds: requestedToolInstanceIds ?? [],
          },
    );
    runtimeConfig.openclawProfile.agents = ensureCoreManagedAgents([
      ...runtimeConfig.openclawProfile.agents,
      {
        id,
        workspace,
        ...(req.botId === undefined ? {} : { botId: req.botId }),
        ...(validated.templateRef === undefined ? {} : { templateRef: validated.templateRef }),
        ...(validated.toolInstanceIds.length === 0
          ? {}
          : { toolInstanceIds: validated.toolInstanceIds }),
      },
    ]);
    await this.ensureManagedAgentWorkspace({
      id,
      workspace,
      runtimeConfig,
    });
    const ensured = await this.ensureManagedAgentMatrixIdentity(runtimeConfig, id);
    runtimeConfig.openclawProfile.agents = ensured.runtimeConfig.openclawProfile.agents;
    await this.persistManagedAgentTopology(runtimeConfig);
    const created = runtimeConfig.openclawProfile.agents.find((entry) => entry.id === id);
    return {
      agent: this.toManagedAgentOutput(
        created ?? {
          id,
          workspace,
          ...(req.botId === undefined ? {} : { botId: req.botId }),
          ...(validated.templateRef === undefined ? {} : { templateRef: validated.templateRef }),
          ...(validated.toolInstanceIds.length === 0
            ? {}
            : { toolInstanceIds: validated.toolInstanceIds }),
        },
      ),
      changed: true,
      restartRequiredServices: ["openclaw-gateway"],
    };
  }

  private async persistManagedAgentTopology(runtimeConfig: RuntimeConfig): Promise<void> {
    runtimeConfig.openclawProfile.agents = ensureCoreManagedAgents(
      runtimeConfig.openclawProfile.agents,
    );
    for (const agent of runtimeConfig.openclawProfile.agents) {
      await this.ensureManagedAgentWorkspace({
        id: agent.id,
        workspace: agent.workspace,
        runtimeConfig,
      });
    }

    await this.persistManagedAgentTopologyDocument(runtimeConfig);
    await this.writeOpenClawRuntimeArtifacts(runtimeConfig);
    this.setManagedOpenClawEnv(runtimeConfig);
    await this.refreshGatewayAfterRuntimeConfig(runtimeConfig);
  }

  private async persistManagedAgentTopologyDocument(runtimeConfig: RuntimeConfig): Promise<void> {
    const raw = await readFile(this.paths.configPath, "utf8");
    const parsed = parseJsonDocument(raw);
    if (!isRecord(parsed)) {
      throw {
        code: "CONFIG_INVALID",
        message: "Sovereign runtime config does not match expected shape",
        retryable: false,
        details: {
          configPath: this.paths.configPath,
        },
      };
    }

    parsed["generatedAt"] = now();
    parsed["openclawProfile"] = {
      plugins: {
        allow: runtimeConfig.openclawProfile.plugins.allow,
      },
      channels: {
        matrix: {
          enabled: true,
          homeserver: runtimeConfig.matrix.adminBaseUrl,
          roomId: runtimeConfig.matrix.alertRoom.roomId,
        },
      },
      agents: runtimeConfig.openclawProfile.agents,
      crons: runtimeConfig.openclawProfile.crons,
      ...(runtimeConfig.openclawProfile.crons[0] === undefined
        ? {}
        : {
            cron: {
              id: runtimeConfig.openclawProfile.crons[0].id,
              every: runtimeConfig.openclawProfile.crons[0].every,
            },
          }),
    };
    parsed["bots"] = runtimeConfig.bots;
    parsed["templates"] = runtimeConfig.templates;
    parsed["sovereignTools"] = runtimeConfig.sovereignTools;

    await this.writeInstallerJsonFile(this.paths.configPath, parsed, 0o644);
  }

  private async ensureManagedAgentWorkspace(input: {
    id: string;
    workspace: string;
    runtimeConfig: RuntimeConfig;
  }): Promise<void> {
    await mkdir(input.workspace, { recursive: true });
    const agent = input.runtimeConfig.openclawProfile.agents.find((entry) => entry.id === input.id);
    if (agent?.templateRef !== undefined) {
      const template = await this.resolveInstalledAgentTemplate(input.runtimeConfig, agent.templateRef);
      await this.writeTemplateWorkspaceFiles({
        workspaceDir: input.workspace,
        runtimeConfig: input.runtimeConfig,
        agentId: input.id,
        template,
        toolInstanceIds: agent.toolInstanceIds ?? [],
      });
    } else {
      const readme = buildManagedAgentWorkspaceReadme(input.id);
      await writeFile(join(input.workspace, "README.md"), `${readme}\n`, "utf8");
    }
    await this.applyRuntimeOwnership(input.workspace);
  }

  private async ensureManagedAgentMatrixIdentity(
    runtimeConfig: RuntimeConfig,
    agentId: string,
  ): Promise<{ runtimeConfig: RuntimeConfig; changed: boolean }> {
    const entry = runtimeConfig.openclawProfile.agents.find((agent) => agent.id === agentId);
    if (entry === undefined) {
      return { runtimeConfig, changed: false };
    }
    const botPackage = await this.findBotPackageByTemplateRef(entry.templateRef);
    if (
      botPackage?.manifest.matrixIdentity.mode === "service-account"
      || (botPackage === null && agentId === MAIL_SENTINEL_AGENT_ID)
    ) {
      const mappedIdentity = {
        localpart:
          runtimeConfig.matrix.bot.localpart
          ?? botPackage?.manifest.matrixIdentity.localpartPrefix
          ?? "service-bot",
        userId: runtimeConfig.matrix.bot.userId,
        ...(runtimeConfig.matrix.bot.passwordSecretRef === undefined
          ? {}
          : { passwordSecretRef: runtimeConfig.matrix.bot.passwordSecretRef }),
        accessTokenSecretRef: runtimeConfig.matrix.bot.accessTokenSecretRef,
      };
      const changed = !areMatrixIdentitiesEqual(entry.matrix, mappedIdentity);
      if (changed) {
        entry.matrix = mappedIdentity;
      }
      return { runtimeConfig, changed };
    }

    const fallbackLocalpart = await this.resolveManagedAgentMatrixLocalpartFallback(
      runtimeConfig,
      entry,
      agentId,
    );
    const localpart = sanitizeManagedAgentLocalpart(entry.matrix?.localpart, fallbackLocalpart);
    const expectedUserId = `@${localpart}:${runtimeConfig.matrix.homeserverDomain}`;

    let passwordSecretRef = entry.matrix?.passwordSecretRef;
    if (passwordSecretRef === undefined || passwordSecretRef.trim().length === 0) {
      passwordSecretRef = await this.writeManagedSecretFile(
        `matrix-agent-${agentId}-password`,
        generateAgentPassword(),
      );
    }
    const password = await this.resolveSecretRef(passwordSecretRef);

    const operatorTokenSecretRef = runtimeConfig.matrix.operator.accessTokenSecretRef;
    if (operatorTokenSecretRef === undefined || operatorTokenSecretRef.length === 0) {
      throw {
        code: "MATRIX_AGENT_IDENTITY_FAILED",
        message: "Operator Matrix access token is required to provision agent identities",
        retryable: false,
      };
    }
    const operatorAccessToken = await this.resolveSecretRef(operatorTokenSecretRef);

    const upsertedUserId = await this.ensureSynapseUserViaAdminApi({
      adminBaseUrl: runtimeConfig.matrix.adminBaseUrl,
      adminAccessToken: operatorAccessToken,
      expectedUserId,
      password,
    });
    const loginSession = await this.loginMatrixUser({
      adminBaseUrl: runtimeConfig.matrix.adminBaseUrl,
      localpart,
      password,
      expectedUserId: upsertedUserId,
    });
    const accessTokenSecretRef = await this.writeManagedSecretFile(
      `matrix-agent-${agentId}-access-token`,
      loginSession.accessToken,
    );

    await this.ensureMatrixUserInAlertRoom({
      adminBaseUrl: runtimeConfig.matrix.adminBaseUrl,
      roomId: runtimeConfig.matrix.alertRoom.roomId,
      inviterAccessToken: operatorAccessToken,
      inviteeUserId: loginSession.userId,
      inviteeAccessToken: loginSession.accessToken,
    });

    const nextIdentity = {
      localpart,
      userId: loginSession.userId,
      passwordSecretRef,
      accessTokenSecretRef,
    };
    const changed = !areMatrixIdentitiesEqual(entry.matrix, nextIdentity);
    entry.matrix = nextIdentity;
    return {
      runtimeConfig,
      changed,
    };
  }

  private async ensureSynapseUserViaAdminApi(input: {
    adminBaseUrl: string;
    adminAccessToken: string;
    expectedUserId: string;
    password: string;
  }): Promise<string> {
    const endpoint = new URL(
      `/_synapse/admin/v2/users/${encodeURIComponent(input.expectedUserId)}`,
      ensureTrailingSlash(input.adminBaseUrl),
    ).toString();
    const response = await this.fetchImpl(endpoint, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${input.adminAccessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        password: input.password,
        admin: false,
        deactivated: false,
      }),
    });
    const bodyText = await response.text();
    const parsed = parseJsonSafely(bodyText);
    if (!response.ok) {
      throw {
        code: "MATRIX_AGENT_IDENTITY_FAILED",
        message: `Failed to upsert Matrix account ${input.expectedUserId}`,
        retryable: true,
        details: {
          endpoint,
          status: response.status,
          body: summarizeUnknown(parsed),
        },
      };
    }
    if (isRecord(parsed) && typeof parsed.name === "string" && parsed.name.length > 0) {
      return parsed.name;
    }
    return input.expectedUserId;
  }

  private async loginMatrixUser(input: {
    adminBaseUrl: string;
    localpart: string;
    password: string;
    expectedUserId: string;
  }): Promise<{ userId: string; accessToken: string }> {
    const endpoint = new URL("/_matrix/client/v3/login", ensureTrailingSlash(input.adminBaseUrl)).toString();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          type: "m.login.password",
          identifier: {
            type: "m.id.user",
            user: input.localpart,
          },
          password: input.password,
        }),
      });
      const bodyText = await response.text();
      const parsed = parseJsonSafely(bodyText);
      if (response.ok) {
        const userId = isRecord(parsed) && typeof parsed.user_id === "string"
          ? parsed.user_id
          : input.expectedUserId;
        const accessToken = isRecord(parsed) && typeof parsed.access_token === "string"
          ? parsed.access_token
          : "";
        if (accessToken.length === 0) {
          throw {
            code: "MATRIX_AGENT_IDENTITY_FAILED",
            message: `Matrix login for ${input.expectedUserId} returned no access token`,
            retryable: true,
          };
        }
        return { userId, accessToken };
      }

      if (
        response.status === 429
        && isRecord(parsed)
        && typeof parsed.retry_after_ms === "number"
        && Number.isFinite(parsed.retry_after_ms)
      ) {
        await delay(Math.min(Math.max(Math.trunc(parsed.retry_after_ms), 100), 5_000));
        continue;
      }

      throw {
        code: "MATRIX_AGENT_IDENTITY_FAILED",
        message: `Matrix login failed for ${input.expectedUserId}`,
        retryable: true,
        details: {
          endpoint,
          status: response.status,
          body: summarizeUnknown(parsed),
        },
      };
    }

    throw {
      code: "MATRIX_AGENT_IDENTITY_FAILED",
      message: `Matrix login was rate-limited for ${input.expectedUserId}`,
      retryable: true,
    };
  }

  private async ensureMatrixUserInAlertRoom(input: {
    adminBaseUrl: string;
    roomId: string;
    inviterAccessToken: string;
    inviteeUserId: string;
    inviteeAccessToken: string;
  }): Promise<void> {
    const inviteEndpoint = new URL(
      `/_matrix/client/v3/rooms/${encodeURIComponent(input.roomId)}/invite`,
      ensureTrailingSlash(input.adminBaseUrl),
    ).toString();
    const inviteResponse = await this.fetchImpl(inviteEndpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.inviterAccessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ user_id: input.inviteeUserId }),
    });
    const inviteText = await inviteResponse.text();
    const inviteParsed = parseJsonSafely(inviteText);
    if (!inviteResponse.ok && !isAlreadyJoinedOrInvitedRoomError(inviteResponse.status, inviteParsed)) {
      throw {
        code: "MATRIX_AGENT_IDENTITY_FAILED",
        message: `Failed to invite ${input.inviteeUserId} to alert room`,
        retryable: true,
        details: {
          endpoint: inviteEndpoint,
          status: inviteResponse.status,
          body: summarizeUnknown(inviteParsed),
        },
      };
    }

    const joinEndpoint = new URL(
      `/_matrix/client/v3/rooms/${encodeURIComponent(input.roomId)}/join`,
      ensureTrailingSlash(input.adminBaseUrl),
    ).toString();
    const joinResponse = await this.fetchImpl(joinEndpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.inviteeAccessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({}),
    });
    const joinText = await joinResponse.text();
    const joinParsed = parseJsonSafely(joinText);
    if (!joinResponse.ok && !isAlreadyJoinedOrInvitedRoomError(joinResponse.status, joinParsed)) {
      throw {
        code: "MATRIX_AGENT_IDENTITY_FAILED",
        message: `Failed to join ${input.inviteeUserId} into alert room`,
        retryable: true,
        details: {
          endpoint: joinEndpoint,
          status: joinResponse.status,
          body: summarizeUnknown(joinParsed),
        },
      };
    }
  }

  private async writeTemplateWorkspaceFiles(input: {
    workspaceDir: string;
    runtimeConfig: RuntimeConfig;
    agentId: string;
    template: AgentTemplateManifest;
    toolInstanceIds: string[];
  }): Promise<void> {
    const boundTools = this.resolveBoundToolInstances(input.runtimeConfig, input.toolInstanceIds);
    const toolLines = boundTools.length === 0
      ? ["No bound tool instances."]
      : [
          "Run the listed commands with the OpenClaw `exec` tool.",
          "",
          ...boundTools.flatMap((tool) => {
            const manifest = this.resolveInstalledToolTemplate(input.runtimeConfig, tool.templateRef);
            return [
              `- \`${tool.id}\``,
              `  template: \`${tool.templateRef}\``,
              `  capabilities: ${manifest.capabilities.join(", ")}`,
              ...manifest.allowedCommands.map((command) =>
                `  command: \`${this.renderSovereignToolCommand(tool.id, command)}\``),
              ...(manifest.id === "imap-readonly"
                ? [
                    "  note: searches already run inside the configured mailbox",
                    "  note: use `--query ALL` for the whole mailbox and do not prefix the query with `INBOX`",
                  ]
                : []),
            ];
          }),
        ];
    for (const file of input.template.workspaceFiles) {
      const targetPath = join(input.workspaceDir, file.path);
      await mkdir(dirname(targetPath), { recursive: true });
      const rendered = renderTemplateWorkspaceContent({
        content: file.content,
        agentId: input.agentId,
        matrixHomeserver: input.runtimeConfig.matrix.publicBaseUrl,
        matrixAlertRoomId: input.runtimeConfig.matrix.alertRoom.roomId,
        toolSection: toolLines.join("\n"),
      });
      await writeFile(targetPath, `${rendered}\n`, "utf8");
      await this.applyRuntimeOwnership(targetPath);
    }
  }

  private async tryReadRuntimeConfig(): Promise<RuntimeConfig | null> {
    try {
      const raw = await readFile(this.paths.configPath, "utf8");
      return parseRuntimeConfigDocument(raw);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      this.logger.warn(
        {
          configPath: this.paths.configPath,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to read runtime config for status/doctor probes",
      );
      return null;
    }
  }

  private async tryReuseExistingMatrixAccounts(input: {
    req: InstallRequest;
    provision: BundledMatrixProvisionResult;
    error: unknown;
    botLocalpart?: string;
  }): Promise<BundledMatrixAccountsResult | null> {
    if (!isRateLimitedMatrixLoginFailure(input.error)) {
      return null;
    }

    const runtimeConfig = await this.tryReadRuntimeConfig();
    if (runtimeConfig === null) {
      return null;
    }
    if (runtimeConfig.matrix.homeserverDomain !== input.provision.homeserverDomain) {
      return null;
    }

    const expectedOperatorLocalpart = sanitizeExpectedMatrixLocalpart(
      input.req.operator.username,
      "operator",
    );
    const expectedBotLocalpart = resolveExpectedBundledBotLocalpart(
      expectedOperatorLocalpart,
      input.botLocalpart,
    );
    const operator = runtimeConfig.matrix.operator;
    const bot = runtimeConfig.matrix.bot;
    if (
      operator.localpart !== expectedOperatorLocalpart
      || bot.localpart !== expectedBotLocalpart
      || operator.passwordSecretRef === undefined
      || operator.accessTokenSecretRef === undefined
      || bot.passwordSecretRef === undefined
    ) {
      return null;
    }

    try {
      const [operatorAccessToken, botAccessToken] = await Promise.all([
        this.resolveSecretRef(operator.accessTokenSecretRef),
        this.resolveSecretRef(bot.accessTokenSecretRef),
      ]);
      this.logger.warn(
        {
          homeserverDomain: input.provision.homeserverDomain,
          operatorUserId: operator.userId,
          botUserId: bot.userId,
        },
        "Matrix login is rate limited; reusing existing persisted Matrix account tokens",
      );
      return {
        operator: {
          localpart: operator.localpart,
          userId: operator.userId,
          passwordSecretRef: operator.passwordSecretRef,
          accessToken: operatorAccessToken,
        },
        bot: {
          localpart: bot.localpart,
          userId: bot.userId,
          passwordSecretRef: bot.passwordSecretRef,
          accessToken: botAccessToken,
        },
      };
    } catch (reuseError) {
      this.logger.warn(
        {
          error: reuseError instanceof Error ? reuseError.message : String(reuseError),
        },
        "Failed to reuse persisted Matrix account tokens after login rate limiting",
      );
      return null;
    }
  }

  private async tryRecoverRateLimitedMatrixReconfigure(input: {
    req: InstallRequest;
    provision: BundledMatrixProvisionResult;
    error: unknown;
    botLocalpart?: string;
  }): Promise<BundledMatrixAccountsResult | null> {
    if (!isRateLimitedMatrixLoginFailure(input.error) || this.matrixProvisioner.resetState === undefined) {
      return null;
    }

    const runtimeConfig = await this.tryReadRuntimeConfig();
    if (
      runtimeConfig === null
      || runtimeConfig.matrix.homeserverDomain === input.provision.homeserverDomain
    ) {
      return null;
    }

    this.logger.warn(
      {
        currentHomeserverDomain: runtimeConfig.matrix.homeserverDomain,
        targetHomeserverDomain: input.provision.homeserverDomain,
        projectDir: input.provision.projectDir,
      },
      "Matrix login is rate limited while switching to a new bundled homeserver; resetting the new Matrix state and retrying",
    );

    await this.matrixProvisioner.resetState(input.provision);
    return this.matrixProvisioner.bootstrapAccounts(input.req, input.provision, {
      ...(input.botLocalpart === undefined ? {} : { botLocalpart: input.botLocalpart }),
    });
  }

  private async tryReadMailSentinelRegistration(): Promise<
    | {
        agentId: string;
        cronJobId: string;
      }
    | null
  > {
    const registrationFile = join(
      this.paths.stateDir,
      "mail-sentinel",
      "registration.json",
    );
    try {
      const raw = await readFile(registrationFile, "utf8");
      const parsed = parseJsonDocument(raw);
      if (!isRecord(parsed)) {
        return null;
      }
      if (typeof parsed.agentId !== "string" || typeof parsed.cronJobId !== "string") {
        return null;
      }
      return {
        agentId: parsed.agentId,
        cronJobId: parsed.cronJobId,
      };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      this.logger.warn(
        {
          registrationFile,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to read Mail Sentinel registration file",
      );
      return null;
    }
  }

  private async safeDetectOpenClaw(): Promise<
    | {
        binaryPath: string;
        version: string;
      }
    | null
  > {
    try {
      return await this.openclawBootstrapper.detectInstalled();
    } catch (error) {
      this.logger.warn(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        "OpenClaw CLI detection failed during status/doctor probe",
      );
      return null;
    }
  }

  private async inspectGatewayService(): Promise<{
    installed: boolean;
    state: GatewayState;
    message?: string;
  }> {
    const sovereignSystemctl = await this.inspectGatewayViaSystemctl([
      SOVEREIGN_GATEWAY_SYSTEMD_UNIT,
    ]);
    if (sovereignSystemctl !== null) {
      return sovereignSystemctl;
    }

    const openclawGatewayStatus = await this.safeExec("openclaw", ["gateway", "status"]);
    if (openclawGatewayStatus.ok) {
      const output = `${openclawGatewayStatus.result.stdout}\n${openclawGatewayStatus.result.stderr}`;
      const state = parseGatewayState(output);
      if (
        openclawGatewayStatus.result.exitCode === 0
        || state !== "unknown"
        || !looksLikeMissingGateway(output)
      ) {
        return {
          installed: !looksLikeMissingGateway(output),
          state,
          message: summarizeText(output, 220),
        };
      }
    }

    const systemctl = await this.inspectGatewayViaSystemctl([
      "openclaw-gateway.service",
      "openclaw-gateway",
    ]);
    if (systemctl !== null) {
      return systemctl;
    }

    return {
      installed: false,
      state: "unknown",
      message:
        openclawGatewayStatus.ok
          ? summarizeText(
              `${openclawGatewayStatus.result.stdout}\n${openclawGatewayStatus.result.stderr}`,
              220,
            )
          : openclawGatewayStatus.error,
    };
  }

  private async inspectRelayTunnelService(): Promise<{
    installed: boolean;
    state: GatewayState;
    message?: string;
  }> {
    const systemctl = await this.inspectGatewayViaSystemctl([RELAY_TUNNEL_SYSTEMD_UNIT]);
    if (systemctl !== null) {
      return systemctl;
    }
    return {
      installed: false,
      state: "unknown",
    };
  }

  private async inspectGatewayViaSystemctl(candidates: string[]): Promise<{
    installed: boolean;
    state: GatewayState;
    message?: string;
  } | null> {
    for (const unit of candidates) {
      const result = await this.safeExec("systemctl", ["is-active", unit]);
      if (!result.ok) {
        if (isMissingBinaryError(result.error)) {
          return null;
        }
        continue;
      }

      const output = `${result.result.stdout}\n${result.result.stderr}`;
      const state = parseGatewayState(output);
      if (result.result.exitCode === 0 || state !== "unknown") {
        return {
          installed: !/not-found|could not be found|no such file/i.test(output),
          state,
          message: summarizeText(output, 220),
        };
      }
    }

    return null;
  }

  private async probeOpenClawHealth(): Promise<{
    ok: boolean;
    message: string;
  }> {
    const probe = await this.safeExec("openclaw", ["health"], {
      timeoutMs: OPENCLAW_STATUS_PROBE_TIMEOUT_MS,
    });
    if (!probe.ok) {
      return {
        ok: false,
        message: probe.error,
      };
    }
    if (probe.result.exitCode === 0) {
      return {
        ok: true,
        message: summarizeText(probe.result.stdout, 220) || "openclaw health ok",
      };
    }
    return {
      ok: false,
      message: summarizeText(`${probe.result.stdout}\n${probe.result.stderr}`, 220),
    };
  }

  private async inspectOpenClawListContains(
    baseArgs: string[],
    expectedId: string,
  ): Promise<{ present: boolean; verified: boolean }> {
    const attempts = [baseArgs, [...baseArgs, "--json"]];
    for (const args of attempts) {
      const probe = await this.safeExec("openclaw", args, {
        timeoutMs: OPENCLAW_STATUS_PROBE_TIMEOUT_MS,
      });
      if (!probe.ok) {
        continue;
      }
      if (probe.result.exitCode !== 0) {
        continue;
      }
      const body = `${probe.result.stdout}\n${probe.result.stderr}`;
      return {
        present: textContainsId(body, expectedId),
        verified: true,
      };
    }

    return {
      present: false,
      verified: false,
    };
  }

  private async inspectMatrixStatus(
    runtimeConfig: RuntimeConfig | null,
  ): Promise<{
    health: ComponentHealth;
    roomReachable: boolean;
    message?: string;
  }> {
    if (runtimeConfig === null) {
      return {
        health: "unknown",
        roomReachable: false,
        message: "Sovereign runtime config does not exist yet",
      };
    }

    const matrixBaseUrl = runtimeConfig.matrix.adminBaseUrl;
    const matrixResult = await this.testMatrix({
      publicBaseUrl: matrixBaseUrl,
      federationEnabled: runtimeConfig.matrix.federationEnabled,
    });
    if (!matrixResult.ok) {
      return {
        health: "unhealthy",
        roomReachable: false,
        message: "Matrix endpoint probe failed",
      };
    }

    const roomReachable = await this.probeMatrixRoomReachable(runtimeConfig);
    return {
      health: roomReachable ? "healthy" : "degraded",
      roomReachable,
      ...(roomReachable
        ? {}
        : { message: "Matrix homeserver is reachable but alert room probe failed" }),
    };
  }

  private async inspectOpenClawRuntimeWiring(
    runtimeConfig: RuntimeConfig | null,
  ): Promise<CheckResult> {
    const defaults = this.getOpenClawRuntimePaths();
    const openclawHome = runtimeConfig?.openclaw.openclawHome ?? defaults.openclawHome;
    const runtimeConfigPath =
      runtimeConfig?.openclaw.runtimeConfigPath ?? defaults.runtimeConfigPath;
    const runtimeProfilePath =
      runtimeConfig?.openclaw.runtimeProfilePath ?? defaults.runtimeProfilePath;
    const gatewayEnvPath = runtimeConfig?.openclaw.gatewayEnvPath ?? defaults.gatewayEnvPath;
    const missing: string[] = [];

    for (const path of [openclawHome, runtimeConfigPath, runtimeProfilePath, gatewayEnvPath]) {
      const exists = await this.pathExists(path);
      if (!exists) {
        missing.push(path);
      }
    }

    if (missing.length > 0) {
      return check(
        "openclaw-runtime-wiring",
        "OpenClaw runtime wiring",
        "fail",
        "OpenClaw runtime files are missing",
        { missing },
      );
    }

    try {
      const envRaw = await readFile(gatewayEnvPath, "utf8");
      const env = parseEnvFile(envRaw);
      const configRef = env.OPENCLAW_CONFIG ?? env.OPENCLAW_CONFIG_PATH;
      const homeRef = env.OPENCLAW_HOME;
      const matches = configRef === runtimeConfigPath && homeRef === openclawHome;

      return check(
        "openclaw-runtime-wiring",
        "OpenClaw runtime wiring",
        matches ? "pass" : "warn",
        matches
          ? "OpenClaw runtime env wiring matches Sovereign-managed paths"
          : "OpenClaw runtime env wiring is present but does not match expected paths",
        {
          expectedConfigPath: runtimeConfigPath,
          expectedOpenclawHome: openclawHome,
          envConfigPath: configRef,
          envOpenclawHome: homeRef,
        },
      );
    } catch (error) {
      return check(
        "openclaw-runtime-wiring",
        "OpenClaw runtime wiring",
        "fail",
        "OpenClaw runtime env file is not readable",
        {
          gatewayEnvPath,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  private async probeMatrixRoomReachable(runtimeConfig: RuntimeConfig): Promise<boolean> {
    try {
      const accessToken = await this.resolveSecretRef(runtimeConfig.matrix.bot.accessTokenSecretRef);
      const endpoint = new URL(
        `/_matrix/client/v3/rooms/${encodeURIComponent(runtimeConfig.matrix.alertRoom.roomId)}/joined_members`,
        ensureTrailingSlash(runtimeConfig.matrix.adminBaseUrl),
      ).toString();
      const response = await this.fetchImpl(endpoint, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async safeExec(
    command: string,
    args: string[],
    options?: {
      timeoutMs?: number;
    },
  ): Promise<
    | {
        ok: true;
        result: ExecResult;
      }
    | {
        ok: false;
        error: string;
      }
  > {
    if (this.execRunner === null) {
      return {
        ok: false,
        error: "Exec runner is not configured",
      };
    }

    const openclawEnv =
      command === "openclaw" ? await this.resolveManagedOpenClawEnv() : null;
    const openclawServiceUser =
      command === "openclaw" ? await this.resolveManagedOpenClawServiceUser() : null;
    const shouldRunOpenClawAsServiceUser =
      command === "openclaw"
      && typeof process.getuid === "function"
      && process.getuid() === 0
      && openclawServiceUser !== null
      && openclawServiceUser !== "root";
    const effectiveCommand = shouldRunOpenClawAsServiceUser ? "sudo" : command;
    const effectiveArgs = shouldRunOpenClawAsServiceUser
      ? [
          "-u",
          openclawServiceUser,
          "--preserve-env=OPENCLAW_HOME,OPENCLAW_CONFIG,OPENCLAW_CONFIG_PATH,SOVEREIGN_NODE_CONFIG,CI,TMPDIR,TMP,TEMP",
          "--",
          command,
          ...args,
        ]
      : args;

    try {
      const result = await this.execRunner.run({
        command: effectiveCommand,
        args: effectiveArgs,
        options: {
          timeout: options?.timeoutMs ?? INSTALLER_EXEC_TIMEOUT_MS,
          ...(command === "openclaw"
            ? {
                env: {
                  CI: "1",
                  ...(openclawEnv ?? {}),
                },
              }
            : {}),
        },
      });
      return {
        ok: true,
        result,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await access(path, fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  private getOpenClawRuntimePaths(): {
    openclawHome: string;
    runtimeConfigPath: string;
    runtimeProfilePath: string;
    gatewayEnvPath: string;
  } {
    const openclawHome = join(this.paths.openclawServiceHome, ".openclaw");
    return {
      openclawHome,
      runtimeConfigPath: join(openclawHome, "openclaw.json5"),
      runtimeProfilePath: join(this.paths.openclawServiceHome, "profiles", "sovereign-runtime-profile.json5"),
      gatewayEnvPath: join(this.paths.openclawServiceHome, "gateway.env"),
    };
  }

  private buildManagedOpenClawEnv(runtimeConfig: RuntimeConfig): Record<string, string> {
    const tempDir = this.getManagedOpenClawTempDir(runtimeConfig);
    return {
      OPENCLAW_HOME: runtimeConfig.openclaw.openclawHome,
      OPENCLAW_CONFIG: runtimeConfig.openclaw.runtimeConfigPath,
      OPENCLAW_CONFIG_PATH: runtimeConfig.openclaw.runtimeConfigPath,
      SOVEREIGN_NODE_CONFIG: this.paths.configPath,
      TMPDIR: tempDir,
      TMP: tempDir,
      TEMP: tempDir,
    };
  }

  private getManagedOpenClawTempDir(runtimeConfig?: RuntimeConfig): string {
    const gatewayEnvPath =
      runtimeConfig?.openclaw.gatewayEnvPath ?? join(this.paths.openclawServiceHome, "gateway.env");
    return join(dirname(gatewayEnvPath), "tmp");
  }

  private setManagedOpenClawEnv(runtimeConfig: RuntimeConfig): void {
    const env = this.buildManagedOpenClawEnv(runtimeConfig);
    this.managedOpenClawEnv = env;
    for (const [key, value] of Object.entries(env)) {
      if (key === "TMPDIR" || key === "TMP" || key === "TEMP") {
        continue;
      }
      process.env[key] = value;
    }
  }

  private async resolveManagedOpenClawEnv(): Promise<Record<string, string> | null> {
    if (this.managedOpenClawEnv !== undefined) {
      return this.managedOpenClawEnv;
    }

    const runtimeConfig = await this.tryReadRuntimeConfig();
    if (runtimeConfig === null) {
      this.managedOpenClawEnv = null;
      return null;
    }

    const env = this.buildManagedOpenClawEnv(runtimeConfig);
    this.managedOpenClawEnv = env;
    return env;
  }

  private async resolveManagedOpenClawServiceUser(): Promise<string | null> {
    const runtimeConfig = await this.tryReadRuntimeConfig();
    if (runtimeConfig === null) {
      return null;
    }
    const configuredUser = runtimeConfig.openclaw.serviceUser?.trim();
    if (configuredUser === undefined || configuredUser.length === 0) {
      return null;
    }
    return configuredUser;
  }

  private buildInstallSteps(req: InstallRequest): InstallStep[] {
    const stepState: {
      effectiveRequest?: InstallRequest;
      relayEnrollment?: RelayEnrollmentResult;
      matrixProvision?: BundledMatrixProvisionResult;
      matrixAccounts?: BundledMatrixAccountsResult;
      matrixRoom?: BundledMatrixRoomBootstrapResult;
      runtimeConfig?: RuntimeConfig;
      selectedBots?: LoadedBotPackage[];
      sharedServiceBotLocalpart?: string;
      botRegistrations?: ManagedAgentRegistrationResult[];
      gatewayServiceSkipped?: boolean;
      relayTunnelServiceInstalled?: boolean;
    } = {};

    return [
      {
        id: "preflight",
        label: "Preflight",
        run: async () => {
          const result = await this.preflight(req);
          if (result.overall === "fail") {
            throw {
              code: "PREFLIGHT_FAILED",
              message: "Preflight checks failed",
              retryable: false,
              details: {
                recommendedActions: result.recommendedActions,
              },
            };
          }
        },
      },
      {
        id: "openclaw_bootstrap_cli",
        label: "Install OpenClaw CLI",
        run: async () => {
          const openclaw = req.openclaw;
          const manageInstallation = openclaw?.manageInstallation ?? true;

          if (!manageInstallation) {
            const detected = await this.openclawBootstrapper.detectInstalled();
            if (detected === null) {
              throw {
                code: "OPENCLAW_MISSING",
                message:
                  "OpenClaw is not installed but the request disabled Sovereign-managed installation",
                retryable: false,
              };
            }
            return;
          }

          await this.openclawBootstrapper.ensureInstalled({
            version: resolveRequestedOpenClawVersion(openclaw?.version),
            noOnboard: true,
            noPrompt: true,
            forceReinstall: openclaw?.forceReinstall ?? false,
            skipIfCompatibleInstalled: openclaw?.skipIfCompatibleInstalled ?? true,
          });
        },
      },
      {
        id: "imap_validate",
        label: "Validate IMAP",
        run: async () => {
          if (req.imap === undefined) {
            this.logger.info(
              "IMAP validation skipped because install request left IMAP in pending mode",
            );
            return;
          }
          const result = await this.testImap({ imap: req.imap });
          if (!result.ok) {
            throw {
              code: "IMAP_TEST_FAILED",
              message: result.error?.message ?? "IMAP validation failed",
              retryable: result.error?.retryable ?? true,
            };
          }
        },
      },
      {
        id: "relay_enroll",
        label: "Enroll managed relay",
        run: async (ctx) => {
          if (!this.isRelayModeRequest(req)) {
            stepState.effectiveRequest = req;
            return;
          }
          stepState.relayEnrollment = await this.resolveRelayEnrollment(req, ctx.installationId);
          stepState.effectiveRequest = this.buildRelayProvisionRequest(
            req,
            stepState.relayEnrollment,
          );
        },
      },
      {
        id: "matrix_provision",
        label: "Provision bundled Matrix stack",
        run: async () => {
          stepState.matrixProvision = await this.matrixProvisioner.provision(
            stepState.effectiveRequest ?? req,
          );
        },
      },
      {
        id: "matrix_bootstrap_accounts",
        label: "Bootstrap Matrix accounts",
        run: async () => {
          if (stepState.matrixProvision === undefined) {
            throw {
              code: "INSTALL_INTERNAL_STATE",
              message: "Matrix provisioning output is missing before account bootstrap",
              retryable: false,
            };
          }
          if (stepState.selectedBots === undefined) {
            stepState.selectedBots = (await this.resolveRequestedBots(stepState.effectiveRequest ?? req))
              .packages;
          }
          const sharedServiceBotLocalpart = this.resolveSharedServiceBotLocalpart(
            stepState.selectedBots,
          );
          if (sharedServiceBotLocalpart !== undefined) {
            stepState.sharedServiceBotLocalpart = sharedServiceBotLocalpart;
          }
          try {
            stepState.matrixAccounts = await this.matrixProvisioner.bootstrapAccounts(
              stepState.effectiveRequest ?? req,
              stepState.matrixProvision,
              {
                ...(sharedServiceBotLocalpart === undefined
                  ? {}
                  : { botLocalpart: sharedServiceBotLocalpart }),
              },
            );
          } catch (error) {
            const reusedAccounts = await this.tryReuseExistingMatrixAccounts({
              req: stepState.effectiveRequest ?? req,
              provision: stepState.matrixProvision,
              error,
              ...(sharedServiceBotLocalpart === undefined
                ? {}
                : { botLocalpart: sharedServiceBotLocalpart }),
            });
            if (reusedAccounts !== null) {
              stepState.matrixAccounts = reusedAccounts;
              return;
            }

            const resetAccounts = await this.tryRecoverRateLimitedMatrixReconfigure({
              req: stepState.effectiveRequest ?? req,
              provision: stepState.matrixProvision,
              error,
              ...(sharedServiceBotLocalpart === undefined
                ? {}
                : { botLocalpart: sharedServiceBotLocalpart }),
            });
            if (resetAccounts !== null) {
              stepState.matrixAccounts = resetAccounts;
              return;
            }

            throw error;
          }
        },
      },
      {
        id: "matrix_bootstrap_room",
        label: "Bootstrap Matrix alert room",
        run: async () => {
          if (stepState.matrixProvision === undefined) {
            throw {
              code: "INSTALL_INTERNAL_STATE",
              message: "Matrix provisioning output is missing before room bootstrap",
              retryable: false,
            };
          }
          if (stepState.matrixAccounts === undefined) {
            throw {
              code: "INSTALL_INTERNAL_STATE",
              message: "Matrix account bootstrap output is missing before room bootstrap",
              retryable: false,
            };
          }
          stepState.matrixRoom = await this.matrixProvisioner.bootstrapRoom(
            stepState.effectiveRequest ?? req,
            stepState.matrixProvision,
            stepState.matrixAccounts,
          );
        },
      },
      {
        id: "openclaw_gateway_service_install",
        label: "Install OpenClaw gateway service",
        run: async () => {
          if (stepState.matrixRoom === undefined) {
            throw {
              code: "INSTALL_INTERNAL_STATE",
              message: "Matrix room bootstrap output is missing before gateway service install",
              retryable: false,
            };
          }

          if (this.shouldPreferSystemGatewayService()) {
            stepState.gatewayServiceSkipped = true;
            this.logger.info(
              {
                serviceUser: this.getConfiguredServiceIdentity().user,
              },
              "Skipping OpenClaw user-service gateway install in root install context; using system-level service flow",
            );
            return;
          }

          try {
            await this.openclawGatewayServiceManager.install({
              force: req.openclaw?.forceReinstall ?? false,
            });
            await this.openclawGatewayServiceManager.start();
          } catch (error) {
            if (!isGatewayUserSystemdUnavailableError(error)) {
              throw error;
            }
            stepState.gatewayServiceSkipped = true;
            this.logger.warn(
              {
                error: describeError(error),
              },
              "OpenClaw gateway service install/start skipped because systemd user services are unavailable",
            );
          }
        },
      },
      {
        id: "openclaw_configure",
        label: "Configure OpenClaw runtime",
        run: async () => {
          if (stepState.matrixProvision === undefined) {
            throw {
              code: "INSTALL_INTERNAL_STATE",
              message: "Matrix provisioning output is missing before OpenClaw configure",
              retryable: false,
            };
          }
          if (stepState.matrixAccounts === undefined) {
            throw {
              code: "INSTALL_INTERNAL_STATE",
              message: "Matrix account output is missing before OpenClaw configure",
              retryable: false,
            };
          }
          if (stepState.matrixRoom === undefined) {
            throw {
              code: "INSTALL_INTERNAL_STATE",
              message: "Matrix room output is missing before OpenClaw configure",
              retryable: false,
            };
          }

          let runtimeConfig = await this.writeSovereignConfig({
            req: stepState.effectiveRequest ?? req,
            matrixProvision: stepState.matrixProvision,
            matrixAccounts: stepState.matrixAccounts,
            matrixRoom: stepState.matrixRoom,
            ...(stepState.relayEnrollment === undefined
              ? {}
              : { relayEnrollment: stepState.relayEnrollment }),
          });
          if (stepState.selectedBots === undefined) {
            stepState.selectedBots = (await this.resolveRequestedBots(stepState.effectiveRequest ?? req))
              .packages;
          }
          for (const agent of runtimeConfig.openclawProfile.agents) {
            await this.ensureManagedAgentWorkspace({
              id: agent.id,
              workspace: agent.workspace,
              runtimeConfig,
            });
          }
          let topologyChanged = false;
          for (const agent of runtimeConfig.openclawProfile.agents) {
            try {
              const ensuredAgent = await this.ensureManagedAgentMatrixIdentity(
                runtimeConfig,
                agent.id,
              );
              runtimeConfig = ensuredAgent.runtimeConfig;
              topologyChanged = topologyChanged || ensuredAgent.changed;
            } catch (error) {
              this.logger.warn(
                {
                  agentId: agent.id,
                  error: describeError(error),
                },
                "Managed bot Matrix identity provisioning failed during install; continuing with degraded bot setup",
              );
            }
          }
          if (topologyChanged) {
            await this.persistManagedAgentTopologyDocument(runtimeConfig);
          }
          await this.writeOpenClawRuntimeArtifacts(runtimeConfig);
          stepState.runtimeConfig = runtimeConfig;
          this.setManagedOpenClawEnv(runtimeConfig);
          if (runtimeConfig.relay?.enabled === true) {
            stepState.relayTunnelServiceInstalled = await this.ensureRelayTunnelService(
              runtimeConfig,
            );
          }

          if (stepState.gatewayServiceSkipped === true) {
            const fallbackStarted = await this.ensureSystemGatewayServiceFallback(runtimeConfig);
            if (fallbackStarted) {
              stepState.gatewayServiceSkipped = false;
              return;
            }
            this.logger.warn(
              "OpenClaw gateway restart skipped because neither user-service nor system-service startup succeeded",
            );
            return;
          }

          try {
            await this.openclawGatewayServiceManager.restart();
          } catch (error) {
            if (isGatewayUserSystemdUnavailableError(error)) {
              stepState.gatewayServiceSkipped = true;
              this.logger.warn(
                {
                  error: describeError(error),
                },
                "OpenClaw gateway restart skipped because systemd user services are unavailable",
              );
              return;
            }

            this.logger.warn(
              {
                error: error instanceof Error ? error.message : String(error),
              },
              "OpenClaw gateway restart failed after runtime configure; retrying with start",
            );
            try {
              await this.openclawGatewayServiceManager.start();
            } catch (startError) {
              if (isGatewayUserSystemdUnavailableError(startError)) {
                stepState.gatewayServiceSkipped = true;
                this.logger.warn(
                  {
                    error: describeError(startError),
                  },
                  "OpenClaw gateway start skipped because systemd user services are unavailable",
                );
                return;
              }
              throw startError;
            }
          }
        },
      },
      {
        id: "bots_configure",
        label: "Register managed bots",
        run: async () => {
          if (stepState.runtimeConfig === undefined) {
            throw {
              code: "INSTALL_INTERNAL_STATE",
              message: "Runtime config is missing before managed bot registration",
              retryable: false,
            };
          }
          stepState.botRegistrations = await this.registerManagedBots(
            stepState.runtimeConfig,
            stepState.selectedBots ?? [],
            {
              allowGatewayUnavailableFallback: stepState.gatewayServiceSkipped === true,
            },
          );
        },
      },
      {
        id: "smoke_checks",
        label: "Run smoke checks",
        run: async () => {
          if (stepState.matrixProvision === undefined) {
            throw {
              code: "INSTALL_INTERNAL_STATE",
              message: "Matrix provisioning output is missing before smoke checks",
              retryable: false,
            };
          }
          await this.runSmokeChecks(
            stepState.matrixProvision,
            stepState.runtimeConfig ?? await this.readRuntimeConfig(),
            stepState.gatewayServiceSkipped ?? false,
            stepState.relayEnrollment !== undefined,
          );
        },
      },
      {
        id: "test_alert",
        label: "Send hello alert",
        run: async () => {
          await this.sendInstalledBotHelloMessages();
        },
      },
    ];
  }

  private isRelayModeRequest(req: InstallRequest): boolean {
    if (req.connectivity?.mode === "relay") {
      return true;
    }
    if (req.connectivity?.mode === "direct") {
      return false;
    }
    return req.relay !== undefined;
  }

  private getRelayRequest(req: InstallRequest): NonNullable<InstallRequest["relay"]> {
    if (req.relay !== undefined) {
      return req.relay;
    }
    throw {
      code: "RELAY_CONFIG_MISSING",
      message: "Relay mode requires relay.controlUrl",
      retryable: false,
    };
  }

  private isDefaultManagedRelayControlUrl(controlUrl: string): boolean {
    return controlUrl.trim().replace(/\/+$/, "") === DEFAULT_MANAGED_RELAY_CONTROL_URL;
  }

  private async tryReuseExistingRelayEnrollment(
    relay: NonNullable<InstallRequest["relay"]>,
  ): Promise<RelayEnrollmentResult | null> {
    const runtimeConfig = await this.tryReadRuntimeConfig();
    if (runtimeConfig?.relay?.enabled !== true) {
      return null;
    }
    if (runtimeConfig.relay.controlUrl !== relay.controlUrl) {
      return null;
    }

    try {
      const token = await this.resolveSecretRef(runtimeConfig.relay.tunnel.tokenSecretRef);
      return {
        controlUrl: runtimeConfig.relay.controlUrl,
        hostname: runtimeConfig.relay.hostname,
        publicBaseUrl: runtimeConfig.relay.publicBaseUrl,
        tunnel: {
          serverAddr: runtimeConfig.relay.tunnel.serverAddr,
          serverPort: runtimeConfig.relay.tunnel.serverPort,
          token,
          proxyName: runtimeConfig.relay.tunnel.proxyName,
          ...(runtimeConfig.relay.tunnel.subdomain === undefined
            ? {}
            : { subdomain: runtimeConfig.relay.tunnel.subdomain }),
          type: runtimeConfig.relay.tunnel.type,
          localIp: runtimeConfig.relay.tunnel.localIp,
          localPort: runtimeConfig.relay.tunnel.localPort,
        },
      };
    } catch (error) {
      this.logger.warn(
        {
          error: describeError(error),
        },
        "Existing relay runtime config was found but could not be reused",
      );
      return null;
    }
  }

  private async resolveRelayEnrollment(
    req: InstallRequest,
    installationId: string,
  ): Promise<RelayEnrollmentResult> {
    const relay = this.getRelayRequest(req);
    const reused = await this.tryReuseExistingRelayEnrollment(relay);
    if (reused !== null) {
      this.logger.info(
        {
          hostname: reused.hostname,
          publicBaseUrl: reused.publicBaseUrl,
        },
        "Reusing existing managed relay assignment",
      );
      return reused;
    }

    const enrollmentToken = relay.enrollmentToken?.trim();
    const usesManagedPublicEnroll =
      this.isDefaultManagedRelayControlUrl(relay.controlUrl)
      && (enrollmentToken === undefined || enrollmentToken.length === 0);
    if (!usesManagedPublicEnroll && (enrollmentToken === undefined || enrollmentToken.length === 0)) {
      throw {
        code: "RELAY_CONFIG_MISSING",
        message: "Custom relay mode requires relay.enrollmentToken",
        retryable: false,
        details: {
          controlUrl: relay.controlUrl,
        },
      };
    }

    const endpoint = new URL(
      usesManagedPublicEnroll ? "/api/v1/enroll-public" : "/api/v1/enroll",
      ensureTrailingSlash(relay.controlUrl),
    ).toString();
    let lastFailure: { status?: number; responseText?: string; error?: unknown } | null = null;
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const requestedSlug = this.generateManagedRelayRequestedSlug();
      let response: Response;
      try {
        response = await this.fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            ...(usesManagedPublicEnroll ? { installationId } : { enrollmentToken }),
            requestedSlug,
            version: process.env.npm_package_version ?? "0.1.0",
          }),
        });
      } catch (error) {
        lastFailure = {
          error,
        };
        continue;
      }

      const responseText = await response.text();
      if (!response.ok) {
        lastFailure = {
          status: response.status,
          responseText,
        };
        const responseTextLower = responseText.toLowerCase();
        const slugConflict =
          response.status === 409
          || (
            (response.status === 400 || response.status === 422)
            && responseTextLower.includes("slug")
            && (
              responseTextLower.includes("taken")
              || responseTextLower.includes("already")
              || responseTextLower.includes("exists")
            )
          );
        if (slugConflict && attempt < 6) {
          this.logger.warn(
            {
              requestedSlug,
              controlUrl: relay.controlUrl,
              status: response.status,
            },
            "Managed relay slug collision detected; retrying with a new generated node name",
          );
          continue;
        }
        throw {
          code: "RELAY_ENROLL_FAILED",
          message: "Managed relay enrollment was rejected",
          retryable: response.status >= 500,
          details: {
            controlUrl: relay.controlUrl,
            status: response.status,
            requestedSlug,
            body: summarizeText(responseText, 1200),
          },
        };
      }

      const parsed = parseJsonDocument(responseText);
      const payload =
        isRecord(parsed)
        && isRecord(parsed.result)
          ? parsed.result
          : isRecord(parsed)
            ? parsed
            : null;
      const tunnel = payload !== null && isRecord(payload.tunnel) ? payload.tunnel : null;
      const hostname =
        payload !== null && typeof payload.assignedHostname === "string"
          ? payload.assignedHostname.trim()
          : payload !== null && typeof payload.hostname === "string"
            ? payload.hostname.trim()
            : "";
      const publicBaseUrl =
        payload !== null && typeof payload.publicBaseUrl === "string"
          ? payload.publicBaseUrl.trim()
          : "";
      const serverAddr =
        tunnel !== null && typeof tunnel.serverAddr === "string"
          ? tunnel.serverAddr.trim()
          : tunnel !== null && typeof tunnel.serverHost === "string"
            ? tunnel.serverHost.trim()
            : "";
      const serverPort =
        tunnel !== null && typeof tunnel.serverPort === "number" && Number.isFinite(tunnel.serverPort)
          ? Math.trunc(tunnel.serverPort)
          : 7000;
      const token =
        tunnel !== null && typeof tunnel.token === "string"
          ? tunnel.token.trim()
          : tunnel !== null && typeof tunnel.authToken === "string"
            ? tunnel.authToken.trim()
            : "";
      const proxyName =
        tunnel !== null && typeof tunnel.proxyName === "string"
          ? tunnel.proxyName.trim()
          : hostname.length > 0
            ? `relay-${hostname.replace(/[^a-zA-Z0-9-]/g, "-")}`
            : "";
      const subdomain =
        tunnel !== null && typeof tunnel.subdomain === "string" && tunnel.subdomain.trim().length > 0
          ? tunnel.subdomain.trim()
          : undefined;

      if (
        hostname.length === 0
        || publicBaseUrl.length === 0
        || serverAddr.length === 0
        || token.length === 0
        || proxyName.length === 0
      ) {
        throw {
          code: "RELAY_ENROLL_INVALID",
          message: "Managed relay enrollment returned an incomplete response",
          retryable: false,
          details: {
            controlUrl: relay.controlUrl,
            requestedSlug,
            response: summarizeText(responseText, 1200),
          },
        };
      }

      this.logger.info(
        {
          hostname,
          publicBaseUrl,
          controlUrl: relay.controlUrl,
          requestedSlug,
        },
        "Managed relay enrollment succeeded",
      );

      return {
        controlUrl: relay.controlUrl,
        hostname,
        publicBaseUrl,
        tunnel: {
          serverAddr,
          serverPort,
          token,
          proxyName,
          ...(subdomain === undefined ? {} : { subdomain }),
          type: "http",
          localIp: "127.0.0.1",
          localPort: RELAY_LOCAL_EDGE_PORT,
        },
      };
    }

    throw {
      code: "RELAY_ENROLL_FAILED",
      message: "Managed relay enrollment request failed",
      retryable: true,
      details: {
        controlUrl: relay.controlUrl,
        ...(lastFailure?.status === undefined ? {} : { status: lastFailure.status }),
        ...(lastFailure?.responseText === undefined
          ? {}
          : { body: summarizeText(lastFailure.responseText, 1200) }),
        ...(lastFailure?.error === undefined ? {} : { error: describeError(lastFailure.error) }),
      },
    };
  }

  private generateManagedRelayRequestedSlug(): string {
    const entropy = randomUUID().replace(/-/g, "");
    const pick = (values: readonly string[], offset: number): string => {
      const nibble = entropy.slice(offset, offset + 2);
      const value = Number.parseInt(nibble, 16);
      const index = Number.isFinite(value) ? value % values.length : 0;
      return values[index] ?? values[0] ?? "node";
    };
    const suffix = entropy.slice(0, 4);
    const raw = `${pick(RELAY_NAME_MOODS, 0)}-${pick(RELAY_NAME_THEMES, 2)}-${pick(RELAY_NAME_MASCOTS, 4)}-${suffix}`.toLowerCase();
    const normalized = raw
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "");
    return normalized.length === 0 ? `sovereign-node-${suffix}` : normalized.slice(0, 63).replace(/-+$/, "");
  }

  private buildRelayProvisionRequest(
    req: InstallRequest,
    enrollment: RelayEnrollmentResult,
  ): InstallRequest {
    return {
      ...req,
      connectivity: {
        ...(req.connectivity ?? {}),
        mode: "relay",
      },
      matrix: {
        ...req.matrix,
        homeserverDomain: enrollment.hostname,
        publicBaseUrl: enrollment.publicBaseUrl,
        federationEnabled: false,
      },
    };
  }

  private getRelayTunnelConfigPath(): string {
    return join(this.paths.stateDir, "relay", "frpc.toml");
  }

  private async ensureRelayTunnelService(runtimeConfig: RuntimeConfig): Promise<boolean> {
    if (runtimeConfig.relay?.enabled !== true) {
      return false;
    }

    const relay = runtimeConfig.relay;
    const configPath = relay.configPath;
    const unitPath = join("/etc/systemd/system", relay.serviceName);
    const containerName = relay.serviceName.replace(/\.service$/, "");
    let token: string;

    try {
      token = await this.resolveSecretRef(relay.tunnel.tokenSecretRef);
      await mkdir(dirname(configPath), { recursive: true });
      await this.applyRuntimeOwnership(dirname(configPath));
      const configText = [
        `serverAddr = "${relay.tunnel.serverAddr}"`,
        `serverPort = ${relay.tunnel.serverPort}`,
        "",
        "[auth]",
        'method = "token"',
        `token = "${token}"`,
        "",
        "[[proxies]]",
        `name = "${relay.tunnel.proxyName}"`,
        `type = "${relay.tunnel.type}"`,
        `localIP = "${relay.tunnel.localIp}"`,
        `localPort = ${relay.tunnel.localPort}`,
        `customDomains = ["${relay.hostname}"]`,
        ...(relay.tunnel.subdomain === undefined
          ? []
          : [`subdomain = "${relay.tunnel.subdomain}"`]),
      ].join("\n");
      await writeFile(configPath, `${configText}\n`, "utf8");
      await chmod(configPath, 0o600);
      await this.applyRuntimeOwnership(configPath);
    } catch (error) {
      this.logger.warn(
        {
          configPath,
          error: describeError(error),
        },
        "Failed to write managed relay tunnel config",
      );
      return false;
    }

    const unitContents = [
      "[Unit]",
      "Description=Sovereign Matrix Relay Tunnel",
      "After=network-online.target docker.service",
      "Wants=network-online.target",
      "Requires=docker.service",
      "",
      "[Service]",
      "Type=simple",
      `ExecStartPre=-/usr/bin/docker rm -f ${containerName}`,
      `ExecStart=/usr/bin/docker run --rm --name ${containerName} --network host -v ${configPath}:/etc/frp/frpc.toml:ro ${RELAY_TUNNEL_DEFAULT_IMAGE} -c /etc/frp/frpc.toml`,
      `ExecStop=/usr/bin/docker stop ${containerName}`,
      "Restart=always",
      "RestartSec=3",
      "",
      "[Install]",
      "WantedBy=multi-user.target",
      "",
    ].join("\n");

    try {
      await mkdir(dirname(unitPath), { recursive: true });
      await writeFile(unitPath, unitContents, "utf8");
    } catch (error) {
      this.logger.warn(
        {
          unitPath,
          error: describeError(error),
        },
        "Failed to write managed relay tunnel systemd unit",
      );
      return false;
    }

    const commands: string[][] = [
      ["daemon-reload"],
      ["enable", "--now", relay.serviceName],
      ["restart", relay.serviceName],
      ["is-active", relay.serviceName],
    ];
    for (const args of commands) {
      const result = await this.safeExec("systemctl", args);
      if (!result.ok) {
        this.logger.warn(
          {
            command: ["systemctl", ...args].join(" "),
            error: result.error,
          },
          "Managed relay tunnel systemd command failed",
        );
        return false;
      }
      if (result.result.exitCode !== 0) {
        this.logger.warn(
          {
            command: result.result.command,
            exitCode: result.result.exitCode,
            stderr: truncateText(result.result.stderr, 1200),
            stdout: truncateText(result.result.stdout, 1200),
          },
          "Managed relay tunnel systemd command exited non-zero",
        );
        return false;
      }
    }

    this.logger.info(
      {
        unitName: relay.serviceName,
        hostname: relay.hostname,
        publicBaseUrl: relay.publicBaseUrl,
      },
      "Managed relay tunnel service started successfully",
    );
    return true;
  }

  private async persistJobSnapshot(input: {
    installationId: string;
    request: InstallRequest;
    snapshot: JobRunnerSnapshot;
  }): Promise<void> {
    const response: InstallJobStatusResponse = {
      job: input.snapshot.job,
      ...(input.snapshot.error === undefined ? {} : { error: input.snapshot.error }),
    };

    const record: PersistedInstallJobRecord = {
      version: 1,
      installationId: input.installationId,
      request: installRequestSchema.parse(input.request),
      response: installJobStatusResponseSchema.parse(response),
      updatedAt: now(),
    };

    await this.writeJobRecord(record);
  }

  private async writeJobRecord(record: PersistedInstallJobRecord): Promise<void> {
    const filePath = await this.getJobFilePath(record.response.job.jobId);
    const tempPath = `${filePath}.${randomUUID()}.tmp`;
    const payload = `${JSON.stringify(record, null, 2)}\n`;
    await writeFile(tempPath, payload, "utf8");
    await rename(tempPath, filePath);
  }

  private async readJobRecord(jobId: string): Promise<PersistedInstallJobRecord | null> {
    const filePath = await this.getJobFilePath(jobId);
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedInstallJobRecord>;
      if (parsed.response === undefined || parsed.request === undefined) {
        throw new Error(`Install job record is missing required fields: ${jobId}`);
      }

      return {
        version: 1,
        installationId:
          typeof parsed.installationId === "string"
            ? parsed.installationId
            : `inst_unknown_${jobId}`,
        request: installRequestSchema.parse(parsed.request),
        response: installJobStatusResponseSchema.parse(parsed.response),
        updatedAt:
          typeof parsed.updatedAt === "string" && parsed.updatedAt.length > 0
            ? parsed.updatedAt
            : now(),
      };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private async getJobFilePath(jobId: string): Promise<string> {
    const dir = await this.ensureInstallJobsDir();
    return join(dir, `${jobId}.json`);
  }

  private async ensureInstallJobsDir(): Promise<string> {
    if (this.resolvedInstallJobsDir !== null) {
      return this.resolvedInstallJobsDir;
    }

    const override = process.env.SOVEREIGN_NODE_INSTALL_JOBS_DIR;
    if (override !== undefined && override.length > 0) {
      await mkdir(override, { recursive: true });
      await access(override, fsConstants.W_OK);
      this.resolvedInstallJobsDir = override;
      return override;
    }

    try {
      await mkdir(this.paths.installJobsDir, { recursive: true });
      await access(this.paths.installJobsDir, fsConstants.W_OK);
      this.resolvedInstallJobsDir = this.paths.installJobsDir;
      return this.resolvedInstallJobsDir;
    } catch (error) {
      const fallback = resolve(process.cwd(), ".sovereign-node-dev", "install-jobs");
      await mkdir(fallback, { recursive: true });
      this.logger.debug(
        {
          preferredInstallJobsDir: this.paths.installJobsDir,
          fallbackInstallJobsDir: fallback,
          error: error instanceof Error ? error.message : String(error),
        },
        "Install jobs dir is not writable; using local fallback for scaffold/dev execution",
      );
      this.resolvedInstallJobsDir = fallback;
      return fallback;
    }
  }

  private async registerManagedBots(
    runtimeConfig: RuntimeConfig,
    botPackages: LoadedBotPackage[],
    options?: {
      allowGatewayUnavailableFallback?: boolean;
    },
  ): Promise<ManagedAgentRegistrationResult[]> {
    const registrations: ManagedAgentRegistrationResult[] = [];
    let deferred = false;

    for (const botPackage of botPackages) {
      const agent = runtimeConfig.openclawProfile.agents.find(
        (entry) => entry.botId === botPackage.manifest.id || entry.id === botPackage.manifest.id,
      );
      if (agent === undefined) {
        continue;
      }
      const cronEntry = runtimeConfig.openclawProfile.crons.find(
        (entry) => entry.botId === botPackage.manifest.id || entry.agentId === agent.id,
      );
      try {
        const registration = await this.managedAgentRegistrar.register({
          agentId: agent.id,
          workspaceDir: agent.workspace,
          ...(cronEntry === undefined || botPackage.manifest.openclaw.cron === undefined
            ? {}
            : {
                cron: {
                  id: cronEntry.id,
                  every: cronEntry.every,
                  message: botPackage.manifest.openclaw.cron.message,
                  announceRoomId: runtimeConfig.matrix.alertRoom.roomId,
                  ...(botPackage.manifest.openclaw.cron.session === undefined
                    ? {}
                    : { session: botPackage.manifest.openclaw.cron.session }),
                },
              }),
        });
        registrations.push(registration);
      } catch (error) {
        if (
          options?.allowGatewayUnavailableFallback !== true
          || !isMailSentinelGatewayUnavailableError(error)
        ) {
          throw error;
        }
        deferred = true;
        this.logger.warn(
          {
            botId: botPackage.manifest.id,
            error: describeError(error),
          },
          "Managed bot registration deferred because OpenClaw gateway is unavailable",
        );
        registrations.push({
          agentId: agent.id,
          workspaceDir: agent.workspace,
          agentCommand: "deferred: gateway unavailable",
          ...(cronEntry === undefined
            ? {}
            : {
                cronJobId: cronEntry.id,
                cronCommand: "deferred: gateway unavailable",
              }),
        });
      }
    }

    await this.persistManagedBotRegistrationRecords(registrations);

    if (!deferred) {
      try {
        await this.ensureManagedAgentOpenClawBindings(runtimeConfig);
      } catch (error) {
        if (!isCoreAgentBindingBestEffortSkippable(error)) {
          throw error;
        }
        this.logger.warn(
          {
            error: describeError(error),
          },
          "Managed bot Matrix binding commands are unavailable in this OpenClaw runtime; continuing without explicit per-agent bindings",
        );
      }
    }

    return registrations;
  }

  private async persistManagedBotRegistrationRecords(
    registrations: ManagedAgentRegistrationResult[],
  ): Promise<void> {
    for (const registration of registrations) {
      await this.writeInstallerJsonFile(
        join(this.paths.stateDir, registration.agentId, "registration.json"),
        {
          agentId: registration.agentId,
          ...(registration.cronJobId === undefined ? {} : { cronJobId: registration.cronJobId }),
          deferred:
            registration.agentCommand.startsWith("deferred:")
            || registration.cronCommand?.startsWith("deferred:") === true,
        },
        0o600,
      );
    }
  }

  private async ensureManagedAgentOpenClawBindings(runtimeConfig: RuntimeConfig): Promise<void> {
    if (this.execRunner === null) {
      this.logger.warn(
        "Exec runner unavailable; skipping explicit OpenClaw per-agent matrix account/binding setup",
      );
      return;
    }
    const matrixPluginEnable = await this.safeExec("openclaw", ["plugins", "enable", "matrix"]);
    if (!matrixPluginEnable.ok) {
      throw {
        code: "MANAGED_AGENT_REGISTER_FAILED",
        message: "OpenClaw matrix plugin could not be enabled",
        retryable: true,
        details: {
          error: matrixPluginEnable.error,
        },
      };
    }
    if (matrixPluginEnable.result.exitCode !== 0) {
      throw {
        code: "MANAGED_AGENT_REGISTER_FAILED",
        message: "OpenClaw matrix plugin enable command exited with non-zero status",
        retryable: true,
        details: {
          command: matrixPluginEnable.result.command,
          exitCode: matrixPluginEnable.result.exitCode,
          stderr: truncateText(matrixPluginEnable.result.stderr, 1200),
          stdout: truncateText(matrixPluginEnable.result.stdout, 1200),
        },
      };
    }

    for (const agent of runtimeConfig.openclawProfile.agents) {
      if (agent.matrix === undefined || agent.matrix.accessTokenSecretRef === undefined) {
        this.logger.warn(
          {
            agentId: agent.id,
          },
          "Managed agent has no Matrix identity yet; skipping OpenClaw matrix account binding",
        );
        continue;
      }
      await this.runOpenClawCommandAlternatives({
        label: `${agent.id}-agent`,
        commands: [
          ["agents", "add", agent.id, "--workspace", agent.workspace],
          ["agents", "create", agent.id, "--workspace", agent.workspace],
          ["agents", "upsert", agent.id, "--workspace", agent.workspace],
          ["agents", "upsert", "--id", agent.id, "--workspace", agent.workspace],
          ["agents", "add", "--id", agent.id, "--workspace", agent.workspace],
          ["agents", "create", "--id", agent.id, "--workspace", agent.workspace],
        ],
        allowAlreadyExists: true,
      });
      await this.runOpenClawCommandAlternatives({
        label: `${agent.id}-matrix-bind`,
        commands: [
          [
            "agents",
            "bind",
            "--agent",
            agent.id,
            "--bind",
            `matrix:${agent.id}`,
          ],
          [
            "agents",
            "bind",
            "--agent",
            agent.id,
            "--bind",
            "matrix",
          ],
        ],
        allowAlreadyExists: true,
      });
      for (const pattern of this.listAgentExecAllowlistPatterns(
        runtimeConfig,
        agent.toolInstanceIds ?? [],
      )) {
        await this.runOpenClawCommandAlternatives({
          label: `${agent.id}-exec-allowlist`,
          commands: [["approvals", "allowlist", "add", "--agent", agent.id, pattern]],
          allowAlreadyExists: true,
        });
      }
    }
  }

  private async runOpenClawCommandAlternatives(input: {
    label: string;
    commands: string[][];
    allowAlreadyExists?: boolean;
  }): Promise<void> {
    const failures: {
      command: string;
      exitCode: number;
      stderr: string;
      stdout: string;
    }[] = [];
    for (const args of input.commands) {
      const result = await this.safeExec("openclaw", args);
      if (!result.ok) {
        failures.push({
          command: `openclaw ${args.join(" ")}`,
          exitCode: -1,
          stderr: truncateText(result.error, 1200),
          stdout: "",
        });
        continue;
      }
      if (result.result.exitCode === 0) {
        return;
      }
      const output = `${result.result.stderr}\n${result.result.stdout}`;
      if (input.allowAlreadyExists === true && isAlreadyExistsOutput(output)) {
        return;
      }
      failures.push({
        command: result.result.command,
        exitCode: result.result.exitCode,
        stderr: truncateText(result.result.stderr, 1200),
        stdout: truncateText(result.result.stdout, 1200),
      });
    }
    throw {
      code: "MANAGED_AGENT_REGISTER_FAILED",
      message: `OpenClaw ${input.label} registration commands failed`,
      retryable: true,
      details: {
        failures,
      },
    };
  }

  private async sendInstalledBotHelloMessages(): Promise<void> {
    const runtimeConfig = await this.readRuntimeConfig();
    let candidateCount = 0;
    let deliveredCount = 0;
    for (const agent of runtimeConfig.openclawProfile.agents) {
      const botPackage = await this.findBotPackageByTemplateRef(agent.templateRef);
      if (botPackage?.manifest.helloMessage === undefined) {
        continue;
      }
      candidateCount += 1;
      if (agent.matrix?.accessTokenSecretRef === undefined) {
        this.logger.warn(
          {
            agentId: agent.id,
          },
          "Managed bot has no Matrix access token; skipping hello message",
        );
        continue;
      }
      const accessToken = await this.resolveSecretRef(agent.matrix.accessTokenSecretRef);
      await this.sendMatrixRoomMessage({
        adminBaseUrl: runtimeConfig.matrix.adminBaseUrl,
        roomId: runtimeConfig.matrix.alertRoom.roomId,
        accessToken,
        text: botPackage.manifest.helloMessage,
      });
      deliveredCount += 1;
    }
    if (candidateCount > 0 && deliveredCount === 0) {
      throw {
        code: "TEST_ALERT_FAILED",
        message: "No managed bot hello messages could be delivered",
        retryable: true,
      };
    }
  }

  private async sendMatrixRoomMessage(input: {
    adminBaseUrl: string;
    roomId: string;
    accessToken: string;
    text: string;
  }): Promise<void> {
    const txnId = randomUUID();
    const endpoint = new URL(
      `/_matrix/client/v3/rooms/${encodeURIComponent(input.roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`,
      ensureTrailingSlash(input.adminBaseUrl),
    ).toString();
    const response = await this.fetchImpl(endpoint, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        msgtype: "m.text",
        body: input.text,
      }),
    });
    const bodyText = await response.text();
    if (!response.ok) {
      throw {
        code: "TEST_ALERT_FAILED",
        message: "Matrix hello message delivery failed",
        retryable: true,
        details: {
          endpoint,
          status: response.status,
          body: summarizeText(bodyText, 1200),
        },
      };
    }
  }

  private async ensureSystemGatewayServiceFallback(runtimeConfig: RuntimeConfig): Promise<boolean> {
    if (this.execRunner === null) {
      return false;
    }

    const serviceIdentity = this.getConfiguredServiceIdentity(runtimeConfig);
    const managedTempDir = this.getManagedOpenClawTempDir(runtimeConfig);
    const unitName = SOVEREIGN_GATEWAY_SYSTEMD_UNIT;
    const unitPath =
      process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH?.trim()
      || `/etc/systemd/system/${unitName}`;
    const unitContents = [
      "[Unit]",
      "Description=Sovereign OpenClaw Gateway",
      "After=network-online.target",
      "Wants=network-online.target",
      "",
      "[Service]",
      "Type=simple",
      `User=${serviceIdentity.user}`,
      `Group=${serviceIdentity.group}`,
      `WorkingDirectory=${this.paths.openclawServiceHome}`,
      `Environment=HOME=${this.paths.openclawServiceHome}`,
      `Environment=TMPDIR=${managedTempDir}`,
      `Environment=TMP=${managedTempDir}`,
      `Environment=TEMP=${managedTempDir}`,
      `EnvironmentFile=-${runtimeConfig.openclaw.gatewayEnvPath}`,
      "ExecStart=/usr/bin/env openclaw gateway run --allow-unconfigured --bind loopback",
      "Restart=always",
      "RestartSec=3",
      "",
      "[Install]",
      "WantedBy=multi-user.target",
      "",
    ].join("\n");

    try {
      await mkdir(this.paths.openclawServiceHome, { recursive: true });
      await mkdir(managedTempDir, { recursive: true });
      await chmod(managedTempDir, 0o700);
      await this.applyRuntimeOwnership(this.paths.openclawServiceHome);
      await this.applyRuntimeOwnership(managedTempDir);
      await mkdir(dirname(unitPath), { recursive: true });
      await writeFile(unitPath, unitContents, "utf8");
    } catch (error) {
      this.logger.warn(
        {
          unitPath,
          error: describeError(error),
        },
        "Failed to write system-level OpenClaw gateway unit",
      );
      return false;
    }

    const commands: string[][] = [
      ["daemon-reload"],
      ["enable", "--now", unitName],
      ["restart", unitName],
      ["is-active", unitName],
    ];
    for (const args of commands) {
      const result = await this.safeExec("systemctl", args);
      if (!result.ok) {
        this.logger.warn(
          {
            command: ["systemctl", ...args].join(" "),
            error: result.error,
          },
          "System-level OpenClaw gateway command failed",
        );
        return false;
      }
      if (result.result.exitCode !== 0) {
        this.logger.warn(
          {
            command: result.result.command,
            exitCode: result.result.exitCode,
            stderr: truncateText(result.result.stderr, 1200),
            stdout: truncateText(result.result.stdout, 1200),
          },
          "System-level OpenClaw gateway command exited non-zero",
        );
        return false;
      }
    }

    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const health = await this.probeOpenClawHealth();
      if (health.ok) {
        this.logger.info(
          {
            unitName,
            unitPath,
            health: health.message,
          },
          "System-level OpenClaw gateway service started successfully",
        );
        return true;
      }
      if (attempt < 20) {
        await delay(1000);
      } else {
        this.logger.warn(
          {
            unitName,
            health: health.message,
          },
          "System-level OpenClaw gateway service did not become healthy in time",
        );
      }
    }

    return false;
  }

  private async runSmokeChecks(
    matrixProvision: BundledMatrixProvisionResult,
    runtimeConfig: RuntimeConfig,
    gatewayServiceSkipped: boolean,
    relayModeEnabled: boolean,
  ): Promise<void> {
    const matrix = await this.testMatrix({
      publicBaseUrl: matrixProvision.adminBaseUrl,
      federationEnabled: matrixProvision.federationEnabled,
    });
    if (!matrix.ok) {
      throw {
        code: "SMOKE_CHECKS_FAILED",
        message: "Matrix smoke check failed",
        retryable: true,
        details: {
          checks: matrix.checks,
        },
      };
    }

    const openclaw = await this.safeDetectOpenClaw();
    if (openclaw === null) {
      throw {
        code: "SMOKE_CHECKS_FAILED",
        message: "OpenClaw CLI is not detectable during smoke checks",
        retryable: true,
      };
    }

    if (!(await this.probeMatrixRoomReachable(runtimeConfig))) {
      throw {
        code: "SMOKE_CHECKS_FAILED",
        message: "Matrix alert room is not reachable with the configured bot token",
        retryable: true,
        details: {
          roomId: runtimeConfig.matrix.alertRoom.roomId,
        },
      };
    }

    if (relayModeEnabled) {
      const relay = await this.inspectRelayTunnelService();
      if (!relay.installed || relay.state !== "running") {
        throw {
          code: "SMOKE_CHECKS_FAILED",
          message: "Managed relay tunnel service is not running during smoke checks",
          retryable: true,
          details: {
            state: relay.state,
            message: relay.message,
          },
        };
      }
    }

    const wiringCheck = await this.inspectOpenClawRuntimeWiring(runtimeConfig);
    if (wiringCheck.status === "fail") {
      throw {
        code: "SMOKE_CHECKS_FAILED",
        message: "OpenClaw runtime wiring check failed",
        retryable: true,
        details: wiringCheck.details,
      };
    }

    if (this.execRunner !== null && !gatewayServiceSkipped) {
      const gateway = await this.inspectGatewayService();
      if (!gateway.installed || gateway.state !== "running") {
        throw {
          code: "SMOKE_CHECKS_FAILED",
          message: "OpenClaw gateway service is not running during smoke checks",
          retryable: true,
          details: {
            state: gateway.state,
            message: gateway.message,
          },
        };
      }

      const health = await this.probeOpenClawHealth();
      if (!health.ok) {
        throw {
          code: "SMOKE_CHECKS_FAILED",
          message: "OpenClaw health probe failed during smoke checks",
          retryable: true,
          details: {
            health: health.message,
          },
        };
      }

      const requiredAgentIds = dedupeStrings(
        ensureCoreManagedAgents(runtimeConfig.openclawProfile.agents).map((entry) => entry.id),
      );
      const missingAgentIds: string[] = [];
      let verifiedAgentProbe = false;
      for (const agentId of requiredAgentIds) {
        const agentProbe = await this.inspectOpenClawListContains(["agents", "list"], agentId);
        verifiedAgentProbe = verifiedAgentProbe || agentProbe.verified;
        if (agentProbe.verified && !agentProbe.present) {
          missingAgentIds.push(agentId);
        }
      }
      if (verifiedAgentProbe && missingAgentIds.length > 0) {
        throw {
          code: "SMOKE_CHECKS_FAILED",
          message: "One or more managed agents are missing from OpenClaw runtime",
          retryable: true,
          details: {
            missingAgentIds,
          },
        };
      }

      const expectedCronIds = dedupeStrings(
        runtimeConfig.openclawProfile.crons.map((entry) => entry.id),
      );
      const missingCronJobIds: string[] = [];
      let verifiedCronProbe = false;
      for (const cronJobId of expectedCronIds) {
        const cronProbe = await this.inspectOpenClawListContains(["cron", "list"], cronJobId);
        verifiedCronProbe = verifiedCronProbe || cronProbe.verified;
        if (cronProbe.verified && !cronProbe.present) {
          missingCronJobIds.push(cronJobId);
        }
      }
      if (verifiedCronProbe && missingCronJobIds.length > 0) {
        throw {
          code: "SMOKE_CHECKS_FAILED",
          message: "One or more managed cron jobs are missing from OpenClaw runtime",
          retryable: true,
          details: {
            missingCronJobIds,
          },
        };
      }
    }
  }

  private async readRuntimeConfig(): Promise<RuntimeConfig> {
    let raw = "";
    try {
      raw = await readFile(this.paths.configPath, "utf8");
    } catch (error) {
      throw {
        code: "CONFIG_NOT_FOUND",
        message: "Sovereign runtime config does not exist yet",
        retryable: false,
        details: {
          configPath: this.paths.configPath,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }

    const parsed = parseRuntimeConfigDocument(raw);
    if (parsed === null) {
      throw {
        code: "CONFIG_INVALID",
        message: "Sovereign runtime config does not match expected shape",
        retryable: false,
        details: {
          configPath: this.paths.configPath,
        },
      };
    }

    return parsed;
  }

  private getMatrixOnboardingStatePath(runtimeConfig: RuntimeConfig): string {
    const configured = runtimeConfig.matrix.onboardingStatePath?.trim();
    if (configured !== undefined && configured.length > 0) {
      return configured;
    }
    const projectDir = runtimeConfig.matrix.projectDir?.trim();
    if (projectDir !== undefined && projectDir.length > 0) {
      return join(projectDir, "onboarding", "state.json");
    }
    throw {
      code: "MATRIX_ONBOARDING_UNAVAILABLE",
      message: "Matrix onboarding is unavailable for this installation",
      retryable: false,
      details: {
        reason: "missing_project_dir",
      },
    };
  }

  private getInstallRequestPath(): string {
    const configured = process.env.SOVEREIGN_NODE_REQUEST_FILE?.trim();
    if (configured !== undefined && configured.length > 0) {
      return configured;
    }
    const configDir = dirname(this.paths.configPath);
    if (configDir.length > 0 && configDir !== ".") {
      return join(configDir, "install-request.json");
    }
    return DEFAULT_INSTALL_REQUEST_FILE;
  }

  private async writeInstallerJsonFile(
    path: string,
    value: unknown,
    mode: number,
  ): Promise<void> {
    const tempPath = `${path}.${randomUUID()}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await chmod(tempPath, mode);
    await rename(tempPath, path);
    await this.applyRuntimeOwnership(path);
  }

  private async updateInstallRequestOpenrouter(input: {
    model: string;
    secretRef: string;
    modelChanged: boolean;
    credentialsChanged: boolean;
  }): Promise<{ changed: string[]; validation: CheckResult[] }> {
    const requestPath = this.getInstallRequestPath();
    let raw = "";
    try {
      raw = await readFile(requestPath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return {
          changed: [],
          validation: [
            check(
              "install-request-sync",
              "Saved install request sync",
              "warn",
              "Saved install request file was not found; future installer updates will keep the previous OpenRouter settings until the request file is refreshed",
              {
                requestFile: requestPath,
              },
            ),
          ],
        };
      }
      throw {
        code: "REQUEST_UPDATE_FAILED",
        message: "Failed to read the saved install request file",
        retryable: false,
        details: {
          requestFile: requestPath,
          error: describeError(error),
        },
      };
    }

    const parsed = parseJsonDocument(raw);
    const validated = installRequestSchema.safeParse(parsed);
    if (!validated.success) {
      return {
        changed: [],
        validation: [
          check(
            "install-request-sync",
            "Saved install request sync",
            "warn",
            "Saved install request could not be updated because it is invalid",
            {
              requestFile: requestPath,
            },
          ),
        ],
      };
    }

    const requestPayload = validated.data;
    const changed: string[] = [];
    if (input.modelChanged && requestPayload.openrouter.model !== input.model) {
      requestPayload.openrouter.model = input.model;
      changed.push("request.openrouter.model");
    }
    if (input.credentialsChanged) {
      requestPayload.openrouter.secretRef = input.secretRef;
      delete requestPayload.openrouter.apiKey;
      changed.push("request.openrouter.secretRef");
    }

    if (changed.length === 0) {
      return {
        changed,
        validation: [
          check(
            "install-request-sync",
            "Saved install request sync",
            "pass",
            "Saved install request already matched the current OpenRouter settings",
            {
              requestFile: requestPath,
            },
          ),
        ],
      };
    }

    try {
      await this.writeInstallerJsonFile(requestPath, requestPayload, 0o640);
    } catch (error) {
      throw {
        code: "REQUEST_UPDATE_FAILED",
        message: "Failed to write the saved install request file",
        retryable: false,
        details: {
          requestFile: requestPath,
          error: describeError(error),
        },
      };
    }

    return {
      changed,
      validation: [
        check(
          "install-request-sync",
          "Saved install request sync",
          "pass",
          "Saved install request updated to match the new OpenRouter settings",
          {
            requestFile: requestPath,
          },
        ),
      ],
    };
  }

  private async refreshGatewayAfterRuntimeConfig(runtimeConfig: RuntimeConfig): Promise<void> {
    if (this.shouldPreferSystemGatewayService(runtimeConfig)) {
      const started = await this.ensureSystemGatewayServiceFallback(runtimeConfig);
      if (started) {
        return;
      }
      throw {
        code: "OPENCLAW_GATEWAY_RESTART_FAILED",
        message: "Failed to restart the system-level OpenClaw gateway service",
        retryable: true,
      };
    }

    try {
      await this.openclawGatewayServiceManager.restart();
      return;
    } catch (error) {
      if (isGatewayUserSystemdUnavailableError(error)) {
        throw {
          code: "OPENCLAW_GATEWAY_RESTART_FAILED",
          message: "OpenClaw gateway restart is unavailable because systemd user services are unavailable in this context",
          retryable: true,
          details: {
            error: describeError(error),
          },
        };
      }
    }

    await this.openclawGatewayServiceManager.start();
  }

  private async resolveSecretRef(secretRef: string): Promise<string> {
    if (secretRef.startsWith("file:")) {
      const filePath = secretRef.slice("file:".length);
      const raw = await readFile(filePath, "utf8");
      const value = stripSingleTrailingNewline(raw);
      if (value.length === 0) {
        throw {
          code: "SECRET_READ_FAILED",
          message: "Secret file is empty",
          retryable: false,
          details: {
            secretRef,
          },
        };
      }
      return value;
    }

    if (secretRef.startsWith("env:")) {
      const key = secretRef.slice("env:".length);
      const value = process.env[key];
      if (value !== undefined && value.length > 0) {
        return value;
      }
      throw {
        code: "SECRET_READ_FAILED",
        message: "Secret environment variable is not set",
        retryable: false,
        details: {
          secretRef,
        },
      };
    }

    throw {
      code: "SECRET_REF_UNSUPPORTED",
      message: "Unsupported secretRef format",
      retryable: false,
      details: {
        secretRef,
      },
    };
  }

  private async writeSovereignConfig(input: {
    req: InstallRequest;
    relayEnrollment?: RelayEnrollmentResult;
    matrixProvision: BundledMatrixProvisionResult;
    matrixAccounts: BundledMatrixAccountsResult;
    matrixRoom: BundledMatrixRoomBootstrapResult;
  }): Promise<RuntimeConfig> {
    const imapConfig = await this.resolveImapConfig(input.req.imap);
    const openrouterSecretRef = await this.resolveOpenRouterSecretRef(input.req.openrouter);
    const openrouterModel = input.req.openrouter.model ?? DEFAULT_OPENROUTER_MODEL;
    const operatorTokenSecretRef = await this.writeSecretFile(
      "matrix-operator-access-token",
      input.matrixAccounts.operator.accessToken,
    );
    const botTokenSecretRef = await this.writeSecretFile(
      "matrix-bot-access-token",
      input.matrixAccounts.bot.accessToken,
    );
    const relayTokenSecretRef =
      input.relayEnrollment === undefined
        ? undefined
        : await this.writeSecretFile("relay-tunnel-token", input.relayEnrollment.tunnel.token);
    const serviceIdentity = this.getConfiguredServiceIdentity();
    const openclawPaths = this.getOpenClawRuntimePaths();
    const { packages: selectedBotPackages, configById: selectedBotConfig } =
      await this.resolveRequestedBots(input.req);
    const allBotPackages = await this.listBotPackages();
    const previousRuntimeConfig = await this.tryReadRuntimeConfig();
    const allBotTemplateRefs = new Set(allBotPackages.map((entry) => entry.templateRef));
    const allManagedBotToolIds = new Set(
      allBotPackages.flatMap((entry) =>
        entry.manifest.toolInstances.map(
          (tool: LoadedBotPackage["manifest"]["toolInstances"][number]) => tool.id,
        )),
    );
    const requiredCoreTemplateRefs = dedupeStrings(
      selectedBotPackages.flatMap((entry) => [
        ...entry.manifest.toolInstances.map(
          (tool: LoadedBotPackage["manifest"]["toolInstances"][number]) => tool.templateRef,
        ),
        ...entry.template.requiredToolTemplates.map((tool) => formatTemplateRef(tool.id, tool.version)),
        ...entry.template.optionalToolTemplates.map((tool) => formatTemplateRef(tool.id, tool.version)),
      ]).filter((ref: string) => findCoreTemplateManifest(ref) !== undefined),
    );
    const preservedUserAgents =
      previousRuntimeConfig?.openclawProfile.agents.filter(
        (entry) =>
          !allBotTemplateRefs.has(entry.templateRef ?? "")
          && !selectedBotPackages.some((botPackage) => botPackage.manifest.id === entry.botId),
      ) ?? [];
    const preservedInstalledTemplates = previousRuntimeConfig?.templates.installed ?? [];
    const preservedToolInstances = previousRuntimeConfig?.sovereignTools.instances ?? [];
    let installedTemplates = this.withRequiredCoreTemplates(
      preservedInstalledTemplates,
      requiredCoreTemplateRefs,
    );
    for (const botPackage of selectedBotPackages) {
      installedTemplates = this.upsertInstalledBotTemplateEntry(
        installedTemplates,
        botPackage,
      ).installed;
    }

    const baseMatrixConfig = {
      accessMode: input.relayEnrollment === undefined ? "direct" as const : "relay" as const,
      homeserverDomain: input.matrixProvision.homeserverDomain,
      federationEnabled: input.matrixProvision.federationEnabled,
      publicBaseUrl: input.matrixProvision.publicBaseUrl,
      adminBaseUrl: input.matrixProvision.adminBaseUrl,
      projectDir: input.matrixProvision.projectDir,
      onboardingStatePath: join(input.matrixProvision.projectDir, "onboarding", "state.json"),
      operator: {
        localpart: input.matrixAccounts.operator.localpart,
        userId: input.matrixAccounts.operator.userId,
        passwordSecretRef: input.matrixAccounts.operator.passwordSecretRef,
        accessTokenSecretRef: operatorTokenSecretRef,
      },
      bot: {
        localpart: input.matrixAccounts.bot.localpart,
        userId: input.matrixAccounts.bot.userId,
        passwordSecretRef: input.matrixAccounts.bot.passwordSecretRef,
        accessTokenSecretRef: botTokenSecretRef,
      },
      alertRoom: {
        roomId: input.matrixRoom.roomId,
        roomName: input.matrixRoom.roomName,
      },
    };
    const provisionalRuntimeConfig: RuntimeConfig = {
      openclaw: {
        managedInstallation: input.req.openclaw?.manageInstallation ?? true,
        installMethod: input.req.openclaw?.installMethod ?? "install_sh",
        requestedVersion: resolveRequestedOpenClawVersion(input.req.openclaw?.version),
        openclawHome: openclawPaths.openclawHome,
        runtimeConfigPath: openclawPaths.runtimeConfigPath,
        runtimeProfilePath: openclawPaths.runtimeProfilePath,
        gatewayEnvPath: openclawPaths.gatewayEnvPath,
        serviceUser: serviceIdentity.user,
        serviceGroup: serviceIdentity.group,
      },
      openrouter: {
        model: openrouterModel,
        apiKeySecretRef: openrouterSecretRef,
      },
      openclawProfile: {
        plugins: {
          allow: ["matrix"],
        },
        agents: [],
        crons: [],
      },
      imap: {
        status: imapConfig.status,
        host: imapConfig.host,
        port: imapConfig.port,
        tls: imapConfig.tls,
        username: imapConfig.username,
        mailbox: imapConfig.mailbox,
        secretRef: imapConfig.secretRef,
      },
      matrix: baseMatrixConfig,
      bots: {
        config: selectedBotConfig,
      },
      templates: {
        installed: installedTemplates,
      },
      sovereignTools: {
        instances: [],
      },
      ...(input.relayEnrollment === undefined
        ? {}
        : {
            relay: {
              enabled: true,
              controlUrl: input.relayEnrollment.controlUrl,
              hostname: input.relayEnrollment.hostname,
              publicBaseUrl: input.relayEnrollment.publicBaseUrl,
              connected: false,
              serviceName: RELAY_TUNNEL_SYSTEMD_UNIT,
              configPath: this.getRelayTunnelConfigPath(),
              tunnel: {
                serverAddr: input.relayEnrollment.tunnel.serverAddr,
                serverPort: input.relayEnrollment.tunnel.serverPort,
                tokenSecretRef: relayTokenSecretRef ?? "env:SOVEREIGN_RELAY_TOKEN_UNSET",
                proxyName: input.relayEnrollment.tunnel.proxyName,
                ...(input.relayEnrollment.tunnel.subdomain === undefined
                  ? {}
                  : { subdomain: input.relayEnrollment.tunnel.subdomain }),
                type: input.relayEnrollment.tunnel.type,
                localIp: input.relayEnrollment.tunnel.localIp,
                localPort: input.relayEnrollment.tunnel.localPort,
              },
            } satisfies RelayRuntimeConfig,
          }),
    };
    const preservedUserToolInstances = preservedToolInstances.filter(
      (entry) => !allManagedBotToolIds.has(entry.id),
    );
    const managedBotToolInstances = selectedBotPackages.flatMap((botPackage) =>
      botPackage.manifest.toolInstances.flatMap(
        (tool: LoadedBotPackage["manifest"]["toolInstances"][number]) =>
        this.isBotToolInstanceEnabled(provisionalRuntimeConfig, tool.enabledWhen)
          ? [
              this.buildManagedBotToolInstance({
                runtimeConfig: provisionalRuntimeConfig,
                tool,
                existing: preservedToolInstances.find((entry) => entry.id === tool.id),
              }),
            ]
          : [],
      ));
    provisionalRuntimeConfig.sovereignTools.instances = sortToolInstances([
      ...preservedUserToolInstances,
      ...managedBotToolInstances,
    ]);
    const managedBotAgents = selectedBotPackages.map((botPackage) => {
      const toolInstanceIds = managedBotToolInstances
        .filter((tool: RuntimeConfig["sovereignTools"]["instances"][number]) =>
          botPackage.manifest.toolInstances.some(
            (definition: LoadedBotPackage["manifest"]["toolInstances"][number]) => definition.id === tool.id,
          ))
        .map((tool: RuntimeConfig["sovereignTools"]["instances"][number]) => tool.id);
      return {
        id: botPackage.manifest.id,
        workspace: join(this.paths.stateDir, botPackage.manifest.id, "workspace"),
        templateRef: botPackage.templateRef,
        botId: botPackage.manifest.id,
        ...(toolInstanceIds.length === 0 ? {} : { toolInstanceIds }),
        ...(botPackage.manifest.matrixIdentity.mode !== "service-account"
          ? {}
          : {
              matrix: {
                localpart: input.matrixAccounts.bot.localpart,
                userId: input.matrixAccounts.bot.userId,
                ...(input.matrixAccounts.bot.passwordSecretRef === undefined
                  ? {}
                  : { passwordSecretRef: input.matrixAccounts.bot.passwordSecretRef }),
                accessTokenSecretRef: botTokenSecretRef,
              },
            }),
      };
    });
    const managedAgents = ensureCoreManagedAgents([
      ...preservedUserAgents,
      ...managedBotAgents,
    ]);
    const runtimeConfig: RuntimeConfig = {
      ...provisionalRuntimeConfig,
      openclawProfile: {
        plugins: {
          allow: ["matrix"],
        },
        agents: managedAgents,
        crons: selectedBotPackages.flatMap((botPackage) => {
          const cron = botPackage.manifest.openclaw.cron;
          if (cron === undefined) {
            return [];
          }
          const configuredEvery = selectedBotConfig[botPackage.manifest.id]?.[cron.everyConfigKey ?? ""];
          const every =
            typeof configuredEvery === "string" && configuredEvery.length > 0
              ? configuredEvery
              : cron.defaultEvery ?? "5m";
          return [{
            id: cron.id,
            every,
            agentId: botPackage.manifest.id,
            botId: botPackage.manifest.id,
          }];
        }),
        ...(selectedBotPackages.flatMap((botPackage) => {
          const cron = botPackage.manifest.openclaw.cron;
          if (cron === undefined) {
            return [];
          }
          const configuredEvery = selectedBotConfig[botPackage.manifest.id]?.[cron.everyConfigKey ?? ""];
          const every =
            typeof configuredEvery === "string" && configuredEvery.length > 0
              ? configuredEvery
              : cron.defaultEvery ?? "5m";
          return [{ id: cron.id, every }];
        })[0] === undefined
          ? {}
          : {
              cron: selectedBotPackages.flatMap((botPackage) => {
                const cron = botPackage.manifest.openclaw.cron;
                if (cron === undefined) {
                  return [];
                }
                const configuredEvery =
                  selectedBotConfig[botPackage.manifest.id]?.[cron.everyConfigKey ?? ""];
                const every =
                  typeof configuredEvery === "string" && configuredEvery.length > 0
                    ? configuredEvery
                    : cron.defaultEvery ?? "5m";
                return [{ id: cron.id, every }];
              })[0],
            }),
      },
      sovereignTools: {
        instances: provisionalRuntimeConfig.sovereignTools.instances,
      },
    };

    const configPayload = {
      contractVersion: CONTRACT_VERSION,
      mode: "bundled_matrix" as const,
      generatedAt: now(),
      connectivity: {
        mode: runtimeConfig.matrix.accessMode,
      },
      openclaw: {
        managedInstallation: runtimeConfig.openclaw.managedInstallation,
        installMethod: runtimeConfig.openclaw.installMethod,
        requestedVersion: runtimeConfig.openclaw.requestedVersion,
        openclawHome: runtimeConfig.openclaw.openclawHome,
        runtimeConfigPath: runtimeConfig.openclaw.runtimeConfigPath,
        runtimeProfilePath: runtimeConfig.openclaw.runtimeProfilePath,
        gatewayEnvPath: runtimeConfig.openclaw.gatewayEnvPath,
        serviceUser: runtimeConfig.openclaw.serviceUser,
        serviceGroup: runtimeConfig.openclaw.serviceGroup,
        serviceHome: this.paths.openclawServiceHome,
      },
      openclawProfile: {
        plugins: {
          allow: runtimeConfig.openclawProfile.plugins.allow,
        },
        channels: {
          matrix: {
            enabled: true,
            homeserver: runtimeConfig.matrix.adminBaseUrl,
            roomId: runtimeConfig.matrix.alertRoom.roomId,
          },
        },
        agents: runtimeConfig.openclawProfile.agents,
        crons: runtimeConfig.openclawProfile.crons,
        ...(runtimeConfig.openclawProfile.crons[0] === undefined
          ? {}
          : {
              cron: {
                id: runtimeConfig.openclawProfile.crons[0].id,
                every: runtimeConfig.openclawProfile.crons[0].every,
              },
            }),
      },
      openrouter: {
        provider: "openrouter",
        model: runtimeConfig.openrouter.model,
        apiKeySecretRef: runtimeConfig.openrouter.apiKeySecretRef,
      },
      imap:
        runtimeConfig.imap.status === "configured" && input.req.imap !== undefined
          ? {
              status: "configured",
              host: runtimeConfig.imap.host,
              port: runtimeConfig.imap.port,
              tls: runtimeConfig.imap.tls,
              username: runtimeConfig.imap.username,
              secretRef: runtimeConfig.imap.secretRef,
              mailbox: runtimeConfig.imap.mailbox,
            }
          : {
              status: "pending",
              host: runtimeConfig.imap.host,
              port: runtimeConfig.imap.port,
              tls: runtimeConfig.imap.tls,
              username: runtimeConfig.imap.username,
              secretRef: runtimeConfig.imap.secretRef,
              mailbox: runtimeConfig.imap.mailbox,
            },
      matrix: {
        accessMode: runtimeConfig.matrix.accessMode,
        homeserverDomain: input.matrixProvision.homeserverDomain,
        publicBaseUrl: runtimeConfig.matrix.publicBaseUrl,
        adminBaseUrl: runtimeConfig.matrix.adminBaseUrl,
        federationEnabled: runtimeConfig.matrix.federationEnabled,
        tlsMode: input.matrixProvision.tlsMode,
        projectDir: runtimeConfig.matrix.projectDir,
        onboardingStatePath: runtimeConfig.matrix.onboardingStatePath,
        operator: {
          localpart: input.matrixAccounts.operator.localpart,
          userId: runtimeConfig.matrix.operator.userId,
          passwordSecretRef: input.matrixAccounts.operator.passwordSecretRef,
          accessTokenSecretRef: operatorTokenSecretRef,
        },
        bot: {
          localpart: input.matrixAccounts.bot.localpart,
          userId: runtimeConfig.matrix.bot.userId,
          passwordSecretRef: input.matrixAccounts.bot.passwordSecretRef,
          accessTokenSecretRef: runtimeConfig.matrix.bot.accessTokenSecretRef,
        },
        alertRoom: {
          roomId: runtimeConfig.matrix.alertRoom.roomId,
          roomName: runtimeConfig.matrix.alertRoom.roomName,
        },
      },
      ...(runtimeConfig.relay === undefined
        ? {}
        : {
            relay: {
              enabled: runtimeConfig.relay.enabled,
              controlUrl: runtimeConfig.relay.controlUrl,
              hostname: runtimeConfig.relay.hostname,
              publicBaseUrl: runtimeConfig.relay.publicBaseUrl,
              connected: runtimeConfig.relay.connected,
              serviceName: runtimeConfig.relay.serviceName,
              configPath: runtimeConfig.relay.configPath,
              tunnel: runtimeConfig.relay.tunnel,
            },
          }),
      bots: runtimeConfig.bots,
      templates: runtimeConfig.templates,
      sovereignTools: runtimeConfig.sovereignTools,
    };

    try {
      const configDir = dirname(this.paths.configPath);
      await mkdir(configDir, { recursive: true });
      const tempPath = `${this.paths.configPath}.${randomUUID()}.tmp`;
      await writeFile(tempPath, `${JSON.stringify(configPayload, null, 2)}\n`, "utf8");
      await chmod(tempPath, 0o644);
      await rename(tempPath, this.paths.configPath);
      await this.applyRuntimeOwnership(this.paths.configPath);
    } catch (error) {
      throw {
        code: "OPENCLAW_CONFIG_WRITE_FAILED",
        message: "Failed to persist Sovereign/OpenClaw runtime config",
        retryable: true,
        details: {
          configPath: this.paths.configPath,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }

    return runtimeConfig;
  }

  private async writeOpenClawRuntimeArtifacts(runtimeConfig: RuntimeConfig): Promise<void> {
    const openrouterApiKey = await this.resolveSecretRef(runtimeConfig.openrouter.apiKeySecretRef);
    const managedAgents = ensureCoreManagedAgents(
      runtimeConfig.openclawProfile.agents,
    );
    const operatorAllowlist = [runtimeConfig.matrix.operator.userId];
    const pluginEntries: Record<string, unknown> = {
      matrix: {
        enabled: true,
      },
    };
    const matrixAccounts: Record<
      string,
      {
        homeserver: string;
        userId: string;
        accessToken: string;
      }
    > = {};
    for (const agent of managedAgents) {
      if (agent.matrix === undefined || agent.matrix.accessTokenSecretRef === undefined) {
        continue;
      }
      matrixAccounts[agent.id] = {
        homeserver: runtimeConfig.matrix.adminBaseUrl,
        userId: agent.matrix.userId,
        accessToken: await this.resolveSecretRef(agent.matrix.accessTokenSecretRef),
      };
    }
    matrixAccounts["default"] = {
      homeserver: runtimeConfig.matrix.adminBaseUrl,
      userId: runtimeConfig.matrix.bot.userId,
      accessToken: await this.resolveSecretRef(runtimeConfig.matrix.bot.accessTokenSecretRef),
    };

    const runtimePayload = {
      gateway: {
        bind: "loopback" as const,
      },
      plugins: {
        allow: runtimeConfig.openclawProfile.plugins.allow,
        entries: pluginEntries,
      },
      channels: {
        matrix: {
          enabled: true,
          homeserver: runtimeConfig.matrix.adminBaseUrl,
          userId: runtimeConfig.matrix.bot.userId,
          ...(Object.keys(matrixAccounts).length === 0
            ? {}
            : {
                accounts: matrixAccounts,
              }),
          dm: {
            policy: "allowlist" as const,
            allowFrom: operatorAllowlist,
          },
          groupPolicy: "allowlist" as const,
          groupAllowFrom: operatorAllowlist,
          groups: {
            [runtimeConfig.matrix.alertRoom.roomId]: {
              enabled: true,
              allow: true,
              autoReply: true,
              users: operatorAllowlist,
            },
          },
        },
      },
      agents: {
        defaults: {
          model: normalizeOpenClawAgentModel(runtimeConfig.openrouter.model),
        },
        list: managedAgents.map((entry) => {
          const tools = this.buildOpenClawAgentToolPolicy(
            runtimeConfig,
            entry.toolInstanceIds ?? [],
          );
          return {
            id: entry.id,
            workspace: entry.workspace,
            ...(tools === null ? {} : { tools }),
          };
        }),
      },
      cron: {
        enabled: true,
      },
    };

    const profilePayload = {
      generatedAt: now(),
      source: "sovereign-node",
      openclawProfile: runtimeConfig.openclawProfile,
      bots: runtimeConfig.bots,
      matrix: {
        publicBaseUrl: runtimeConfig.matrix.publicBaseUrl,
        adminBaseUrl: runtimeConfig.matrix.adminBaseUrl,
        roomId: runtimeConfig.matrix.alertRoom.roomId,
      },
      imap: {
        status: runtimeConfig.imap.status,
        host: runtimeConfig.imap.host,
        mailbox: runtimeConfig.imap.mailbox,
      },
      openrouter: runtimeConfig.openrouter,
    };
    const managedTempDir = this.getManagedOpenClawTempDir(runtimeConfig);

    try {
      await mkdir(this.paths.openclawServiceHome, { recursive: true });
      await mkdir(runtimeConfig.openclaw.openclawHome, { recursive: true });
      await mkdir(dirname(runtimeConfig.openclaw.runtimeProfilePath), { recursive: true });
      await mkdir(managedTempDir, { recursive: true });
      await chmod(managedTempDir, 0o700);
      await this.applyRuntimeOwnership(this.paths.openclawServiceHome);
      await this.applyRuntimeOwnership(runtimeConfig.openclaw.openclawHome);
      await this.applyRuntimeOwnership(dirname(runtimeConfig.openclaw.runtimeProfilePath));
      await this.applyRuntimeOwnership(managedTempDir);
      await this.writeProtectedJsonFile(
        runtimeConfig.openclaw.runtimeConfigPath,
        runtimePayload,
      );
      await this.writeProtectedJsonFile(
        runtimeConfig.openclaw.runtimeProfilePath,
        profilePayload,
      );

      const envFileLines = [
        `OPENCLAW_HOME=${runtimeConfig.openclaw.openclawHome}`,
        `OPENCLAW_CONFIG=${runtimeConfig.openclaw.runtimeConfigPath}`,
        `OPENCLAW_CONFIG_PATH=${runtimeConfig.openclaw.runtimeConfigPath}`,
        `SOVEREIGN_NODE_CONFIG=${this.paths.configPath}`,
        `TMPDIR=${managedTempDir}`,
        `TMP=${managedTempDir}`,
        `TEMP=${managedTempDir}`,
        `OPENROUTER_API_KEY=${openrouterApiKey}`,
        `MATRIX_HOMESERVER=${runtimeConfig.matrix.adminBaseUrl}`,
        `MATRIX_USER_ID=${runtimeConfig.matrix.bot.userId}`,
      ];
      const matrixAccessToken = await this.resolveSecretRef(
        runtimeConfig.matrix.bot.accessTokenSecretRef,
      );
      envFileLines.push(`MATRIX_ACCESS_TOKEN=${matrixAccessToken}`);
      const envTempPath = `${runtimeConfig.openclaw.gatewayEnvPath}.${randomUUID()}.tmp`;
      await writeFile(envTempPath, `${envFileLines.join("\n")}\n`, "utf8");
      await chmod(envTempPath, 0o600);
      await rename(envTempPath, runtimeConfig.openclaw.gatewayEnvPath);
      await this.applyRuntimeOwnership(runtimeConfig.openclaw.gatewayEnvPath);
    } catch (error) {
      throw {
        code: "OPENCLAW_CONFIG_WRITE_FAILED",
        message: "Failed to write OpenClaw runtime artifacts",
        retryable: true,
        details: {
          openclawHome: runtimeConfig.openclaw.openclawHome,
          runtimeConfigPath: runtimeConfig.openclaw.runtimeConfigPath,
          runtimeProfilePath: runtimeConfig.openclaw.runtimeProfilePath,
          gatewayEnvPath: runtimeConfig.openclaw.gatewayEnvPath,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private async writeProtectedJsonFile(path: string, value: unknown): Promise<void> {
    const tempPath = `${path}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await chmod(tempPath, 0o600);
    await rename(tempPath, path);
    await this.applyRuntimeOwnership(path);
  }

  private async resolveImapConfig(
    imap: InstallRequest["imap"],
  ): Promise<RuntimeConfig["imap"]> {
    if (imap === undefined) {
      return {
        status: "pending",
        host: "pending",
        port: 993,
        tls: true,
        username: "pending",
        mailbox: "INBOX",
        secretRef: "env:SOVEREIGN_IMAP_SECRET_UNSET",
      };
    }

    if (imap.secretRef !== undefined && imap.secretRef.length > 0) {
      return {
        status: "configured",
        host: imap.host,
        port: imap.port,
        tls: imap.tls,
        username: imap.username,
        mailbox: imap.mailbox ?? "INBOX",
        secretRef: imap.secretRef,
      };
    }

    if (imap.password !== undefined && imap.password.length > 0) {
      return {
        status: "configured",
        host: imap.host,
        port: imap.port,
        tls: imap.tls,
        username: imap.username,
        mailbox: imap.mailbox ?? "INBOX",
        secretRef: await this.writeSecretFile("imap-password", imap.password),
      };
    }

    return {
      status: "pending",
      host: imap.host,
      port: imap.port,
      tls: imap.tls,
      username: imap.username,
      mailbox: imap.mailbox ?? "INBOX",
      secretRef: "env:SOVEREIGN_IMAP_SECRET_UNSET",
    };
  }

  private async resolveOpenRouterSecretRef(
    openrouter: InstallRequest["openrouter"],
  ): Promise<string> {
    if (openrouter.secretRef !== undefined && openrouter.secretRef.length > 0) {
      return openrouter.secretRef;
    }

    if (openrouter.apiKey !== undefined && openrouter.apiKey.length > 0) {
      return this.writeSecretFile("openrouter-api-key", openrouter.apiKey);
    }

    if (process.env.OPENROUTER_API_KEY !== undefined && process.env.OPENROUTER_API_KEY.length > 0) {
      return "env:OPENROUTER_API_KEY";
    }

    throw {
      code: "OPENROUTER_SECRET_MISSING",
      message: "OpenRouter credentials are missing (provide openrouter.apiKey or openrouter.secretRef)",
      retryable: false,
    };
  }

  private async writeSecretFile(fileName: string, value: string): Promise<string> {
    const secretsDir = await this.ensureSecretsDir();
    const filePath = join(secretsDir, fileName);
    const tempPath = `${filePath}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${value}\n`, "utf8");
    await chmod(tempPath, 0o600);
    await rename(tempPath, filePath);
    await this.applyRuntimeOwnership(filePath);
    return `file:${filePath}`;
  }

  private async writeManagedSecretFile(fileName: string, value: string): Promise<string> {
    try {
      await mkdir(this.paths.secretsDir, { recursive: true });
      await chmod(this.paths.secretsDir, 0o700);
      await this.applyRuntimeOwnership(this.paths.secretsDir);
      await access(this.paths.secretsDir, fsConstants.W_OK);
    } catch (error) {
      throw {
        code: "SECRET_WRITE_FAILED",
        message: "Managed secrets directory is not writable; rerun with sufficient privileges",
        retryable: false,
        details: {
          secretsDir: this.paths.secretsDir,
          error: describeError(error),
        },
      };
    }

    const filePath = join(this.paths.secretsDir, fileName);
    const tempPath = `${filePath}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${value}\n`, "utf8");
    await chmod(tempPath, 0o600);
    await rename(tempPath, filePath);
    await this.applyRuntimeOwnership(filePath);
    return `file:${filePath}`;
  }

  private async ensureSecretsDir(): Promise<string> {
    if (this.resolvedSecretsDir !== null) {
      return this.resolvedSecretsDir;
    }

    try {
      await mkdir(this.paths.secretsDir, { recursive: true });
      await chmod(this.paths.secretsDir, 0o700);
      await this.applyRuntimeOwnership(this.paths.secretsDir);
      await access(this.paths.secretsDir, fsConstants.W_OK);
      this.resolvedSecretsDir = this.paths.secretsDir;
      return this.resolvedSecretsDir;
    } catch (error) {
      const fallback = resolve(process.cwd(), ".sovereign-node-dev", "secrets");
      await mkdir(fallback, { recursive: true });
      await chmod(fallback, 0o700);
      this.logger.debug(
        {
          preferredSecretsDir: this.paths.secretsDir,
          fallbackSecretsDir: fallback,
          error: error instanceof Error ? error.message : String(error),
        },
        "Secrets dir is not writable; using local fallback for scaffold/dev execution",
      );
      this.resolvedSecretsDir = fallback;
      return fallback;
    }
  }

  private getConfiguredServiceIdentity(
    runtimeConfig?: RuntimeConfig,
  ): { user: string; group: string } {
    const envUser = process.env.SOVEREIGN_NODE_SERVICE_USER?.trim();
    const envGroup = process.env.SOVEREIGN_NODE_SERVICE_GROUP?.trim();
    const configUser = runtimeConfig?.openclaw.serviceUser?.trim();
    const configGroup = runtimeConfig?.openclaw.serviceGroup?.trim();
    const user =
      (envUser !== undefined && envUser.length > 0
        ? envUser
        : configUser !== undefined && configUser.length > 0
          ? configUser
          : DEFAULT_SERVICE_USER);
    const group =
      (envGroup !== undefined && envGroup.length > 0
        ? envGroup
        : configGroup !== undefined && configGroup.length > 0
          ? configGroup
          : user || DEFAULT_SERVICE_GROUP);
    return {
      user,
      group,
    };
  }

  private shouldPreferSystemGatewayService(runtimeConfig?: RuntimeConfig): boolean {
    if (typeof process.getuid !== "function" || process.getuid() !== 0) {
      return false;
    }
    const serviceIdentity = this.getConfiguredServiceIdentity(runtimeConfig);
    return serviceIdentity.user !== "root";
  }

  private async resolveRuntimeOwnership(): Promise<{ uid: number; gid: number } | null> {
    if (this.resolvedRuntimeOwnership !== undefined) {
      return this.resolvedRuntimeOwnership;
    }

    if (typeof process.getuid === "function" && process.getuid() !== 0) {
      this.resolvedRuntimeOwnership = null;
      return null;
    }

    const candidates = [
      this.paths.stateDir,
      this.paths.openclawServiceHome,
      this.paths.secretsDir,
      dirname(this.paths.configPath),
    ];
    for (const candidate of candidates) {
      try {
        const info = await stat(candidate);
        this.resolvedRuntimeOwnership = {
          uid: info.uid,
          gid: info.gid,
        };
        return this.resolvedRuntimeOwnership;
      } catch (error) {
        if (
          isNodeError(error)
          && (error.code === "ENOENT" || error.code === "ENOTDIR")
        ) {
          continue;
        }
      }
    }

    this.resolvedRuntimeOwnership = null;
    return null;
  }

  private async applyRuntimeOwnership(path: string): Promise<void> {
    const ownership = await this.resolveRuntimeOwnership();
    if (ownership === null) {
      return;
    }

    try {
      await chown(path, ownership.uid, ownership.gid);
    } catch (error) {
      if (
        isNodeError(error)
        && (error.code === "ENOENT" || error.code === "EPERM" || error.code === "EACCES")
      ) {
        return;
      }
      this.logger.debug(
        {
          path,
          error: describeError(error),
        },
        "Failed to apply runtime ownership to installer artifact",
      );
    }
  }
}

const dedupeStrings = (values: string[]): string[] =>
  Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));

const resolveExpectedBundledBotLocalpart = (
  operatorLocalpart: string,
  preferredLocalpart?: string,
): string => {
  const desiredLocalpart = sanitizeExpectedMatrixLocalpart(
    preferredLocalpart ?? "service-bot",
    "service-bot",
  );
  return operatorLocalpart === desiredLocalpart ? `${desiredLocalpart}-bot` : desiredLocalpart;
};

const compactBotConfigRecord = (
  value: Record<string, BotConfigValue | undefined>,
): BotConfigRecord =>
  Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, BotConfigValue] =>
        entry[1] !== undefined
        && (typeof entry[1] === "string" || typeof entry[1] === "number" || typeof entry[1] === "boolean"),
    ),
  );

const isBotConfigRecordMap = (
  value: unknown,
): value is Record<string, BotConfigRecord> => {
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).every((entry) =>
    isRecord(entry)
    && Object.values(entry).every((item) =>
      typeof item === "string" || typeof item === "number" || typeof item === "boolean"));
};

const sortInstalledTemplates = (
  entries: RuntimeConfig["templates"]["installed"],
): RuntimeConfig["templates"]["installed"] =>
  [...entries].sort((left, right) =>
    `${left.kind}:${left.id}:${left.version}`.localeCompare(
      `${right.kind}:${right.id}:${right.version}`,
    ));

const sortToolInstances = (
  entries: RuntimeConfig["sovereignTools"]["instances"],
): RuntimeConfig["sovereignTools"]["instances"] =>
  [...entries].sort((left, right) => left.id.localeCompare(right.id));
