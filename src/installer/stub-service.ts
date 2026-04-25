import { randomUUID } from "node:crypto";
import type {
  PreflightRequest,
  ReconfigureImapRequest,
  ReconfigureMatrixRequest,
  ReconfigureOpenrouterRequest,
  TestAlertRequest,
  TestImapRequest,
  TestMatrixRequest,
} from "../contracts/api.js";
import { type CheckResult, CONTRACT_VERSION } from "../contracts/common.js";
import type {
  DoctorReport,
  InstallJobStatusResponse,
  InstallRequest,
  MatrixOnboardingIssueResult,
  MatrixOnboardingPublicState,
  PreflightResult,
  ReconfigureResult,
  SetupUiBootstrapIssueResult,
  SetupUiBootstrapPublicState,
  SovereignStatus,
  StartInstallResult,
  TestAlertResult,
  TestImapResult,
  TestMatrixResult,
} from "../contracts/index.js";
import type { Logger } from "../logging/logger.js";
import type {
  InstallerService,
  MailSentinelApplyResult,
  MailSentinelDeleteResult,
  MailSentinelListResult,
  MailSentinelMigrationResult,
  ManagedAgentDeleteResult,
  ManagedAgentListResult,
  ManagedAgentUpsertResult,
  MatrixUserRemoveResult,
  MigrationStatusResult,
  PendingMigration,
  SovereignBotInstantiateResult,
  SovereignBotListResult,
  SovereignTemplateInstallResult,
  SovereignTemplateListResult,
  SovereignToolInstanceDeleteResult,
  SovereignToolInstanceListResult,
  SovereignToolInstanceUpsertResult,
} from "./service.js";

const now = () => new Date().toISOString();

