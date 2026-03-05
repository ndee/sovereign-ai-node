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
  createManagedAgent(req: { id: string; workspace?: string }): Promise<ManagedAgentUpsertResult>;
  updateManagedAgent(req: { id: string; workspace?: string }): Promise<ManagedAgentUpsertResult>;
  deleteManagedAgent(req: { id: string }): Promise<ManagedAgentDeleteResult>;
}
