import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, chown, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import JSON5 from "json5";

import { CONTRACT_VERSION, type CheckResult, type ComponentHealth } from "../contracts/common.js";
import {
  installJobStatusResponseSchema,
  installRequestSchema,
  type DoctorReport,
  type InstallJobStatusResponse,
  type InstallRequest,
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
import type { OpenClawBootstrapper } from "../openclaw/bootstrap.js";
import type { OpenClawGatewayServiceManager } from "../openclaw/gateway-service.js";
import type {
  MailSentinelRegistrationResult,
  OpenClawMailSentinelRegistrar,
} from "../openclaw/mail-sentinel.js";
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
import type { InstallerService } from "./service.js";
import { StubInstallerService } from "./stub-service.js";

type PersistedInstallJobRecord = {
  version: 1;
  installationId: string;
  request: InstallRequest;
  response: InstallJobStatusResponse;
  updatedAt: string;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type RuntimeConfig = {
  openrouter: {
    model: string;
    apiKeySecretRef: string;
  };
  openclaw: {
    managedInstallation: boolean;
    installMethod: "install_sh";
    requestedVersion: string;
    openclawHome: string;
    runtimeConfigPath: string;
    runtimeProfilePath: string;
    gatewayEnvPath: string;
    serviceUser?: string;
    serviceGroup?: string;
  };
  openclawProfile: {
    plugins: {
      allow: string[];
    };
    agents: Array<{
      id: string;
      workspace: string;
    }>;
    cron: {
      id: string;
      every: string;
    };
  };
  imap: {
    status: "configured" | "pending";
    host: string;
    mailbox: string;
    secretRef: string;
  };
  mailSentinel: {
    pollInterval: string;
    lookbackWindow: string;
    e2eeAlertRoom: boolean;
  };
  matrix: {
    homeserverDomain: string;
    federationEnabled: boolean;
    publicBaseUrl: string;
    adminBaseUrl: string;
    operator: {
      localpart?: string;
      userId: string;
      passwordSecretRef?: string;
      accessTokenSecretRef?: string;
    };
    bot: {
      localpart?: string;
      userId: string;
      passwordSecretRef?: string;
      accessTokenSecretRef: string;
    };
    alertRoom: {
      roomId: string;
      roomName: string;
    };
  };
};

type RealInstallerServiceDeps = {
  openclawBootstrapper: OpenClawBootstrapper;
  openclawGatewayServiceManager: OpenClawGatewayServiceManager;
  mailSentinelRegistrar: OpenClawMailSentinelRegistrar;
  preflightChecker: HostPreflightChecker;
  imapTester: ImapTester;
  matrixProvisioner: BundledMatrixProvisioner;
  execRunner?: ExecRunner;
  fetchImpl?: FetchLike;
};

type GatewayState = "running" | "stopped" | "failed" | "unknown";

const MAIL_SENTINEL_AGENT_ID = "mail-sentinel";
const MAIL_SENTINEL_CRON_ID = "mail-sentinel-poll";
const MAIL_SENTINEL_HELLO_MESSAGE = "Hello from Mail Sentinel";
const INSTALLER_EXEC_TIMEOUT_MS = 60_000;
const SOVEREIGN_GATEWAY_SYSTEMD_UNIT = "sovereign-openclaw-gateway.service";
const DEFAULT_OPENROUTER_MODEL = "openai/gpt-5-nano";
const DEFAULT_INSTALL_REQUEST_FILE = "/etc/sovereign-node/install-request.json";
const DEFAULT_SERVICE_USER = "root";
const DEFAULT_SERVICE_GROUP = "root";

export class RealInstallerService implements InstallerService {
  private readonly stubService: StubInstallerService;

  private readonly jobRunner = new JobRunner();

  private resolvedInstallJobsDir: string | null = null;
  private resolvedSecretsDir: string | null = null;
  private resolvedRuntimeOwnership: { uid: number; gid: number } | null | undefined = undefined;
  private managedOpenClawEnv: Record<string, string> | null | undefined = undefined;

  private readonly openclawBootstrapper: OpenClawBootstrapper;

  private readonly openclawGatewayServiceManager: OpenClawGatewayServiceManager;

  private readonly mailSentinelRegistrar: OpenClawMailSentinelRegistrar;

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
    this.mailSentinelRegistrar = deps.mailSentinelRegistrar;
    this.preflightChecker = deps.preflightChecker;
    this.imapTester = deps.imapTester;
    this.matrixProvisioner = deps.matrixProvisioner;
    this.execRunner = deps.execRunner ?? null;
    this.fetchImpl = deps.fetchImpl ?? defaultFetch;
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
    const expectedAgentId =
      runtimeConfig?.openclawProfile.agents[0]?.id ?? MAIL_SENTINEL_AGENT_ID;
    const expectedCronId = runtimeConfig?.openclawProfile.cron.id ?? MAIL_SENTINEL_CRON_ID;
    const registration = await this.tryReadMailSentinelRegistration();
    const expectedFromRegistrationAgent = registration?.agentId;
    const expectedFromRegistrationCron = registration?.cronJobId;

    const gateway = await this.inspectGatewayService();
    const healthProbe = await this.probeOpenClawHealth();
    const agentProbe = await this.inspectOpenClawListContains(
      ["agents", "list"],
      expectedFromRegistrationAgent ?? expectedAgentId,
    );
    const cronProbe = await this.inspectOpenClawListContains(
      ["cron", "list"],
      expectedFromRegistrationCron ?? expectedCronId,
    );
    const matrixStatus = await this.inspectMatrixStatus(runtimeConfig);

    const cliInstalled = detectedOpenClaw !== null;
    const managedBySovereign = runtimeConfig?.openclaw.managedInstallation ?? true;
    const pluginIds = runtimeConfig?.openclawProfile.plugins.allow;
    const openclawHealth = deriveOpenClawHealth({
      cliInstalled,
      gatewayState: gateway.state,
      healthProbeOk: healthProbe.ok,
      agentPresent: agentProbe.present || registration?.agentId !== undefined,
      cronPresent: cronProbe.present || registration?.cronJobId !== undefined,
    });
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
      ],
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
        agentPresent: agentProbe.present || registration?.agentId !== undefined,
        cronPresent: cronProbe.present || registration?.cronJobId !== undefined,
        ...(pluginIds === undefined ? {} : { pluginIds }),
      },
      mailSentinel: {
        agentId: (registration?.agentId as "mail-sentinel") ?? MAIL_SENTINEL_AGENT_ID,
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
    const healthProbe = await this.probeOpenClawHealth();
    const expectedAgentId =
      runtimeConfig?.openclawProfile.agents[0]?.id ?? MAIL_SENTINEL_AGENT_ID;
    const expectedCronId = runtimeConfig?.openclawProfile.cron.id ?? MAIL_SENTINEL_CRON_ID;
    const agentProbe = await this.inspectOpenClawListContains(
      ["agents", "list"],
      expectedAgentId,
    );
    const cronProbe = await this.inspectOpenClawListContains(
      ["cron", "list"],
      expectedCronId,
    );
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

    checks.push(wiringCheck);

    checks.push(
      check(
        "mail-sentinel-registration",
        "Mail Sentinel agent/cron registration",
        agentProbe.verified && cronProbe.verified
          ? agentProbe.present && cronProbe.present
            ? "pass"
            : "fail"
          : "warn",
        agentProbe.verified && cronProbe.verified
          ? agentProbe.present && cronProbe.present
            ? "Mail Sentinel agent and cron entries are present in OpenClaw"
            : "Mail Sentinel agent and/or cron entries are missing in OpenClaw"
          : "Could not fully verify Mail Sentinel registration via OpenClaw CLI",
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
        agentPresent: agentProbe.present,
        cronPresent: cronProbe.present,
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
    const expectedBotLocalpart =
      expectedOperatorLocalpart === "mail-sentinel" ? "mail-sentinel-bot" : "mail-sentinel";
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
    return this.matrixProvisioner.bootstrapAccounts(input.req, input.provision);
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
    const probe = await this.safeExec("openclaw", ["health"]);
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
      const probe = await this.safeExec("openclaw", args);
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

    try {
      const result = await this.execRunner.run({
        command,
        args,
        options: {
          timeout: INSTALLER_EXEC_TIMEOUT_MS,
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
    return {
      OPENCLAW_HOME: runtimeConfig.openclaw.openclawHome,
      OPENCLAW_CONFIG: runtimeConfig.openclaw.runtimeConfigPath,
      OPENCLAW_CONFIG_PATH: runtimeConfig.openclaw.runtimeConfigPath,
      SOVEREIGN_NODE_CONFIG: this.paths.configPath,
    };
  }

  private setManagedOpenClawEnv(runtimeConfig: RuntimeConfig): void {
    const env = this.buildManagedOpenClawEnv(runtimeConfig);
    this.managedOpenClawEnv = env;
    for (const [key, value] of Object.entries(env)) {
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

  private buildInstallSteps(req: InstallRequest): InstallStep[] {
    const stepState: {
      matrixProvision?: BundledMatrixProvisionResult;
      matrixAccounts?: BundledMatrixAccountsResult;
      matrixRoom?: BundledMatrixRoomBootstrapResult;
      mailSentinelRegistration?: MailSentinelRegistrationResult;
      gatewayServiceSkipped?: boolean;
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
            version: openclaw?.version ?? "pinned-by-sovereign",
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
        id: "matrix_provision",
        label: "Provision bundled Matrix stack",
        run: async () => {
          stepState.matrixProvision = await this.matrixProvisioner.provision(req);
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
          try {
            stepState.matrixAccounts = await this.matrixProvisioner.bootstrapAccounts(
              req,
              stepState.matrixProvision,
            );
          } catch (error) {
            const reusedAccounts = await this.tryReuseExistingMatrixAccounts({
              req,
              provision: stepState.matrixProvision,
              error,
            });
            if (reusedAccounts !== null) {
              stepState.matrixAccounts = reusedAccounts;
              return;
            }

            const resetAccounts = await this.tryRecoverRateLimitedMatrixReconfigure({
              req,
              provision: stepState.matrixProvision,
              error,
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
            req,
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

          const runtimeConfig = await this.writeSovereignConfig({
            req,
            matrixProvision: stepState.matrixProvision,
            matrixAccounts: stepState.matrixAccounts,
            matrixRoom: stepState.matrixRoom,
          });
          await this.writeOpenClawRuntimeArtifacts(runtimeConfig);
          this.setManagedOpenClawEnv(runtimeConfig);

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
        id: "mail_sentinel_register",
        label: "Register Mail Sentinel agent and cron",
        run: async () => {
          if (stepState.matrixRoom === undefined) {
            throw {
              code: "INSTALL_INTERNAL_STATE",
              message: "Matrix room output is missing before Mail Sentinel registration",
              retryable: false,
            };
          }
          stepState.mailSentinelRegistration = await this.registerMailSentinel(
            req,
            stepState.matrixRoom,
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
            stepState.mailSentinelRegistration?.agentId ?? MAIL_SENTINEL_AGENT_ID,
            stepState.mailSentinelRegistration?.cronJobId ?? MAIL_SENTINEL_CRON_ID,
            stepState.gatewayServiceSkipped ?? false,
          );
        },
      },
      {
        id: "test_alert",
        label: "Send hello alert",
        run: async () => {
          const testAlert = await this.testAlert({
            channel: "matrix",
            text: MAIL_SENTINEL_HELLO_MESSAGE,
          });
          if (!testAlert.delivered) {
            throw {
              code: testAlert.error?.code ?? "TEST_ALERT_FAILED",
              message: testAlert.error?.message ?? "Test alert delivery failed",
              retryable: testAlert.error?.retryable ?? true,
              ...(testAlert.error?.details === undefined
                ? {}
                : { details: testAlert.error.details }),
            };
          }
        },
      },
    ];
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

  private async registerMailSentinel(
    req: InstallRequest,
    matrixRoom: BundledMatrixRoomBootstrapResult,
    options?: {
      allowGatewayUnavailableFallback?: boolean;
    },
  ): Promise<MailSentinelRegistrationResult> {
    const registrationDir = join(this.paths.stateDir, "mail-sentinel");
    const workspaceDir = join(registrationDir, "workspace");
    const registrationFile = join(registrationDir, "registration.json");
    const pollInterval = req.mailSentinel?.pollInterval ?? "5m";
    const lookbackWindow = req.mailSentinel?.lookbackWindow ?? "15m";
    const agentId = "mail-sentinel";
    const cronJobId = "mail-sentinel-poll";

    try {
      await mkdir(registrationDir, { recursive: true });
      await mkdir(workspaceDir, { recursive: true });
      const readmePath = join(workspaceDir, "README.md");
      const readme = [
        "# Mail Sentinel workspace",
        "",
        "Provisioned by sovereign-node install flow.",
        "Managed by Sovereign Node installer.",
      ].join("\n");
      await writeFile(readmePath, `${readme}\n`, "utf8");
      await this.applyRuntimeOwnership(registrationDir);
      await this.applyRuntimeOwnership(workspaceDir);
      await this.applyRuntimeOwnership(readmePath);
    } catch (error) {
      throw {
        code: "MAIL_SENTINEL_REGISTER_FAILED",
        message: "Failed to persist Mail Sentinel registration artifacts",
        retryable: true,
        details: {
          registrationDir,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }

    let registration: MailSentinelRegistrationResult;
    let deferredReason: string | undefined;
    try {
      registration = await this.mailSentinelRegistrar.register({
        agentId,
        workspaceDir,
        cronJobName: cronJobId,
        pollInterval,
        lookbackWindow,
        roomId: matrixRoom.roomId,
      });
    } catch (error) {
      if (
        options?.allowGatewayUnavailableFallback !== true
        || !isMailSentinelGatewayUnavailableError(error)
      ) {
        throw error;
      }

      deferredReason = describeError(error);
      this.logger.warn(
        {
          error: deferredReason,
        },
        "Mail Sentinel cron registration deferred because OpenClaw gateway is unavailable",
      );
      registration = {
        agentId,
        cronJobId,
        workspaceDir,
        agentCommand: "deferred: gateway unavailable",
        cronCommand: "deferred: gateway unavailable",
      };
    }

    await this.persistMailSentinelRegistrationRecord({
      registrationFile,
      registration,
      pollInterval,
      lookbackWindow,
      roomId: matrixRoom.roomId,
      roomName: matrixRoom.roomName,
      ...(deferredReason === undefined ? {} : { deferredReason }),
    });

    return registration;
  }

  private async persistMailSentinelRegistrationRecord(input: {
    registrationFile: string;
    registration: MailSentinelRegistrationResult;
    pollInterval: string;
    lookbackWindow: string;
    roomId: string;
    roomName: string;
    deferredReason?: string;
  }): Promise<void> {
    const registrationPayload = {
      agentId: input.registration.agentId,
      cronJobId: input.registration.cronJobId,
      pollInterval: input.pollInterval,
      lookbackWindow: input.lookbackWindow,
      roomId: input.roomId,
      roomName: input.roomName,
      configPath: this.paths.configPath,
      agentCommand: input.registration.agentCommand,
      cronCommand: input.registration.cronCommand,
      registeredAt: now(),
      ...(input.deferredReason === undefined
        ? {}
        : {
            deferred: true,
            deferredReason: input.deferredReason,
          }),
    };

    try {
      await writeFile(input.registrationFile, `${JSON.stringify(registrationPayload, null, 2)}\n`, "utf8");
      await this.applyRuntimeOwnership(input.registrationFile);
    } catch (error) {
      throw {
        code: "MAIL_SENTINEL_REGISTER_FAILED",
        message: "Failed to persist Mail Sentinel registration record",
        retryable: true,
        details: {
          registrationFile: input.registrationFile,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private async ensureSystemGatewayServiceFallback(runtimeConfig: RuntimeConfig): Promise<boolean> {
    if (this.execRunner === null) {
      return false;
    }

    const serviceIdentity = this.getConfiguredServiceIdentity(runtimeConfig);
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
      await this.applyRuntimeOwnership(this.paths.openclawServiceHome);
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
    expectedAgentId: string,
    expectedCronJobId: string,
    gatewayServiceSkipped: boolean,
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

    const runtimeConfig = await this.readRuntimeConfig();
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

      const agentProbe = await this.inspectOpenClawListContains(["agents", "list"], expectedAgentId);
      if (agentProbe.verified && !agentProbe.present) {
        throw {
          code: "SMOKE_CHECKS_FAILED",
          message: "Mail Sentinel agent is missing from OpenClaw runtime",
          retryable: true,
          details: {
            agentId: expectedAgentId,
          },
        };
      }

      const cronProbe = await this.inspectOpenClawListContains(["cron", "list"], expectedCronJobId);
      if (cronProbe.verified && !cronProbe.present) {
        throw {
          code: "SMOKE_CHECKS_FAILED",
          message: "Mail Sentinel cron job is missing from OpenClaw runtime",
          retryable: true,
          details: {
            cronJobId: expectedCronJobId,
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
    const serviceIdentity = this.getConfiguredServiceIdentity();
    const openclawPaths = this.getOpenClawRuntimePaths();
    const runtimeConfig: RuntimeConfig = {
      openclaw: {
        managedInstallation: input.req.openclaw?.manageInstallation ?? true,
        installMethod: input.req.openclaw?.installMethod ?? "install_sh",
        requestedVersion: input.req.openclaw?.version ?? "pinned-by-sovereign",
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
          allow: imapConfig.status === "configured" ? ["matrix", "imap-readonly"] : ["matrix"],
        },
        agents: [
          {
            id: MAIL_SENTINEL_AGENT_ID,
            workspace: join(this.paths.stateDir, MAIL_SENTINEL_AGENT_ID, "workspace"),
          },
        ],
        cron: {
          id: MAIL_SENTINEL_CRON_ID,
          every: input.req.mailSentinel?.pollInterval ?? "5m",
        },
      },
      imap: {
        status: imapConfig.status,
        host: imapConfig.host,
        mailbox: imapConfig.mailbox,
        secretRef: imapConfig.secretRef,
      },
      matrix: {
        homeserverDomain: input.matrixProvision.homeserverDomain,
        federationEnabled: input.matrixProvision.federationEnabled,
        publicBaseUrl: input.matrixProvision.publicBaseUrl,
        adminBaseUrl: input.matrixProvision.adminBaseUrl,
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
      },
      mailSentinel: {
        pollInterval: input.req.mailSentinel?.pollInterval ?? "5m",
        lookbackWindow: input.req.mailSentinel?.lookbackWindow ?? "15m",
        e2eeAlertRoom: input.req.mailSentinel?.e2eeAlertRoom ?? false,
      },
    };

    const configPayload = {
      contractVersion: CONTRACT_VERSION,
      mode: "bundled_matrix" as const,
      generatedAt: now(),
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
        cron: {
          id: runtimeConfig.openclawProfile.cron.id,
          every: runtimeConfig.openclawProfile.cron.every,
        },
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
              port: input.req.imap.port,
              tls: input.req.imap.tls,
              username: input.req.imap.username,
              secretRef: runtimeConfig.imap.secretRef,
              mailbox: runtimeConfig.imap.mailbox,
            }
          : {
              status: "pending",
              mailbox: runtimeConfig.imap.mailbox,
            },
      matrix: {
        homeserverDomain: input.matrixProvision.homeserverDomain,
        publicBaseUrl: runtimeConfig.matrix.publicBaseUrl,
        adminBaseUrl: runtimeConfig.matrix.adminBaseUrl,
        federationEnabled: runtimeConfig.matrix.federationEnabled,
        tlsMode: input.matrixProvision.tlsMode,
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
      mailSentinel: {
        pollInterval: runtimeConfig.mailSentinel.pollInterval,
        lookbackWindow: runtimeConfig.mailSentinel.lookbackWindow,
        e2eeAlertRoom: runtimeConfig.mailSentinel.e2eeAlertRoom,
      },
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
    const openclawPaths = this.getOpenClawRuntimePaths();
    const openrouterApiKey = await this.resolveSecretRef(runtimeConfig.openrouter.apiKeySecretRef);
    const imapConfigured = runtimeConfig.imap.status === "configured";
    const pluginEntries: Record<string, unknown> = {
      matrix: {
        enabled: true,
      },
    };
    if (imapConfigured) {
      pluginEntries["imap-readonly"] = {
        enabled: true,
        config: {
          account: {
            host: runtimeConfig.imap.host,
            mailbox: runtimeConfig.imap.mailbox,
            secretRef: runtimeConfig.imap.secretRef,
          },
        },
      };
    }

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
          dm: {
            policy: "disabled" as const,
          },
          groupPolicy: "allowlist" as const,
          groups: {
            [runtimeConfig.matrix.alertRoom.roomId]: {
              enabled: true,
              autoReply: false,
            },
          },
        },
      },
      agents: {
        defaults: {
          model: runtimeConfig.openrouter.model,
        },
        list: [
          {
            id: runtimeConfig.openclawProfile.agents[0]?.id ?? MAIL_SENTINEL_AGENT_ID,
            workspace:
              runtimeConfig.openclawProfile.agents[0]?.workspace
              ?? join(this.paths.stateDir, MAIL_SENTINEL_AGENT_ID, "workspace"),
          },
        ],
      },
      cron: {
        enabled: true,
      },
    };

    const profilePayload = {
      generatedAt: now(),
      source: "sovereign-node",
      openclawProfile: runtimeConfig.openclawProfile,
      mailSentinel: runtimeConfig.mailSentinel,
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

    try {
      await mkdir(this.paths.openclawServiceHome, { recursive: true });
      await mkdir(runtimeConfig.openclaw.openclawHome, { recursive: true });
      await mkdir(dirname(runtimeConfig.openclaw.runtimeProfilePath), { recursive: true });
      await this.applyRuntimeOwnership(this.paths.openclawServiceHome);
      await this.applyRuntimeOwnership(runtimeConfig.openclaw.openclawHome);
      await this.applyRuntimeOwnership(dirname(runtimeConfig.openclaw.runtimeProfilePath));
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
        mailbox: "INBOX",
        secretRef: "env:SOVEREIGN_IMAP_SECRET_UNSET",
      };
    }

    if (imap.secretRef !== undefined && imap.secretRef.length > 0) {
      return {
        status: "configured",
        host: imap.host,
        mailbox: imap.mailbox ?? "INBOX",
        secretRef: imap.secretRef,
      };
    }

    if (imap.password !== undefined && imap.password.length > 0) {
      return {
        status: "configured",
        host: imap.host,
        mailbox: imap.mailbox ?? "INBOX",
        secretRef: await this.writeSecretFile("imap-password", imap.password),
      };
    }

    return {
      status: "pending",
      host: imap.host,
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

const now = () => new Date().toISOString();

const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

const ensureTrailingSlash = (value: string): string =>
  value.endsWith("/") ? value : `${value}/`;

const parseJsonSafely = (raw: string): unknown => {
  if (raw.trim().length === 0) {
    return {};
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
};

const parseJsonDocument = (raw: string): unknown => {
  if (raw.trim().length === 0) {
    return {};
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    try {
      return JSON5.parse(raw) as unknown;
    } catch {
      return raw;
    }
  }
};

const parseRuntimeConfigDocument = (raw: string): RuntimeConfig | null => {
  const parsed = parseJsonDocument(raw);
  if (!isRecord(parsed)) {
    return null;
  }

  const matrix = parsed.matrix;
  if (!isRecord(matrix)) {
    return null;
  }
  const bot = matrix.bot;
  const alertRoom = matrix.alertRoom;
  const adminBaseUrl =
    typeof matrix.adminBaseUrl === "string" && matrix.adminBaseUrl.length > 0
      ? matrix.adminBaseUrl
      : matrix.publicBaseUrl;
  if (
    typeof matrix.publicBaseUrl !== "string"
    || matrix.publicBaseUrl.length === 0
    || typeof adminBaseUrl !== "string"
    || adminBaseUrl.length === 0
    || !isRecord(bot)
    || typeof bot.accessTokenSecretRef !== "string"
    || bot.accessTokenSecretRef.length === 0
    || !isRecord(alertRoom)
    || typeof alertRoom.roomId !== "string"
    || alertRoom.roomId.length === 0
  ) {
    return null;
  }

  const openclaw = isRecord(parsed.openclaw) ? parsed.openclaw : {};
  const openclawServiceHome =
    typeof openclaw.serviceHome === "string" && openclaw.serviceHome.length > 0
      ? openclaw.serviceHome
      : "/var/lib/sovereign-node/openclaw-home";
  const openclawHome =
    typeof openclaw.openclawHome === "string" && openclaw.openclawHome.length > 0
      ? openclaw.openclawHome
      : join(openclawServiceHome, ".openclaw");
  const runtimeConfigPath =
    typeof openclaw.runtimeConfigPath === "string" && openclaw.runtimeConfigPath.length > 0
      ? openclaw.runtimeConfigPath
      : join(openclawHome, "openclaw.json5");
  const runtimeProfilePath =
    typeof openclaw.runtimeProfilePath === "string" && openclaw.runtimeProfilePath.length > 0
      ? openclaw.runtimeProfilePath
      : join(openclawServiceHome, "profiles", "sovereign-runtime-profile.json5");
  const gatewayEnvPath =
    typeof openclaw.gatewayEnvPath === "string" && openclaw.gatewayEnvPath.length > 0
      ? openclaw.gatewayEnvPath
      : join(openclawServiceHome, "gateway.env");
  const serviceUser =
    typeof openclaw.serviceUser === "string" && openclaw.serviceUser.length > 0
      ? openclaw.serviceUser
      : undefined;
  const serviceGroup =
    typeof openclaw.serviceGroup === "string" && openclaw.serviceGroup.length > 0
      ? openclaw.serviceGroup
      : undefined;
  const openclawProfile = isRecord(parsed.openclawProfile) ? parsed.openclawProfile : {};
  const openclawPlugins = isRecord(openclawProfile.plugins) ? openclawProfile.plugins : {};
  const openclawAgents = Array.isArray(openclawProfile.agents)
    ? openclawProfile.agents
        .filter(
          (agent): agent is { id: string; workspace: string } =>
            isRecord(agent)
            && typeof agent.id === "string"
            && agent.id.length > 0
            && typeof agent.workspace === "string"
            && agent.workspace.length > 0,
        )
    : [
        {
          id: MAIL_SENTINEL_AGENT_ID,
          workspace: join("/var/lib/sovereign-node", MAIL_SENTINEL_AGENT_ID, "workspace"),
        },
      ];
  const openclawCron = isRecord(openclawProfile.cron) ? openclawProfile.cron : {};
  const openrouter = isRecord(parsed.openrouter) ? parsed.openrouter : {};
  const imap = isRecord(parsed.imap) ? parsed.imap : {};
  const mailSentinel = isRecord(parsed.mailSentinel) ? parsed.mailSentinel : {};
  const operator = isRecord(matrix.operator) ? matrix.operator : {};
  const homeserverDomain =
    typeof matrix.homeserverDomain === "string" && matrix.homeserverDomain.length > 0
      ? matrix.homeserverDomain
      : inferMatrixHomeserverDomain(matrix.publicBaseUrl);
  const inferredImapConfigured =
    typeof imap.host === "string"
    && imap.host.length > 0
    && imap.host !== "pending"
    && typeof imap.secretRef === "string"
    && imap.secretRef.length > 0;

  return {
    openclaw: {
      managedInstallation:
        typeof openclaw.managedInstallation === "boolean" ? openclaw.managedInstallation : true,
      installMethod:
        openclaw.installMethod === "install_sh" ? openclaw.installMethod : "install_sh",
      requestedVersion:
        typeof openclaw.requestedVersion === "string" && openclaw.requestedVersion.length > 0
          ? openclaw.requestedVersion
          : "pinned-by-sovereign",
      openclawHome,
      runtimeConfigPath,
      runtimeProfilePath,
      gatewayEnvPath,
      ...(serviceUser === undefined ? {} : { serviceUser }),
      ...(serviceGroup === undefined ? {} : { serviceGroup }),
    },
    openrouter: {
      model:
        typeof openrouter.model === "string" && openrouter.model.length > 0
          ? openrouter.model
          : DEFAULT_OPENROUTER_MODEL,
      apiKeySecretRef:
        typeof openrouter.apiKeySecretRef === "string" && openrouter.apiKeySecretRef.length > 0
          ? openrouter.apiKeySecretRef
          : "env:OPENROUTER_API_KEY",
    },
    openclawProfile: {
      plugins: {
        allow: Array.isArray(openclawPlugins.allow)
          ? openclawPlugins.allow.filter(
              (entry): entry is string => typeof entry === "string" && entry.length > 0,
            )
          : ["matrix"],
      },
      agents: openclawAgents,
      cron: {
        id:
          typeof openclawCron.id === "string" && openclawCron.id.length > 0
            ? openclawCron.id
            : MAIL_SENTINEL_CRON_ID,
        every:
          typeof openclawCron.every === "string" && openclawCron.every.length > 0
            ? openclawCron.every
            : "5m",
      },
    },
    imap: {
      status:
        imap.status === "configured" || imap.status === "pending"
          ? imap.status
          : inferredImapConfigured
            ? "configured"
            : "pending",
      host: typeof imap.host === "string" && imap.host.length > 0 ? imap.host : "unknown",
      mailbox:
        typeof imap.mailbox === "string" && imap.mailbox.length > 0 ? imap.mailbox : "INBOX",
      secretRef:
        typeof imap.secretRef === "string" && imap.secretRef.length > 0
          ? imap.secretRef
          : "env:SOVEREIGN_IMAP_SECRET_UNSET",
    },
    matrix: {
      homeserverDomain,
      federationEnabled:
        typeof matrix.federationEnabled === "boolean" ? matrix.federationEnabled : false,
      publicBaseUrl: matrix.publicBaseUrl,
      adminBaseUrl,
      operator: {
        localpart:
          typeof operator.localpart === "string" && operator.localpart.length > 0
            ? operator.localpart
            : undefined,
        userId:
          typeof operator.userId === "string" && operator.userId.length > 0
            ? operator.userId
            : "@operator:local",
        passwordSecretRef:
          typeof operator.passwordSecretRef === "string" && operator.passwordSecretRef.length > 0
            ? operator.passwordSecretRef
            : undefined,
        accessTokenSecretRef:
          typeof operator.accessTokenSecretRef === "string"
          && operator.accessTokenSecretRef.length > 0
            ? operator.accessTokenSecretRef
            : undefined,
      },
      bot: {
        localpart:
          typeof bot.localpart === "string" && bot.localpart.length > 0 ? bot.localpart : undefined,
        userId:
          typeof bot.userId === "string" && bot.userId.length > 0
            ? bot.userId
            : "@mail-sentinel:local",
        passwordSecretRef:
          typeof bot.passwordSecretRef === "string" && bot.passwordSecretRef.length > 0
            ? bot.passwordSecretRef
            : undefined,
        accessTokenSecretRef: bot.accessTokenSecretRef,
      },
      alertRoom: {
        roomId: alertRoom.roomId,
        roomName:
          typeof alertRoom.roomName === "string" && alertRoom.roomName.length > 0
            ? alertRoom.roomName
            : "Sovereign Alerts",
      },
    },
    mailSentinel: {
      pollInterval:
        typeof mailSentinel.pollInterval === "string" && mailSentinel.pollInterval.length > 0
          ? mailSentinel.pollInterval
          : "5m",
      lookbackWindow:
        typeof mailSentinel.lookbackWindow === "string" && mailSentinel.lookbackWindow.length > 0
          ? mailSentinel.lookbackWindow
          : "15m",
      e2eeAlertRoom:
        typeof mailSentinel.e2eeAlertRoom === "boolean" ? mailSentinel.e2eeAlertRoom : false,
    },
  };
};

const inferMatrixHomeserverDomain = (publicBaseUrl: string): string => {
  try {
    return new URL(publicBaseUrl).hostname;
  } catch {
    return "unknown";
  }
};

const sanitizeExpectedMatrixLocalpart = (value: string, fallback: string): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._=+\-/]/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : fallback;
};

const isRateLimitedMatrixLoginFailure = (error: unknown): boolean => {
  if (!isStructuredError(error) || error.code !== "MATRIX_LOGIN_FAILED" || !isRecord(error.details)) {
    return false;
  }
  if (error.details.status === 429) {
    return true;
  }
  return (
    typeof error.details.body === "string"
    && /m_limit_exceeded|too many requests/i.test(error.details.body)
  );
};

const check = (
  id: string,
  name: string,
  status: CheckResult["status"],
  message: string,
  details?: Record<string, unknown>,
): CheckResult => ({
  id,
  name,
  status,
  message,
  ...(details === undefined ? {} : { details }),
});

const summarizeChecksOverall = (checks: CheckResult[]): DoctorReport["overall"] => {
  if (checks.some((entry) => entry.status === "fail")) {
    return "fail";
  }
  if (checks.some((entry) => entry.status === "warn")) {
    return "warn";
  }
  return "pass";
};

const mapHealthToServiceState = (
  health: ComponentHealth,
): "running" | "stopped" | "failed" | "unknown" => {
  if (health === "healthy" || health === "degraded") {
    return "running";
  }
  if (health === "unhealthy") {
    return "failed";
  }
  return "unknown";
};

const deriveOpenClawHealth = (input: {
  cliInstalled: boolean;
  gatewayState: GatewayState;
  healthProbeOk: boolean;
  agentPresent: boolean;
  cronPresent: boolean;
}): ComponentHealth => {
  if (!input.cliInstalled || input.gatewayState === "failed") {
    return "unhealthy";
  }
  if (input.gatewayState !== "running" || !input.healthProbeOk) {
    return "degraded";
  }
  if (!input.agentPresent || !input.cronPresent) {
    return "degraded";
  }
  return "healthy";
};

const parseGatewayState = (value: string): GatewayState => {
  const normalized = value.toLowerCase();
  if (/running|active/.test(normalized)) {
    return "running";
  }
  if (/inactive|stopped|dead/.test(normalized)) {
    return "stopped";
  }
  if (/failed|error/.test(normalized)) {
    return "failed";
  }
  return "unknown";
};

const looksLikeMissingGateway = (value: string): boolean =>
  /not\s+installed|not-found|could not be found|unknown command|no such/i.test(value);

const textContainsId = (value: string, id: string): boolean => {
  if (id.length === 0) {
    return false;
  }
  const escaped = escapeRegExp(id);
  const regex = new RegExp(`(^|[^A-Za-z0-9_\\-])${escaped}([^A-Za-z0-9_\\-]|$)`);
  return regex.test(value);
};

const escapeRegExp = (value: string): string =>
  value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

const parseEnvFile = (raw: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const index = trimmed.indexOf("=");
    if (index <= 0) {
      continue;
    }
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (key.length > 0) {
      out[key] = value;
    }
  }
  return out;
};

const summarizeText = (value: string, maxChars = 400): string =>
  truncateText(value.replace(/\s+/g, " ").trim(), maxChars);

const isMissingBinaryError = (value: string): boolean =>
  /command not found|no such file or directory|enoent/i.test(value);

const isGatewayUserSystemdUnavailableError = (error: unknown): boolean => {
  const messages: string[] = [];
  let gatewayCommandFailure = false;

  if (error instanceof Error) {
    messages.push(error.message);
  }

  if (isRecord(error)) {
    if (typeof error.code === "string") {
      gatewayCommandFailure =
        error.code === "OPENCLAW_GATEWAY_INSTALL_FAILED"
        || error.code === "OPENCLAW_GATEWAY_START_FAILED"
        || error.code === "OPENCLAW_GATEWAY_RESTART_FAILED";
    }

    if (typeof error.message === "string") {
      messages.push(error.message);
    }

    if (isRecord(error.details)) {
      if (typeof error.details.stderr === "string") {
        messages.push(error.details.stderr);
      }
      if (typeof error.details.stdout === "string") {
        messages.push(error.details.stdout);
      }
    }
  }

  const combined = messages.join("\n");
  if (!gatewayCommandFailure) {
    return false;
  }

  return /systemctl --user unavailable|failed to connect to bus|no medium found/i.test(
    combined,
  );
};

const isMailSentinelGatewayUnavailableError = (error: unknown): boolean => {
  if (!isRecord(error) || error.code !== "MAIL_SENTINEL_REGISTER_FAILED") {
    return false;
  }

  const messages: string[] = [];
  if (typeof error.message === "string") {
    messages.push(error.message);
  }
  if (isRecord(error.details)) {
    const failures = error.details.failures;
    if (Array.isArray(failures)) {
      for (const failure of failures) {
        if (!isRecord(failure)) {
          continue;
        }
        if (typeof failure.stderr === "string") {
          messages.push(failure.stderr);
        }
        if (typeof failure.stdout === "string") {
          messages.push(failure.stdout);
        }
      }
    }
  }

  const combined = messages.join("\n");
  return /gateway closed|failed to connect|connection refused|econnrefused|no medium found/i.test(
    combined,
  );
};

const resolveVersionPinStatus = (
  runtimeConfig: RuntimeConfig | null,
  detectedOpenClaw: { version: string } | null,
): CheckResult["status"] => {
  if (detectedOpenClaw === null) {
    return "fail";
  }
  if (runtimeConfig === null) {
    return "warn";
  }

  const expected = runtimeConfig.openclaw.requestedVersion;
  if (expected === "pinned-by-sovereign") {
    return "warn";
  }
  return normalizeVersionToken(expected) === normalizeVersionToken(detectedOpenClaw.version)
    ? "pass"
    : "fail";
};

const describeVersionPin = (
  runtimeConfig: RuntimeConfig | null,
  detectedOpenClaw: { version: string } | null,
): string => {
  if (detectedOpenClaw === null) {
    return "OpenClaw version cannot be validated because CLI is missing";
  }
  if (runtimeConfig === null) {
    return "Sovereign runtime config is missing, so version pin cannot be validated";
  }

  const expected = runtimeConfig.openclaw.requestedVersion;
  if (expected === "pinned-by-sovereign") {
    return "Configured OpenClaw version is abstract (pinned-by-sovereign); exact pin comparison skipped";
  }

  if (normalizeVersionToken(expected) === normalizeVersionToken(detectedOpenClaw.version)) {
    return "OpenClaw version matches configured pin";
  }
  return "OpenClaw version does not match configured pin";
};

const normalizeVersionToken = (value: string): string => {
  const match = value.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
  return (match?.[0] ?? value).trim().toLowerCase();
};

const buildSuggestedCommands = (input: {
  runtimeConfig: RuntimeConfig | null;
  gateway: { installed: boolean; state: GatewayState };
  healthProbe: { ok: boolean };
  cliDetected: boolean;
  agentPresent: boolean;
  cronPresent: boolean;
  wiringCheck: CheckResult;
}): string[] => {
  const commands: string[] = [];
  if (!input.cliDetected) {
    commands.push(
      "curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --version <pinned-version> --no-onboard --no-prompt",
    );
  }
  if (!input.gateway.installed) {
    commands.push("openclaw gateway install --force");
  }
  if (input.gateway.state !== "running" || !input.healthProbe.ok) {
    commands.push("openclaw gateway restart");
    commands.push("openclaw health");
  }
  if (input.wiringCheck.status !== "pass") {
    const runtimeConfigPath =
      input.runtimeConfig?.openclaw.runtimeConfigPath
      ?? "/var/lib/sovereign-node/openclaw-home/.openclaw/openclaw.json5";
    commands.push(`ls -l ${runtimeConfigPath}`);
  }
  if (!input.agentPresent || !input.cronPresent) {
    commands.push("openclaw agents list");
    commands.push("openclaw cron list");
  }
  commands.push("sovereign-node doctor --json");
  return Array.from(new Set(commands));
};

const summarizeUnknown = (value: unknown): string => {
  if (typeof value === "string") {
    return truncateText(value, 800);
  }
  try {
    return truncateText(JSON.stringify(value), 800);
  } catch {
    return truncateText(String(value), 800);
  }
};

const truncateText = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}...(truncated)`;
};

const delay = async (ms: number): Promise<void> => {
  await new Promise<void>((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
};

const describeError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
};

const stripSingleTrailingNewline = (value: string): string =>
  value.endsWith("\r\n")
    ? value.slice(0, -2)
    : value.endsWith("\n")
      ? value.slice(0, -1)
      : value;

const normalizeTestAlertError = (error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
} => {
  if (isStructuredError(error)) {
    return error;
  }

  if (error instanceof Error) {
    return {
      code: "TEST_ALERT_FAILED",
      message: error.message,
      retryable: true,
    };
  }

  return {
    code: "TEST_ALERT_FAILED",
    message: String(error),
    retryable: true,
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isStructuredError = (
  value: unknown,
): value is {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
} => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.code === "string"
    && typeof value.message === "string"
    && typeof value.retryable === "boolean"
  );
};

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  typeof error === "object" && error !== null && "code" in error;
