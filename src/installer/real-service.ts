import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { CONTRACT_VERSION } from "../contracts/common.js";
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
  TestAlertRequest,
  TestImapRequest,
  TestMatrixRequest,
} from "../contracts/api.js";
import type { Logger } from "../logging/logger.js";
import type { SovereignPaths } from "../config/paths.js";
import type { OpenClawBootstrapper } from "../openclaw/bootstrap.js";
import type { OpenClawGatewayServiceManager } from "../openclaw/gateway-service.js";
import type { ImapTester } from "../system/imap.js";
import type {
  BundledMatrixAccountsResult,
  BundledMatrixProvisionResult,
  BundledMatrixProvisioner,
  BundledMatrixRoomBootstrapResult,
} from "../system/matrix.js";
import type { HostPreflightChecker } from "../system/preflight.js";
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

type RealInstallerServiceDeps = {
  openclawBootstrapper: OpenClawBootstrapper;
  openclawGatewayServiceManager: OpenClawGatewayServiceManager;
  preflightChecker: HostPreflightChecker;
  imapTester: ImapTester;
  matrixProvisioner: BundledMatrixProvisioner;
};

export class RealInstallerService implements InstallerService {
  private readonly stubService: StubInstallerService;

  private readonly jobRunner = new JobRunner();

  private resolvedInstallJobsDir: string | null = null;
  private resolvedSecretsDir: string | null = null;

  private readonly openclawBootstrapper: OpenClawBootstrapper;

  private readonly openclawGatewayServiceManager: OpenClawGatewayServiceManager;

  private readonly preflightChecker: HostPreflightChecker;

  private readonly imapTester: ImapTester;

  private readonly matrixProvisioner: BundledMatrixProvisioner;

  constructor(
    private readonly logger: Logger,
    private readonly paths: SovereignPaths,
    deps: RealInstallerServiceDeps,
  ) {
    this.stubService = new StubInstallerService(logger);
    this.openclawBootstrapper = deps.openclawBootstrapper;
    this.openclawGatewayServiceManager = deps.openclawGatewayServiceManager;
    this.preflightChecker = deps.preflightChecker;
    this.imapTester = deps.imapTester;
    this.matrixProvisioner = deps.matrixProvisioner;
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
    return this.stubService.testAlert(req);
  }

  async getStatus(): Promise<SovereignStatus> {
    return this.stubService.getStatus();
  }

  async getDoctorReport(): Promise<DoctorReport> {
    return this.stubService.getDoctorReport();
  }

  async reconfigureImap(req: ReconfigureImapRequest): Promise<ReconfigureResult> {
    return this.stubService.reconfigureImap(req);
  }

  async reconfigureMatrix(req: ReconfigureMatrixRequest): Promise<ReconfigureResult> {
    return this.stubService.reconfigureMatrix(req);
  }

  private buildInstallSteps(req: InstallRequest): InstallStep[] {
    const stepState: {
      matrixProvision?: BundledMatrixProvisionResult;
      matrixAccounts?: BundledMatrixAccountsResult;
      matrixRoom?: BundledMatrixRoomBootstrapResult;
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
          stepState.matrixAccounts = await this.matrixProvisioner.bootstrapAccounts(
            req,
            stepState.matrixProvision,
          );
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

          await this.openclawGatewayServiceManager.install({
            force: req.openclaw?.forceReinstall ?? false,
          });
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

          await this.writeSovereignConfig({
            req,
            matrixProvision: stepState.matrixProvision,
            matrixAccounts: stepState.matrixAccounts,
            matrixRoom: stepState.matrixRoom,
          });
        },
      },
      {
        id: "mail_sentinel_register",
        label: "Register Mail Sentinel agent and cron",
        run: async () => {
          throw {
            code: "NOT_IMPLEMENTED",
            message:
              "Mail Sentinel agent/cron registration is not implemented yet",
            retryable: true,
            details: {
              configPath: this.paths.configPath,
            },
          };
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

  private async writeSovereignConfig(input: {
    req: InstallRequest;
    matrixProvision: BundledMatrixProvisionResult;
    matrixAccounts: BundledMatrixAccountsResult;
    matrixRoom: BundledMatrixRoomBootstrapResult;
  }): Promise<void> {
    const imapSecretRef = await this.resolveImapSecretRef(input.req.imap);
    const operatorTokenSecretRef = await this.writeSecretFile(
      "matrix-operator-access-token",
      input.matrixAccounts.operator.accessToken,
    );
    const botTokenSecretRef = await this.writeSecretFile(
      "matrix-bot-access-token",
      input.matrixAccounts.bot.accessToken,
    );

    const configPayload = {
      contractVersion: CONTRACT_VERSION,
      mode: "bundled_matrix" as const,
      generatedAt: now(),
      openclaw: {
        managedInstallation: input.req.openclaw?.manageInstallation ?? true,
        installMethod: input.req.openclaw?.installMethod ?? "install_sh",
        serviceHome: this.paths.openclawServiceHome,
      },
      imap: {
        host: input.req.imap.host,
        port: input.req.imap.port,
        tls: input.req.imap.tls,
        username: input.req.imap.username,
        secretRef: imapSecretRef,
        mailbox: input.req.imap.mailbox ?? "INBOX",
      },
      matrix: {
        homeserverDomain: input.matrixProvision.homeserverDomain,
        publicBaseUrl: input.matrixProvision.publicBaseUrl,
        federationEnabled: input.matrixProvision.federationEnabled,
        tlsMode: input.matrixProvision.tlsMode,
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

    try {
      const configDir = dirname(this.paths.configPath);
      await mkdir(configDir, { recursive: true });
      const tempPath = `${this.paths.configPath}.${randomUUID()}.tmp`;
      await writeFile(tempPath, `${JSON.stringify(configPayload, null, 2)}\n`, "utf8");
      await chmod(tempPath, 0o600);
      await rename(tempPath, this.paths.configPath);
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
  }

  private async resolveImapSecretRef(
    imap: InstallRequest["imap"],
  ): Promise<string> {
    if (imap.secretRef !== undefined && imap.secretRef.length > 0) {
      return imap.secretRef;
    }

    if (imap.password !== undefined && imap.password.length > 0) {
      return this.writeSecretFile("imap-password", imap.password);
    }

    throw {
      code: "IMAP_SECRET_MISSING",
      message: "IMAP configuration is missing both secretRef and password",
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
    return `file:${filePath}`;
  }

  private async ensureSecretsDir(): Promise<string> {
    if (this.resolvedSecretsDir !== null) {
      return this.resolvedSecretsDir;
    }

    try {
      await mkdir(this.paths.secretsDir, { recursive: true });
      await chmod(this.paths.secretsDir, 0o700);
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
}

const now = () => new Date().toISOString();

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  typeof error === "object" && error !== null && "code" in error;
