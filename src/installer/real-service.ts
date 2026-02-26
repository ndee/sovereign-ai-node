import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

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

export class RealInstallerService implements InstallerService {
  private readonly stubService: StubInstallerService;

  private readonly jobRunner = new JobRunner();

  private resolvedInstallJobsDir: string | null = null;

  constructor(
    private readonly logger: Logger,
    private readonly paths: SovereignPaths,
  ) {
    this.stubService = new StubInstallerService(logger);
  }

  async preflight(input?: PreflightRequest): Promise<PreflightResult> {
    return this.stubService.preflight(input);
  }

  async testImap(req: TestImapRequest): Promise<TestImapResult> {
    return this.stubService.testImap(req);
  }

  async testMatrix(req: TestMatrixRequest): Promise<TestMatrixResult> {
    return this.stubService.testMatrix(req);
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
          throw {
            code: "NOT_IMPLEMENTED",
            message:
              "OpenClaw bootstrap step is not implemented yet (job execution/persistence is now wired)",
            retryable: true,
          };
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
}

const now = () => new Date().toISOString();

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  typeof error === "object" && error !== null && "code" in error;
