import { randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { TestMatrixRequest } from "../contracts/api.js";
import type { CheckResult } from "../contracts/common.js";
import type { InstallRequest, TestMatrixResult } from "../contracts/index.js";
import type { SovereignPaths } from "../config/paths.js";
import type { Logger } from "../logging/logger.js";
import type { ExecRunner, ExecResult } from "./exec.js";

const MATRIX_INTERNAL_BASE_URL = "http://127.0.0.1:8008";
const MATRIX_READY_TIMEOUT_MS = 180_000;
const MATRIX_READY_POLL_INTERVAL_MS = 1_500;
const MATRIX_HTTP_TIMEOUT_MS = 8_000;
const MATRIX_LOGIN_RETRY_ATTEMPTS = 5;
const MATRIX_LOGIN_RETRY_DELAY_MS = 500;
const MATRIX_COMPOSE_COMMAND_TIMEOUT_MS = 180_000;
const MATRIX_BOOTSTRAP_SECRET_DIR = "bootstrap-secrets";
const DEFAULT_SYNAPSE_IMAGE = "matrixdotorg/synapse:v1.125.0";
const DEFAULT_CADDY_IMAGE = "caddy:2.10.2-alpine";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type BundledMatrixTlsMode = "auto" | "internal" | "local-dev";

export type BundledMatrixProvisionResult = {
  projectDir: string;
  composeFilePath: string;
  homeserverDomain: string;
  publicBaseUrl: string;
  adminBaseUrl: string;
  federationEnabled: boolean;
  tlsMode: BundledMatrixTlsMode;
};

type MatrixBootstrapAccount = {
  localpart: string;
  userId: string;
  passwordSecretRef: string;
  accessToken: string;
};

export type BundledMatrixAccountsResult = {
  operator: MatrixBootstrapAccount;
  bot: MatrixBootstrapAccount;
};

export type BundledMatrixRoomBootstrapResult = {
  roomId: string;
  roomName: string;
};

export interface BundledMatrixProvisioner {
  provision(req: InstallRequest): Promise<BundledMatrixProvisionResult>;
  bootstrapAccounts(
    req: InstallRequest,
    provision: BundledMatrixProvisionResult,
  ): Promise<BundledMatrixAccountsResult>;
  bootstrapRoom(
    req: InstallRequest,
    provision: BundledMatrixProvisionResult,
    accounts: BundledMatrixAccountsResult,
  ): Promise<BundledMatrixRoomBootstrapResult>;
  test(req: TestMatrixRequest): Promise<TestMatrixResult>;
}

export class DockerComposeBundledMatrixProvisioner implements BundledMatrixProvisioner {
  private resolvedBaseDir: string | null = null;

  constructor(
    private readonly execRunner: ExecRunner,
    private readonly logger: Logger,
    private readonly paths: SovereignPaths,
    private readonly fetchImpl: FetchLike = defaultFetch,
  ) {}

  async provision(req: InstallRequest): Promise<BundledMatrixProvisionResult> {
    const tlsMode = req.matrix.tlsMode ?? "auto";
    if (tlsMode === "manual") {
      throw {
        code: "MATRIX_TLS_MODE_UNSUPPORTED",
        message:
          "Bundled Matrix provisioning does not yet support tlsMode=manual",
        retryable: false,
        details: {
          requestedTlsMode: tlsMode,
          supportedTlsModes: ["auto", "internal", "local-dev"],
        },
      };
    }
    if (tlsMode !== "local-dev" && tlsMode !== "auto" && tlsMode !== "internal") {
      throw {
        code: "MATRIX_TLS_MODE_UNSUPPORTED",
        message: "Bundled Matrix provisioning received an unknown tlsMode",
        retryable: false,
        details: {
          requestedTlsMode: tlsMode,
        },
      };
    }

    const homeserverDomain = req.matrix.homeserverDomain;
    const publicBaseUrl = normalizePublicBaseUrl(req.matrix.publicBaseUrl);
    validateBundledTlsMode({
      tlsMode,
      homeserverDomain,
      publicBaseUrl,
    });
    const federationEnabled = req.matrix.federationEnabled ?? false;
    const baseDir = await this.ensureBaseDir();
    const projectSlug = slugifyProjectName(homeserverDomain);
    const projectDir = join(baseDir, projectSlug);
    const synapseDir = join(projectDir, "synapse");
    const postgresDir = join(projectDir, "postgres-data");
    const wellKnownDir = join(projectDir, "well-known");
    const proxyDir = join(projectDir, "reverse-proxy");
    const proxyDataDir = join(projectDir, "reverse-proxy-data");
    const proxyConfigDir = join(projectDir, "reverse-proxy-config");
    const composeFilePath = join(projectDir, "compose.yaml");
    const envFilePath = join(projectDir, ".env");

    await mkdir(synapseDir, { recursive: true });
    await mkdir(postgresDir, { recursive: true });
    if (tlsMode !== "local-dev") {
      await mkdir(wellKnownDir, { recursive: true });
      await mkdir(join(wellKnownDir, ".well-known", "matrix"), { recursive: true });
      await mkdir(proxyDir, { recursive: true });
      await mkdir(proxyDataDir, { recursive: true });
      await mkdir(proxyConfigDir, { recursive: true });
    }
    await ensureDirectoryTreeWritable(synapseDir);
    await ensureDirectoryTreeWritable(postgresDir);
    if (tlsMode !== "local-dev") {
      await ensureDirectoryTreeWritable(wellKnownDir);
      await ensureDirectoryTreeWritable(proxyDir);
      await ensureDirectoryTreeWritable(proxyDataDir);
      await ensureDirectoryTreeWritable(proxyConfigDir);
    }

    const existingEnv = await this.readExistingEnv(projectDir);
    const existingPostgresPassword = existingEnv.POSTGRES_PASSWORD?.trim();
    const generated = {
      postgresPassword:
        existingPostgresPassword !== undefined && existingPostgresPassword.length > 0
          ? existingPostgresPassword
          : `pg_${randomUUID().replaceAll("-", "")}`,
      registrationSharedSecret: randomUUID().replaceAll("-", ""),
      macaroonSecret: randomUUID().replaceAll("-", ""),
      formSecret: randomUUID().replaceAll("-", ""),
      signingKeyFile: `${homeserverDomain}.signing.key`,
    };

    const composeYaml = renderComposeYaml({
      synapseImage: resolveSynapseImage(),
      caddyImage: DEFAULT_CADDY_IMAGE,
      tlsMode,
      localSynapsePortBinding:
        tlsMode !== "local-dev"
          ? "127.0.0.1:8008:8008"
          : resolveLocalDevSynapsePortBinding(publicBaseUrl),
      httpsProxyPortBinding:
        tlsMode !== "local-dev" ? resolveAutoHttpsProxyPortBinding(publicBaseUrl) : undefined,
    });
    const envFile = renderEnvFile({
      homeserverDomain,
      publicBaseUrl,
      federationEnabled,
      postgresPassword: generated.postgresPassword,
      synapseConfigPath: "/data/homeserver.yaml",
    });
    const homeserverYaml = renderSynapseConfig({
      homeserverDomain,
      publicBaseUrl,
      federationEnabled,
      behindReverseProxy: tlsMode !== "local-dev",
      postgresPassword: generated.postgresPassword,
      registrationSharedSecret: generated.registrationSharedSecret,
      macaroonSecret: generated.macaroonSecret,
      formSecret: generated.formSecret,
      signingKeyFile: generated.signingKeyFile,
    });
    const signingKey = renderSigningKey();
    const logConfig = renderSynapseLogConfig();

    const writes = [
      writeFile(composeFilePath, `${composeYaml}\n`, "utf8"),
      writeFile(envFilePath, `${envFile}\n`, "utf8"),
      writeFile(join(synapseDir, "homeserver.yaml"), `${homeserverYaml}\n`, "utf8"),
      writeFile(join(synapseDir, generated.signingKeyFile), `${signingKey}\n`, "utf8"),
      writeFile(join(synapseDir, "log.config"), `${logConfig}\n`, "utf8"),
    ];
    if (tlsMode !== "local-dev") {
      const wellKnown = renderWellKnownFiles({
        homeserverDomain,
        publicBaseUrl,
      });
      writes.push(
        writeFile(
          join(proxyDir, "Caddyfile"),
          `${renderCaddyfile(homeserverDomain, tlsMode)}\n`,
          "utf8",
        ),
        writeFile(
          join(wellKnownDir, ".well-known", "matrix", "client"),
          `${wellKnown.client}\n`,
          "utf8",
        ),
        writeFile(
          join(wellKnownDir, ".well-known", "matrix", "server"),
          `${wellKnown.server}\n`,
          "utf8",
        ),
      );
    }

    await Promise.all(writes);
    await ensureDirectoryTreeWritable(synapseDir);
    await ensureDirectoryTreeWritable(postgresDir);
    if (tlsMode !== "local-dev") {
      await ensureDirectoryTreeWritable(wellKnownDir);
      await ensureDirectoryTreeWritable(proxyDir);
      await ensureDirectoryTreeWritable(proxyDataDir);
      await ensureDirectoryTreeWritable(proxyConfigDir);
    }

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
      "Bundled Matrix compose bundle generated and validated",
    );

    return {
      projectDir,
      composeFilePath,
      homeserverDomain,
      publicBaseUrl,
      adminBaseUrl: MATRIX_INTERNAL_BASE_URL,
      federationEnabled,
      tlsMode,
    };
  }

  async bootstrapAccounts(
    req: InstallRequest,
    provision: BundledMatrixProvisionResult,
  ): Promise<BundledMatrixAccountsResult> {
    await this.ensureStackRunning(provision);
    await this.waitForSynapseReadyWithRecovery(provision);

    const operatorLocalpart = sanitizeMatrixLocalpart(req.operator.username, "operator");
    const botLocalpart = chooseBotLocalpart(operatorLocalpart);
    const secretsDir = await this.ensureBootstrapSecretsDir(provision.projectDir);
    const operatorSecretName = `${operatorLocalpart}.password`;
    const botSecretName = `${botLocalpart}.password`;
    const operatorPassword =
      (await this.readSecretFile(secretsDir, operatorSecretName)) ?? generatePassword();
    const botPassword = (await this.readSecretFile(secretsDir, botSecretName)) ?? generatePassword();

    const operatorPasswordSecretRef = await this.writeSecretFile(
      secretsDir,
      operatorSecretName,
      operatorPassword,
    );
    const botPasswordSecretRef = await this.writeSecretFile(
      secretsDir,
      botSecretName,
      botPassword,
    );

    try {
      return await this.bootstrapAccountsWithKnownPasswords({
        provision,
        operatorLocalpart,
        operatorPassword,
        operatorPasswordSecretRef,
        botLocalpart,
        botPassword,
        botPasswordSecretRef,
      });
    } catch (error) {
      if (!isRecoverableAccountCredentialFailure(error)) {
        throw error;
      }

      this.logger.warn(
        {
          projectDir: provision.projectDir,
          homeserverDomain: provision.homeserverDomain,
          operatorLocalpart,
          botLocalpart,
        },
        "Detected stale Matrix bootstrap credentials; resetting bundled Matrix Postgres state and retrying account bootstrap",
      );

      await this.resetBundledPostgresState(provision);
      await this.ensureStackRunning(provision);
      await this.waitForSynapseReadyWithRecovery(provision);

      const recoveredOperatorPassword = generatePassword();
      const recoveredBotPassword = generatePassword();
      const recoveredOperatorPasswordSecretRef = await this.writeSecretFile(
        secretsDir,
        operatorSecretName,
        recoveredOperatorPassword,
      );
      const recoveredBotPasswordSecretRef = await this.writeSecretFile(
        secretsDir,
        botSecretName,
        recoveredBotPassword,
      );

      return this.bootstrapAccountsWithKnownPasswords({
        provision,
        operatorLocalpart,
        operatorPassword: recoveredOperatorPassword,
        operatorPasswordSecretRef: recoveredOperatorPasswordSecretRef,
        botLocalpart,
        botPassword: recoveredBotPassword,
        botPasswordSecretRef: recoveredBotPasswordSecretRef,
      });
    }
  }

  private async bootstrapAccountsWithKnownPasswords(input: {
    provision: BundledMatrixProvisionResult;
    operatorLocalpart: string;
    operatorPassword: string;
    operatorPasswordSecretRef: string;
    botLocalpart: string;
    botPassword: string;
    botPasswordSecretRef: string;
  }): Promise<BundledMatrixAccountsResult> {
    await this.registerSynapseUser(input.provision, {
      localpart: input.operatorLocalpart,
      password: input.operatorPassword,
      admin: true,
    });
    await this.registerSynapseUser(input.provision, {
      localpart: input.botLocalpart,
      password: input.botPassword,
      admin: false,
    });

    const operatorSession = await this.loginUser(
      input.provision.adminBaseUrl,
      input.operatorLocalpart,
      input.operatorPassword,
    );
    const botSession = await this.loginUser(
      input.provision.adminBaseUrl,
      input.botLocalpart,
      input.botPassword,
    );

    const accounts: BundledMatrixAccountsResult = {
      operator: {
        localpart: input.operatorLocalpart,
        userId: operatorSession.userId,
        passwordSecretRef: input.operatorPasswordSecretRef,
        accessToken: operatorSession.accessToken,
      },
      bot: {
        localpart: input.botLocalpart,
        userId: botSession.userId,
        passwordSecretRef: input.botPasswordSecretRef,
        accessToken: botSession.accessToken,
      },
    };

    this.logger.info(
      {
        projectDir: input.provision.projectDir,
        homeserverDomain: input.provision.homeserverDomain,
        operatorUserId: accounts.operator.userId,
        botUserId: accounts.bot.userId,
      },
      "Bundled Matrix accounts bootstrapped",
    );

    return accounts;
  }

  async bootstrapRoom(
    req: InstallRequest,
    provision: BundledMatrixProvisionResult,
    accounts: BundledMatrixAccountsResult,
  ): Promise<BundledMatrixRoomBootstrapResult> {
    await this.waitForSynapseReady(provision.adminBaseUrl);

    const roomName = req.matrix.alertRoomName?.trim() || "Sovereign Alerts";
    const created = await this.matrixJsonRequest<{ room_id?: unknown }>({
      baseUrl: provision.adminBaseUrl,
      path: "/_matrix/client/v3/createRoom",
      method: "POST",
      accessToken: accounts.operator.accessToken,
      body: {
        name: roomName,
        preset: "private_chat",
        visibility: "private",
      },
      errorCode: "MATRIX_ROOM_CREATE_FAILED",
      errorMessage: "Failed to create the Matrix alert room",
      retryable: true,
    });

    const roomId = typeof created.room_id === "string" ? created.room_id.trim() : "";
    if (roomId.length === 0) {
      throw {
        code: "MATRIX_ROOM_CREATE_FAILED",
        message: "Matrix room creation returned an invalid room_id",
        retryable: true,
      };
    }

    await this.matrixJsonRequest({
      baseUrl: provision.adminBaseUrl,
      path: `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`,
      method: "POST",
      accessToken: accounts.operator.accessToken,
      body: {
        user_id: accounts.bot.userId,
      },
      errorCode: "MATRIX_ROOM_INVITE_FAILED",
      errorMessage: "Failed to invite bot account into the Matrix alert room",
      retryable: true,
    });

    await this.matrixJsonRequest({
      baseUrl: provision.adminBaseUrl,
      path: `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
      method: "POST",
      accessToken: accounts.bot.accessToken,
      body: {},
      errorCode: "MATRIX_ROOM_JOIN_FAILED",
      errorMessage: "Bot account could not join the Matrix alert room",
      retryable: true,
    });

    const result: BundledMatrixRoomBootstrapResult = {
      roomId,
      roomName,
    };
    this.logger.info(
      {
        projectDir: provision.projectDir,
        roomId: result.roomId,
        roomName: result.roomName,
      },
      "Bundled Matrix alert room bootstrapped",
    );
    return result;
  }

  async test(req: TestMatrixRequest): Promise<TestMatrixResult> {
    const homeserverUrl = normalizePublicBaseUrl(req.publicBaseUrl);
    const checks: CheckResult[] = [];

    const clientProbe = await this.runProbe({
      id: "matrix-client-api",
      name: "Matrix client API",
      passMessage: "Matrix client API is reachable",
      failMessage: "Matrix client API is not reachable",
      run: async () => {
        const payload = await this.matrixJsonRequest<{ versions?: unknown }>({
          baseUrl: homeserverUrl,
          path: "/_matrix/client/versions",
          method: "GET",
          errorCode: "MATRIX_CLIENT_API_UNREACHABLE",
          errorMessage: "Matrix client API probe failed",
          retryable: true,
        });
        if (!Array.isArray(payload.versions)) {
          throw new Error("Matrix client versions response did not include a versions array");
        }
      },
    });
    checks.push(clientProbe.check);

    const federationEnabled = req.federationEnabled ?? false;
    let serverDiscovery: { required: boolean; ok: boolean };
    if (federationEnabled) {
      const federationProbe = await this.runProbe({
        id: "matrix-federation-api",
        name: "Matrix federation API",
        passMessage: "Matrix federation API is reachable",
        failMessage: "Matrix federation API is not reachable",
        run: async () => {
          const payload = await this.matrixJsonRequest<{ server?: unknown }>({
            baseUrl: homeserverUrl,
            path: "/_matrix/federation/v1/version",
            method: "GET",
            errorCode: "MATRIX_FEDERATION_API_UNREACHABLE",
            errorMessage: "Matrix federation probe failed",
            retryable: true,
          });
          if (!isRecord(payload.server)) {
            throw new Error("Matrix federation response did not include server metadata");
          }
        },
      });
      checks.push(federationProbe.check);
      serverDiscovery = {
        required: true,
        ok: federationProbe.ok,
      };
    } else {
      checks.push(
        check(
          "matrix-federation-api",
          "Matrix federation API",
          "skip",
          "Matrix federation is disabled; federation probe skipped",
        ),
      );
      serverDiscovery = {
        required: false,
        ok: true,
      };
    }

    return {
      ok: checks.every((entry) => entry.status !== "fail"),
      homeserverUrl,
      clientDiscovery: {
        required: false,
        ok: true,
      },
      serverDiscovery,
      checks,
    };
  }

  private async ensureStackRunning(provision: BundledMatrixProvisionResult): Promise<void> {
    const services = ["postgres", "synapse"];
    if (provision.tlsMode !== "local-dev") {
      services.push("reverse-proxy");
    }
    const upArgs = ["up", "-d", "--remove-orphans", "--force-recreate", ...services];
    const composeUp = await this.runComposeCommand(
      provision.projectDir,
      provision.composeFilePath,
      upArgs,
    );
    if (composeUp.exitCode === 0) {
      return;
    }

    const composeDown = await this.runComposeCommand(
      provision.projectDir,
      provision.composeFilePath,
      ["down", "--remove-orphans"],
    );
    const retryUp = await this.runComposeCommand(
      provision.projectDir,
      provision.composeFilePath,
      upArgs,
    );
    if (retryUp.exitCode === 0) {
      this.logger.warn(
        {
          projectDir: provision.projectDir,
          firstAttemptExitCode: composeUp.exitCode,
        },
        "Bundled Matrix stack start failed once and recovered after compose down/up retry",
      );
      return;
    }

    throw {
      code: "MATRIX_STACK_START_FAILED",
      message: "Failed to start bundled Matrix services with Docker Compose",
      retryable: true,
      details: {
        firstAttempt: {
          exitCode: composeUp.exitCode,
          stderr: truncateText(composeUp.stderr, 4000),
          stdout: truncateText(composeUp.stdout, 4000),
        },
        downAttempt: {
          exitCode: composeDown.exitCode,
          stderr: truncateText(composeDown.stderr, 3000),
          stdout: truncateText(composeDown.stdout, 3000),
        },
        retryAttempt: {
          exitCode: retryUp.exitCode,
          stderr: truncateText(retryUp.stderr, 4000),
          stdout: truncateText(retryUp.stdout, 4000),
        },
        projectDir: provision.projectDir,
        composeFilePath: provision.composeFilePath,
      },
    };
  }

  private async registerSynapseUser(
    provision: BundledMatrixProvisionResult,
    input: {
      localpart: string;
      password: string;
      admin: boolean;
    },
  ): Promise<void> {
    const args = [
      "exec",
      "-T",
      "synapse",
      "register_new_matrix_user",
      "-u",
      input.localpart,
      "-p",
      input.password,
      ...(input.admin ? ["-a"] : ["--no-admin"]),
      "-c",
      "/data/homeserver.yaml",
      provision.adminBaseUrl,
    ];
    let registerResult: ExecResult;
    try {
      registerResult = await this.runComposeCommand(
        provision.projectDir,
        provision.composeFilePath,
        args,
      );
    } catch (error) {
      throw {
        code: "MATRIX_ACCOUNT_BOOTSTRAP_FAILED",
        message: `Failed to register Matrix account '${input.localpart}'`,
        retryable: true,
        details: {
          localpart: input.localpart,
          admin: input.admin,
          projectDir: provision.projectDir,
          error: describeError(error),
        },
      };
    }
    if (registerResult.exitCode !== 0) {
      throw {
        code: "MATRIX_ACCOUNT_BOOTSTRAP_FAILED",
        message: `Failed to register Matrix account '${input.localpart}'`,
        retryable: true,
        details: {
          localpart: input.localpart,
          admin: input.admin,
          exitCode: registerResult.exitCode,
          stderr: truncateText(registerResult.stderr, 4000),
          stdout: truncateText(registerResult.stdout, 4000),
          projectDir: provision.projectDir,
        },
      };
    }
  }

  private async loginUser(
    baseUrl: string,
    localpart: string,
    password: string,
  ): Promise<{ accessToken: string; userId: string }> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MATRIX_LOGIN_RETRY_ATTEMPTS; attempt += 1) {
      try {
        const payload = await this.matrixJsonRequest<{
          access_token?: unknown;
          user_id?: unknown;
        }>({
          baseUrl,
          path: "/_matrix/client/v3/login",
          method: "POST",
          body: {
            type: "m.login.password",
            identifier: {
              type: "m.id.user",
              user: localpart,
            },
            password,
          },
          errorCode: "MATRIX_LOGIN_FAILED",
          errorMessage: `Matrix login failed for '${localpart}'`,
          retryable: false,
        });

        const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
        const userId = typeof payload.user_id === "string" ? payload.user_id : "";
        if (accessToken.length === 0 || userId.length === 0) {
          throw {
            code: "MATRIX_LOGIN_FAILED",
            message: `Matrix login response for '${localpart}' did not include an access token`,
            retryable: false,
          };
        }

        return {
          accessToken,
          userId,
        };
      } catch (error) {
        lastError = error;
        if (!isRecoverableAccountCredentialFailure(error) || attempt >= MATRIX_LOGIN_RETRY_ATTEMPTS) {
          break;
        }
        await delay(MATRIX_LOGIN_RETRY_DELAY_MS);
      }
    }

    throw lastError;
  }

  private async waitForSynapseReady(baseUrl: string): Promise<void> {
    const deadline = Date.now() + MATRIX_READY_TIMEOUT_MS;
    let lastError = "unknown";

    while (Date.now() < deadline) {
      try {
        const payload = await this.matrixJsonRequest<{ versions?: unknown }>({
          baseUrl,
          path: "/_matrix/client/versions",
          method: "GET",
          errorCode: "MATRIX_READY_CHECK_FAILED",
          errorMessage: "Matrix readiness check failed",
          retryable: true,
        });
        if (Array.isArray(payload.versions)) {
          return;
        }
        lastError = "versions array missing from readiness response";
      } catch (error) {
        lastError = describeError(error);
      }

      await delay(MATRIX_READY_POLL_INTERVAL_MS);
    }

    throw {
      code: "MATRIX_WAIT_READY_TIMEOUT",
      message: "Timed out waiting for bundled Matrix homeserver readiness",
      retryable: true,
      details: {
        baseUrl,
        timeoutMs: MATRIX_READY_TIMEOUT_MS,
        lastError,
      },
    };
  }

  private async waitForSynapseReadyWithRecovery(
    provision: BundledMatrixProvisionResult,
  ): Promise<void> {
    const diagnosticsTrail: Array<Record<string, unknown>> = [];
    const maxRecoveries = 2;

    for (let attempt = 0; attempt <= maxRecoveries; attempt += 1) {
      try {
        await this.waitForSynapseReady(provision.adminBaseUrl);
        return;
      } catch (error) {
        if (!(isStructuredError(error) && error.code === "MATRIX_WAIT_READY_TIMEOUT")) {
          throw error;
        }

        const diagnostics = await this.collectComposeDiagnostics(provision);
        const synapseLogs =
          typeof diagnostics.synapseLogs === "string" ? diagnostics.synapseLogs : "";
        const recoverable = isRecoverablePostgresBootstrapFailure(synapseLogs);
        diagnosticsTrail.push({
          attempt: attempt + 1,
          recoverable,
          diagnostics,
        });

        if (!recoverable || attempt === maxRecoveries) {
          throw {
            ...error,
            details: {
              ...(error.details ?? {}),
              recoveryAttempts: diagnosticsTrail,
            },
          };
        }

        this.logger.warn(
          {
            projectDir: provision.projectDir,
            recoveryAttempt: attempt + 1,
            maxRecoveries,
          },
          "Detected recoverable bundled Matrix Postgres bootstrap mismatch; resetting postgres data and retrying",
        );

        await this.resetBundledPostgresState(provision);
        await this.ensureStackRunning(provision);
      }
    }
  }

  private async resetBundledPostgresState(
    provision: BundledMatrixProvisionResult,
  ): Promise<void> {
    await this.runComposeCommand(
      provision.projectDir,
      provision.composeFilePath,
      ["down", "--remove-orphans"],
    );
    const postgresDir = join(provision.projectDir, "postgres-data");
    await rm(postgresDir, { recursive: true, force: true });
    await mkdir(postgresDir, { recursive: true });
    await ensureDirectoryTreeWritable(postgresDir);
  }

  private async collectComposeDiagnostics(
    provision: BundledMatrixProvisionResult,
  ): Promise<Record<string, unknown>> {
    const ps = await this.safeComposeDiagnosticCommand(
      provision,
      ["ps", "-a"],
      "ps-unavailable",
    );
    const logs = await this.safeComposeDiagnosticCommand(
      provision,
      ["logs", "--no-color", "--tail", "200", "synapse"],
      "logs-unavailable",
    );
    return {
      composePs: ps,
      synapseLogs: logs,
    };
  }

  private async safeComposeDiagnosticCommand(
    provision: BundledMatrixProvisionResult,
    args: string[],
    fallback: string,
  ): Promise<string> {
    try {
      const result = await this.runComposeCommand(
        provision.projectDir,
        provision.composeFilePath,
        args,
      );
      return truncateText(`${result.stdout}\n${result.stderr}`, 6000);
    } catch (error) {
      return `${fallback}: ${describeError(error)}`;
    }
  }

  private async runProbe(input: {
    id: string;
    name: string;
    passMessage: string;
    failMessage: string;
    run: () => Promise<void>;
  }): Promise<{ ok: boolean; check: CheckResult }> {
    try {
      await input.run();
      return {
        ok: true,
        check: check(input.id, input.name, "pass", input.passMessage),
      };
    } catch (error) {
      return {
        ok: false,
        check: check(input.id, input.name, "fail", input.failMessage, {
          error: describeError(error),
        }),
      };
    }
  }

  private async matrixJsonRequest<T>(input: {
    baseUrl: string;
    path: string;
    method: "GET" | "POST";
    accessToken?: string;
    body?: unknown;
    errorCode: string;
    errorMessage: string;
    retryable: boolean;
  }): Promise<T> {
    const url = new URL(input.path, ensureTrailingSlash(input.baseUrl)).toString();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MATRIX_HTTP_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, {
        method: input.method,
        headers: {
          Accept: "application/json",
          ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(input.accessToken === undefined
            ? {}
            : { Authorization: `Bearer ${input.accessToken}` }),
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        signal: controller.signal,
      });

      const rawBody = await response.text();
      const parsedBody = parseJsonSafely(rawBody);
      if (!response.ok) {
        throw {
          code: input.errorCode,
          message: input.errorMessage,
          retryable: input.retryable,
          details: {
            url,
            status: response.status,
            body: summarizeUnknown(parsedBody),
          },
        };
      }

      return parsedBody as T;
    } catch (error) {
      if (isStructuredError(error)) {
        throw error;
      }
      throw {
        code: input.errorCode,
        message: input.errorMessage,
        retryable: input.retryable,
        details: {
          url,
          error: describeError(error),
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async ensureBootstrapSecretsDir(projectDir: string): Promise<string> {
    const dir = join(projectDir, MATRIX_BOOTSTRAP_SECRET_DIR);
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o700);
    return dir;
  }

  private async writeSecretFile(
    secretsDir: string,
    fileName: string,
    value: string,
  ): Promise<string> {
    const secretPath = join(secretsDir, fileName);
    await writeFile(secretPath, `${value}\n`, "utf8");
    await chmod(secretPath, 0o600);
    return `file:${secretPath}`;
  }

  private async readSecretFile(secretsDir: string, fileName: string): Promise<string | null> {
    const secretPath = join(secretsDir, fileName);
    try {
      const raw = await readFile(secretPath, "utf8");
      const value = stripSingleTrailingNewline(raw);
      return value.length > 0 ? value : null;
    } catch {
      return null;
    }
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
          timeout: MATRIX_COMPOSE_COMMAND_TIMEOUT_MS,
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

  private async readExistingEnv(projectDir: string): Promise<Record<string, string>> {
    const envPath = join(projectDir, ".env");
    try {
      const raw = await readFile(envPath, "utf8");
      return parseSimpleEnv(raw);
    } catch {
      return {};
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

type ComposeTemplateInput = {
  synapseImage: string;
  caddyImage: string;
  tlsMode: BundledMatrixTlsMode;
  localSynapsePortBinding: string;
  httpsProxyPortBinding?: string;
};

const renderComposeYaml = (input: ComposeTemplateInput): string => `
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: synapse
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_DB: synapse
      POSTGRES_INITDB_ARGS: "--encoding=UTF8 --locale=C"
    volumes:
      - ./postgres-data:/var/lib/postgresql/data

  synapse:
    image: ${input.synapseImage}
    restart: unless-stopped
    depends_on:
      - postgres
    environment:
      SYNAPSE_CONFIG_PATH: \${SYNAPSE_CONFIG_PATH}
    ports:
      - "${input.localSynapsePortBinding}"
    volumes:
      - ./synapse:/data
${input.tlsMode !== "local-dev"
  ? `

  reverse-proxy:
    image: ${input.caddyImage}
    restart: unless-stopped
    depends_on:
      - synapse
    ports:
      - "80:80"
      - "${input.httpsProxyPortBinding}"
    volumes:
      - ./reverse-proxy/Caddyfile:/etc/caddy/Caddyfile:ro
      - ./well-known:/srv:ro
      - ./reverse-proxy-data:/data
      - ./reverse-proxy-config:/config`
  : ""}
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
  behindReverseProxy: boolean;
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
    `    x_forwarded: ${input.behindReverseProxy ? "true" : "false"}`,
    "    bind_addresses: ['0.0.0.0']",
    "    resources:",
    "      - names: [client, federation]",
    "        compress: false",
    "",
    "database:",
    "  name: psycopg2",
    "  allow_unsafe_locale: true",
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

const renderSigningKey = (): string => {
  const keyType = "ed25519";
  const keyId = "a_1";
  const seed = randomBytes(32).toString("base64").replace(/=+$/g, "");
  return `${keyType} ${keyId} ${seed}`;
};

const resolveSynapseImage = (): string => {
  const configured = process.env.SOVEREIGN_MATRIX_SYNAPSE_IMAGE?.trim();
  if (configured !== undefined && configured.length > 0) {
    return configured;
  }
  return DEFAULT_SYNAPSE_IMAGE;
};

const resolveLocalDevSynapsePortBinding = (publicBaseUrl: string): string => {
  const parsed = new URL(publicBaseUrl);
  const host = parsed.hostname.trim().toLowerCase();
  const hostBind = isLoopbackHostname(host) ? "127.0.0.1" : "0.0.0.0";
  const publicPort =
    parsed.port.length > 0 ? parsed.port : parsed.protocol === "https:" ? "443" : "80";
  return `${hostBind}:${publicPort}:8008`;
};

const resolveAutoHttpsProxyPortBinding = (publicBaseUrl: string): string => {
  const parsed = new URL(publicBaseUrl);
  const httpsPort = parsed.port.length > 0 ? parsed.port : "443";
  return `${httpsPort}:443`;
};

const isLoopbackHostname = (value: string): boolean =>
  value === "localhost"
  || value === "127.0.0.1"
  || value === "::1"
  || value === "[::1]";

const isIpAddressHostname = (value: string): boolean =>
  /^[0-9]{1,3}(?:\.[0-9]{1,3}){3}$/.test(value) || value.includes(":");

const isLikelyLanOnlyHostname = (value: string): boolean =>
  isLoopbackHostname(value)
  || isIpAddressHostname(value)
  || !value.includes(".")
  || value.endsWith(".local")
  || value.endsWith(".localhost")
  || value.endsWith(".home.arpa")
  || value.endsWith(".internal")
  || value.endsWith(".lan");

const validateBundledTlsMode = (input: {
  tlsMode: BundledMatrixTlsMode;
  homeserverDomain: string;
  publicBaseUrl: string;
}): void => {
  if (input.tlsMode === "local-dev") {
    return;
  }

  const parsed = new URL(input.publicBaseUrl);
  const publicHost = parsed.hostname.trim().toLowerCase();
  const publicPort = parsed.port.length > 0 ? parsed.port : "443";
  const homeserverDomain = input.homeserverDomain.trim().toLowerCase();

  if (parsed.protocol !== "https:") {
    throw {
      code: "MATRIX_TLS_MODE_INVALID",
      message: `Bundled Matrix tlsMode=${input.tlsMode} requires an https publicBaseUrl`,
      retryable: false,
      details: {
        tlsMode: input.tlsMode,
        publicBaseUrl: input.publicBaseUrl,
      },
    };
  }
  if (input.tlsMode === "auto" && isLikelyLanOnlyHostname(publicHost)) {
    throw {
      code: "MATRIX_TLS_MODE_INVALID",
      message:
        "Bundled Matrix tlsMode=auto requires a public DNS hostname, not a LAN-only hostname, loopback address, or IP literal",
      retryable: false,
      details: {
        tlsMode: input.tlsMode,
        publicBaseUrl: input.publicBaseUrl,
      },
    };
  }
  if (publicHost !== homeserverDomain) {
    throw {
      code: "MATRIX_TLS_MODE_INVALID",
      message: `Bundled Matrix tlsMode=${input.tlsMode} currently requires homeserverDomain to match the publicBaseUrl hostname`,
      retryable: false,
      details: {
        homeserverDomain: input.homeserverDomain,
        publicBaseUrl: input.publicBaseUrl,
      },
    };
  }
  if (publicPort === "80") {
    throw {
      code: "MATRIX_TLS_MODE_INVALID",
      message: `Bundled Matrix tlsMode=${input.tlsMode} cannot use HTTPS on port 80`,
      retryable: false,
      details: {
        publicBaseUrl: input.publicBaseUrl,
      },
    };
  }
  if (publicPort === "8008") {
    throw {
      code: "MATRIX_TLS_MODE_INVALID",
      message:
        `Bundled Matrix tlsMode=${input.tlsMode} cannot publish HTTPS on port 8008 because that port is reserved for the local Synapse admin endpoint`,
      retryable: false,
      details: {
        publicBaseUrl: input.publicBaseUrl,
      },
    };
  }
};

const renderCaddyfile = (
  homeserverDomain: string,
  tlsMode: Exclude<BundledMatrixTlsMode, "local-dev">,
): string =>
  [
    "{",
    "  admin off",
    "}",
    "",
    `${homeserverDomain} {`,
    ...(tlsMode === "internal" ? ["  tls internal"] : []),
    "  @wellKnown path /.well-known/matrix/client /.well-known/matrix/server",
    "  handle @wellKnown {",
    "    root * /srv",
    "    header Access-Control-Allow-Origin *",
    "    header Content-Type application/json",
    "    header Cache-Control \"public, max-age=300\"",
    "    file_server",
    "  }",
    "",
    "  handle {",
    "    reverse_proxy synapse:8008",
    "  }",
    "}",
  ].join("\n");

const renderWellKnownFiles = (input: {
  homeserverDomain: string;
  publicBaseUrl: string;
}): { client: string; server: string } => {
  const parsed = new URL(input.publicBaseUrl);
  const httpsPort = parsed.port.length > 0 ? parsed.port : "443";
  return {
    client: JSON.stringify(
      {
        "m.homeserver": {
          base_url: input.publicBaseUrl,
        },
      },
      null,
      2,
    ),
    server: JSON.stringify(
      {
        "m.server": httpsPort === "443" ? input.homeserverDomain : `${input.homeserverDomain}:${httpsPort}`,
      },
      null,
      2,
    ),
  };
};

const ensureDirectoryTreeWritable = async (root: string): Promise<void> => {
  const queue: string[] = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      break;
    }
    await chmod(current, 0o777);
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      queue.push(join(current, entry.name));
    }
  }
};

const isRecoverablePostgresBootstrapFailure = (value: string): boolean =>
  /password authentication failed for user ["']synapse["']/i.test(value)
  || /incorrect collation/i.test(value)
  || /incorrectdatabasesetup/i.test(value);

const isRecoverableAccountCredentialFailure = (error: unknown): boolean => {
  if (!isStructuredError(error) || error.code !== "MATRIX_LOGIN_FAILED") {
    return false;
  }
  if (!isRecord(error.details)) {
    return false;
  }

  const status = error.details.status;
  if (status === 403) {
    return true;
  }

  const body = error.details.body;
  return (
    typeof body === "string"
    && /invalid username or password|m_forbidden/i.test(body)
  );
};

const parseSimpleEnv = (raw: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (key.length === 0) {
      continue;
    }
    out[key] = value;
  }
  return out;
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

const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

const delay = async (ms: number): Promise<void> =>
  new Promise<void>((resolveTimeout) => {
    setTimeout(resolveTimeout, ms);
  });

const chooseBotLocalpart = (operatorLocalpart: string): string =>
  operatorLocalpart === "mail-sentinel" ? "mail-sentinel-bot" : "mail-sentinel";

const sanitizeMatrixLocalpart = (value: string, fallback: string): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._=+\-/]/g, "_")
    .replace(/^_+|_+$/g, "");
  if (normalized.length > 0) {
    return normalized;
  }
  return fallback;
};

