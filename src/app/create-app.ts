import { DEFAULT_PATHS } from "../config/paths.js";
import { StubInstallerService } from "../installer/stub-service.js";
import { createLogger } from "../logging/logger.js";
import { ShellOpenClawBootstrapper } from "../openclaw/bootstrap.js";
import { ShellOpenClawGatewayServiceManager } from "../openclaw/gateway-service.js";
import { ExecaExecRunner } from "../system/exec.js";

export const createApp = () => {
  const logger = createLogger();
  const execRunner = new ExecaExecRunner();

  // Scaffolds initialized now so the dependency graph is in place when implementation begins.
  const openclawBootstrapper = new ShellOpenClawBootstrapper(execRunner, logger);
  const openclawGatewayServiceManager = new ShellOpenClawGatewayServiceManager(
    execRunner,
    logger,
  );

  void openclawBootstrapper;
  void openclawGatewayServiceManager;

  return {
    logger,
    paths: DEFAULT_PATHS,
    installerService: new StubInstallerService(logger),
  };
};

export type AppContainer = ReturnType<typeof createApp>;
