import type {
  PreflightRequest,
  ReconfigureImapRequest,
  ReconfigureMatrixRequest,
  ReconfigureOpenrouterRequest,
  TestAlertRequest,
  TestImapRequest,
  TestMatrixRequest,
} from "../contracts/api.js";
import type {
  DoctorReport,
  InstallJobStatusResponse,
  InstallRequest,
  MatrixOnboardingIssueResult,
  PreflightResult,
  ReconfigureResult,
  SovereignStatus,
  StartInstallResult,
  TestAlertResult,
  TestImapResult,
  TestMatrixResult,
} from "../contracts/index.js";

export type ManagedAgent = {
  id: string;
  workspace: string;
  matrixUserId?: string;
  templateRef?: string;
  toolInstanceIds?: string[];
};

export type ManagedAgentListResult = {
  agents: ManagedAgent[];
};

export type ManagedAgentUpsertResult = {
  agent: ManagedAgent;
  changed: boolean;
  restartRequiredServices: string[];
};

export type ManagedAgentDeleteResult = {
  id: string;
  deleted: boolean;
  restartRequiredServices: string[];
};

export type SovereignTemplateKind = "agent" | "tool";

export type SovereignTemplateSummary = {
  kind: SovereignTemplateKind;
  id: string;
  version: string;
  description: string;
  trusted: boolean;
  installed: boolean;
  pinned: boolean;
  keyId: string;
  manifestSha256: string;
};

export type SovereignTemplateListResult = {
  templates: SovereignTemplateSummary[];
};

export type SovereignTemplateInstallResult = {
  template: SovereignTemplateSummary;
  changed: boolean;
};

export type SovereignBotSummary = {
  id: string;
  version: string;
  displayName: string;
  description: string;
  defaultInstall: boolean;
  templateRef: string;
  installed: boolean;
  instantiated: boolean;
  agentId?: string;
  cronJobIds?: string[];
};

export type SovereignBotListResult = {
  bots: SovereignBotSummary[];
};

export type SovereignBotInstantiateResult = {
  bot: SovereignBotSummary;
  agent: ManagedAgent;
  changed: boolean;
  restartRequiredServices: string[];
};

export type SovereignToolInstance = {
  id: string;
  templateRef: string;
  capabilities: string[];
  config: Record<string, string>;
  secretRefs: Record<string, string>;
};

export type SovereignToolInstanceListResult = {
  tools: SovereignToolInstance[];
};

export type SovereignToolInstanceUpsertResult = {
  tool: SovereignToolInstance;
  changed: boolean;
};

export type SovereignToolInstanceDeleteResult = {
  id: string;
  deleted: boolean;
};

export type MatrixUserRemoveResult = {
  localpart: string;
  userId: string;
  removed: boolean;
};

export interface InstallerService {
  preflight(input?: PreflightRequest): Promise<PreflightResult>;
  testImap(req: TestImapRequest): Promise<TestImapResult>;
  testMatrix(req: TestMatrixRequest): Promise<TestMatrixResult>;
  startInstall(req: InstallRequest): Promise<StartInstallResult>;
  getInstallJob(jobId: string): Promise<InstallJobStatusResponse>;
  testAlert(req: TestAlertRequest): Promise<TestAlertResult>;
  getStatus(): Promise<SovereignStatus>;
  getDoctorReport(): Promise<DoctorReport>;
  reconfigureImap(req: ReconfigureImapRequest): Promise<ReconfigureResult>;
  reconfigureMatrix(req: ReconfigureMatrixRequest): Promise<ReconfigureResult>;
  reconfigureOpenrouter(req: ReconfigureOpenrouterRequest): Promise<ReconfigureResult>;
  issueMatrixOnboardingCode(req?: { ttlMinutes?: number }): Promise<MatrixOnboardingIssueResult>;
  inviteMatrixUser(req: {
    username: string;
    ttlMinutes?: number;
  }): Promise<MatrixOnboardingIssueResult>;
  removeMatrixUser(req: { username: string }): Promise<MatrixUserRemoveResult>;
  listManagedAgents(): Promise<ManagedAgentListResult>;
  createManagedAgent(req: {
    id: string;
    workspace?: string;
    templateRef?: string;
    toolInstanceIds?: string[];
  }): Promise<ManagedAgentUpsertResult>;
  updateManagedAgent(req: {
    id: string;
    workspace?: string;
    templateRef?: string;
    toolInstanceIds?: string[];
  }): Promise<ManagedAgentUpsertResult>;
  deleteManagedAgent(req: { id: string }): Promise<ManagedAgentDeleteResult>;
  listSovereignBots(): Promise<SovereignBotListResult>;
  instantiateSovereignBot(req: {
    id: string;
    workspace?: string;
  }): Promise<SovereignBotInstantiateResult>;
  listSovereignTemplates(): Promise<SovereignTemplateListResult>;
  installSovereignTemplate(req: { ref: string }): Promise<SovereignTemplateInstallResult>;
  listSovereignToolInstances(): Promise<SovereignToolInstanceListResult>;
  createSovereignToolInstance(req: {
    id: string;
    templateRef: string;
    config?: Record<string, string>;
    secretRefs?: Record<string, string>;
  }): Promise<SovereignToolInstanceUpsertResult>;
  updateSovereignToolInstance(req: {
    id: string;
    templateRef?: string;
    config?: Record<string, string>;
    secretRefs?: Record<string, string>;
  }): Promise<SovereignToolInstanceUpsertResult>;
  deleteSovereignToolInstance(req: { id: string }): Promise<SovereignToolInstanceDeleteResult>;
}