const generatePassword = (): string => `sn_${randomBytes(24).toString("base64url")}`;

const normalizePublicBaseUrl = (value: string): string => {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw {
      code: "MATRIX_URL_INVALID",
      message: "Matrix publicBaseUrl must use http or https",
      retryable: false,
      details: {
        publicBaseUrl: value,
      },
    };
  }
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  const normalized = parsed.toString();
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
};

const parseJsonSafely = (raw: string): unknown => {
  if (raw.trim().length === 0) {
    return {};
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
};

const summarizeUnknown = (value: unknown): string => {
  if (typeof value === "string") {
    return truncateText(value, 800);
  }
  try {
    return truncateText(JSON.stringify(value), 800);
  } catch {
    return truncateText(String(value), 800);
  }
};

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : summarizeUnknown(error);

const stripSingleTrailingNewline = (value: string): string =>
  value.endsWith("\n") ? value.slice(0, -1) : value;

const check = (
  id: string,
  name: string,
  status: CheckResult["status"],
  message: string,
  details?: Record<string, unknown>,
): CheckResult => ({
  id,
  name,
  status,
  message,
  ...(details === undefined ? {} : { details }),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isStructuredError = (
  value: unknown,
): value is {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
} => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.code === "string"
    && typeof value.message === "string"
    && typeof value.retryable === "boolean"
  );
};
