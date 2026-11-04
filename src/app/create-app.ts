import { FilesystemBotCatalog } from "../bots/catalog.js";
import { DEFAULT_PATHS } from "../config/paths.js";
import { RealInstallerService } from "../installer/real-service.js";
import { createLogger } from "../logging/logger.js";
import { ShellOpenClawBootstrapper } from "../openclaw/bootstrap.js";
import { ShellOpenClawGatewayServiceManager } from "../openclaw/gateway-service.js";
import { ShellOpenClawManagedAgentRegistrar } from "../openclaw/managed-agent.js";
import { RealBackupService } from "../system/backup.js";
import { ShellDockerRuntimePreparer } from "../system/docker-runtime.js";
import { ExecaExecRunner } from "../system/exec.js";
import { SocketImapTester } from "../system/imap.js";
import { DockerComposeBundledMatrixProvisioner } from "../system/matrix.js";
import { HttpOpenrouterKeyValidator } from "../system/openrouter.js";
import { ShellHostPreflightChecker } from "../system/preflight.js";

export const createApp = () => {
  const logger = createLogger();
  const execRunner = new ExecaExecRunner();

  // Read once at startup: an install job later points this process's HOME at
  // the OpenClaw home, and the next install in the same process must still use
  // the npm prefix the first one installed OpenClaw into.
  const openclawBootstrapper = new ShellOpenClawBootstrapper(execRunner, logger, process.env.HOME);
  const imapTester = new SocketImapTester(logger);
  const openrouterKeyValidator = new HttpOpenrouterKeyValidator();
  const matrixProvisioner = new DockerComposeBundledMatrixProvisioner(
    execRunner,
    logger,
    DEFAULT_PATHS,
  );
  const preflightChecker = new ShellHostPreflightChecker(execRunner, logger);
  const dockerRuntimePreparer = new ShellDockerRuntimePreparer(execRunner, logger);
  const openclawGatewayServiceManager = new ShellOpenClawGatewayServiceManager(execRunner, logger);
  const managedAgentRegistrar = new ShellOpenClawManagedAgentRegistrar(execRunner, logger);
  const botCatalog = new FilesystemBotCatalog();

  return {
    logger,
    paths: DEFAULT_PATHS,
    installerService: new RealInstallerService(logger, DEFAULT_PATHS, {
      openclawBootstrapper,
      openclawGatewayServiceManager,
      managedAgentRegistrar,
      botCatalog,
      preflightChecker,
      dockerRuntimePreparer,
      imapTester,
      openrouterKeyValidator,
      matrixProvisioner,
      execRunner,
    }),
    backupService: new RealBackupService(execRunner, logger, DEFAULT_PATHS),
  };
};

export type AppContainer = ReturnType<typeof createApp>;