const check = (
  id: string,
  message: string,
  status: CheckResult["status"] = "pass",
): CheckResult => ({
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
      bots: {
        "mail-sentinel": {
          fields: {
            consecutiveFailures: 0,
          },
          health: "unknown",
        },
      },
      hostResources: [],
      imap: {
        authStatus: "unknown",
      },
      version: {
        sovereignNode: "2.0.0",
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
      suggestedCommands: ["pnpm install", "pnpm dev:cli -- doctor --json"],
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

  async issueMatrixOnboardingCode(): Promise<MatrixOnboardingIssueResult> {
    return {
      code: "SCFD-0000-0000",
      expiresAt: now(),
      onboardingUrl: "https://matrix.example.org/onboard",
      onboardingLink: "https://matrix.example.org/onboard#code=SCFD-0000-0000",
      username: "@operator:matrix.example.org",
    };
  }

  async getMatrixOnboardingState(): Promise<MatrixOnboardingPublicState | null> {
    return {
      issuedAt: "2025-01-01T00:00:00.000Z",
      expiresAt: "2025-01-01T00:21:00.000Z",
      failedAttempts: 0,
      maxAttempts: 5,
      username: "@operator:matrix.example.org",
      homeserverUrl: "https://matrix.example.org",
    };
  }

  async getAuthStage(): Promise<{
    stage: "needs-bootstrap" | "needs-password";
    username?: string;
  }> {
    return { stage: "needs-password", username: "@admin:matrix.example.org" };
  }

  async issueSetupUiBootstrapToken(): Promise<SetupUiBootstrapIssueResult> {
    return {
      token: "ABCD-EFGH-JKLM",
      expiresAt: "2025-01-02T00:00:00.000Z",
      ttlMinutes: 24 * 60,
    };
  }

  async getSetupUiBootstrapState(): Promise<SetupUiBootstrapPublicState | null> {
    return null;
  }

  async consumeSetupUiBootstrapToken(
    token: string,
  ): Promise<
    | { ok: true }
    | { ok: false; reason: "invalid" | "expired" | "consumed" | "locked" | "not-issued" }
  > {
    return token === "ABCD-EFGH-JKLM" ? { ok: true } : { ok: false, reason: "invalid" };
  }

  async verifyOperatorPassword(
    password: string,
  ): Promise<
    | { ok: true; username: string }
    | { ok: false; reason: "invalid" | "homeserver-unreachable" | "not-configured" }
  > {
    if (password === "scaffold-operator-password") {
      return { ok: true, username: "@admin:matrix.example.org" };
    }
    return { ok: false, reason: "invalid" };
  }

  async inviteMatrixUser(req: {
    username: string;
    ttlMinutes?: number;
  }): Promise<MatrixOnboardingIssueResult> {
    return {
      code: "SCFD-1111-2222",
      expiresAt: now(),
      onboardingUrl: "https://matrix.example.org/onboard",
      onboardingLink: "https://matrix.example.org/onboard#code=SCFD-1111-2222",
      username: req.username.startsWith("@") ? req.username : `@${req.username}:matrix.example.org`,
    };
  }

  async removeMatrixUser(req: { username: string }): Promise<MatrixUserRemoveResult> {
    const localpart = req.username.replace(/^@/, "").split(":")[0] ?? req.username;
    return {
      localpart,
      userId: `@${localpart}:matrix.example.org`,
      removed: true,
    };
  }

  async getPendingMigrations(): Promise<MigrationStatusResult> {
    const pending: PendingMigration[] = [];
    return {
      requestFile: "/etc/sovereign-node/install-request.json",
      pending,
    };
  }

  async migrateLegacyMailSentinel(): Promise<MailSentinelMigrationResult> {
    return {
      changed: false,
      requestFile: "/etc/sovereign-node/install-request.json",
      instance: {
        id: "mail-sentinel",
        packageId: "mail-sentinel",
        workspace: "/var/lib/sovereign-node/mail-sentinel/workspace",
        matrixLocalpart: "mail-sentinel",
        matrixUserId: "@mail-sentinel:matrix.example.org",
        alertRoomId: "!alerts:matrix.example.org",
        alertRoomName: "Sovereign Alerts",
        allowedUsers: ["@operator:matrix.example.org"],
        imapHost: "imap.example.org",
        imapUsername: "mailbox@example.org",
        mailbox: "INBOX",
        pollInterval: "30m",
      },
    };
  }

  async listMailSentinelInstances(): Promise<MailSentinelListResult> {
    return {
      instances: [
        {
          id: "mail-sentinel",
          packageId: "mail-sentinel",
          workspace: "/var/lib/sovereign-node/mail-sentinel/workspace",
          matrixLocalpart: "mail-sentinel",
          matrixUserId: "@mail-sentinel:matrix.example.org",
          alertRoomId: "!alerts:matrix.example.org",
          alertRoomName: "Sovereign Alerts",
          allowedUsers: ["@operator:matrix.example.org"],
          imapHost: "imap.example.org",
          imapUsername: "mailbox@example.org",
          mailbox: "INBOX",
          pollInterval: "30m",
        },
      ],
    };
  }

  async createMailSentinelInstance(req: { id: string }): Promise<MailSentinelApplyResult> {
    return {
      instance: {
        id: req.id,
        packageId: "mail-sentinel",
        workspace: `/var/lib/sovereign-node/${req.id}/workspace`,
        allowedUsers: [],
      },
      changed: true,
      job: (
        await this.startInstall({
          mode: "bundled_matrix",
          openrouter: { secretRef: "env:OPENROUTER_API_KEY" },
          matrix: {
            homeserverDomain: "matrix.example.org",
            publicBaseUrl: "https://matrix.example.org",
          },
          operator: { username: "operator" },
        })
      ).job,
    };
  }

  async updateMailSentinelInstance(req: { id: string }): Promise<MailSentinelApplyResult> {
    return await this.createMailSentinelInstance(req);
  }

  async deleteMailSentinelInstance(req: { id: string }): Promise<MailSentinelDeleteResult> {
    return {
      id: req.id,
      deleted: true,
      job: (
        await this.startInstall({
          mode: "bundled_matrix",
          openrouter: { secretRef: "env:OPENROUTER_API_KEY" },
          matrix: {
            homeserverDomain: "matrix.example.org",
            publicBaseUrl: "https://matrix.example.org",
          },
          operator: { username: "operator" },
        })
      ).job,
    };
  }

  async listManagedAgents(): Promise<ManagedAgentListResult> {
    return {
      agents: [
        {
          id: "mail-sentinel",
          workspace: "/var/lib/sovereign-node/mail-sentinel/workspace",
        },
      ],
    };
  }

  async createManagedAgent(req: {
    id: string;
    workspace?: string;
    templateRef?: string;
    toolInstanceIds?: string[];
  }): Promise<ManagedAgentUpsertResult> {
    return {
      agent: {
        id: req.id,
        workspace: req.workspace ?? `/var/lib/sovereign-node/${req.id}/workspace`,
        ...(req.templateRef === undefined ? {} : { templateRef: req.templateRef }),
        ...(req.toolInstanceIds === undefined ? {} : { toolInstanceIds: req.toolInstanceIds }),
      },
      changed: true,
      restartRequiredServices: ["openclaw-gateway"],
    };
  }

  async updateManagedAgent(req: {
    id: string;
    workspace?: string;
    templateRef?: string;
    toolInstanceIds?: string[];
  }): Promise<ManagedAgentUpsertResult> {
    return {
      agent: {
        id: req.id,
        workspace: req.workspace ?? `/var/lib/sovereign-node/${req.id}/workspace`,
        ...(req.templateRef === undefined ? {} : { templateRef: req.templateRef }),
        ...(req.toolInstanceIds === undefined ? {} : { toolInstanceIds: req.toolInstanceIds }),
      },
      changed: true,
      restartRequiredServices: ["openclaw-gateway"],
    };
  }

  async deleteManagedAgent(req: { id: string }): Promise<ManagedAgentDeleteResult> {
    return {
      id: req.id,
      deleted: true,
      restartRequiredServices: ["openclaw-gateway"],
    };
  }

  async listSovereignBots(): Promise<SovereignBotListResult> {
    return {
      bots: [
        {
          id: "mail-sentinel",
          version: "1.0.0",
          displayName: "Mail Sentinel",
          description: "Inbox triage bot for read-only IMAP summaries and Matrix alerting.",
          defaultInstall: true,
          templateRef: "mail-sentinel@1.0.0",
          installed: true,
          instantiated: true,
          agentId: "mail-sentinel",
          cronJobIds: ["mail-sentinel-poll"],
        },
        {
          id: "node-operator",
          version: "1.0.0",
          displayName: "Node Operator",
          description: "Primary conversational operator for Sovereign Node and managed agents.",
          defaultInstall: false,
          templateRef: "node-operator@1.0.0",
          installed: false,
          instantiated: false,
        },
      ],
    };
  }

  async instantiateSovereignBot(req: {
    id: string;
    workspace?: string;
  }): Promise<SovereignBotInstantiateResult> {
    return {
      bot: {
        id: req.id,
        version: "1.0.0",
        displayName: req.id,
        description: "Scaffold bot package",
        defaultInstall: req.id === "mail-sentinel",
        templateRef: `${req.id}@1.0.0`,
        installed: true,
        instantiated: true,
        agentId: req.id,
      },
      agent: {
        id: req.id,
        workspace: req.workspace ?? `/var/lib/sovereign-node/${req.id}/workspace`,
        templateRef: `${req.id}@1.0.0`,
      },
      changed: true,
      restartRequiredServices: ["openclaw-gateway"],
    };
  }

  async listSovereignTemplates(): Promise<SovereignTemplateListResult> {
    return {
      templates: [],
    };
  }

  async installSovereignTemplate(_req: { ref: string }): Promise<SovereignTemplateInstallResult> {
    return {
      template: {
        kind: "agent",
        id: "scaffold",
        version: "0.0.0",
        description: "Scaffold template",
        trusted: false,
        installed: false,
        pinned: false,
        keyId: "scaffold",
        manifestSha256: "scaffold",
      },
      changed: false,
    };
  }

  async listSovereignToolInstances(): Promise<SovereignToolInstanceListResult> {
    return {
      tools: [],
    };
  }

  async createSovereignToolInstance(req: {
    id: string;
    templateRef: string;
    config?: Record<string, string>;
    secretRefs?: Record<string, string>;
  }): Promise<SovereignToolInstanceUpsertResult> {
    return {
      tool: {
        id: req.id,
        templateRef: req.templateRef,
        capabilities: [],
        config: req.config ?? {},
        secretRefs: req.secretRefs ?? {},
      },
      changed: true,
    };
  }

  async updateSovereignToolInstance(req: {
    id: string;
    templateRef?: string;
    config?: Record<string, string>;
    secretRefs?: Record<string, string>;
  }): Promise<SovereignToolInstanceUpsertResult> {
    return {
      tool: {
        id: req.id,
        templateRef: req.templateRef ?? "scaffold@0.0.0",
        capabilities: [],
        config: req.config ?? {},
        secretRefs: req.secretRefs ?? {},
      },
      changed: true,
    };
  }

  async deleteSovereignToolInstance(req: {
    id: string;
  }): Promise<SovereignToolInstanceDeleteResult> {
    return {
      id: req.id,
      deleted: true,
    };
  }
}
