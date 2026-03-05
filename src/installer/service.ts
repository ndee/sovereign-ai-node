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
