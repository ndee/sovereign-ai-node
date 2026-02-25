import type { Command } from "commander";

import type { AppContainer } from "../../app/create-app.js";
import { startInstallResultSchema, type InstallRequest } from "../../contracts/index.js";
import { writeCliError, writeCliSuccess } from "../output.js";

type InstallOptions = {
  json?: boolean;
  nonInteractive?: boolean;
  openclawVersion?: string;
  skipOpenclawInstall?: boolean;
  forceOpenclawReinstall?: boolean;
};

const buildScaffoldInstallRequest = (opts: InstallOptions): InstallRequest => ({
  mode: "bundled_matrix",
  openclaw: {
    manageInstallation: !opts.skipOpenclawInstall,
    installMethod: "install_sh",
    version: opts.openclawVersion ?? "pinned-by-sovereign",
    skipIfCompatibleInstalled: true,
    forceReinstall: opts.forceOpenclawReinstall ?? false,
    runOnboard: false,
  },
  imap: {
    host: "imap.example.org",
    port: 993,
    tls: true,
    username: "operator@example.org",
    secretRef: "file:/etc/sovereign-node/secrets/imap-password",
    mailbox: "INBOX",
  },
  matrix: {
    homeserverDomain: "matrix.example.org",
    publicBaseUrl: "https://matrix.example.org",
    federationEnabled: false,
    tlsMode: "auto",
    alertRoomName: "Sovereign Alerts",
  },
  operator: {
    username: "operator",
  },
  mailSentinel: {
    pollInterval: "5m",
    lookbackWindow: "15m",
    e2eeAlertRoom: false,
  },
  advanced: {
    nonInteractive: opts.nonInteractive ?? false,
  },
});

export const registerInstallCommand = (program: Command, app: AppContainer): void => {
  program
    .command("install")
    .description("Run the Sovereign Node installer flow (scaffold)")
    .option("--json", "Emit JSON output")
    .option("--non-interactive", "Run without interactive prompts")
    .option("--openclaw-version <ver>", "Override pinned OpenClaw version (advanced)")
    .option("--skip-openclaw-install", "Reuse existing OpenClaw install only (advanced)")
    .option("--force-openclaw-reinstall", "Force OpenClaw reinstall (repair path)")
    .action(async (opts: InstallOptions) => {
      const command = "install";
      try {
        const req = buildScaffoldInstallRequest(opts);
        const result = await app.installerService.startInstall(req);
        writeCliSuccess(command, result, startInstallResultSchema, Boolean(opts.json));
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });
};

