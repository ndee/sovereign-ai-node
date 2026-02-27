import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { InstallRequest } from "../contracts/index.js";
import type { SovereignPaths } from "../config/paths.js";
import type { Logger } from "../logging/logger.js";
import type { ExecRunner, ExecResult } from "./exec.js";

export type BundledMatrixProvisionResult = {
  projectDir: string;
  composeFilePath: string;
  homeserverDomain: string;
  publicBaseUrl: string;
  federationEnabled: boolean;
  tlsMode: "local-dev";
};

export interface BundledMatrixProvisioner {
  provision(req: InstallRequest): Promise<BundledMatrixProvisionResult>;
}

export class DockerComposeBundledMatrixProvisioner implements BundledMatrixProvisioner {
  private resolvedBaseDir: string | null = null;

  constructor(
    private readonly execRunner: ExecRunner,
    private readonly logger: Logger,
    private readonly paths: SovereignPaths,
  ) {}

  async provision(req: InstallRequest): Promise<BundledMatrixProvisionResult> {
    const tlsMode = req.matrix.tlsMode ?? "auto";
    if (tlsMode !== "local-dev") {
      throw {
        code: "MATRIX_TLS_MODE_UNSUPPORTED",
        message:
          "Bundled Matrix provisioning is currently implemented only for tlsMode=local-dev",
        retryable: false,
        details: {
          requestedTlsMode: tlsMode,
          supportedTlsMode: "local-dev",
        },
      };
    }

    const homeserverDomain = req.matrix.homeserverDomain;
    const publicBaseUrl = req.matrix.publicBaseUrl;
    const federationEnabled = req.matrix.federationEnabled ?? false;
    const baseDir = await this.ensureBaseDir();
    const projectSlug = slugifyProjectName(homeserverDomain);
    const projectDir = join(baseDir, projectSlug);
    const synapseDir = join(projectDir, "synapse");
    const composeFilePath = join(projectDir, "compose.yaml");

    await mkdir(synapseDir, { recursive: true });

    const generated = {
      postgresPassword: `pg_${randomUUID().replaceAll("-", "")}`,
      registrationSharedSecret: randomUUID().replaceAll("-", ""),
      macaroonSecret: randomUUID().replaceAll("-", ""),
      formSecret: randomUUID().replaceAll("-", ""),
      signingKeyFile: `${homeserverDomain}.signing.key`,
    };

    const composeYaml = renderComposeYaml();
    const envFile = renderEnvFile({
      homeserverDomain,
      publicBaseUrl,
      federationEnabled,
      postgresPassword: generated.postgresPassword,
      synapseConfigPath: "./synapse/homeserver.yaml",
    });
    const homeserverYaml = renderSynapseConfig({
      homeserverDomain,
      publicBaseUrl,
      federationEnabled,
      postgresPassword: generated.postgresPassword,
      registrationSharedSecret: generated.registrationSharedSecret,
      macaroonSecret: generated.macaroonSecret,
      formSecret: generated.formSecret,
      signingKeyFile: generated.signingKeyFile,
    });
    const signingKey = renderSigningKey(generated.signingKeyFile);
    const logConfig = renderSynapseLogConfig();

    await Promise.all([
      writeFile(composeFilePath, `${composeYaml}\n`, "utf8"),
      writeFile(join(projectDir, ".env"), `${envFile}\n`, "utf8"),
      writeFile(join(synapseDir, "homeserver.yaml"), `${homeserverYaml}\n`, "utf8"),
      writeFile(join(synapseDir, generated.signingKeyFile), `${signingKey}\n`, "utf8"),
      writeFile(join(synapseDir, "log.config"), `${logConfig}\n`, "utf8"),
    ]);

    const composeConfigCheck = await this.runComposeCommand(projectDir, composeFilePath, [
      "config",
    ]);
    if (composeConfigCheck.exitCode !== 0) {
      throw {
        code: "MATRIX_COMPOSE_CONFIG_FAILED",
        message: "Bundled Matrix compose configuration validation failed",
        retryable: true,
        details: {
          command: composeConfigCheck.command,
          exitCode: composeConfigCheck.exitCode,
          stderr: truncateText(composeConfigCheck.stderr, 4000),
          stdout: truncateText(composeConfigCheck.stdout, 4000),
          projectDir,
          composeFilePath,
        },
      };
    }

    this.logger.info(
      {
        projectDir,
        homeserverDomain,
        publicBaseUrl,
        tlsMode,
      },
      "Bundled Matrix local-dev compose bundle generated and validated",
    );

    return {
      projectDir,
      composeFilePath,
      homeserverDomain,
      publicBaseUrl,
      federationEnabled,
      tlsMode: "local-dev",
    };
  }

  private async runComposeCommand(
    projectDir: string,
    composeFilePath: string,
    trailingArgs: string[],
  ): Promise<ExecResult> {
    const commonArgs = ["compose", "-f", composeFilePath, "--project-directory", projectDir];
    const dockerCompose = await this.safeExec("docker", [...commonArgs, ...trailingArgs], projectDir);
    if (dockerCompose.ok && dockerCompose.result.exitCode === 0) {
      return dockerCompose.result;
    }

    const legacyArgs = ["-f", composeFilePath, ...trailingArgs];
    const dockerComposeLegacy = await this.safeExec("docker-compose", legacyArgs, projectDir);
    if (dockerComposeLegacy.ok && dockerComposeLegacy.result.exitCode === 0) {
      return dockerComposeLegacy.result;
    }

    if (dockerCompose.ok) {
      return dockerCompose.result;
    }
    if (dockerComposeLegacy.ok) {
      return dockerComposeLegacy.result;
    }

    throw {
      code: "MATRIX_COMPOSE_UNAVAILABLE",
      message: "Neither docker compose nor docker-compose could be executed",
      retryable: false,
      details: {
        dockerComposeError: dockerCompose.error,
        dockerComposeLegacyError: dockerComposeLegacy.error,
      },
    };
  }

