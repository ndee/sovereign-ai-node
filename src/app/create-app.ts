import { DEFAULT_PATHS } from "../config/paths.js";
import { RealInstallerService } from "../installer/real-service.js";
import { createLogger } from "../logging/logger.js";
import { ShellOpenClawBootstrapper } from "../openclaw/bootstrap.js";
import { ShellOpenClawGatewayServiceManager } from "../openclaw/gateway-service.js";
import { ExecaExecRunner } from "../system/exec.js";
import { ShellHostPreflightChecker } from "../system/preflight.js";

export const createApp = () => {
  const logger = createLogger();
  const execRunner = new ExecaExecRunner();

  // Scaffolds initialized now so the dependency graph is in place when implementation begins.
  const openclawBootstrapper = new ShellOpenClawBootstrapper(execRunner, logger);
  const preflightChecker = new ShellHostPreflightChecker(execRunner, logger);
  const openclawGatewayServiceManager = new ShellOpenClawGatewayServiceManager(
    execRunner,
    logger,
  );

  void openclawGatewayServiceManager;

  return {
    logger,
    paths: DEFAULT_PATHS,
    installerService: new RealInstallerService(logger, DEFAULT_PATHS, {
      openclawBootstrapper,
      preflightChecker,
    }),
  };
};

export type AppContainer = ReturnType<typeof createApp>;
