import { FilesystemBotCatalog } from "../bots/catalog.js";
import { DEFAULT_PATHS } from "../config/paths.js";
import { RealInstallerService } from "../installer/real-service.js";
import { createLogger } from "../logging/logger.js";
import { ShellOpenClawBootstrapper } from "../openclaw/bootstrap.js";
import { ShellOpenClawGatewayServiceManager } from "../openclaw/gateway-service.js";
import { ShellOpenClawManagedAgentRegistrar } from "../openclaw/managed-agent.js";
import { ExecaExecRunner } from "../system/exec.js";
import { SocketImapTester } from "../system/imap.js";
import { DockerComposeBundledMatrixProvisioner } from "../system/matrix.js";
import { ShellHostPreflightChecker } from "../system/preflight.js";

export const createApp = () => {
  const logger = createLogger();
  const execRunner = new ExecaExecRunner();

  const openclawBootstrapper = new ShellOpenClawBootstrapper(execRunner, logger);
  const imapTester = new SocketImapTester(logger);
  const matrixProvisioner = new DockerComposeBundledMatrixProvisioner(
    execRunner,
    logger,
    DEFAULT_PATHS,
  );
  const preflightChecker = new ShellHostPreflightChecker(execRunner, logger);
  const openclawGatewayServiceManager = new ShellOpenClawGatewayServiceManager(
    execRunner,
    logger,
  );
  const managedAgentRegistrar = new ShellOpenClawManagedAgentRegistrar(
    execRunner,
    logger,
  );
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
      imapTester,
      matrixProvisioner,
      execRunner,
    }),
  };
};

export type AppContainer = ReturnType<typeof createApp>;
