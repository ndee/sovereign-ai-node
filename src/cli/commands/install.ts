import { readFile } from "node:fs/promises";

import type { Command } from "commander";

import type { AppContainer } from "../../app/create-app.js";
import {
  installRequestSchema,
  startInstallResultSchema,
  type InstallRequest,
} from "../../contracts/index.js";
import { writeCliError, writeCliSuccess } from "../output.js";

type InstallOptions = {
  json?: boolean;
  nonInteractive?: boolean;
  openclawVersion?: string;
  skipOpenclawInstall?: boolean;
  forceOpenclawReinstall?: boolean;
  connectivityMode?: "direct" | "relay";
  relayControlUrl?: string;
  relayEnrollmentToken?: string;
  matrixTlsMode?: "auto" | "internal" | "manual" | "local-dev";
  requestFile?: string;
};

const buildScaffoldInstallRequest = (opts: InstallOptions): InstallRequest => {
  const connectivityMode =
    opts.connectivityMode
    ?? (opts.relayControlUrl !== undefined || opts.relayEnrollmentToken !== undefined
      ? "relay"
      : "direct");
  return {
    mode: "bundled_matrix",
    connectivity: {
      mode: connectivityMode,
    },
    ...(connectivityMode === "relay"
      ? {
          relay: {
            controlUrl: opts.relayControlUrl ?? "https://relay.example.com",
            enrollmentToken: opts.relayEnrollmentToken ?? "replace-me",
          },
        }
      : {}),
    openclaw: {
      manageInstallation: !opts.skipOpenclawInstall,
      installMethod: "install_sh",
      version: opts.openclawVersion ?? "pinned-by-sovereign",
      skipIfCompatibleInstalled: true,
      forceReinstall: opts.forceOpenclawReinstall ?? false,
      runOnboard: false,
    },
    openrouter: {
      model: "openai/gpt-5-nano",
      secretRef: "env:OPENROUTER_API_KEY",
    },
    matrix: {
      homeserverDomain:
        connectivityMode === "relay" ? "relay-pending.invalid" : "matrix.example.org",
      publicBaseUrl:
        connectivityMode === "relay" ? "https://relay-pending.invalid" : "https://matrix.example.org",
      federationEnabled: false,
      tlsMode: connectivityMode === "relay" ? "auto" : (opts.matrixTlsMode ?? "auto"),
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
  };
};

export const registerInstallCommand = (program: Command, app: AppContainer): void => {
  program
    .command("install")
    .description("Run the Sovereign Node installer flow (scaffold)")
    .option("--json", "Emit JSON output")
    .option("--non-interactive", "Run without interactive prompts")
    .option("--openclaw-version <ver>", "Override pinned OpenClaw version (advanced)")
    .option("--skip-openclaw-install", "Reuse existing OpenClaw install only (advanced)")
    .option("--force-openclaw-reinstall", "Force OpenClaw reinstall (repair path)")
    .option(
      "--connectivity-mode <mode>",
      "Connection mode (direct|relay) (scaffold/dev)",
    )
    .option("--relay-control-url <url>", "Managed relay control plane URL (scaffold/dev)")
    .option(
      "--relay-enrollment-token <token>",
      "Managed relay enrollment token (scaffold/dev)",
    )
    .option(
      "--matrix-tls-mode <mode>",
      "Matrix TLS mode (auto|internal|manual|local-dev) (scaffold/dev)",
    )
    .option(
      "--request-file <path>",
      "Path to an InstallRequest JSON file (overrides scaffold defaults)",
    )
    .action(async (opts: InstallOptions) => {
      const command = "install";
      try {
        const req =
          opts.requestFile === undefined
            ? buildScaffoldInstallRequest(opts)
            : await readInstallRequestFromFile(opts.requestFile);
        const result = await app.installerService.startInstall(req);
        writeCliSuccess(command, result, startInstallResultSchema, Boolean(opts.json));
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });
};

const readInstallRequestFromFile = async (path: string): Promise<InstallRequest> => {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return installRequestSchema.parse(parsed);
};
