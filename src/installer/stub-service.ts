import { randomUUID } from "node:crypto";

import { CONTRACT_VERSION, type CheckResult } from "../contracts/common.js";
import type {
  DoctorReport,
  InstallJobStatusResponse,
  InstallRequest,
  PreflightResult,
  ReconfigureResult,
  SovereignStatus,
  StartInstallResult,
  TestAlertResult,
  TestImapResult,
  TestMatrixResult,
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
import type { InstallerService } from "./service.js";

const now = () => new Date().toISOString();

const check = (id: string, message: string, status: CheckResult["status"] = "pass"): CheckResult => ({
  id,
  name: id,
  status,
  message,
});

export class StubInstallerService implements InstallerService {
  private lastInstallJobId: string | null = null;

  constructor(private readonly logger: Logger) {}

  async preflight(_input?: PreflightRequest): Promise<PreflightResult> {
    return {
      mode: "bundled_matrix",
      overall: "warn",
      checks: [
        check("linux-host", "Scaffold only: host preflight not yet implemented", "warn"),
        check("sudo-access", "Scaffold only: privilege checks not yet implemented", "warn"),
      ],
      recommendedActions: [
        "Implement host preflight checks in src/system/preflight.ts",
        "Implement Docker/Compose detection for bundled Matrix profile",
      ],
    };
  }

  async testImap(req: TestImapRequest): Promise<TestImapResult> {
    return {
      ok: false,
      host: req.imap.host,
      port: req.imap.port,
      tls: req.imap.tls,
      auth: "failed",
      mailbox: req.imap.mailbox ?? "INBOX",
      error: {
        code: "NOT_IMPLEMENTED",
        message: "IMAP validation scaffold only; implementation pending",
        retryable: true,
      },
    };
  }

  async testMatrix(req: TestMatrixRequest): Promise<TestMatrixResult> {
    return {
      ok: false,
      homeserverUrl: req.publicBaseUrl,
      clientDiscovery: { required: false, ok: false },
      serverDiscovery: {
        required: Boolean(req.federationEnabled),
        ok: false,
      },
      checks: [check("matrix-http", "Matrix test scaffold only", "warn")],
    };
  }

  async startInstall(req: InstallRequest): Promise<StartInstallResult> {
    this.logger.info({ mode: req.mode }, "Stub installer startInstall invoked");
    const jobId = `job_${randomUUID()}`;
    this.lastInstallJobId = jobId;
    const timestamp = now();
    return {
      job: {
        jobId,
        state: "pending",
        createdAt: timestamp,
        steps: [
          {
            id: "preflight",
            label: "Preflight",
            state: "pending",
          },
          {
            id: "openclaw_bootstrap_cli",
            label: "Install OpenClaw CLI",
            state: "pending",
          },
          {
            id: "imap_validate",
            label: "Validate IMAP",
            state: "pending",
          },
        ],
      },
    };
  }

  async getInstallJob(jobId: string): Promise<InstallJobStatusResponse> {
    const activeJobId = this.lastInstallJobId ?? jobId;
    const timestamp = now();
    return {
      job: {
        jobId: activeJobId,
        state: "failed",
        createdAt: timestamp,
        startedAt: timestamp,
        endedAt: timestamp,
        currentStepId: "openclaw_bootstrap_cli",
        steps: [
          {
            id: "preflight",
            label: "Preflight",
            state: "succeeded",
            startedAt: timestamp,
            endedAt: timestamp,
          },
          {
            id: "openclaw_bootstrap_cli",
            label: "Install OpenClaw CLI",
            state: "failed",
            startedAt: timestamp,
            endedAt: timestamp,
            error: {
              code: "NOT_IMPLEMENTED",
              message: "OpenClaw bootstrap step not implemented in scaffold",
              retryable: true,
            },
          },
        ],
      },
      error: {
        code: "NOT_IMPLEMENTED",
        message: "Installer job execution is a scaffold placeholder",
        retryable: true,
      },
    };
  }

  async testAlert(req: TestAlertRequest): Promise<TestAlertResult> {
    return {
      delivered: false,
      target: {
        channel: "matrix",
        roomId: req.roomId ?? "!placeholder:example.org",
      },
      error: {
        code: "NOT_IMPLEMENTED",
        message: "Test alert delivery scaffold only; Matrix delivery implementation pending",
        retryable: true,
      },
    };
  }

  async getStatus(): Promise<SovereignStatus> {
    return {
      mode: "bundled_matrix",
      services: [
        {
          name: "sovereign-node",
          kind: "sovereign-node",
          health: "degraded",
          state: "running",
          message: "Scaffold mode",
        },
      ],
      matrix: {
        health: "unknown",
        roomReachable: false,
        federationEnabled: false,
      },
      openclaw: {
        managedBySovereign: true,
        cliInstalled: false,
        health: "unknown",
        serviceInstalled: false,
        agentPresent: false,
        cronPresent: false,
      },
      mailSentinel: {
        agentId: "mail-sentinel",
        consecutiveFailures: 0,
      },
      imap: {
        authStatus: "unknown",
      },
      version: {
        sovereignNode: "0.1.0",
        contractVersion: CONTRACT_VERSION,
      },
    };
  }

  async getDoctorReport(): Promise<DoctorReport> {
    return {
      overall: "warn",
      checks: [
        check("openclaw-cli", "OpenClaw CLI check not implemented", "warn"),
        check("openclaw-version-pin", "OpenClaw version pin check not implemented", "warn"),
        check("gateway-service", "OpenClaw gateway service check not implemented", "warn"),
      ],
      suggestedCommands: [
        "pnpm install",
        "pnpm dev:cli -- doctor --json",
      ],
    };
  }

  async reconfigureImap(_req: ReconfigureImapRequest): Promise<ReconfigureResult> {
    return {
      target: "imap",
      changed: [],
      restartRequiredServices: [],
      validation: [check("imap-config", "Reconfigure IMAP scaffold only", "warn")],
    };
  }

  async reconfigureMatrix(_req: ReconfigureMatrixRequest): Promise<ReconfigureResult> {
    return {
      target: "matrix",
      changed: [],
      restartRequiredServices: [],
      validation: [check("matrix-config", "Reconfigure Matrix scaffold only", "warn")],
    };
  }

  async reconfigureOpenrouter(_req: ReconfigureOpenrouterRequest): Promise<ReconfigureResult> {
    return {
      target: "openrouter",
      changed: [],
      restartRequiredServices: [],
      validation: [check("openrouter-config", "Reconfigure OpenRouter scaffold only", "warn")],
    };
  }
}