  private async safeExec(
    command: string,
    args: string[],
    cwd: string,
  ): Promise<{ ok: true; result: ExecResult } | { ok: false; error: string }> {
    try {
      const result = await this.execRunner.run({
        command,
        args,
        options: {
          cwd,
        },
      });
      return { ok: true, result };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async ensureBaseDir(): Promise<string> {
    if (this.resolvedBaseDir !== null) {
      return this.resolvedBaseDir;
    }

    const preferred = join(this.paths.stateDir, "bundled-matrix");
    try {
      await mkdir(preferred, { recursive: true });
      await access(preferred, fsConstants.W_OK);
      this.resolvedBaseDir = preferred;
      return preferred;
    } catch (error) {
      const fallback = resolve(process.cwd(), ".sovereign-node-dev", "bundled-matrix");
      await mkdir(fallback, { recursive: true });
      this.logger.debug(
        {
          preferredMatrixStateDir: preferred,
          fallbackMatrixStateDir: fallback,
          error: error instanceof Error ? error.message : String(error),
        },
        "Bundled Matrix state dir is not writable; using local fallback for scaffold/dev execution",
      );
      this.resolvedBaseDir = fallback;
      return fallback;
    }
  }
}

type EnvTemplateInput = {
  homeserverDomain: string;
  publicBaseUrl: string;
  federationEnabled: boolean;
  postgresPassword: string;
  synapseConfigPath: string;
};

const renderComposeYaml = (): string => `
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: synapse
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_DB: synapse
    volumes:
      - ./postgres-data:/var/lib/postgresql/data

  synapse:
    image: matrixdotorg/synapse:latest
    restart: unless-stopped
    depends_on:
      - postgres
    environment:
      SYNAPSE_CONFIG_PATH: \${SYNAPSE_CONFIG_PATH}
    ports:
      - "127.0.0.1:8008:8008"
    volumes:
      - ./synapse:/data
`.trim();

const renderEnvFile = (input: EnvTemplateInput): string =>
  [
    `POSTGRES_PASSWORD=${input.postgresPassword}`,
    `SYNAPSE_CONFIG_PATH=${input.synapseConfigPath}`,
    `MATRIX_HOMESERVER_DOMAIN=${input.homeserverDomain}`,
    `MATRIX_PUBLIC_BASE_URL=${input.publicBaseUrl}`,
    `MATRIX_FEDERATION_ENABLED=${input.federationEnabled ? "true" : "false"}`,
  ].join("\n");

type SynapseConfigInput = {
  homeserverDomain: string;
  publicBaseUrl: string;
  federationEnabled: boolean;
  postgresPassword: string;
  registrationSharedSecret: string;
  macaroonSecret: string;
  formSecret: string;
  signingKeyFile: string;
};

const renderSynapseConfig = (input: SynapseConfigInput): string => {
  const federationWhitelistLine = input.federationEnabled
    ? ""
    : "federation_domain_whitelist: []\n";

  return [
    `server_name: "${input.homeserverDomain}"`,
    `public_baseurl: "${ensureTrailingSlash(input.publicBaseUrl)}"`,
    "pid_file: /data/homeserver.pid",
    "",
    "listeners:",
    "  - port: 8008",
    "    tls: false",
    "    type: http",
    "    x_forwarded: false",
    "    bind_addresses: ['0.0.0.0']",
    "    resources:",
    "      - names: [client, federation]",
    "        compress: false",
    "",
    "database:",
    "  name: psycopg2",
    "  args:",
    "    user: synapse",
    `    password: "${input.postgresPassword}"`,
    "    database: synapse",
    "    host: postgres",
    "",
    "report_stats: false",
    "enable_registration: false",
    "enable_registration_without_verification: false",
    "allow_public_rooms_without_auth: false",
    "allow_public_rooms_over_federation: false",
    `registration_shared_secret: "${input.registrationSharedSecret}"`,
    `macaroon_secret_key: "${input.macaroonSecret}"`,
    `form_secret: "${input.formSecret}"`,
    `signing_key_path: "/data/${input.signingKeyFile}"`,
    'media_store_path: "/data/media_store"',
    'log_config: "/data/log.config"',
    federationWhitelistLine.trimEnd(),
  ]
    .filter((line) => line.length > 0)
    .join("\n");
};

const renderSigningKey = (fileName: string): string => {
  const keyId = "ed25519:a_1";
  const seed = randomUUID().replaceAll("-", "");
  return `${fileName} ${keyId} ${seed}`;
};

const renderSynapseLogConfig = (): string => `
version: 1
formatters:
  precise:
    format: "%(asctime)s %(name)s %(lineno)d %(levelname)s %(request)s %(message)s"
handlers:
  console:
    class: logging.StreamHandler
    formatter: precise
loggers:
  synapse:
    level: INFO
root:
  level: INFO
  handlers: [console]
disable_existing_loggers: false
`.trim();

const slugifyProjectName = (value: string): string => {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "matrix-local-dev";
};

const ensureTrailingSlash = (value: string): string => (value.endsWith("/") ? value : `${value}/`);

const truncateText = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}...(truncated)`;
};
