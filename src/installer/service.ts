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
}
