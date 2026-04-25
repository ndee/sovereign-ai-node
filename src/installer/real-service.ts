import { randomUUID } from "node:crypto";
import { type Dirent, constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  chown,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type {
  BotCatalog,
  BotConfigRecord,
  BotConfigValue,
  LoadedBotPackage,
} from "../bots/catalog.js";
import { FilesystemBotCatalog } from "../bots/catalog.js";
import type {
  HostResourceValueExpr,
  SovereignBotHostResource,
  SovereignBotHostStateCheck,
} from "../bots/host-resources.js";
import type { SovereignPaths } from "../config/paths.js";
import type {
  PreflightRequest,
  ReconfigureImapRequest,
  ReconfigureMatrixRequest,
  ReconfigureOpenrouterRequest,
  TestAlertRequest,
  TestImapRequest,
  TestMatrixRequest,
} from "../contracts/api.js";
import { type CheckResult, CONTRACT_VERSION, type ComponentHealth } from "../contracts/common.js";
import {
  type DoctorReport,
  type InstallJobStatusResponse,
  type InstallRequest,
  installJobStatusResponseSchema,
  installRequestSchema,
  type MatrixOnboardingIssueResult,
  type MatrixOnboardingPublicState,
  type PreflightResult,
  type ReconfigureResult,
  type SovereignStatus,
  type StartInstallResult,
  type TestAlertResult,
  type TestImapResult,
  type TestMatrixResult,
} from "../contracts/index.js";
import type { Logger } from "../logging/logger.js";
import {
  buildMatrixOnboardingLink,
  buildMatrixOnboardingUrl,
  issueMatrixOnboardingState,
  parseMatrixOnboardingState,
} from "../onboarding/bootstrap-code.js";
import {
  type OpenClawBootstrapper,
  resolveRequestedOpenClawVersion,
} from "../openclaw/bootstrap.js";
import type { OpenClawGatewayServiceManager } from "../openclaw/gateway-service.js";
import {
  extractGuardedJsonStateActorFromConversationInfoText,
  extractGuardedJsonStateActorFromDirectSessionKey,
  extractGuardedJsonStateActorFromUserContent,
  extractLatestGuardedJsonStateActorFromBranch,
  GUARDED_JSON_STATE_OPENCLAW_PLUGIN_ID,
  GUARDED_JSON_STATE_OPENCLAW_TOOL_NAME,
  isGuardedJsonStateRecord,
  normalizeGuardedJsonStateMatrixActorUserId,
  resolveGuardedJsonStateSessionContext,
  resolveGuardedJsonStateToolContext,
  resolveGuardedJsonStateWorkspaceDir,
} from "../openclaw/guarded-json-state-context.js";
import type {
  ManagedAgentRegistrationResult,
  OpenClawManagedAgentRegistrar,
} from "../openclaw/managed-agent.js";
import type { ExecResult, ExecRunner } from "../system/exec.js";
import type { ImapTester } from "../system/imap.js";
import type {
  BundledMatrixAccountsResult,
  BundledMatrixProvisioner,
  BundledMatrixProvisionResult,
  BundledMatrixRoomBootstrapResult,
} from "../system/matrix.js";
import {
  FilesystemMatrixAvatarResolver,
  type MatrixAvatarResolver,
} from "../system/matrix-avatars.js";
import type { HostPreflightChecker } from "../system/preflight.js";
import { formatGiB, parseDfAvailableBytes } from "../system/preflight.js";
import {
  type AgentTemplateManifest,
  CORE_TEMPLATE_MANIFESTS,
  CORE_TRUSTED_TEMPLATE_KEYS,
  findCoreTemplateManifest,
  formatTemplateRef,
  parseTemplateRef,
  type SovereignTemplateManifest,
  type ToolTemplateDefinition,
  verifySignedTemplateManifest,
} from "../templates/catalog.js";
import {
  type InstallContext,
  type InstallStep,
  JobRunner,
  type JobRunnerSnapshot,
} from "./job-runner.js";
import {
  renderGuardedJsonStateWorkspacePluginConfig as renderGuardedJsonStateWorkspacePluginConfigFile,
  renderGuardedJsonStateWorkspacePluginManifest as renderGuardedJsonStateWorkspacePluginManifestFile,
} from "./real-service-guarded-json-state-plugin.js";
import { ensureLobsterCliInstalled } from "./real-service-lobster.js";
import {
  buildRelayProvisionRequest as buildRelayProvisionRequestFile,
  generateManagedRelayRequestedSlug as generateManagedRelayRequestedSlugFile,
  getRelayRequest as getRelayRequestFile,
  isDefaultManagedRelayControlUrl as isDefaultManagedRelayControlUrlFile,
  isRelayModeRequest as isRelayModeRequestFile,
} from "./real-service-relay.js";
import {
  parseManagedRelayEnrollmentResponse,
  type RelayEnrollmentData,
  tryUsePreEnrolledRelay as tryUsePreEnrolledRelayFile,
} from "./real-service-relay-enrollment.js";
import {
  areMatrixIdentitiesEqual,
  areStringListsEqual,
  areStringRecordsEqual,
  buildSuggestedCommands,
  type CompiledBotStatus,
  type CompiledHostResource,
  type CompiledHostResourceCheck,
  check,
  DEFAULT_INSTALL_REQUEST_FILE,
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_SERVICE_GROUP,
  DEFAULT_SERVICE_USER,
  defaultFetch,
  delay,
  deriveOpenClawHealth,
  describeError,
  describeVersionPin,
  ensureCoreManagedAgents,
  ensureTrailingSlash,
  type FetchLike,
  type GatewayState,
  generateAgentPassword,
  INSTALLER_EXEC_TIMEOUT_MS,
  type InstallProvenance,
  isAlreadyExistsOutput,
  isAlreadyJoinedOrInvitedRoomError,
  isCoreAgentBindingBestEffortSkippable,
  isGatewayUserSystemdUnavailableError,
  isMailSentinelGatewayUnavailableError,
  isMissingBinaryError,
  isNodeError,
  isRateLimitedMatrixLoginFailure,
  isRecord,
  looksLikeMissingGateway,
  MAIL_SENTINEL_AGENT_ID,
  MANAGED_OPENCLAW_DM_SCOPE,
  mapHealthToServiceState,
  normalizeOpenClawAgentModel,
  normalizeStringRecord,
  normalizeTestAlertError,
  now,
  parseEnvFile,
  parseGatewayState,
  parseInstallProvenance,
  parseJsonDocument,
  parseJsonSafely,
  parseRuntimeConfigDocument,
  RELAY_LOCAL_EDGE_PORT,
  RELAY_TUNNEL_DEFAULT_IMAGE,
  RELAY_TUNNEL_SYSTEMD_UNIT,
  RESERVED_AGENT_IDS,
  type RelayRuntimeConfig,
  type RuntimeAgentEntry,
  type RuntimeBotInstance,
  type RuntimeConfig,
  resolveVersionPinStatus,
  SOVEREIGN_GATEWAY_SYSTEMD_UNIT,
  sanitizeExpectedMatrixLocalpart,
  sanitizeManagedAgentId,
  sanitizeManagedAgentLocalpart,
  sanitizeManagedWorkspace,
  sanitizeMatrixLocalpartFromAgentId,
  sanitizeOptionalTemplateRef,
  sanitizeOptionalToolInstanceIds,
  sanitizeToolInstanceId,
  stripSingleTrailingNewline,
  summarizeChecksOverall,
  summarizeText,
  summarizeUnknown,
  textContainsId,
  truncateText,
} from "./real-service-shared.js";
import {
  dedupeStrings,
  isBotConfigRecordMap,
  isManagedAgentMatrixAccessTokenFileName,
  normalizeBotConfigRecord,
  normalizeMatrixUserList,
  renderSystemGatewayMatrixWaitCommand,
  resolveExecutablePath,
  resolveExpectedBundledBotLocalpart,
  rewriteAllowedUsersToHomeserverDomain,
  shouldGateSystemGatewayOnLocalMatrix,
  sortBotInstances,
  sortInstalledTemplates,
  sortToolInstances,
  toSystemdDuration,
} from "./real-service-utils.js";
import type {
  InstallerService,
  MailSentinelApplyResult,
  MailSentinelDeleteResult,
  MailSentinelListResult,
  MailSentinelMigrationResult,
  MailSentinelSummary,
  ManagedAgent,
  ManagedAgentDeleteResult,
  ManagedAgentListResult,
  ManagedAgentUpsertResult,
  MatrixUserRemoveResult,
  MigrationStatusResult,
  PendingMigration,
  SovereignBotInstantiateResult,
  SovereignBotListResult,
  SovereignTemplateInstallResult,
  SovereignTemplateListResult,
  SovereignToolInstanceDeleteResult,
  SovereignToolInstanceListResult,
  SovereignToolInstanceUpsertResult,
} from "./service.js";
import { StubInstallerService } from "./stub-service.js";
import { renderTemplateWorkspaceContent } from "./workspace-documents.js";

type PersistedInstallJobRecord = {
  version: 1;
  installationId: string;
  request: InstallRequest;
  response: InstallJobStatusResponse;
  updatedAt: string;
};

type RelayEnrollmentResult = RelayEnrollmentData;

type CompiledHostPlan = {
  resources: CompiledHostResource[];
  botStatus: CompiledBotStatus[];
};

type HostResourceContext = {
  runtimeConfig: RuntimeConfig;
  botPackage: LoadedBotPackage;
  agent: RuntimeConfig["openclawProfile"]["agents"][number];
  botInstance?: RuntimeBotInstance;
  toolInstanceIds: string[];
  toolInstanceIdMap: Record<string, string>;
};

type MaterializedBotToolInstance = RuntimeConfig["sovereignTools"]["instances"][number] & {
  botId: string;
  botInstanceId?: string;
  manifestToolId: string;
};

type RequestedBotInstance = RuntimeBotInstance;

const OPENCLAW_EXEC_TOOL_ID = "exec";
const OPENCLAW_SESSION_STATUS_TOOL_ID = "session_status";
const OPENCLAW_STATUS_PROBE_TIMEOUT_MS = 5_000;
const OPENCLAW_EMPTY_HEALTH_RETRY_ATTEMPTS = 3;
const OPENCLAW_EMPTY_HEALTH_RETRY_DELAY_MS = 1_000;
const OPENCLAW_RUNTIME_SETTLE_ATTEMPTS = 6;
const OPENCLAW_RUNTIME_SETTLE_DELAY_MS = 5_000;
const SYSTEM_GATEWAY_MATRIX_WAIT_ATTEMPTS = 120;
const SYSTEM_GATEWAY_MATRIX_WAIT_DELAY_SECONDS = 2;
const SYSTEM_GATEWAY_MATRIX_WAIT_TIMEOUT_SECONDS = 5;
const DOCTOR_DISK_WARN_BYTES = 2 * 1024 * 1024 * 1024;
const DOCTOR_DISK_FAIL_BYTES = 500 * 1024 * 1024;
const LOBSTER_CLI_PROBE_TIMEOUT_MS = 20_000;
const LOBSTER_CLI_INSTALL_TIMEOUT_MS = 5 * 60_000;
const MAIL_SENTINEL_MIGRATION_ID = "mail-sentinel-instances";
const MAIL_SENTINEL_IMAP_HOST_KEY = "imapHost";
const MAIL_SENTINEL_IMAP_PORT_KEY = "imapPort";
const MAIL_SENTINEL_IMAP_TLS_KEY = "imapTls";
const MAIL_SENTINEL_IMAP_USERNAME_KEY = "imapUsername";
const MAIL_SENTINEL_IMAP_MAILBOX_KEY = "imapMailbox";
const MAIL_SENTINEL_IMAP_CONFIGURED_KEY = "imapConfigured";
const MAIL_SENTINEL_IMAP_PASSWORD_SECRET_KEY = "imapPassword";
const SOVEREIGN_PINNED_LOBSTER_PACKAGE_NAME = "@clawdbot/lobster";
const SOVEREIGN_PINNED_LOBSTER_VERSION = "2026.1.24";
const SOVEREIGN_EXECUTABLE_PATHS: Record<string, string> = {
  "sovereign-node": "/usr/local/bin/sovereign-node",
  "sovereign-node-api": "/usr/local/bin/sovereign-node-api",
  "sovereign-node-onboarding-api": "/usr/local/bin/sovereign-node-onboarding-api",
  "sovereign-tool": "/usr/local/bin/sovereign-tool",
};

const DEFAULT_MATRIX_USER_INVITE_TTL_MINUTES = 1_440;

type RealInstallerServiceDeps = {
  openclawBootstrapper: OpenClawBootstrapper;
  openclawGatewayServiceManager: OpenClawGatewayServiceManager;
  managedAgentRegistrar?: OpenClawManagedAgentRegistrar;
  botCatalog?: BotCatalog;
  preflightChecker: HostPreflightChecker;
  imapTester: ImapTester;
  matrixProvisioner: BundledMatrixProvisioner;
  execRunner?: ExecRunner;
  fetchImpl?: FetchLike;
};

export class RealInstallerService implements InstallerService {
  private readonly stubService: StubInstallerService;

  private readonly jobRunner = new JobRunner();

  private resolvedInstallJobsDir: string | null = null;
  private resolvedSecretsDir: string | null = null;
  private resolvedRuntimeOwnership: { uid: number; gid: number } | null | undefined = undefined;
  private managedOpenClawEnv: Record<string, string> | null | undefined = undefined;

  private readonly openclawBootstrapper: OpenClawBootstrapper;

  private readonly openclawGatewayServiceManager: OpenClawGatewayServiceManager;

  private readonly managedAgentRegistrar: OpenClawManagedAgentRegistrar;

  private readonly botCatalog: BotCatalog;

  private readonly preflightChecker: HostPreflightChecker;

  private readonly imapTester: ImapTester;

  private readonly matrixProvisioner: BundledMatrixProvisioner;

  private readonly execRunner: ExecRunner | null;

  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly logger: Logger,
    private readonly paths: SovereignPaths,
    deps: RealInstallerServiceDeps,
  ) {
    this.stubService = new StubInstallerService(logger);
    this.openclawBootstrapper = deps.openclawBootstrapper;
    this.openclawGatewayServiceManager = deps.openclawGatewayServiceManager;
    this.managedAgentRegistrar = deps.managedAgentRegistrar ??
      deps.managedAgentRegistrar ?? {
        register: async () => {
          throw new Error("RealInstallerService requires a managed agent registrar");
        },
      };
    this.botCatalog = deps.botCatalog ?? new FilesystemBotCatalog();
    this.preflightChecker = deps.preflightChecker;
    this.imapTester = deps.imapTester;
    this.matrixProvisioner = deps.matrixProvisioner;
    this.execRunner = deps.execRunner ?? null;
    this.fetchImpl = deps.fetchImpl ?? defaultFetch;
  }

  private async listBotPackages(): Promise<LoadedBotPackage[]> {
    return await this.botCatalog.listPackages();
  }

  private async getBotPackage(id: string): Promise<LoadedBotPackage> {
    return await this.botCatalog.getPackage(id);
  }

  private async findBotPackageByTemplateRef(
    templateRef: string | undefined,
  ): Promise<LoadedBotPackage | null> {
    if (templateRef === undefined) {
      return null;
    }
    return await this.botCatalog.findPackageByTemplateRef(templateRef);
  }

  private async resolveRequestedBots(req: InstallRequest): Promise<{
    packages: LoadedBotPackage[];
    configById: Record<string, BotConfigRecord>;
  }> {
    const defaultBotIds = await this.botCatalog.getDefaultSelectedIds();
    const selectedBotIds = this.resolveRequestedBotIds(req, defaultBotIds);
    const packages = await Promise.all(
      selectedBotIds.map(async (id) => await this.getBotPackage(id)),
    );
    const defaultsById = Object.fromEntries(
      packages.map((entry) => [entry.manifest.id, { ...entry.manifest.configDefaults }] as const),
    );
    const configuredByRequest = isBotConfigRecordMap(req.bots?.config) ? req.bots.config : {};
    const mergedById = Object.fromEntries(
      packages.map(
        (entry) =>
          [
            entry.manifest.id,
            {
              ...defaultsById[entry.manifest.id],
              ...(configuredByRequest[entry.manifest.id] ?? {}),
            },
          ] satisfies [string, BotConfigRecord],
      ),
    );
    return {
      packages,
      configById: mergedById,
    };
  }

  private resolveRequestedBotInstances(input: {
    req: InstallRequest;
    packages: LoadedBotPackage[];
    configById: Record<string, BotConfigRecord>;
    imap: RuntimeConfig["imap"];
    matrixRoom: { roomId: string; roomName: string };
    homeserverDomain: string;
    previousRuntimeConfig: RuntimeConfig | null;
  }): RequestedBotInstance[] {
    const explicitInstances = Array.isArray(input.req.bots?.instances)
      ? input.req.bots.instances.map((entry) =>
          this.normalizeRequestedBotInstance({
            entry,
            configById: input.configById,
            matrixRoom: input.matrixRoom,
            homeserverDomain: input.homeserverDomain,
            previousRuntimeConfig: input.previousRuntimeConfig,
          }),
        )
      : [];
    const normalized = explicitInstances.map((entry) =>
      this.applyLegacyMailSentinelRequestedInstanceDefaults({
        entry,
        imap: input.imap,
        matrixRoom: input.matrixRoom,
        homeserverDomain: input.homeserverDomain,
        previousRuntimeConfig: input.previousRuntimeConfig,
      }),
    );
    const hasMailSentinelInstance = normalized.some(
      (entry) => entry.packageId === MAIL_SENTINEL_AGENT_ID,
    );
    if (
      !hasMailSentinelInstance &&
      input.packages.some((entry) => entry.manifest.id === MAIL_SENTINEL_AGENT_ID)
    ) {
      normalized.push(
        this.buildLegacyMailSentinelRequestedInstance({
          configById: input.configById,
          imap: input.imap,
          matrixRoom: input.matrixRoom,
          homeserverDomain: input.homeserverDomain,
          previousRuntimeConfig: input.previousRuntimeConfig,
        }),
      );
    }
    return sortBotInstances(normalized);
  }

  private normalizeRequestedBotInstance(input: {
    entry: NonNullable<NonNullable<InstallRequest["bots"]>["instances"]>[number];
    configById: Record<string, BotConfigRecord>;
    matrixRoom: { roomId: string; roomName: string };
    homeserverDomain: string;
    previousRuntimeConfig: RuntimeConfig | null;
  }): RequestedBotInstance {
    const id = sanitizeManagedAgentId(input.entry.id);
    const packageId = input.entry.packageId.trim();
    const previous = input.previousRuntimeConfig?.bots.instances.find((entry) => entry.id === id);
    const matrixEntry = isRecord(input.entry.matrix) ? input.entry.matrix : {};
    const alertRoomEntry = isRecord(matrixEntry.alertRoom) ? matrixEntry.alertRoom : {};
    // Rotate persisted allowedUsers to the current Synapse homeserver domain.
    // Same staleness problem as alertRoom: the saved install-request and
    // previous runtime both carry MXIDs that disagree with the live Synapse
    // after a homeserver rotation, and the entries are copied verbatim
    // without normalization (rewriteAllowedUsersToHomeserverDomain docstring
    // has the full explanation).
    const allowedUsers = rewriteAllowedUsersToHomeserverDomain(
      Array.isArray(matrixEntry.allowedUsers)
        ? matrixEntry.allowedUsers
        : (previous?.matrix?.allowedUsers ?? []),
      input.homeserverDomain,
    );
    const config = {
      ...(input.configById[packageId] ?? {}),
      ...(previous?.config ?? {}),
      ...normalizeBotConfigRecord(input.entry.config),
    };
    const secretRefs = normalizeStringRecord({
      ...(previous?.secretRefs ?? {}),
      ...normalizeStringRecord(
        isRecord(input.entry.secretRefs)
          ? Object.fromEntries(
              Object.entries(input.entry.secretRefs).filter(
                (pair): pair is [string, string] =>
                  typeof pair[0] === "string" &&
                  pair[0].length > 0 &&
                  typeof pair[1] === "string" &&
                  pair[1].length > 0,
              ),
            )
          : {},
      ),
    });
    const localpart =
      typeof matrixEntry.localpart === "string" && matrixEntry.localpart.trim().length > 0
        ? sanitizeManagedAgentLocalpart(matrixEntry.localpart, id)
        : previous?.matrix?.localpart;
    // Rotate the alertRoom to the current install's room whenever the
    // caller's or previous runtime's value disagrees with it. The saved
    // install-request persists `bots.instances[].matrix.alertRoom.roomId`
    // across updates (see migrateLegacyMailSentinel), so a stale roomId
    // from before a homeserver/room rotation survives forever otherwise —
    // #120 only rotated when alertRoomEntry.roomId was empty, leaving the
    // explicit-roomId branch to keep pinning bots to a dead room. Any
    // caller-provided roomId that doesn't match the freshly-bootstrapped
    // matrixRoom is ipso facto stale: operator-chosen rooms flow through
    // matrixRoom, so a legitimate custom value would equal currentRoomId.
    const previousRoomId = previous?.matrix?.alertRoom?.roomId;
    const previousRoomName = previous?.matrix?.alertRoom?.roomName;
    const currentRoomId = input.matrixRoom.roomId;
    const explicitRoomId =
      typeof alertRoomEntry.roomId === "string" && alertRoomEntry.roomId.trim().length > 0
        ? alertRoomEntry.roomId.trim()
        : undefined;
    const explicitRoomName =
      typeof alertRoomEntry.roomName === "string" && alertRoomEntry.roomName.trim().length > 0
        ? alertRoomEntry.roomName.trim()
        : undefined;
    const explicitMatchesCurrent = explicitRoomId === currentRoomId;
    const previousMatchesCurrent =
      typeof previousRoomId === "string" && previousRoomId === currentRoomId;
    const roomId = explicitMatchesCurrent
      ? explicitRoomId
      : previousMatchesCurrent
        ? previousRoomId
        : (currentRoomId ?? explicitRoomId ?? previousRoomId);
    const roomName = explicitMatchesCurrent
      ? (explicitRoomName ?? input.matrixRoom.roomName)
      : previousMatchesCurrent
        ? (previousRoomName ?? input.matrixRoom.roomName)
        : (input.matrixRoom.roomName ??
          explicitRoomName ??
          (roomId === undefined ? undefined : previousRoomName));
    return {
      id,
      packageId,
      workspace: sanitizeManagedWorkspace(
        input.entry.workspace,
        previous?.workspace ?? join(this.paths.stateDir, id, "workspace"),
      ),
      config,
      secretRefs,
      ...(localpart === undefined && roomId === undefined && allowedUsers.length === 0
        ? {}
        : {
            matrix: {
              ...(localpart === undefined ? {} : { localpart }),
              ...(roomId === undefined
                ? {}
                : {
                    alertRoom: {
                      roomId,
                      roomName: roomName ?? input.matrixRoom.roomName,
                    },
                  }),
              ...(allowedUsers.length === 0 ? {} : { allowedUsers }),
            },
          }),
    };
  }

  private buildLegacyMailSentinelRequestedInstance(input: {
    configById: Record<string, BotConfigRecord>;
    imap: RuntimeConfig["imap"];
    matrixRoom: { roomId: string; roomName: string };
    homeserverDomain: string;
    previousRuntimeConfig: RuntimeConfig | null;
  }): RequestedBotInstance {
    const previous =
      input.previousRuntimeConfig?.bots.instances.find(
        (entry) => entry.id === MAIL_SENTINEL_AGENT_ID,
      ) ?? undefined;
    const previousAgent = input.previousRuntimeConfig?.openclawProfile.agents.find(
      (entry) => entry.id === MAIL_SENTINEL_AGENT_ID,
    );
    const rotatedAllowedUsers =
      previous?.matrix?.allowedUsers === undefined
        ? undefined
        : rewriteAllowedUsersToHomeserverDomain(
            previous.matrix.allowedUsers,
            input.homeserverDomain,
          );
    return this.applyLegacyMailSentinelRequestedInstanceDefaults({
      entry: {
        id: MAIL_SENTINEL_AGENT_ID,
        packageId: MAIL_SENTINEL_AGENT_ID,
        workspace:
          previous?.workspace ?? join(this.paths.stateDir, MAIL_SENTINEL_AGENT_ID, "workspace"),
        config: {
          ...(input.configById[MAIL_SENTINEL_AGENT_ID] ?? {}),
          ...(previous?.config ?? {}),
        },
        secretRefs: previous?.secretRefs ?? {},
        matrix: {
          ...(previous?.matrix?.localpart === undefined
            ? previousAgent?.matrix?.localpart === undefined
              ? {}
              : { localpart: previousAgent.matrix.localpart }
            : { localpart: previous.matrix.localpart }),
          // Same staleness guard as normalizeRequestedBotInstance +
          // applyLegacyMailSentinelRequestedInstanceDefaults: when the
          // previous runtime's roomId doesn't match the current install's
          // authoritative matrixRoom, use matrixRoom so the subsequent
          // tool bindings resolve to a room that actually exists.
          alertRoom:
            previous?.matrix?.alertRoom?.roomId === input.matrixRoom.roomId
              ? previous.matrix.alertRoom
              : input.matrixRoom,
          // Rotate MXIDs to the current homeserver so post-rotation
          // operator accounts land in the allowlist instead of the dead
          // pre-rotation domain. Drop the field entirely when the rewrite
          // yields nothing (mirrors the previous "copy only when present"
          // shape so callers still see undefined for empty lists).
          ...(rotatedAllowedUsers === undefined || rotatedAllowedUsers.length === 0
            ? {}
            : { allowedUsers: rotatedAllowedUsers }),
        },
      },
      imap: input.imap,
      matrixRoom: input.matrixRoom,
      homeserverDomain: input.homeserverDomain,
      previousRuntimeConfig: input.previousRuntimeConfig,
    });
  }

  private applyLegacyMailSentinelRequestedInstanceDefaults(input: {
    entry: RequestedBotInstance;
    imap: RuntimeConfig["imap"];
    matrixRoom: { roomId: string; roomName: string };
    homeserverDomain: string;
    previousRuntimeConfig: RuntimeConfig | null;
  }): RequestedBotInstance {
    if (input.entry.packageId !== MAIL_SENTINEL_AGENT_ID) {
      return input.entry;
    }
    const previous = input.previousRuntimeConfig?.bots.instances.find(
      (entry) => entry.id === input.entry.id,
    );
    // The top-level `imap` section is the authoritative source for all
    // mail-sentinel IMAP settings. Whenever it is configured, overwrite the
    // instance's six IMAP keys unconditionally — even if they already carry
    // plausible-looking values. Hosts that went through the earlier broken
    // migrations accumulated stale manifest defaults (imapPort=993,
    // imapHost="pending") both in the install-request and in the previous
    // runtime config. PR #97's sentinel-based trigger only fired when
    // imapConfigured itself was still a sentinel; a second update cycle
    // could therefore leave imapPort/imapTls/imapMailbox pinned to 993 even
    // though imapHost and imapUsername had already been corrected. Treating
    // the top-level section as the single source of truth eliminates the
    // drift window entirely.
    //
    // When the top-level imap section is still pending, fall back to the
    // entry's own values (or the previous runtime config) so genuinely
    // fresh installs without IMAP configured don't lose any per-instance
    // overrides that may have been placed in the install request.
    const isImapSentinel = (value: unknown): boolean =>
      value === undefined || value === "pending" || value === false;
    const topLevelImapAuthoritative = input.imap.status === "configured";
    const next: RequestedBotInstance = {
      ...input.entry,
      config: {
        ...input.entry.config,
        ...(topLevelImapAuthoritative
          ? {
              [MAIL_SENTINEL_IMAP_CONFIGURED_KEY]: true,
              [MAIL_SENTINEL_IMAP_HOST_KEY]: input.imap.host,
              [MAIL_SENTINEL_IMAP_PORT_KEY]: input.imap.port,
              [MAIL_SENTINEL_IMAP_TLS_KEY]: input.imap.tls,
              [MAIL_SENTINEL_IMAP_USERNAME_KEY]: input.imap.username,
              [MAIL_SENTINEL_IMAP_MAILBOX_KEY]: input.imap.mailbox,
            }
          : {
              ...(isImapSentinel(input.entry.config[MAIL_SENTINEL_IMAP_CONFIGURED_KEY])
                ? { [MAIL_SENTINEL_IMAP_CONFIGURED_KEY]: false }
                : {}),
              ...(input.entry.config[MAIL_SENTINEL_IMAP_HOST_KEY] === undefined
                ? {
                    [MAIL_SENTINEL_IMAP_HOST_KEY]:
                      previous?.config[MAIL_SENTINEL_IMAP_HOST_KEY] ?? input.imap.host,
                  }
                : {}),
              ...(input.entry.config[MAIL_SENTINEL_IMAP_PORT_KEY] === undefined
                ? {
                    [MAIL_SENTINEL_IMAP_PORT_KEY]:
                      previous?.config[MAIL_SENTINEL_IMAP_PORT_KEY] ?? input.imap.port,
                  }
                : {}),
              ...(input.entry.config[MAIL_SENTINEL_IMAP_TLS_KEY] === undefined
                ? {
                    [MAIL_SENTINEL_IMAP_TLS_KEY]:
                      previous?.config[MAIL_SENTINEL_IMAP_TLS_KEY] ?? input.imap.tls,
                  }
                : {}),
              ...(input.entry.config[MAIL_SENTINEL_IMAP_USERNAME_KEY] === undefined
                ? {
                    [MAIL_SENTINEL_IMAP_USERNAME_KEY]:
                      previous?.config[MAIL_SENTINEL_IMAP_USERNAME_KEY] ?? input.imap.username,
                  }
                : {}),
              ...(input.entry.config[MAIL_SENTINEL_IMAP_MAILBOX_KEY] === undefined
                ? {
                    [MAIL_SENTINEL_IMAP_MAILBOX_KEY]:
                      previous?.config[MAIL_SENTINEL_IMAP_MAILBOX_KEY] ?? input.imap.mailbox,
                  }
                : {}),
            }),
      },
      secretRefs: normalizeStringRecord({
        ...input.entry.secretRefs,
        ...(input.entry.secretRefs[MAIL_SENTINEL_IMAP_PASSWORD_SECRET_KEY] === undefined &&
        input.imap.status === "configured"
          ? {
              [MAIL_SENTINEL_IMAP_PASSWORD_SECRET_KEY]:
                previous?.secretRefs[MAIL_SENTINEL_IMAP_PASSWORD_SECRET_KEY] ??
                input.imap.secretRef,
            }
          : {}),
      }),
      matrix: {
        ...(input.entry.matrix ?? {}),
        // Rotate the bot-instance alertRoom to the current install's
        // matrixRoom unless the entry/previous roomId already matches it.
        // Saved install-requests persist a stale roomId from the legacy
        // migration across updates; callers with a legit custom roomId
        // flow it through matrixRoom so any mismatch here is ipso facto
        // stale. Preserving the entry/previous alertRoom block when it
        // matches keeps operator-picked roomName intact.
        alertRoom:
          input.entry.matrix?.alertRoom?.roomId === input.matrixRoom.roomId
            ? input.entry.matrix.alertRoom
            : previous?.matrix?.alertRoom?.roomId === input.matrixRoom.roomId
              ? previous.matrix.alertRoom
              : input.matrixRoom,
        // Rotate allowedUsers to the current homeserver in both branches:
        // when the entry already carries a list (replayed install request),
        // and when we fall back to the previous runtime's list. Either one
        // can have survived a homeserver rotation untouched — the E2E VPS
        // reproduction had `@operator:e2e.sovereign.local` leaking through
        // on every `sovereign-node update` because
        // normalizeRequestedBotInstance ran ahead of this function and the
        // rotation was only applied there.
        ...(input.entry.matrix?.allowedUsers !== undefined
          ? {
              allowedUsers: rewriteAllowedUsersToHomeserverDomain(
                input.entry.matrix.allowedUsers,
                input.homeserverDomain,
              ),
            }
          : previous?.matrix?.allowedUsers !== undefined
            ? {
                allowedUsers: rewriteAllowedUsersToHomeserverDomain(
                  previous.matrix.allowedUsers,
                  input.homeserverDomain,
                ),
              }
            : {}),
      },
    };
    return next;
  }

  private getRuntimeBotInstance(
    runtimeConfig: RuntimeConfig,
    id: string,
  ): RuntimeBotInstance | undefined {
    return runtimeConfig.bots.instances.find((entry) => entry.id === id);
  }

  private getRuntimeBotInstanceForAgent(
    runtimeConfig: RuntimeConfig,
    agent: RuntimeAgentEntry,
  ): RuntimeBotInstance | undefined {
    return agent.botInstanceId === undefined
      ? undefined
      : this.getRuntimeBotInstance(runtimeConfig, agent.botInstanceId);
  }

  private resolveSharedServiceBotLocalpart(packages: LoadedBotPackage[]): string | undefined {
    return packages.find((entry) => entry.manifest.matrixIdentity.mode === "service-account")
      ?.manifest.matrixIdentity.localpartPrefix;
  }

  private resolvePreferredDedicatedMatrixBot(
    packages: LoadedBotPackage[],
  ): LoadedBotPackage | undefined {
    return (
      packages.find(
        (entry) =>
          entry.manifest.matrixIdentity.mode === "dedicated-account" &&
          entry.manifest.matrixRouting?.defaultAccount === true,
      ) ?? packages.find((entry) => entry.manifest.matrixIdentity.mode === "dedicated-account")
    );
  }

  private resolveBootstrapMatrixBotLocalpart(packages: LoadedBotPackage[]): string | undefined {
    return (
      this.resolveSharedServiceBotLocalpart(packages) ??
      this.resolvePreferredDedicatedMatrixBot(packages)?.manifest.matrixIdentity.localpartPrefix
    );
  }

  private resolveBotMatrixRouting(manifest: LoadedBotPackage["manifest"] | undefined): {
    defaultAccount: boolean;
    dmEnabled: boolean;
    alertRoom: {
      autoReply: boolean;
      requireMention: boolean;
    };
  } {
    const defaultAutoReply = true;
    const configuredAutoReply = manifest?.matrixRouting?.alertRoom?.autoReply;
    const autoReply = configuredAutoReply ?? defaultAutoReply;
    const configuredRequireMention = manifest?.matrixRouting?.alertRoom?.requireMention;

    return {
      defaultAccount: manifest?.matrixRouting?.defaultAccount === true,
      dmEnabled: manifest?.matrixRouting?.dm?.enabled ?? true,
      alertRoom: {
        autoReply,
        requireMention: configuredRequireMention ?? !autoReply,
      },
    };
  }

  private async listInvitedHumanMatrixUserIds(runtimeConfig: RuntimeConfig): Promise<string[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.paths.secretsDir, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const reservedUserIds = new Set<string>([
      runtimeConfig.matrix.operator.userId,
      runtimeConfig.matrix.bot.userId,
      ...runtimeConfig.openclawProfile.agents.flatMap((entry) =>
        entry.matrix?.userId === undefined ? [] : [entry.matrix.userId],
      ),
    ]);
    const reservedLocalparts = new Set<string>(
      [
        runtimeConfig.matrix.operator.localpart ?? "",
        runtimeConfig.matrix.bot.localpart ?? "",
        ...runtimeConfig.openclawProfile.agents.flatMap((entry) =>
          entry.matrix?.localpart === undefined ? [] : [entry.matrix.localpart],
        ),
      ].filter((value) => value.length > 0),
    );

    return dedupeStrings(
      entries.flatMap((entry) => {
        if (!entry.isFile()) {
          return [];
        }
        const match = /^matrix-user-(.+)\.password$/.exec(entry.name);
        if (match === null) {
          return [];
        }
        const localpart = sanitizeExpectedMatrixLocalpart(match[1] ?? "", "");
        if (localpart.length === 0 || reservedLocalparts.has(localpart)) {
          return [];
        }
        const userId = `@${localpart}:${runtimeConfig.matrix.homeserverDomain}`;
        if (reservedUserIds.has(userId)) {
          return [];
        }
        return [userId];
      }),
    );
  }

  private async refreshManagedMatrixRouting(runtimeConfig: RuntimeConfig): Promise<void> {
    await this.writeOpenClawRuntimeArtifacts(runtimeConfig);
    this.setManagedOpenClawEnv(runtimeConfig);
    await this.refreshGatewayAfterRuntimeConfig(runtimeConfig);
  }

  private syncPrimaryDedicatedMatrixBotIdentity(
    runtimeConfig: RuntimeConfig,
    identity: {
      localpart: string;
      userId: string;
      passwordSecretRef?: string;
      accessTokenSecretRef: string;
    },
  ): boolean {
    const current = runtimeConfig.matrix.bot;
    if (current.localpart !== identity.localpart && current.userId !== identity.userId) {
      return false;
    }
    if (
      current.localpart === identity.localpart &&
      current.userId === identity.userId &&
      current.passwordSecretRef === identity.passwordSecretRef &&
      current.accessTokenSecretRef === identity.accessTokenSecretRef
    ) {
      return false;
    }
    runtimeConfig.matrix.bot = {
      localpart: identity.localpart,
      userId: identity.userId,
      ...(identity.passwordSecretRef === undefined
        ? {}
        : { passwordSecretRef: identity.passwordSecretRef }),
      accessTokenSecretRef: identity.accessTokenSecretRef,
    };
    return true;
  }

  private resolveRequestedBotIds(req: InstallRequest, defaultBotIds: string[]): string[] {
    const selected =
      req.bots?.selected
        ?.map((entry: string) => entry.trim())
        .filter((entry: string) => entry.length > 0) ?? [];
    const selectedFromInstances = Array.isArray(req.bots?.instances)
      ? req.bots.instances
          .map((entry) => entry.packageId.trim())
          .filter((entry) => entry.length > 0)
      : [];
    if (selected.length > 0 || selectedFromInstances.length > 0) {
      return dedupeStrings([...selected, ...selectedFromInstances]);
    }
    return dedupeStrings(defaultBotIds);
  }

  async preflight(input?: PreflightRequest): Promise<PreflightResult> {
    return this.preflightChecker.run(input);
  }

  async testImap(req: TestImapRequest): Promise<TestImapResult> {
    return this.imapTester.test(req);
  }

  async testMatrix(req: TestMatrixRequest): Promise<TestMatrixResult> {
    return this.matrixProvisioner.test(req);
  }

  async startInstall(req: InstallRequest): Promise<StartInstallResult> {
    const installationId = `inst_${randomUUID()}`;
    const jobId = `job_${randomUUID()}`;
    const ctx: InstallContext = {
      installationId,
      jobId,
    };

    const runResult = await this.jobRunner.run(
      ctx,
      this.buildInstallSteps(req),
      async (snapshot) => {
        await this.persistJobSnapshot({
          installationId,
          request: req,
          snapshot,
        });
      },
    );

    return {
      job: runResult.job,
    };
  }

  async getInstallJob(jobId: string): Promise<InstallJobStatusResponse> {
    const record = await this.readJobRecord(jobId);
    if (record === null) {
      throw new Error(`Install job not found: ${jobId}`);
    }

    return record.response;
  }

  async testAlert(req: TestAlertRequest): Promise<TestAlertResult> {
    const channel = req.channel ?? "matrix";
    const unknownRoom = req.roomId ?? "!unknown:local";
    if (channel !== "matrix") {
      return {
        delivered: false,
        target: {
          channel: "matrix",
          roomId: unknownRoom,
        },
        error: {
          code: "TEST_ALERT_CHANNEL_UNSUPPORTED",
          message: "Only Matrix test alerts are currently supported",
          retryable: false,
          details: { requestedChannel: channel },
        },
      };
    }

    try {
      const config = await this.readRuntimeConfig();
      const roomId = req.roomId ?? config.matrix.alertRoom.roomId;
      const transactionId = `sovereign_${Date.now()}_${randomUUID().slice(0, 8)}`;
      const endpoint = new URL(
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(
          transactionId,
        )}`,
        ensureTrailingSlash(config.matrix.adminBaseUrl),
      ).toString();

      const sendMatrixTestAlert = async (): Promise<{
        response: Response;
        parsed: unknown;
      }> => {
        const accessToken = await this.resolveSecretRef(config.matrix.bot.accessTokenSecretRef);
        const response = await this.fetchImpl(endpoint, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            msgtype: "m.text",
            body: req.text ?? `Sovereign test alert (${now()})`,
          }),
        });

        const rawBody = await response.text();
        return {
          response,
          parsed: parseJsonSafely(rawBody),
        };
      };

      let { response, parsed } = await sendMatrixTestAlert();
      if ((response.status === 401 || response.status === 403) && response.ok === false) {
        const repaired = await this.ensureManagedMatrixAccessTokens(config);
        if (repaired) {
          ({ response, parsed } = await sendMatrixTestAlert());
        }
      }

      if (!response.ok) {
        return {
          delivered: false,
          target: {
            channel: "matrix",
            roomId,
          },
          error: {
            code: "TEST_ALERT_FAILED",
            message: "Matrix test alert delivery failed",
            retryable: true,
            details: {
              status: response.status,
              body: summarizeUnknown(parsed),
            },
          },
        };
      }

      const messageId =
        isRecord(parsed) && typeof parsed.event_id === "string" ? parsed.event_id : undefined;

      return {
        delivered: true,
        target: {
          channel: "matrix",
          roomId,
        },
        ...(messageId === undefined ? {} : { messageId }),
        sentAt: now(),
      };
    } catch (error) {
      return {
        delivered: false,
        target: {
          channel: "matrix",
          roomId: unknownRoom,
        },
        error: normalizeTestAlertError(error),
      };
    }
  }

  async getStatus(): Promise<SovereignStatus> {
    const runtimeConfig = await this.tryReadRuntimeConfig();
    const provenance = await this.tryReadInstallProvenance();
    const detectedOpenClaw = await this.safeDetectOpenClaw();
    const expectedAgentIds = runtimeConfig?.openclawProfile.agents.map((entry) => entry.id) ?? [];
    const expectedCronIds = runtimeConfig?.openclawProfile.crons.map((entry) => entry.id) ?? [];

    const gateway = await this.inspectGatewayService();
    const relay =
      runtimeConfig?.relay?.enabled === true
        ? await this.inspectRelayTunnelService()
        : {
            installed: false,
            state: "unknown" as GatewayState,
            message: undefined,
          };
    const healthProbe = await this.probeOpenClawHealth();
    const agentProbes = await Promise.all(
      expectedAgentIds.map(
        async (id) =>
          await this.inspectManagedOpenClawListContains(runtimeConfig, ["agents", "list"], id),
      ),
    );
    const cronProbes = await Promise.all(
      expectedCronIds.map(
        async (id) =>
          await this.inspectManagedOpenClawListContains(runtimeConfig, ["cron", "list"], id),
      ),
    );
    const managedRuntimeJson =
      runtimeConfig === null ? null : await this.readManagedOpenClawRuntimeJson(runtimeConfig);
    const matrixStatus = await this.inspectMatrixStatus(runtimeConfig);

    const cliInstalled = detectedOpenClaw !== null;
    const managedBySovereign = runtimeConfig?.openclaw.managedInstallation ?? true;
    const pluginIds = runtimeConfig?.openclawProfile.plugins.allow;
    const agentPresent = expectedAgentIds.every(
      (id, index) =>
        !(agentProbes[index]?.verified ?? false) ||
        agentProbes[index]?.present === true ||
        this.managedOpenClawRuntimeHasAgent(managedRuntimeJson, id),
    );
    const cronPresent = expectedCronIds.every(
      (id, index) =>
        !(cronProbes[index]?.verified ?? false) ||
        cronProbes[index]?.present === true ||
        this.managedOpenClawRuntimeHasCron(managedRuntimeJson, id),
    );
    const openclawHealth = deriveOpenClawHealth({
      cliInstalled,
      gatewayState: gateway.state,
      healthProbeOk: healthProbe.ok,
      agentPresent,
      cronPresent,
    });
    const relayServiceHealth: ComponentHealth =
      relay.installed && relay.state === "running"
        ? "healthy"
        : relay.installed
          ? "degraded"
          : "unhealthy";
    const sovereignHealth: ComponentHealth = runtimeConfig === null ? "degraded" : "healthy";
    const hostResourceStatus =
      runtimeConfig === null
        ? { resources: [], bots: {} }
        : await this.inspectCompiledHostResources(runtimeConfig);

    return {
      mode: "bundled_matrix",
      services: [
        {
          name: "sovereign-node",
          kind: "sovereign-node",
          health: sovereignHealth,
          state: "running",
          ...(runtimeConfig === null
            ? { message: "Sovereign runtime config is not readable" }
            : {}),
        },
        {
          name: "openclaw-gateway",
          kind: "openclaw",
          health: openclawHealth,
          state: gateway.state,
          ...(gateway.message === undefined ? {} : { message: gateway.message }),
        },
        {
          name: "synapse",
          kind: "synapse",
          health: matrixStatus.health,
          state: mapHealthToServiceState(matrixStatus.health),
          ...(matrixStatus.message === undefined ? {} : { message: matrixStatus.message }),
        },
        ...(runtimeConfig?.relay?.enabled === true
          ? [
              {
                name: "matrix-relay-tunnel",
                kind: "relay-tunnel" as const,
                health: relayServiceHealth,
                state: relay.state,
                ...(relay.message === undefined ? {} : { message: relay.message }),
              },
            ]
          : []),
      ],
      ...(runtimeConfig?.relay === undefined
        ? {}
        : {
            relay: {
              enabled: runtimeConfig.relay.enabled,
              controlUrl: runtimeConfig.relay.controlUrl,
              hostname: runtimeConfig.relay.hostname,
              publicBaseUrl: runtimeConfig.relay.publicBaseUrl,
              connected: relay.installed && relay.state === "running",
              serviceInstalled: relay.installed,
              ...(relay.state === "unknown" ? {} : { serviceState: relay.state }),
            },
          }),
      matrix: {
        ...(runtimeConfig?.matrix.publicBaseUrl === undefined
          ? {}
          : { homeserverUrl: runtimeConfig.matrix.publicBaseUrl }),
        health: matrixStatus.health,
        roomReachable: matrixStatus.roomReachable,
        federationEnabled: runtimeConfig?.matrix.federationEnabled ?? false,
        ...(runtimeConfig?.matrix.alertRoom.roomId === undefined
          ? {}
          : { alertRoomId: runtimeConfig.matrix.alertRoom.roomId }),
      },
      openclaw: {
        managedBySovereign,
        cliInstalled,
        ...(detectedOpenClaw?.binaryPath === undefined
          ? {}
          : { binaryPath: detectedOpenClaw.binaryPath }),
        ...(detectedOpenClaw?.version === undefined ? {} : { version: detectedOpenClaw.version }),
        health: openclawHealth,
        serviceInstalled: gateway.installed,
        ...(gateway.state === "unknown" ? {} : { serviceState: gateway.state }),
        ...(runtimeConfig?.openclaw.runtimeConfigPath === undefined
          ? {}
          : { configPath: runtimeConfig.openclaw.runtimeConfigPath }),
        agentPresent,
        cronPresent,
        ...(pluginIds === undefined ? {} : { pluginIds }),
      },
      bots: hostResourceStatus.bots,
      hostResources: hostResourceStatus.resources,
      imap: {
        authStatus: "unknown",
        ...(runtimeConfig?.imap.status !== "configured" || runtimeConfig.imap.host === undefined
          ? {}
          : { host: runtimeConfig.imap.host }),
        ...(runtimeConfig?.imap.status !== "configured" || runtimeConfig.imap.mailbox === undefined
          ? {}
          : { mailbox: runtimeConfig.imap.mailbox }),
      },
      version: {
        sovereignNode: process.env.npm_package_version ?? "2.0.0",
        contractVersion: CONTRACT_VERSION,
        ...(detectedOpenClaw?.version === undefined ? {} : { openclaw: detectedOpenClaw.version }),
        ...(pluginIds === undefined
          ? {}
          : {
              plugins: Object.fromEntries(
                pluginIds.map((pluginId) => [pluginId, "managed-by-sovereign"]),
              ),
            }),
        ...(provenance === null ? {} : { provenance }),
      },
    };
  }

  async getDoctorReport(): Promise<DoctorReport> {
    const checks: CheckResult[] = [];
    const runtimeConfig = await this.tryReadRuntimeConfig();
    const detectedOpenClaw = await this.safeDetectOpenClaw();
    const gateway = await this.inspectGatewayService();
    const relay =
      runtimeConfig?.relay?.enabled === true ? await this.inspectRelayTunnelService() : null;
    const healthProbe = await this.probeOpenClawHealth();
    const expectedAgentIds = runtimeConfig?.openclawProfile.agents.map((entry) => entry.id) ?? [];
    const expectedCronIds = runtimeConfig?.openclawProfile.crons.map((entry) => entry.id) ?? [];
    const agentProbes = await Promise.all(
      expectedAgentIds.map(
        async (id) =>
          await this.inspectManagedOpenClawListContains(runtimeConfig, ["agents", "list"], id),
      ),
    );
    const cronProbes = await Promise.all(
      expectedCronIds.map(
        async (id) =>
          await this.inspectManagedOpenClawListContains(runtimeConfig, ["cron", "list"], id),
      ),
    );
    const managedRuntimeJson =
      runtimeConfig === null ? null : await this.readManagedOpenClawRuntimeJson(runtimeConfig);
    const agentPresent = expectedAgentIds.every(
      (id, index) =>
        !(agentProbes[index]?.verified ?? false) ||
        agentProbes[index]?.present === true ||
        this.managedOpenClawRuntimeHasAgent(managedRuntimeJson, id),
    );
    const cronPresent = expectedCronIds.every(
      (id, index) =>
        !(cronProbes[index]?.verified ?? false) ||
        cronProbes[index]?.present === true ||
        this.managedOpenClawRuntimeHasCron(managedRuntimeJson, id),
    );
    const wiringCheck = await this.inspectOpenClawRuntimeWiring(runtimeConfig);
    const hostResourceStatus =
      runtimeConfig === null
        ? { resources: [], bots: {} }
        : await this.inspectCompiledHostResources(runtimeConfig);

    checks.push(
      check(
        "openclaw-cli",
        "OpenClaw CLI",
        detectedOpenClaw === null ? "fail" : "pass",
        detectedOpenClaw === null
          ? "OpenClaw CLI is not detectable"
          : `OpenClaw CLI detected (${detectedOpenClaw.version})`,
      ),
    );

    checks.push(
      check(
        "openclaw-version-pin",
        "OpenClaw version pin",
        resolveVersionPinStatus(runtimeConfig, detectedOpenClaw),
        describeVersionPin(runtimeConfig, detectedOpenClaw),
        {
          expectedVersion: runtimeConfig?.openclaw.requestedVersion,
          detectedVersion: detectedOpenClaw?.version,
        },
      ),
    );

    checks.push(
      check(
        "gateway-service-install",
        "OpenClaw gateway service install",
        gateway.installed ? "pass" : "fail",
        gateway.installed
          ? "OpenClaw gateway service appears installed"
          : "OpenClaw gateway service is not installed or not detectable",
        gateway.message === undefined ? undefined : { message: gateway.message },
      ),
    );

    checks.push(
      check(
        "gateway-service-health",
        "OpenClaw gateway service health",
        !gateway.installed
          ? "fail"
          : gateway.state === "running" && healthProbe.ok
            ? "pass"
            : gateway.state === "running" && !healthProbe.ok
              ? "warn"
              : "fail",
        gateway.state === "running" && healthProbe.ok
          ? "OpenClaw gateway service is running and health probe succeeded"
          : gateway.state === "running" && !healthProbe.ok
            ? "OpenClaw gateway service is running but health probe did not succeed"
            : "OpenClaw gateway service health probe failed or service is not running",
        {
          state: gateway.state,
          healthProbe: healthProbe.message,
        },
      ),
    );

    if (relay !== null) {
      checks.push(
        check(
          "relay-tunnel-service",
          "Managed relay tunnel service",
          relay.installed && relay.state === "running" ? "pass" : relay.installed ? "warn" : "fail",
          relay.installed && relay.state === "running"
            ? "Managed relay tunnel service is connected"
            : "Managed relay tunnel service is not running",
          relay.message === undefined
            ? undefined
            : {
                state: relay.state,
                message: relay.message,
              },
        ),
      );
    }

    checks.push(wiringCheck);

    checks.push(
      check(
        "managed-bot-registration",
        "Managed bot registration",
        agentProbes.some((probe) => probe.verified) || cronProbes.some((probe) => probe.verified)
          ? agentPresent && cronPresent
            ? "pass"
            : "fail"
          : "warn",
        agentProbes.some((probe) => probe.verified) || cronProbes.some((probe) => probe.verified)
          ? agentPresent && cronPresent
            ? "Managed bot agents and cron entries are present in OpenClaw"
            : "One or more managed bot agents or cron entries are missing in OpenClaw"
          : "Could not fully verify managed bot registration via OpenClaw CLI",
      ),
    );

    const matrixStatus = await this.inspectMatrixStatus(runtimeConfig);
    checks.push(
      check(
        "matrix-runtime-health",
        "Matrix runtime health",
        matrixStatus.health === "healthy"
          ? "pass"
          : matrixStatus.health === "unknown"
            ? "warn"
            : "fail",
        matrixStatus.health === "healthy"
          ? "Matrix homeserver probe succeeded"
          : (matrixStatus.message ?? "Matrix homeserver probe failed"),
      ),
    );

    const provenance = await this.tryReadInstallProvenance();
    if (runtimeConfig !== null) {
      for (const resource of runtimeConfig.hostResources?.resources ?? []) {
        const observed = hostResourceStatus.resources.find(
          (entry) => entry.id === resource.id && entry.agentId === resource.agentId,
        );
        if (observed === undefined) {
          continue;
        }
        for (const resourceCheck of resource.checks) {
          if (resourceCheck.kind === "resource-state") {
            const actual =
              resourceCheck.property === "present"
                ? observed.present
                : resourceCheck.property === "enabled"
                  ? observed.enabled
                  : resourceCheck.property === "active"
                    ? observed.active
                    : resourceCheck.property === "absent"
                      ? observed.present === undefined
                        ? undefined
                        : !observed.present
                      : undefined;
            checks.push(
              check(
                `host-resource:${resource.id}:${resourceCheck.id}`,
                `${resource.agentId} ${resource.id}`,
                actual === resourceCheck.equals
                  ? "pass"
                  : resourceCheck.severity === "fail"
                    ? "fail"
                    : "warn",
                actual === resourceCheck.equals
                  ? `${resourceCheck.property} matches expected state`
                  : `${resourceCheck.property} expected ${String(resourceCheck.equals)} but got ${String(actual)}`,
              ),
            );
            continue;
          }
          const botFields = hostResourceStatus.bots[resource.agentId]?.fields ?? {};
          const actual = botFields[resourceCheck.field];
          const numeric = typeof actual === "number" ? actual : undefined;
          const failed =
            numeric !== undefined &&
            resourceCheck.failGte !== undefined &&
            numeric >= resourceCheck.failGte;
          const warned =
            numeric !== undefined &&
            resourceCheck.warnGte !== undefined &&
            numeric >= resourceCheck.warnGte;
          checks.push(
            check(
              `host-resource:${resource.id}:${resourceCheck.id}`,
              `${resource.agentId} ${resourceCheck.field}`,
              failed ? "fail" : warned ? "warn" : "pass",
              numeric === undefined
                ? `Field '${resourceCheck.field}' is unavailable`
                : `${resourceCheck.field}=${String(numeric)}`,
            ),
          );
        }
      }
    }
    const dfResult = await this.safeExec("df", ["-Pk", "/"]);
    if (dfResult.ok && dfResult.result.exitCode === 0) {
      const parsed = parseDfAvailableBytes(dfResult.result.stdout);
      if (parsed !== null) {
        const diskStatus: CheckResult["status"] =
          parsed.availableBytes < DOCTOR_DISK_FAIL_BYTES
            ? "fail"
            : parsed.availableBytes < DOCTOR_DISK_WARN_BYTES
              ? "warn"
              : "pass";
        checks.push(
          check(
            "disk-space-root",
            "Root filesystem free space",
            diskStatus,
            diskStatus === "pass"
              ? `Sufficient disk space on / (${formatGiB(parsed.availableBytes)} GiB free)`
              : `Low disk space on / (${formatGiB(parsed.availableBytes)} GiB free)`,
            {
              availableBytes: parsed.availableBytes,
              warnThresholdBytes: DOCTOR_DISK_WARN_BYTES,
              failThresholdBytes: DOCTOR_DISK_FAIL_BYTES,
              mountPoint: parsed.mountPoint,
            },
          ),
        );
      }
    }

    checks.push(
      check(
        "install-provenance",
        "Install provenance",
        provenance !== null ? "pass" : "warn",
        provenance !== null
          ? `Install provenance recorded (${provenance.installSource}, ${provenance.nodeRef}@${provenance.nodeCommitSha.slice(0, 8)})`
          : "Install provenance file is missing; run install.sh to generate it",
      ),
    );

    return {
      overall: summarizeChecksOverall(checks),
      checks,
      suggestedCommands: buildSuggestedCommands({
        runtimeConfig,
        gateway,
        healthProbe,
        cliDetected: detectedOpenClaw !== null,
        agentPresent,
        cronPresent,
        wiringCheck,
      }),
    };
  }

  async reconfigureImap(req: ReconfigureImapRequest): Promise<ReconfigureResult> {
    return this.stubService.reconfigureImap(req);
  }

  async reconfigureMatrix(req: ReconfigureMatrixRequest): Promise<ReconfigureResult> {
    const requestedFederation = req.matrix?.federationEnabled;
    if (requestedFederation === undefined) {
      return this.stubService.reconfigureMatrix(req);
    }

    const runtimeConfig = await this.readRuntimeConfig();

    const federationChanged = requestedFederation !== runtimeConfig.matrix.federationEnabled;
    const changed: string[] = [];
    let gatewayRestarted = false;

    if (federationChanged) {
      changed.push("matrix.federationEnabled");

      const raw = await readFile(this.paths.configPath, "utf8");
      const parsed = parseJsonDocument(raw);
      if (!isRecord(parsed)) {
        throw {
          code: "CONFIG_INVALID",
          message: "Sovereign runtime config does not match expected shape",
          retryable: false,
          details: { configPath: this.paths.configPath },
        };
      }

      const matrixConfig = isRecord(parsed.matrix) ? parsed.matrix : {};
      matrixConfig.federationEnabled = requestedFederation;
      parsed.matrix = matrixConfig;
      parsed.generatedAt = now();
      await this.writeInstallerJsonFile(this.paths.configPath, parsed, 0o644);

      const nextRuntimeConfig: RuntimeConfig = {
        ...runtimeConfig,
        matrix: {
          ...runtimeConfig.matrix,
          federationEnabled: requestedFederation,
        },
      };

      if (
        runtimeConfig.matrix.projectDir !== undefined &&
        this.matrixProvisioner.updateFederationConfig !== undefined
      ) {
        const projectDir = runtimeConfig.matrix.projectDir;
        await this.matrixProvisioner.updateFederationConfig({
          federationEnabled: requestedFederation,
          projectDir,
          composeFilePath: join(projectDir, "compose.yaml"),
          accessMode: runtimeConfig.matrix.accessMode,
          homeserverDomain: runtimeConfig.matrix.homeserverDomain,
          publicBaseUrl: runtimeConfig.matrix.publicBaseUrl,
        });
      }

      await this.writeOpenClawRuntimeArtifacts(nextRuntimeConfig);
      this.setManagedOpenClawEnv(nextRuntimeConfig);
      await this.refreshGatewayAfterRuntimeConfig(nextRuntimeConfig);
      gatewayRestarted = true;
    }

    const requestUpdate = await this.updateInstallRequestFederation({
      federationEnabled: requestedFederation,
      changed: federationChanged,
    });
    changed.push(...requestUpdate.changed);

    return {
      target: "matrix",
      changed,
      restartRequiredServices: gatewayRestarted
        ? ["openclaw-gateway", ...(federationChanged ? ["synapse"] : [])]
        : [],
      validation: [
        check(
          "matrix-federation",
          "Matrix federation config",
          "pass",
          federationChanged
            ? `Matrix federation ${requestedFederation ? "enabled" : "disabled"}`
            : "Matrix federation config already matched the requested value",
        ),
        ...(gatewayRestarted
          ? [
              check(
                "openclaw-gateway-restart",
                "OpenClaw gateway restart",
                "pass",
                "OpenClaw gateway restarted with updated federation settings",
              ),
            ]
          : []),
        ...requestUpdate.validation,
      ],
    };
  }

  async reconfigureOpenrouter(req: ReconfigureOpenrouterRequest): Promise<ReconfigureResult> {
    const runtimeConfig = await this.readRuntimeConfig();
    const raw = await readFile(this.paths.configPath, "utf8");
    const parsed = parseJsonDocument(raw);
    if (!isRecord(parsed)) {
      throw {
        code: "CONFIG_INVALID",
        message: "Sovereign runtime config does not match expected shape",
        retryable: false,
        details: {
          configPath: this.paths.configPath,
        },
      };
    }

    const requestedModel = req.openrouter.model?.trim();
    const nextModel =
      requestedModel !== undefined && requestedModel.length > 0
        ? requestedModel
        : runtimeConfig.openrouter.model;
    const modelChanged = nextModel !== runtimeConfig.openrouter.model;

    let nextSecretRef = runtimeConfig.openrouter.apiKeySecretRef;
    let credentialsChanged = false;
    if (req.openrouter.apiKey !== undefined) {
      nextSecretRef = await this.writeManagedSecretFile(
        "openrouter-api-key",
        req.openrouter.apiKey,
      );
      credentialsChanged = true;
    } else if (req.openrouter.secretRef !== undefined) {
      nextSecretRef = req.openrouter.secretRef;
      credentialsChanged = nextSecretRef !== runtimeConfig.openrouter.apiKeySecretRef;
    }

    const runtimeChanged = modelChanged || credentialsChanged;
    const changed: string[] = [];
    if (modelChanged) {
      changed.push("openrouter.model");
    }
    if (credentialsChanged) {
      changed.push("openrouter.apiKeySecretRef");
    }

    let gatewayRestarted = false;
    if (runtimeChanged) {
      const openrouterConfig = isRecord(parsed.openrouter) ? parsed.openrouter : {};
      openrouterConfig.provider = "openrouter";
      openrouterConfig.model = nextModel;
      openrouterConfig.apiKeySecretRef = nextSecretRef;
      delete openrouterConfig.apiKey;
      parsed.openrouter = openrouterConfig;
      parsed.generatedAt = now();
      await this.writeInstallerJsonFile(this.paths.configPath, parsed, 0o644);

      const nextRuntimeConfig: RuntimeConfig = {
        ...runtimeConfig,
        openrouter: {
          model: nextModel,
          apiKeySecretRef: nextSecretRef,
        },
      };
      await this.writeOpenClawRuntimeArtifacts(nextRuntimeConfig);
      this.setManagedOpenClawEnv(nextRuntimeConfig);
      await this.refreshGatewayAfterRuntimeConfig(nextRuntimeConfig);
      gatewayRestarted = true;
    }

    const requestUpdate = await this.updateInstallRequestOpenrouter({
      model: nextModel,
      secretRef: nextSecretRef,
      modelChanged,
      credentialsChanged,
    });
    changed.push(...requestUpdate.changed);

    return {
      target: "openrouter",
      changed,
      restartRequiredServices: gatewayRestarted ? ["openclaw-gateway"] : [],
      validation: [
        check(
          "openrouter-runtime",
          "OpenRouter runtime config",
          "pass",
          runtimeChanged
            ? "OpenRouter runtime config updated"
            : "OpenRouter runtime config already matched the requested values",
        ),
        ...(gatewayRestarted
          ? [
              check(
                "openclaw-gateway-restart",
                "OpenClaw gateway restart",
                "pass",
                "OpenClaw gateway restarted with updated OpenRouter settings",
              ),
            ]
          : []),
        ...requestUpdate.validation,
      ],
    };
  }

  async issueMatrixOnboardingCode(req?: {
    ttlMinutes?: number;
  }): Promise<MatrixOnboardingIssueResult> {
    const runtimeConfig = await this.readRuntimeConfig();
    const operatorPasswordSecretRef = runtimeConfig.matrix.operator.passwordSecretRef;
    if (operatorPasswordSecretRef === undefined || operatorPasswordSecretRef.length === 0) {
      throw {
        code: "MATRIX_ONBOARDING_UNAVAILABLE",
        message: "Matrix onboarding is unavailable because the operator password secret is missing",
        retryable: false,
      };
    }
    const onboardingUrl = this.assertMatrixOnboardingAvailable(runtimeConfig);
    const issued = issueMatrixOnboardingState({
      passwordSecretRef: operatorPasswordSecretRef,
      username: runtimeConfig.matrix.operator.userId,
      homeserverUrl: runtimeConfig.matrix.publicBaseUrl,
      ...(req?.ttlMinutes === undefined ? {} : { ttlMinutes: req.ttlMinutes }),
    });
    await this.writeMatrixOnboardingState(runtimeConfig, issued.state);
    return {
      code: issued.code,
      expiresAt: issued.state.expiresAt,
      onboardingUrl,
      onboardingLink: buildMatrixOnboardingLink(onboardingUrl, issued.code),
      username: runtimeConfig.matrix.operator.userId,
    };
  }

  async getMatrixOnboardingState(): Promise<MatrixOnboardingPublicState | null> {
    let runtimeConfig: RuntimeConfig;
    try {
      runtimeConfig = await this.readRuntimeConfig();
    } catch {
      return null;
    }
    let statePath: string;
    try {
      statePath = this.getMatrixOnboardingStatePath(runtimeConfig);
    } catch {
      return null;
    }
    let raw: string;
    try {
      raw = await readFile(statePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      return null;
    }
    const state = parseMatrixOnboardingState(parsedJson);
    if (state === null) {
      return null;
    }
    return {
      issuedAt: state.issuedAt,
      expiresAt: state.expiresAt,
      ...(state.consumedAt !== undefined ? { consumedAt: state.consumedAt } : {}),
      failedAttempts: state.failedAttempts,
      maxAttempts: state.maxAttempts,
      username: state.username,
      homeserverUrl: state.homeserverUrl,
    };
  }

  async inviteMatrixUser(req: {
    username: string;
    ttlMinutes?: number;
  }): Promise<MatrixOnboardingIssueResult> {
    const runtimeConfig = await this.readRuntimeConfig();
    const onboardingUrl = this.assertMatrixOnboardingAvailable(runtimeConfig);
    const normalized = this.normalizeMatrixUserIdentifier(req.username, runtimeConfig);
    this.assertHumanMatrixUserTarget(runtimeConfig, normalized, "invite");

    const operatorTokenSecretRef = runtimeConfig.matrix.operator.accessTokenSecretRef;
    if (operatorTokenSecretRef === undefined || operatorTokenSecretRef.length === 0) {
      throw {
        code: "MATRIX_USER_INVITE_FAILED",
        message: "Operator Matrix access token is required to invite local Matrix users",
        retryable: false,
      };
    }
    const operatorAccessToken = await this.resolveSecretRef(operatorTokenSecretRef);
    const passwordSecretRef = await this.writeManagedSecretFile(
      `matrix-user-${normalized.localpart}.password`,
      generateAgentPassword(),
    );
    const password = await this.resolveSecretRef(passwordSecretRef);
    const upsertedUserId = await this.ensureSynapseUserViaAdminApi({
      adminBaseUrl: runtimeConfig.matrix.adminBaseUrl,
      adminAccessToken: operatorAccessToken,
      expectedUserId: normalized.userId,
      password,
    });
    const loginSession = await this.loginMatrixUser({
      adminBaseUrl: runtimeConfig.matrix.adminBaseUrl,
      localpart: normalized.localpart,
      password,
      expectedUserId: upsertedUserId,
    });
    await this.ensureMatrixUserInAlertRoom({
      adminBaseUrl: runtimeConfig.matrix.adminBaseUrl,
      roomId: runtimeConfig.matrix.alertRoom.roomId,
      inviterAccessToken: operatorAccessToken,
      inviteeUserId: loginSession.userId,
      inviteeAccessToken: loginSession.accessToken,
    });

    const issued = issueMatrixOnboardingState({
      passwordSecretRef,
      username: loginSession.userId,
      homeserverUrl: runtimeConfig.matrix.publicBaseUrl,
      ttlMinutes: req.ttlMinutes ?? DEFAULT_MATRIX_USER_INVITE_TTL_MINUTES,
    });
    await this.writeMatrixOnboardingState(runtimeConfig, issued.state);
    await this.refreshManagedMatrixRouting(runtimeConfig);
    return {
      code: issued.code,
      expiresAt: issued.state.expiresAt,
      onboardingUrl,
      onboardingLink: buildMatrixOnboardingLink(onboardingUrl, issued.code),
      username: loginSession.userId,
    };
  }

  async removeMatrixUser(req: { username: string }): Promise<MatrixUserRemoveResult> {
    const runtimeConfig = await this.readRuntimeConfig();
    const normalized = this.normalizeMatrixUserIdentifier(req.username, runtimeConfig);
    this.assertHumanMatrixUserTarget(runtimeConfig, normalized, "remove");

    const operatorTokenSecretRef = runtimeConfig.matrix.operator.accessTokenSecretRef;
    if (operatorTokenSecretRef === undefined || operatorTokenSecretRef.length === 0) {
      throw {
        code: "MATRIX_USER_REMOVE_FAILED",
        message: "Operator Matrix access token is required to remove local Matrix users",
        retryable: false,
      };
    }
    const operatorAccessToken = await this.resolveSecretRef(operatorTokenSecretRef);
    const removed = await this.deactivateSynapseUserViaAdminApi({
      adminBaseUrl: runtimeConfig.matrix.adminBaseUrl,
      adminAccessToken: operatorAccessToken,
      expectedUserId: normalized.userId,
    });
    await rm(join(this.paths.secretsDir, `matrix-user-${normalized.localpart}.password`), {
      force: true,
    });
    await this.refreshManagedMatrixRouting(runtimeConfig);
    return {
      localpart: normalized.localpart,
      userId: normalized.userId,
      removed,
    };
  }

  async getPendingMigrations(): Promise<MigrationStatusResult> {
    const requestPath = this.getInstallRequestPath();
    return {
      requestFile: requestPath,
      pending: await this.listPendingMigrations(),
    };
  }

  async migrateLegacyMailSentinel(req: {
    nonInteractive?: boolean;
    matrixLocalpart?: string;
    alertRoomId?: string;
    alertRoomName?: string;
    createAlertRoomName?: string;
    allowedUsers?: string[];
  }): Promise<MailSentinelMigrationResult> {
    const runtimeConfig = await this.readRuntimeConfig();
    const { requestFile, request } = await this.readSavedInstallRequestOrThrow();
    if (!(await this.isMailSentinelMigrationPending(request, runtimeConfig))) {
      const existing = this.getRuntimeBotInstance(runtimeConfig, MAIL_SENTINEL_AGENT_ID);
      if (existing === undefined) {
        throw {
          code: "MAIL_SENTINEL_MIGRATION_NOT_REQUIRED",
          message: "Legacy Mail Sentinel migration is not pending",
          retryable: false,
        };
      }
      return {
        changed: false,
        requestFile,
        instance: this.toMailSentinelSummary(existing, runtimeConfig),
      };
    }

    const legacyAgent = runtimeConfig.openclawProfile.agents.find(
      (entry) => entry.id === MAIL_SENTINEL_AGENT_ID,
    );
    if (legacyAgent === undefined) {
      throw {
        code: "MAIL_SENTINEL_MIGRATION_NOT_REQUIRED",
        message: "Legacy Mail Sentinel agent was not found in the current runtime",
        retryable: false,
      };
    }

    const defaultAllowedUsers = normalizeMatrixUserList(
      (req.allowedUsers ?? (await this.listInvitedHumanMatrixUserIds(runtimeConfig))).map(
        (entry) => this.normalizeMatrixUserIdentifier(entry, runtimeConfig).userId,
      ),
    );
    if (defaultAllowedUsers.length === 0) {
      throw {
        code: "MAIL_SENTINEL_MIGRATION_INPUT_REQUIRED",
        message: "Provide at least one allowed Matrix user for the migrated Mail Sentinel instance",
        retryable: false,
      };
    }

    const alertRoom =
      req.createAlertRoomName === undefined
        ? {
            roomId: req.alertRoomId?.trim() || runtimeConfig.matrix.alertRoom.roomId,
            roomName: req.alertRoomName?.trim() || runtimeConfig.matrix.alertRoom.roomName,
          }
        : await this.createMatrixRoomViaClientApi({
            runtimeConfig,
            roomName: req.createAlertRoomName,
          });
    const localpart = sanitizeManagedAgentLocalpart(
      req.matrixLocalpart ?? legacyAgent.matrix?.localpart,
      MAIL_SENTINEL_AGENT_ID,
    );

    const legacyBotConfig = request.bots?.config?.[MAIL_SENTINEL_AGENT_ID] ?? {};
    const migratedConfig: Record<string, BotConfigValue> = {
      ...legacyBotConfig,
      [MAIL_SENTINEL_IMAP_CONFIGURED_KEY]: runtimeConfig.imap.status === "configured",
      [MAIL_SENTINEL_IMAP_HOST_KEY]: runtimeConfig.imap.host,
      [MAIL_SENTINEL_IMAP_PORT_KEY]: runtimeConfig.imap.port,
      [MAIL_SENTINEL_IMAP_TLS_KEY]: runtimeConfig.imap.tls,
      [MAIL_SENTINEL_IMAP_USERNAME_KEY]: runtimeConfig.imap.username,
      [MAIL_SENTINEL_IMAP_MAILBOX_KEY]: runtimeConfig.imap.mailbox,
    };
    const migratedSecretRefs: Record<string, string> = normalizeStringRecord({
      ...(runtimeConfig.imap.status === "configured" && runtimeConfig.imap.secretRef !== undefined
        ? { [MAIL_SENTINEL_IMAP_PASSWORD_SECRET_KEY]: runtimeConfig.imap.secretRef }
        : {}),
    });
    const migratedInstance: RequestedBotInstance = {
      id: MAIL_SENTINEL_AGENT_ID,
      packageId: MAIL_SENTINEL_AGENT_ID,
      workspace: legacyAgent.workspace,
      config: migratedConfig,
      secretRefs: migratedSecretRefs,
      matrix: {
        localpart,
        alertRoom,
        allowedUsers: defaultAllowedUsers,
      },
    };
    request.bots = {
      ...(request.bots ?? {}),
      selected: dedupeStrings([...(request.bots?.selected ?? []), MAIL_SENTINEL_AGENT_ID]),
      instances: sortBotInstances([
        ...((request.bots?.instances ?? []).filter(
          (entry) => entry.packageId !== MAIL_SENTINEL_AGENT_ID,
        ) as RequestedBotInstance[]),
        migratedInstance,
      ]),
    };
    await this.writeSavedInstallRequest(request);
    return {
      changed: true,
      requestFile,
      instance: this.toMailSentinelSummary(migratedInstance, runtimeConfig),
    };
  }

  async listMailSentinelInstances(): Promise<MailSentinelListResult> {
    const runtimeConfig = await this.tryReadRuntimeConfig();
    if (runtimeConfig !== null) {
      const runtimeInstances = runtimeConfig.bots.instances.filter(
        (entry) => entry.packageId === MAIL_SENTINEL_AGENT_ID,
      );
      if (runtimeInstances.length > 0) {
        return {
          instances: runtimeInstances.map((entry) =>
            this.toMailSentinelSummary(entry, runtimeConfig),
          ),
        };
      }
      const legacyAgent = runtimeConfig.openclawProfile.agents.find(
        (entry) => entry.id === MAIL_SENTINEL_AGENT_ID,
      );
      if (legacyAgent !== undefined) {
        return {
          instances: [
            this.toMailSentinelSummary(
              {
                id: MAIL_SENTINEL_AGENT_ID,
                packageId: MAIL_SENTINEL_AGENT_ID,
                workspace: legacyAgent.workspace,
                config: {
                  [MAIL_SENTINEL_IMAP_CONFIGURED_KEY]: runtimeConfig.imap.status === "configured",
                  [MAIL_SENTINEL_IMAP_HOST_KEY]: runtimeConfig.imap.host,
                  [MAIL_SENTINEL_IMAP_PORT_KEY]: runtimeConfig.imap.port,
                  [MAIL_SENTINEL_IMAP_TLS_KEY]: runtimeConfig.imap.tls,
                  [MAIL_SENTINEL_IMAP_USERNAME_KEY]: runtimeConfig.imap.username,
                  [MAIL_SENTINEL_IMAP_MAILBOX_KEY]: runtimeConfig.imap.mailbox,
                },
                secretRefs: {
                  [MAIL_SENTINEL_IMAP_PASSWORD_SECRET_KEY]: runtimeConfig.imap.secretRef,
                },
                matrix: {
                  ...(legacyAgent.matrix?.localpart === undefined
                    ? {}
                    : { localpart: legacyAgent.matrix.localpart }),
                  alertRoom: runtimeConfig.matrix.alertRoom,
                  allowedUsers: await this.listInvitedHumanMatrixUserIds(runtimeConfig),
                },
              },
              runtimeConfig,
            ),
          ],
        };
      }
    }

    const request = await this.tryReadSavedInstallRequest();
    // Prefer the runtime config's homeserverDomain when it exists so the
    // summary reflects the live Synapse; fall back to the saved install
    // request, then to an empty string when we have neither (the install
    // hasn't bootstrapped Matrix yet — in that case allowedUsers entries
    // without an explicit domain will be rewritten to `@localpart:` which
    // the summary layer tolerates).
    const summaryHomeserverDomain =
      runtimeConfig?.matrix.homeserverDomain ?? request?.request.matrix.homeserverDomain ?? "";
    return {
      instances: (request?.request.bots?.instances ?? [])
        .filter((entry) => entry.packageId === MAIL_SENTINEL_AGENT_ID)
        .map((entry) =>
          this.toMailSentinelSummary(
            this.normalizeRequestedBotInstance({
              entry,
              configById: isBotConfigRecordMap(request?.request.bots?.config)
                ? (request.request.bots?.config ?? {})
                : {},
              matrixRoom: {
                roomId: "",
                roomName: request?.request.matrix.alertRoomName ?? "Sovereign Alerts",
              },
              homeserverDomain: summaryHomeserverDomain,
              previousRuntimeConfig: runtimeConfig,
            }),
            runtimeConfig,
          ),
        ),
    };
  }

  async createMailSentinelInstance(req: {
    id: string;
    imapHost: string;
    imapPort: number;
    imapTls: boolean;
    imapUsername: string;
    imapPassword?: string;
    imapSecretRef?: string;
    mailbox?: string;
    matrixLocalpart?: string;
    alertRoomId?: string;
    alertRoomName?: string;
    createAlertRoomName?: string;
    allowedUsers: string[];
    pollInterval?: string;
    lookbackWindow?: string;
    defaultReminderDelay?: string;
    digestInterval?: string;
  }): Promise<MailSentinelApplyResult> {
    return this.applyMailSentinelInstance(req, "create");
  }

  async updateMailSentinelInstance(req: {
    id: string;
    imapHost?: string;
    imapPort?: number;
    imapTls?: boolean;
    imapUsername?: string;
    imapPassword?: string;
    imapSecretRef?: string;
    mailbox?: string;
    matrixLocalpart?: string;
    alertRoomId?: string;
    alertRoomName?: string;
    createAlertRoomName?: string;
    allowedUsers?: string[];
    pollInterval?: string;
    lookbackWindow?: string;
    defaultReminderDelay?: string;
    digestInterval?: string;
  }): Promise<MailSentinelApplyResult> {
    return this.applyMailSentinelInstance(req, "update");
  }

  async deleteMailSentinelInstance(req: { id: string }): Promise<MailSentinelDeleteResult> {
    await this.assertNoPendingMigrations();
    const { request } = await this.readSavedInstallRequestOrThrow();
    const id = sanitizeManagedAgentId(req.id);
    const existingInstances = request.bots?.instances ?? [];
    const nextInstances = existingInstances.filter((entry) => entry.id !== id);
    if (nextInstances.length === existingInstances.length) {
      return {
        id,
        deleted: false,
      };
    }
    request.bots = {
      ...(request.bots ?? {}),
      selected: (request.bots?.selected ?? []).filter(
        (entry) =>
          entry !== MAIL_SENTINEL_AGENT_ID ||
          nextInstances.some((item) => item.packageId === entry),
      ),
      instances: nextInstances,
    };
    this.syncSelectedBotsWithInstances(request);
    await this.writeSavedInstallRequest(request);
    const result = await this.startInstall(request);
    return {
      id,
      deleted: true,
      job: result.job,
    };
  }

  async listManagedAgents(): Promise<ManagedAgentListResult> {
    const runtimeConfig = await this.readRuntimeConfig();
    return {
      agents: runtimeConfig.openclawProfile.agents.map((entry) => this.toManagedAgentOutput(entry)),
    };
  }

  async listSovereignBots(): Promise<SovereignBotListResult> {
    const runtimeConfig = await this.tryReadRuntimeConfig();
    const installedTemplateRefs = new Set(
      runtimeConfig?.templates.installed.map((entry) =>
        formatTemplateRef(entry.id, entry.version),
      ) ?? [],
    );
    const botPackages = await this.listBotPackages();
    const bots = await Promise.all(
      botPackages.map(async (botPackage) => {
        const agent = runtimeConfig?.openclawProfile.agents.find(
          (entry) =>
            entry.templateRef === botPackage.templateRef || entry.botId === botPackage.manifest.id,
        );
        const cronJobIds = runtimeConfig?.openclawProfile.crons
          .filter(
            (entry) =>
              entry.botId === botPackage.manifest.id || entry.agentId === botPackage.manifest.id,
          )
          .map((entry) => entry.id)
          .sort((left, right) => left.localeCompare(right));
        return {
          id: botPackage.manifest.id,
          version: botPackage.manifest.version,
          displayName: botPackage.manifest.displayName,
          description: botPackage.manifest.description,
          defaultInstall: botPackage.manifest.defaultInstall === true,
          templateRef: botPackage.templateRef,
          installed: installedTemplateRefs.has(botPackage.templateRef),
          instantiated: agent !== undefined,
          ...(agent === undefined ? {} : { agentId: agent.id }),
          ...(cronJobIds === undefined || cronJobIds.length === 0 ? {} : { cronJobIds }),
        };
      }),
    );
    return {
      bots: bots.sort((left, right) => left.id.localeCompare(right.id)),
    };
  }

  async instantiateSovereignBot(req: {
    id: string;
    workspace?: string;
  }): Promise<SovereignBotInstantiateResult> {
    const runtimeConfig = await this.readRuntimeConfig();
    const botPackage = await this.getBotPackage(req.id);
    const changedTemplate = await this.ensureBotTemplatesInstalled(runtimeConfig, botPackage);
    if (changedTemplate) {
      await this.persistManagedAgentTopologyDocument(runtimeConfig);
    }
    const toolInstanceIds = await this.ensureBotToolInstances(runtimeConfig, botPackage);
    const agentResult = await this.upsertManagedAgent(
      {
        id: botPackage.manifest.id,
        ...(req.workspace === undefined ? {} : { workspace: req.workspace }),
        botId: botPackage.manifest.id,
        templateRef: botPackage.templateRef,
        toolInstanceIds,
      },
      "create",
    );
    const bot = (await this.listSovereignBots()).bots.find(
      (entry) => entry.id === botPackage.manifest.id,
    );
    return {
      bot: bot ?? {
        id: botPackage.manifest.id,
        version: botPackage.manifest.version,
        displayName: botPackage.manifest.displayName,
        description: botPackage.manifest.description,
        defaultInstall: botPackage.manifest.defaultInstall === true,
        templateRef: botPackage.templateRef,
        installed: true,
        instantiated: true,
        agentId: agentResult.agent.id,
      },
      agent: agentResult.agent,
      changed: changedTemplate || agentResult.changed,
      restartRequiredServices: agentResult.restartRequiredServices,
    };
  }

  async listSovereignTemplates(): Promise<SovereignTemplateListResult> {
    const runtimeConfig = await this.tryReadRuntimeConfig();
    const botPackages = await this.listBotPackages();
    const installedByRef = new Map(
      (runtimeConfig?.templates.installed ?? []).map((entry) => [
        formatTemplateRef(entry.id, entry.version),
        entry,
      ]),
    );
    const coreTemplates: SovereignTemplateListResult["templates"] = CORE_TEMPLATE_MANIFESTS.map(
      (manifest) => {
        const verified = verifySignedTemplateManifest(manifest, CORE_TRUSTED_TEMPLATE_KEYS);
        const ref = formatTemplateRef(manifest.id, manifest.version);
        const installed = installedByRef.get(ref);
        return {
          kind: "tool",
          id: manifest.id,
          version: manifest.version,
          description: manifest.description,
          trusted: verified.trusted,
          installed: installed !== undefined,
          pinned: installed?.pinned ?? false,
          keyId: verified.keyId,
          manifestSha256: verified.manifestSha256,
        };
      },
    );
    const botAgentTemplates: SovereignTemplateListResult["templates"] = botPackages.map(
      (botPackage) => {
        const installed = installedByRef.get(botPackage.templateRef);
        return {
          kind: "agent" as const,
          id: botPackage.template.id,
          version: botPackage.template.version,
          description: botPackage.template.description,
          trusted: true,
          installed: installed !== undefined,
          pinned: installed?.pinned ?? false,
          keyId: botPackage.keyId,
          manifestSha256: botPackage.manifestSha256,
        };
      },
    );
    const botToolTemplates: SovereignTemplateListResult["templates"] = botPackages.flatMap(
      (botPackage) =>
        botPackage.toolTemplates.map((toolTemplate) => {
          const installed = installedByRef.get(toolTemplate.templateRef);
          return {
            kind: "tool" as const,
            id: toolTemplate.manifest.id,
            version: toolTemplate.manifest.version,
            description: toolTemplate.manifest.description,
            trusted: true,
            installed: installed !== undefined,
            pinned: installed?.pinned ?? false,
            keyId: toolTemplate.keyId,
            manifestSha256: toolTemplate.manifestSha256,
          };
        }),
    );
    const templates = [...coreTemplates, ...botAgentTemplates, ...botToolTemplates].sort(
      (left, right) =>
        `${left.kind}:${left.id}:${left.version}`.localeCompare(
          `${right.kind}:${right.id}:${right.version}`,
        ),
    );
    return { templates };
  }

  async installSovereignTemplate(req: { ref: string }): Promise<SovereignTemplateInstallResult> {
    const manifest = findCoreTemplateManifest(req.ref);
    const runtimeConfig = await this.readRuntimeConfig();
    if (manifest !== undefined) {
      const existing = runtimeConfig.templates.installed.find(
        (entry) => formatTemplateRef(entry.id, entry.version) === req.ref,
      );
      if (existing !== undefined) {
        return {
          template: {
            kind: existing.kind,
            id: existing.id,
            version: existing.version,
            description: existing.description,
            trusted: existing.trusted,
            installed: true,
            pinned: existing.pinned,
            keyId: existing.keyId,
            manifestSha256: existing.manifestSha256,
          },
          changed: false,
        };
      }
      const installed = this.buildInstalledTemplateEntryFromCore(manifest);
      runtimeConfig.templates.installed = sortInstalledTemplates([
        ...runtimeConfig.templates.installed,
        installed,
      ]);
      await this.persistManagedAgentTopologyDocument(runtimeConfig);
      return {
        template: {
          kind: installed.kind,
          id: installed.id,
          version: installed.version,
          description: installed.description,
          trusted: installed.trusted,
          installed: true,
          pinned: installed.pinned,
          keyId: installed.keyId,
          manifestSha256: installed.manifestSha256,
        },
        changed: true,
      };
    }

    const botPackages = await this.listBotPackages();
    const botPackage = botPackages.find((entry) => entry.templateRef === req.ref) ?? null;
    if (botPackage !== null) {
      const changed = await this.ensureBotTemplatesInstalled(runtimeConfig, botPackage);
      if (changed) {
        await this.persistManagedAgentTopologyDocument(runtimeConfig);
      }
      return {
        template: {
          kind: "agent",
          id: botPackage.template.id,
          version: botPackage.template.version,
          description: botPackage.template.description,
          trusted: true,
          installed: true,
          pinned: true,
          keyId: botPackage.keyId,
          manifestSha256: botPackage.manifestSha256,
        },
        changed,
      };
    }

    const botToolTemplate = this.findBotToolTemplate(botPackages, req.ref);
    if (botToolTemplate === null) {
      throw {
        code: "TEMPLATE_NOT_FOUND",
        message: `Template '${req.ref}' was not found in the trusted catalog`,
        retryable: false,
      };
    }
    const updated = this.upsertInstalledTemplateEntry(
      runtimeConfig.templates.installed,
      botToolTemplate.templateRef,
      this.buildInstalledToolTemplateEntryFromBot(botToolTemplate),
    );
    const changed = updated.changed;
    if (changed) {
      runtimeConfig.templates.installed = updated.installed;
      await this.persistManagedAgentTopologyDocument(runtimeConfig);
    }
    return {
      template: {
        kind: "tool",
        id: botToolTemplate.manifest.id,
        version: botToolTemplate.manifest.version,
        description: botToolTemplate.manifest.description,
        trusted: true,
        installed: true,
        pinned: true,
        keyId: botToolTemplate.keyId,
        manifestSha256: botToolTemplate.manifestSha256,
      },
      changed,
    };
  }

  private buildInstalledTemplateEntryFromCore(
    manifest: SovereignTemplateManifest,
  ): RuntimeConfig["templates"]["installed"][number] {
    const verified = verifySignedTemplateManifest(manifest, CORE_TRUSTED_TEMPLATE_KEYS);
    return {
      kind: "tool",
      id: manifest.id,
      version: manifest.version,
      description: manifest.description,
      trusted: true,
      pinned: true,
      keyId: verified.keyId,
      manifestSha256: verified.manifestSha256,
      installedAt: now(),
      source: "core",
    };
  }

  private buildInstalledTemplateEntryFromBot(
    botPackage: LoadedBotPackage,
  ): RuntimeConfig["templates"]["installed"][number] {
    return {
      kind: "agent",
      id: botPackage.template.id,
      version: botPackage.template.version,
      description: botPackage.template.description,
      trusted: true,
      pinned: true,
      keyId: botPackage.keyId,
      manifestSha256: botPackage.manifestSha256,
      installedAt: now(),
      source: "bot-repo",
    };
  }

  private buildInstalledToolTemplateEntryFromBot(
    toolTemplate: LoadedBotPackage["toolTemplates"][number],
  ): RuntimeConfig["templates"]["installed"][number] {
    return {
      kind: "tool",
      id: toolTemplate.manifest.id,
      version: toolTemplate.manifest.version,
      description: toolTemplate.manifest.description,
      trusted: true,
      pinned: true,
      keyId: toolTemplate.keyId,
      manifestSha256: toolTemplate.manifestSha256,
      installedAt: now(),
      source: "bot-repo",
    };
  }

  private upsertInstalledTemplateEntry(
    existing: RuntimeConfig["templates"]["installed"],
    ref: string,
    next: RuntimeConfig["templates"]["installed"][number],
  ): {
    installed: RuntimeConfig["templates"]["installed"];
    changed: boolean;
  } {
    const current = existing.find((entry) => formatTemplateRef(entry.id, entry.version) === ref);
    if (
      current !== undefined &&
      current.kind === next.kind &&
      current.description === next.description &&
      current.trusted === next.trusted &&
      current.pinned === next.pinned &&
      current.keyId === next.keyId &&
      current.manifestSha256 === next.manifestSha256 &&
      current.source === next.source
    ) {
      return {
        installed: existing,
        changed: false,
      };
    }

    return {
      installed: sortInstalledTemplates([
        ...existing.filter((entry) => formatTemplateRef(entry.id, entry.version) !== ref),
        current === undefined
          ? next
          : {
              ...next,
              installedAt: current.installedAt,
            },
      ]),
      changed: true,
    };
  }

  private upsertInstalledBotTemplateEntry(
    existing: RuntimeConfig["templates"]["installed"],
    botPackage: LoadedBotPackage,
  ): {
    installed: RuntimeConfig["templates"]["installed"];
    changed: boolean;
  } {
    return this.upsertInstalledTemplateEntry(
      existing,
      botPackage.templateRef,
      this.buildInstalledTemplateEntryFromBot(botPackage),
    );
  }

  private upsertInstalledBotToolTemplateEntries(
    existing: RuntimeConfig["templates"]["installed"],
    botPackage: LoadedBotPackage,
  ): {
    installed: RuntimeConfig["templates"]["installed"];
    changed: boolean;
  } {
    let installed = existing;
    let changed = false;
    for (const toolTemplate of botPackage.toolTemplates) {
      const updated = this.upsertInstalledTemplateEntry(
        installed,
        toolTemplate.templateRef,
        this.buildInstalledToolTemplateEntryFromBot(toolTemplate),
      );
      installed = updated.installed;
      changed = changed || updated.changed;
    }
    return { installed, changed };
  }

  private async ensureBotTemplatesInstalled(
    runtimeConfig: RuntimeConfig,
    botPackage: LoadedBotPackage,
  ): Promise<boolean> {
    const updatedAgent = this.upsertInstalledBotTemplateEntry(
      runtimeConfig.templates.installed,
      botPackage,
    );
    const updatedTools = this.upsertInstalledBotToolTemplateEntries(
      updatedAgent.installed,
      botPackage,
    );
    if (!updatedAgent.changed && !updatedTools.changed) {
      return false;
    }
    runtimeConfig.templates.installed = updatedTools.installed;
    return true;
  }

  private withRequiredCoreTemplates(
    existing: RuntimeConfig["templates"]["installed"],
    refs: string[],
  ): RuntimeConfig["templates"]["installed"] {
    const byRef = new Map(
      existing.map((entry) => [formatTemplateRef(entry.id, entry.version), entry] as const),
    );
    for (const ref of refs) {
      const manifest = findCoreTemplateManifest(ref);
      if (manifest === undefined) {
        throw {
          code: "TEMPLATE_NOT_FOUND",
          message: `Template '${ref}' was not found in the trusted core catalog`,
          retryable: false,
        };
      }
      if (byRef.has(ref)) {
        continue;
      }
      byRef.set(ref, this.buildInstalledTemplateEntryFromCore(manifest));
    }
    return sortInstalledTemplates(Array.from(byRef.values()));
  }

  private findBotToolTemplate(
    botPackages: LoadedBotPackage[],
    ref: string,
  ): LoadedBotPackage["toolTemplates"][number] | null {
    for (const botPackage of botPackages) {
      const matched = botPackage.toolTemplates.find((entry) => entry.templateRef === ref);
      if (matched !== undefined) {
        return matched;
      }
    }
    return null;
  }

  private resolveKnownToolTemplateManifest(
    ref: string,
    botPackages: LoadedBotPackage[],
  ): ToolTemplateDefinition {
    const coreTemplate = findCoreTemplateManifest(ref);
    if (coreTemplate !== undefined && coreTemplate.kind === "sovereign-tool-template") {
      return coreTemplate;
    }
    const botTemplate = this.findBotToolTemplate(botPackages, ref);
    if (botTemplate !== null) {
      return botTemplate.manifest;
    }
    throw {
      code: "TEMPLATE_NOT_FOUND",
      message: `Tool template '${ref}' was not found in the trusted catalog`,
      retryable: false,
    };
  }

  private async ensureBotToolInstances(
    runtimeConfig: RuntimeConfig,
    botPackage: LoadedBotPackage,
    botInstance?: RequestedBotInstance,
  ): Promise<string[]> {
    const requiredCoreTemplateRefs = botPackage.manifest.toolInstances
      .map((entry: LoadedBotPackage["manifest"]["toolInstances"][number]) => entry.templateRef)
      .filter((ref: string) => findCoreTemplateManifest(ref) !== undefined);
    if (requiredCoreTemplateRefs.length > 0) {
      runtimeConfig.templates.installed = this.withRequiredCoreTemplates(
        runtimeConfig.templates.installed,
        dedupeStrings(requiredCoreTemplateRefs),
      );
      await this.persistManagedAgentTopologyDocument(runtimeConfig);
    }
    const toolInstanceIdMap = this.buildManagedBotToolInstanceIdMap(
      botPackage,
      botInstance?.id ?? botPackage.manifest.id,
    );
    const toolInstanceIds: string[] = [];
    for (const tool of botPackage.manifest.toolInstances) {
      if (
        !this.isBotToolInstanceEnabled(runtimeConfig, tool.enabledWhen, {
          botPackage,
          botInstance,
          toolInstanceIdMap,
        })
      ) {
        continue;
      }
      const bindings = this.resolveBotToolBindings(runtimeConfig, tool, {
        botPackage,
        botInstance,
        toolInstanceIdMap,
      });
      await this.upsertSovereignToolInstance(
        {
          id: toolInstanceIdMap[tool.id] ?? tool.id,
          templateRef: tool.templateRef,
          config: bindings.config,
          secretRefs: bindings.secretRefs,
        },
        "create",
      );
      toolInstanceIds.push(tool.id);
    }
    return toolInstanceIds;
  }

  private buildManagedBotToolInstance(input: {
    runtimeConfig: RuntimeConfig;
    availableBotPackages: LoadedBotPackage[];
    botPackage: LoadedBotPackage;
    botInstance?: RequestedBotInstance;
    tool: LoadedBotPackage["manifest"]["toolInstances"][number];
    existing: RuntimeConfig["sovereignTools"]["instances"][number] | undefined;
    toolInstanceIdMap: Record<string, string>;
  }): MaterializedBotToolInstance {
    const template = this.resolveKnownToolTemplateManifest(
      input.tool.templateRef,
      input.availableBotPackages,
    );
    const bindings = this.resolveBotToolBindings(input.runtimeConfig, input.tool, {
      botPackage: input.botPackage,
      botInstance: input.botInstance,
      toolInstanceIdMap: input.toolInstanceIdMap,
    });
    const id = input.toolInstanceIdMap[input.tool.id] ?? input.tool.id;
    return {
      id,
      templateRef: input.tool.templateRef,
      capabilities: [...template.capabilities],
      config: bindings.config,
      secretRefs: bindings.secretRefs,
      createdAt: input.existing?.createdAt ?? now(),
      updatedAt: now(),
      botId: input.botPackage.manifest.id,
      ...(input.botInstance === undefined ? {} : { botInstanceId: input.botInstance.id }),
      manifestToolId: input.tool.id,
    };
  }

  private buildManagedBotToolInstanceIdMap(
    botPackage: LoadedBotPackage,
    instanceId: string,
  ): Record<string, string> {
    return Object.fromEntries(
      botPackage.manifest.toolInstances.map((tool) => [
        tool.id,
        this.materializeManagedBotToolInstanceId(botPackage, instanceId, tool.id),
      ]),
    );
  }

  private materializeManagedBotToolInstanceId(
    botPackage: LoadedBotPackage,
    instanceId: string,
    manifestToolId: string,
  ): string {
    if (instanceId === botPackage.manifest.id) {
      return manifestToolId;
    }
    return sanitizeToolInstanceId(`${instanceId}-${manifestToolId}`);
  }

  private isBotToolInstanceEnabled(
    runtimeConfig: RuntimeConfig,
    enabledWhen: LoadedBotPackage["manifest"]["toolInstances"][number]["enabledWhen"],
    context?: {
      botPackage: LoadedBotPackage;
      botInstance: RequestedBotInstance | undefined;
      toolInstanceIdMap: Record<string, string>;
    },
  ): boolean {
    if (enabledWhen === undefined) {
      return true;
    }
    return (
      this.resolveBotPathValue(runtimeConfig, enabledWhen.path, context) === enabledWhen.equals
    );
  }

  private resolveBotToolBindings(
    runtimeConfig: RuntimeConfig,
    tool: LoadedBotPackage["manifest"]["toolInstances"][number],
    context?: {
      botPackage: LoadedBotPackage;
      botInstance: RequestedBotInstance | undefined;
      toolInstanceIdMap: Record<string, string>;
    },
  ): {
    config: Record<string, string>;
    secretRefs: Record<string, string>;
  } {
    return {
      config: Object.fromEntries(
        (Object.entries(tool.config) as Array<[string, (typeof tool.config)[string]]>).map(
          ([key, binding]) => [
            key,
            this.stringifyBotBindingValue(
              this.resolveRequiredBotPathValue(runtimeConfig, binding.from, context),
              binding.stringify === true,
            ),
          ],
        ),
      ),
      secretRefs: Object.fromEntries(
        (Object.entries(tool.secretRefs) as Array<[string, (typeof tool.secretRefs)[string]]>).map(
          ([key, binding]) => [
            key,
            this.stringifyBotBindingValue(
              this.resolveRequiredBotPathValue(runtimeConfig, binding.from, context),
              true,
            ),
          ],
        ),
      ),
    };
  }

  private resolveRequiredBotPathValue(
    runtimeConfig: RuntimeConfig,
    path: string,
    context?: {
      botPackage: LoadedBotPackage;
      botInstance: RequestedBotInstance | undefined;
      toolInstanceIdMap: Record<string, string>;
    },
  ): BotConfigValue {
    const value = this.resolveBotPathValue(runtimeConfig, path, context);
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return value;
    }
    throw {
      code: "BOT_BINDING_RESOLUTION_FAILED",
      message: `Runtime value '${path}' is unavailable for managed bot binding`,
      retryable: false,
      details: {
        path,
      },
    };
  }

  private resolveBotPathValue(
    runtimeConfig: RuntimeConfig,
    path: string,
    context?: {
      botPackage: LoadedBotPackage;
      botInstance: RequestedBotInstance | undefined;
      toolInstanceIdMap: Record<string, string>;
    },
  ): unknown {
    const botInstance = context?.botInstance;
    const botPackage = context?.botPackage;
    // When the binding resolver runs without a concrete botInstance (e.g.
    // inside the `instances.length === 0` branch of the managed-tool
    // construction, reached for any bot selected by the installer that has
    // no pre-existing bot instance from a prior runtime config), we still
    // want `instance.config.*` paths to resolve. Fall back to the bot
    // package's configDefaults so manifests that rely purely on defaults
    // (no user overrides) still build their tool bindings. Historically
    // this only surfaced when a selected bot lacked an `enabledWhen` gate
    // on every tool instance — mail-sentinel's imap tool is gated, so the
    // no-instance branch skipped it and never exercised this path.
    const syntheticInstance =
      botInstance === undefined && botPackage !== undefined
        ? {
            id: botPackage.manifest.id,
            packageId: botPackage.manifest.id,
            workspace: "",
            config: { ...botPackage.manifest.configDefaults },
            secretRefs: {} as Record<string, string>,
            // Bot tool bindings commonly reference
            // `instance.matrix.alertRoom.roomId` to pin alerts at the node's
            // single alert room. Mirror the runtime config's alert room
            // into the synthetic instance.matrix so those bindings resolve
            // without requiring a pre-existing bot instance.
            matrix: {
              alertRoom: {
                roomId: runtimeConfig.matrix?.alertRoom?.roomId ?? "",
                roomName: runtimeConfig.matrix?.alertRoom?.roomName ?? "",
              },
            },
            toolInstanceIds: context?.toolInstanceIdMap ?? {},
          }
        : undefined;
    const syntheticAgent =
      botInstance === undefined && botPackage !== undefined
        ? {
            id: botPackage.manifest.id,
            workspace: "",
          }
        : undefined;
    return path.split(".").reduce<unknown>(
      (current, segment) => {
        if (!isRecord(current) || !(segment in current)) {
          return undefined;
        }
        return current[segment];
      },
      {
        ...runtimeConfig,
        ...(botInstance === undefined
          ? syntheticInstance === undefined
            ? {}
            : {
                instance: syntheticInstance,
                agent: syntheticAgent,
              }
          : {
              instance: {
                id: botInstance.id,
                packageId: botInstance.packageId,
                workspace: botInstance.workspace,
                config: botInstance.config,
                secretRefs: botInstance.secretRefs,
                matrix: botInstance.matrix ?? {},
                toolInstanceIds: context?.toolInstanceIdMap ?? {},
              },
              agent: {
                id: botInstance.id,
                workspace: botInstance.workspace,
              },
            }),
      },
    );
  }

  private stringifyBotBindingValue(value: BotConfigValue, forceString: boolean): string {
    if (typeof value === "string") {
      return value;
    }
    if (forceString || typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    return "";
  }

  private async compileHostResourcePlan(
    runtimeConfig: RuntimeConfig,
    botPackages: LoadedBotPackage[],
  ): Promise<CompiledHostPlan> {
    const resources: CompiledHostResource[] = [];
    const botStatus: CompiledBotStatus[] = [];

    for (const botPackage of botPackages) {
      const agents = runtimeConfig.openclawProfile.agents.filter(
        (entry) => entry.botId === botPackage.manifest.id || entry.id === botPackage.manifest.id,
      );
      if (agents.length === 0) {
        continue;
      }
      for (const agent of agents) {
        const botInstance = this.getRuntimeBotInstanceForAgent(runtimeConfig, agent);
        const context: HostResourceContext = {
          runtimeConfig,
          botPackage,
          agent,
          ...(botInstance === undefined ? {} : { botInstance }),
          toolInstanceIds: agent.toolInstanceIds ?? [],
          toolInstanceIdMap: this.buildManagedBotToolInstanceIdMap(
            botPackage,
            botInstance?.id ?? agent.id,
          ),
        };
        for (const resource of botPackage.manifest.hostResources) {
          if (!this.isBotHostResourceEnabled(context, resource.enabledWhen)) {
            continue;
          }
          const compiled = await this.compileHostResource(context, resource);
          resources.push(...compiled.resources);
          botStatus.push(...compiled.botStatus);
        }
      }
    }

    return { resources, botStatus };
  }

  private async refreshRuntimeHostResources(runtimeConfig: RuntimeConfig): Promise<void> {
    const availableBotPackages = await this.listBotPackages();
    const selectedBotPackages = availableBotPackages.filter((botPackage) =>
      runtimeConfig.openclawProfile.agents.some(
        (agent) =>
          agent.botId === botPackage.manifest.id || agent.templateRef === botPackage.templateRef,
      ),
    );
    const hostPlan = await this.compileHostResourcePlan(runtimeConfig, selectedBotPackages);
    runtimeConfig.hostResources = {
      planPath: join(dirname(this.paths.configPath), "host-resources.json"),
      resources: hostPlan.resources,
      botStatus: hostPlan.botStatus,
    };
    runtimeConfig.openclawProfile.crons = hostPlan.resources.flatMap((resource) =>
      resource.kind !== "openclawCron" ||
      resource.desiredState !== "present" ||
      resource.spec === undefined
        ? []
        : [
            {
              id: resource.spec.id,
              every: resource.spec.every,
              agentId: resource.spec.agentId,
              botId: resource.botId,
            },
          ],
    );
    if (runtimeConfig.openclawProfile.crons[0] === undefined) {
      delete runtimeConfig.openclawProfile.cron;
    } else {
      runtimeConfig.openclawProfile.cron = {
        id: runtimeConfig.openclawProfile.crons[0].id,
        every: runtimeConfig.openclawProfile.crons[0].every,
      };
    }
  }

  private isBotHostResourceEnabled(
    context: HostResourceContext,
    enabledWhen: SovereignBotHostResource["enabledWhen"],
  ): boolean {
    if (enabledWhen === undefined) {
      return true;
    }
    return this.resolveHostResourcePathValue(context, enabledWhen.path) === enabledWhen.equals;
  }

  private async compileHostResource(
    context: HostResourceContext,
    resource: SovereignBotHostResource,
  ): Promise<CompiledHostPlan> {
    const plan: CompiledHostPlan = { resources: [], botStatus: [] };
    const checks = this.compileHostResourceChecks(resource.checks);
    switch (resource.kind) {
      case "directory": {
        const compiledDirectory: CompiledHostResource = {
          id: resource.id,
          botId: context.botPackage.manifest.id,
          agentId: context.agent.id,
          kind: "directory",
          path: this.resolveHostResourceString(context, resource.spec.path),
          ...(resource.spec.mode === undefined ? {} : { mode: resource.spec.mode }),
          ...(typeof context.runtimeConfig.openclaw.serviceUser === "string"
            ? {
                owner:
                  resource.spec.owner === undefined
                    ? context.runtimeConfig.openclaw.serviceUser
                    : this.resolveHostResourceString(context, resource.spec.owner),
              }
            : resource.spec.owner === undefined
              ? {}
              : { owner: this.resolveHostResourceString(context, resource.spec.owner) }),
          ...(typeof context.runtimeConfig.openclaw.serviceGroup === "string"
            ? {
                group:
                  resource.spec.group === undefined
                    ? context.runtimeConfig.openclaw.serviceGroup
                    : this.resolveHostResourceString(context, resource.spec.group),
              }
            : resource.spec.group === undefined
              ? {}
              : { group: this.resolveHostResourceString(context, resource.spec.group) }),
          checks,
        };
        plan.resources.push(compiledDirectory);
        break;
      }
      case "managedFile":
      case "stateFile": {
        const path = this.resolveHostResourceString(context, resource.spec.path);
        const content = await this.compileHostResourceContent(
          context,
          resource.spec.source,
          resource.spec.inlineContent,
        );
        const compiledFile: CompiledHostResource = {
          id: resource.id,
          botId: context.botPackage.manifest.id,
          agentId: context.agent.id,
          kind: resource.kind,
          path,
          content,
          ...(resource.spec.mode === undefined ? {} : { mode: resource.spec.mode }),
          ...(typeof context.runtimeConfig.openclaw.serviceUser === "string"
            ? {
                owner:
                  resource.spec.owner === undefined
                    ? context.runtimeConfig.openclaw.serviceUser
                    : this.resolveHostResourceString(context, resource.spec.owner),
              }
            : resource.spec.owner === undefined
              ? {}
              : { owner: this.resolveHostResourceString(context, resource.spec.owner) }),
          ...(typeof context.runtimeConfig.openclaw.serviceGroup === "string"
            ? {
                group:
                  resource.spec.group === undefined
                    ? context.runtimeConfig.openclaw.serviceGroup
                    : this.resolveHostResourceString(context, resource.spec.group),
              }
            : resource.spec.group === undefined
              ? {}
              : { group: this.resolveHostResourceString(context, resource.spec.group) }),
          writePolicy: resource.spec.writePolicy,
          ...(resource.kind === "stateFile" && Object.keys(resource.status.fields).length > 0
            ? { statusFields: this.compileHostStatusFields(resource.status.fields) }
            : {}),
          checks,
        };
        plan.resources.push(compiledFile);
        if (resource.kind === "stateFile" && Object.keys(resource.status.fields).length > 0) {
          plan.botStatus.push({
            botId: context.botPackage.manifest.id,
            agentId: context.agent.id,
            resourceId: resource.id,
            path,
            fields: this.compileHostStatusFields(resource.status.fields),
          });
        }
        break;
      }
      case "systemdService": {
        const name = this.resolveHostResourceString(context, resource.spec.name);
        plan.resources.push({
          id: resource.id,
          botId: context.botPackage.manifest.id,
          agentId: context.agent.id,
          kind: "systemdService",
          name,
          content: this.renderSystemdServiceResource(context, resource),
          desiredState: resource.spec.desiredState,
          checks,
        });
        break;
      }
      case "systemdTimer": {
        const name = this.resolveHostResourceString(context, resource.spec.name);
        plan.resources.push({
          id: resource.id,
          botId: context.botPackage.manifest.id,
          agentId: context.agent.id,
          kind: "systemdTimer",
          name,
          content: this.renderSystemdTimerResource(context, resource),
          desiredState: resource.spec.desiredState,
          checks,
        });
        break;
      }
      case "openclawCron": {
        const desiredState = resource.spec.desiredState;
        plan.resources.push({
          id: resource.id,
          botId: context.botPackage.manifest.id,
          agentId: context.agent.id,
          kind: "openclawCron",
          desiredState,
          match: {
            name: this.resolveHostResourceString(context, resource.spec.id),
            agentId: this.resolveHostResourceString(context, resource.spec.agentId),
          },
          ...(desiredState === "present"
            ? {
                spec: {
                  id: this.resolveHostResourceString(context, resource.spec.id),
                  agentId: this.resolveHostResourceString(context, resource.spec.agentId),
                  every: this.resolveHostResourceString(context, resource.spec.every),
                  session: resource.spec.session,
                  message: this.resolveHostResourceString(context, resource.spec.message),
                  ...(resource.spec.announceRoomId === undefined
                    ? {}
                    : {
                        announceRoomId: this.resolveHostResourceString(
                          context,
                          resource.spec.announceRoomId,
                        ),
                      }),
                },
              }
            : {}),
          checks,
        });
        break;
      }
    }

    resource.supersedes.forEach((superseded, index) => {
      if (superseded.kind === "openclawCron") {
        plan.resources.push({
          id: `${resource.id}::supersede::${index}`,
          botId: context.botPackage.manifest.id,
          agentId: context.agent.id,
          kind: "openclawCron",
          desiredState: "absent",
          match: {
            ...(superseded.match.id === undefined ? {} : { id: superseded.match.id }),
            ...(superseded.match.name === undefined
              ? {}
              : { name: this.resolveHostResourceString(context, superseded.match.name) }),
            ...(superseded.match.agentId === undefined
              ? {}
              : { agentId: this.resolveHostResourceString(context, superseded.match.agentId) }),
          },
          checks: [],
        });
      }
    });

    return plan;
  }

  private compileHostResourceChecks(
    checks: SovereignBotHostStateCheck[],
  ): CompiledHostResourceCheck[] {
    return checks.map((entry) =>
      entry.kind === "field-threshold"
        ? {
            kind: "field-threshold",
            id: entry.id,
            field: entry.field,
            ...(entry.warnGte === undefined ? {} : { warnGte: entry.warnGte }),
            ...(entry.failGte === undefined ? {} : { failGte: entry.failGte }),
          }
        : {
            kind: "resource-state",
            id: entry.id,
            property: entry.property,
            equals: entry.equals,
            severity: entry.severity,
          },
    );
  }

  private compileHostStatusFields(
    fields: Record<
      string,
      {
        path: string;
        type: "string" | "int" | "boolean" | "timestamp" | "object";
        default?: string | number | boolean | undefined;
      }
    >,
  ): Record<
    string,
    {
      path: string;
      type: "string" | "int" | "boolean" | "timestamp" | "object";
      default?: string | number | boolean | undefined;
    }
  > {
    return Object.fromEntries(
      Object.entries(fields).map(([fieldName, field]) => [
        fieldName,
        {
          path: field.path,
          type: field.type,
          ...(field.default === undefined ? {} : { default: field.default }),
        },
      ]),
    );
  }

  private resolveHostResourceValue(
    context: HostResourceContext,
    expr: HostResourceValueExpr,
  ): string | number | boolean {
    if (typeof expr === "string" || typeof expr === "number" || typeof expr === "boolean") {
      return expr;
    }
    if ("from" in expr) {
      const value = this.resolveHostResourcePathValue(context, expr.from);
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return value;
      }
      throw new Error(`Host resource binding '${expr.from}' did not resolve to a primitive value`);
    }
    if ("join" in expr) {
      return expr.join.map((part) => String(this.resolveHostResourceValue(context, part))).join("");
    }
    if ("default" in expr) {
      const resolved = this.resolveHostResourceValue(context, expr.default[0]);
      if (typeof resolved === "string" && resolved.length === 0) {
        return expr.default[1];
      }
      return resolved ?? expr.default[1];
    }
    if ("convert" in expr) {
      const value = String(this.resolveHostResourceValue(context, expr.value));
      if (expr.convert === "duration.toSystemd") {
        return toSystemdDuration(value);
      }
    }
    throw new Error("Unsupported host resource expression");
  }

  private resolveHostResourceString(
    context: HostResourceContext,
    expr: HostResourceValueExpr,
  ): string {
    return String(this.resolveHostResourceValue(context, expr));
  }

  private resolveHostResourcePathValue(context: HostResourceContext, path: string): unknown {
    const alertRoom =
      context.botInstance?.matrix?.alertRoom ?? context.runtimeConfig.matrix.alertRoom;
    const values = {
      node: {
        paths: {
          configPath: this.paths.configPath,
          secretsDir: this.paths.secretsDir,
          stateDir: this.paths.stateDir,
          logsDir: this.paths.logsDir,
        },
        openclaw: {
          serviceUser: context.runtimeConfig.openclaw.serviceUser,
          serviceGroup: context.runtimeConfig.openclaw.serviceGroup,
          serviceHome: this.paths.openclawServiceHome,
          runtimeConfigPath: context.runtimeConfig.openclaw.runtimeConfigPath,
        },
      },
      bot: {
        id: context.botPackage.manifest.id,
        version: context.botPackage.manifest.version,
        config: context.runtimeConfig.bots.config[context.botPackage.manifest.id] ?? {},
      },
      instance:
        context.botInstance === undefined
          ? undefined
          : {
              id: context.botInstance.id,
              packageId: context.botInstance.packageId,
              workspace: context.botInstance.workspace,
              config: context.botInstance.config,
              secretRefs: context.botInstance.secretRefs,
              matrix: context.botInstance.matrix ?? {},
              toolInstanceIds: context.toolInstanceIdMap,
            },
      agent: {
        id: context.agent.id,
        workspace: context.agent.workspace,
      },
      matrix: {
        homeserver: context.runtimeConfig.matrix.publicBaseUrl,
        alertRoomId: alertRoom.roomId,
        operatorUserId: context.runtimeConfig.matrix.operator.userId,
      },
      tools: {
        ids: context.toolInstanceIds,
      },
      runtime: context.runtimeConfig,
    };
    return path.split(".").reduce<unknown>((current, segment) => {
      if (!isRecord(current) || !(segment in current)) {
        return undefined;
      }
      return current[segment];
    }, values);
  }

  private async compileHostResourceContent(
    context: HostResourceContext,
    source: string | undefined,
    inlineContent: string | undefined,
  ): Promise<string> {
    const alertRoom =
      context.botInstance?.matrix?.alertRoom ?? context.runtimeConfig.matrix.alertRoom;
    const raw =
      source !== undefined
        ? await readFile(join(context.botPackage.rootDir, source), "utf8")
        : (inlineContent ?? "");
    const toolSection = await this.buildManagedBotToolSection(
      context.runtimeConfig,
      context.toolInstanceIds,
    );
    return `${renderTemplateWorkspaceContent({
      content: stripSingleTrailingNewline(raw),
      agentId: context.agent.id,
      matrixHomeserver: context.runtimeConfig.matrix.publicBaseUrl,
      matrixAlertRoomId: alertRoom.roomId,
      matrixOperatorUserId: context.runtimeConfig.matrix.operator.userId,
      toolSection,
    })}\n`;
  }

  private async buildManagedBotToolSection(
    runtimeConfig: RuntimeConfig,
    toolInstanceIds: string[],
  ): Promise<string> {
    const boundTools = this.resolveBoundToolInstances(runtimeConfig, toolInstanceIds);
    const toolLines =
      boundTools.length === 0
        ? ["No bound tool instances."]
        : ["Use only the documented OpenClaw tools or CLI commands listed below.", ""];
    for (const tool of boundTools) {
      const manifest = await this.resolveInstalledToolTemplate(runtimeConfig, tool.templateRef);
      toolLines.push(
        `- \`${tool.id}\``,
        `  template: \`${tool.templateRef}\``,
        `  capabilities: ${manifest.capabilities.join(", ")}`,
        ...this.listDocumentedOpenClawToolNames(manifest).map(
          (toolName) => `  openclaw-tool: \`${toolName}\``,
        ),
        ...this.listDocumentedSovereignToolCommands(runtimeConfig, tool.id, manifest).map(
          (command) => `  command: \`${command}\``,
        ),
        ...this.listDocumentedSovereignToolNotes(manifest),
      );
    }
    return toolLines.join("\n");
  }

  private renderSystemdServiceResource(
    context: HostResourceContext,
    resource: Extract<SovereignBotHostResource, { kind: "systemdService" }>,
  ): string {
    const lines = [
      "[Unit]",
      `Description=${this.resolveHostResourceString(context, resource.spec.description)}`,
      ...resource.spec.after.map(
        (entry) => `After=${this.resolveHostResourceString(context, entry)}`,
      ),
      ...resource.spec.wants.map(
        (entry) => `Wants=${this.resolveHostResourceString(context, entry)}`,
      ),
      "",
      "[Service]",
      `Type=${resource.spec.type}`,
      ...(resource.spec.user === undefined
        ? []
        : [`User=${this.resolveHostResourceString(context, resource.spec.user)}`]),
      ...(resource.spec.group === undefined
        ? []
        : [`Group=${this.resolveHostResourceString(context, resource.spec.group)}`]),
      ...(resource.spec.workingDirectory === undefined
        ? []
        : [
            `WorkingDirectory=${this.resolveHostResourceString(context, resource.spec.workingDirectory)}`,
          ]),
      ...Object.entries(resource.spec.environment).map(
        ([key, value]) => `Environment=${key}=${this.resolveHostResourceString(context, value)}`,
      ),
      `ExecStart=${resource.spec.execStart.map((entry) => this.resolveHostResourceString(context, entry)).join(" ")}`,
      ...(resource.spec.timeoutStartSec === undefined
        ? []
        : [`TimeoutStartSec=${String(resource.spec.timeoutStartSec)}`]),
      ...(resource.spec.restart === undefined ? [] : [`Restart=${resource.spec.restart}`]),
      ...(resource.spec.restartSec === undefined
        ? []
        : [`RestartSec=${this.resolveHostResourceString(context, resource.spec.restartSec)}`]),
      "",
      "[Install]",
      ...resource.spec.wantedBy.map(
        (entry) => `WantedBy=${this.resolveHostResourceString(context, entry)}`,
      ),
      "",
    ];
    return lines.join("\n");
  }

  private renderSystemdTimerResource(
    context: HostResourceContext,
    resource: Extract<SovereignBotHostResource, { kind: "systemdTimer" }>,
  ): string {
    const lines = [
      "[Unit]",
      `Description=${this.resolveHostResourceString(context, resource.spec.description)}`,
      "",
      "[Timer]",
      ...(resource.spec.unit === undefined
        ? []
        : [`Unit=${this.resolveHostResourceString(context, resource.spec.unit)}`]),
      ...(resource.spec.onActiveSec === undefined
        ? []
        : [`OnActiveSec=${this.resolveHostResourceString(context, resource.spec.onActiveSec)}`]),
      ...(resource.spec.onBootSec === undefined
        ? []
        : [`OnBootSec=${this.resolveHostResourceString(context, resource.spec.onBootSec)}`]),
      ...(resource.spec.onUnitActiveSec === undefined
        ? []
        : [
            `OnUnitActiveSec=${this.resolveHostResourceString(context, resource.spec.onUnitActiveSec)}`,
          ]),
      ...(resource.spec.accuracySec === undefined
        ? []
        : [`AccuracySec=${this.resolveHostResourceString(context, resource.spec.accuracySec)}`]),
      ...(resource.spec.persistent === undefined
        ? []
        : [`Persistent=${resource.spec.persistent ? "true" : "false"}`]),
      "",
      "[Install]",
      ...resource.spec.wantedBy.map(
        (entry) => `WantedBy=${this.resolveHostResourceString(context, entry)}`,
      ),
      "",
    ];
    return lines.join("\n");
  }

  private async inspectCompiledHostResources(runtimeConfig: RuntimeConfig): Promise<{
    resources: Array<{
      id: string;
      botId: string;
      agentId: string;
      kind:
        | "directory"
        | "managedFile"
        | "stateFile"
        | "systemdService"
        | "systemdTimer"
        | "openclawCron";
      target: string;
      present?: boolean;
      enabled?: boolean;
      active?: boolean;
      health: ComponentHealth;
      message?: string;
    }>;
    bots: Record<
      string,
      {
        fields: Record<string, string | number | boolean | Record<string, unknown>>;
        health: ComponentHealth;
      }
    >;
  }> {
    const resources: Array<{
      id: string;
      botId: string;
      agentId: string;
      kind:
        | "directory"
        | "managedFile"
        | "stateFile"
        | "systemdService"
        | "systemdTimer"
        | "openclawCron";
      target: string;
      present?: boolean;
      enabled?: boolean;
      active?: boolean;
      health: ComponentHealth;
      message?: string;
    }> = [];
    const bots: Record<
      string,
      {
        fields: Record<string, string | number | boolean | Record<string, unknown>>;
        health: ComponentHealth;
      }
    > = {};
    const cronJobs = await this.listOpenClawCronJobsForStatus(runtimeConfig);

    for (const resource of runtimeConfig.hostResources?.resources ?? []) {
      const currentBot = bots[resource.agentId] ?? {
        fields: {},
        health: "healthy" as ComponentHealth,
      };
      bots[resource.agentId] = currentBot;
      switch (resource.kind) {
        case "directory":
        case "managedFile":
        case "stateFile": {
          let present = false;
          let message: string | undefined;
          try {
            const info = await stat(resource.path);
            present = resource.kind === "directory" ? info.isDirectory() : info.isFile();
            if (!present) {
              message =
                resource.kind === "directory" ? "Path is not a directory" : "Path is not a file";
            }
          } catch (error) {
            if (!isNodeError(error) || error.code !== "ENOENT") {
              message = error instanceof Error ? error.message : String(error);
            }
          }
          const health: ComponentHealth = present ? "healthy" : "unhealthy";
          resources.push({
            id: resource.id,
            botId: resource.botId,
            agentId: resource.agentId,
            kind: resource.kind,
            target: resource.path,
            present,
            health,
            ...(message === undefined ? {} : { message }),
          });
          if (resource.kind === "stateFile" && present && resource.statusFields !== undefined) {
            try {
              const parsed = JSON.parse(await readFile(resource.path, "utf8")) as unknown;
              for (const [fieldName, fieldSpec] of Object.entries(resource.statusFields)) {
                const raw = this.extractNestedValue(parsed, fieldSpec.path);
                const nextValue =
                  raw === undefined
                    ? fieldSpec.default
                    : this.coerceBotStatusValue(raw, fieldSpec.type);
                if (nextValue !== undefined) {
                  currentBot.fields[fieldName] = nextValue;
                }
              }
            } catch (error) {
              currentBot.fields[`${resource.id}Error`] = {
                code: "STATE_FILE_READ_FAILED",
                message: error instanceof Error ? error.message : String(error),
              };
              currentBot.health = "degraded";
            }
          }
          if (health === "unhealthy") {
            currentBot.health = "unhealthy";
          }
          break;
        }
        case "systemdService":
        case "systemdTimer": {
          const enabled = await this.inspectSystemdBool(resource.name, "is-enabled");
          const active = await this.inspectSystemdActive(resource.name);
          const matchesDesiredState =
            enabled === resource.desiredState.enabled && active === resource.desiredState.active;
          const health: ComponentHealth = matchesDesiredState ? "healthy" : "unhealthy";
          resources.push({
            id: resource.id,
            botId: resource.botId,
            agentId: resource.agentId,
            kind: resource.kind,
            target: resource.name,
            enabled,
            active,
            health,
          });
          if (health === "unhealthy") {
            currentBot.health = "unhealthy";
          }
          break;
        }
        case "openclawCron": {
          const matches = cronJobs.filter(
            (entry) =>
              (resource.match.id === undefined ||
                entry.id === resource.match.id ||
                entry.name === resource.match.id) &&
              (resource.match.name === undefined || entry.name === resource.match.name) &&
              (resource.match.agentId === undefined || entry.agentId === resource.match.agentId),
          );
          const present = matches.length > 0;
          const health: ComponentHealth =
            resource.desiredState === "absent"
              ? present
                ? "unhealthy"
                : "healthy"
              : present
                ? "healthy"
                : "unhealthy";
          resources.push({
            id: resource.id,
            botId: resource.botId,
            agentId: resource.agentId,
            kind: resource.kind,
            target: resource.match.name ?? resource.match.id ?? resource.id,
            present,
            health,
          });
          if (health === "unhealthy") {
            currentBot.health = "unhealthy";
          }
          break;
        }
      }
    }

    return { resources, bots };
  }

  private async inspectSystemdBool(
    unitName: string,
    verb: "is-enabled" | "is-active",
  ): Promise<boolean> {
    const result = await this.safeExec("systemctl", [verb, unitName]);
    if (!result.ok || result.result.exitCode !== 0) {
      return false;
    }
    const normalized = result.result.stdout.trim().toLowerCase();
    return normalized === "enabled" || normalized === "active";
  }

  private async inspectSystemdActive(unitName: string): Promise<boolean> {
    const result = await this.safeExec("systemctl", ["is-active", unitName]);
    if (!result.ok || result.result.exitCode !== 0) {
      return false;
    }
    return result.result.stdout.trim().toLowerCase() === "active";
  }

  private async listOpenClawCronJobsForStatus(
    runtimeConfig: RuntimeConfig,
  ): Promise<Array<{ id: string; name: string; agentId?: string }>> {
    try {
      let stdout = "";
      await this.withManagedOpenClawServiceIdentityEnv(runtimeConfig, async () => {
        const result = await this.safeExec("openclaw", ["cron", "list", "--json"]);
        if (result.ok && result.result.exitCode === 0) {
          stdout = result.result.stdout;
        }
      });
      if (stdout.length === 0) {
        return [];
      }
      const parsed = parseJsonSafely(stdout);
      const jobs = Array.isArray(parsed)
        ? parsed
        : isRecord(parsed) && Array.isArray(parsed.jobs)
          ? parsed.jobs
          : [];
      return jobs.flatMap((entry) => {
        if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.name !== "string") {
          return [];
        }
        return [
          {
            id: entry.id,
            name: entry.name,
            ...(typeof entry.agentId === "string" ? { agentId: entry.agentId } : {}),
          },
        ];
      });
    } catch {
      return [];
    }
  }

  private extractNestedValue(value: unknown, path: string): unknown {
    return path.split(".").reduce<unknown>((current, segment) => {
      if (!isRecord(current) || !(segment in current)) {
        return undefined;
      }
      return current[segment];
    }, value);
  }

  private coerceBotStatusValue(
    value: unknown,
    type: "string" | "int" | "boolean" | "timestamp" | "object",
  ): string | number | boolean | Record<string, unknown> | undefined {
    switch (type) {
      case "string":
      case "timestamp":
        return typeof value === "string" ? value : undefined;
      case "int":
        return typeof value === "number" && Number.isInteger(value) ? value : undefined;
      case "boolean":
        return typeof value === "boolean" ? value : undefined;
      case "object":
        return isRecord(value) ? value : undefined;
    }
  }

  async listSovereignToolInstances(): Promise<SovereignToolInstanceListResult> {
    const runtimeConfig = await this.readRuntimeConfig();
    return {
      tools: runtimeConfig.sovereignTools.instances
        .map((entry) => ({
          id: entry.id,
          templateRef: entry.templateRef,
          capabilities: [...entry.capabilities],
          config: { ...entry.config },
          secretRefs: { ...entry.secretRefs },
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    };
  }

  async createSovereignToolInstance(req: {
    id: string;
    templateRef: string;
    config?: Record<string, string>;
    secretRefs?: Record<string, string>;
  }): Promise<SovereignToolInstanceUpsertResult> {
    return this.upsertSovereignToolInstance(req, "create");
  }

  async updateSovereignToolInstance(req: {
    id: string;
    templateRef?: string;
    config?: Record<string, string>;
    secretRefs?: Record<string, string>;
  }): Promise<SovereignToolInstanceUpsertResult> {
    return this.upsertSovereignToolInstance(req, "update");
  }

  async deleteSovereignToolInstance(req: {
    id: string;
  }): Promise<SovereignToolInstanceDeleteResult> {
    const runtimeConfig = await this.readRuntimeConfig();
    const id = sanitizeToolInstanceId(req.id);
    const existing = runtimeConfig.sovereignTools.instances.find((entry) => entry.id === id);
    if (existing === undefined) {
      return {
        id,
        deleted: false,
      };
    }
    const referencedBy = runtimeConfig.openclawProfile.agents
      .filter((entry) => (entry.toolInstanceIds ?? []).includes(id))
      .map((entry) => entry.id);
    if (referencedBy.length > 0) {
      throw {
        code: "TOOL_INSTANCE_IN_USE",
        message: `Tool instance '${id}' is still referenced by one or more agents`,
        retryable: false,
        details: {
          toolInstanceId: id,
          referencedBy,
        },
      };
    }

    runtimeConfig.sovereignTools.instances = runtimeConfig.sovereignTools.instances.filter(
      (entry) => entry.id !== id,
    );
    await this.persistManagedAgentTopologyDocument(runtimeConfig);
    return {
      id,
      deleted: true,
    };
  }

  private async upsertSovereignToolInstance(
    req: {
      id: string;
      templateRef?: string;
      config?: Record<string, string>;
      secretRefs?: Record<string, string>;
    },
    mode: "create" | "update",
  ): Promise<SovereignToolInstanceUpsertResult> {
    const runtimeConfig = await this.readRuntimeConfig();
    const id = sanitizeToolInstanceId(req.id);
    const existing = runtimeConfig.sovereignTools.instances.find((entry) => entry.id === id);
    if (mode === "update" && existing === undefined) {
      throw {
        code: "TOOL_INSTANCE_NOT_FOUND",
        message: `Sovereign tool instance '${id}' does not exist`,
        retryable: false,
      };
    }
    const nextTemplateRef = sanitizeOptionalTemplateRef(req.templateRef) ?? existing?.templateRef;
    if (nextTemplateRef === undefined) {
      throw {
        code: "TOOL_TEMPLATE_REQUIRED",
        message: "Tool template ref is required (example: imap-readonly@1.0.0)",
        retryable: false,
      };
    }
    const toolTemplate = await this.resolveInstalledToolTemplate(runtimeConfig, nextTemplateRef);
    const nextConfig = normalizeStringRecord(req.config ?? existing?.config ?? {});
    const nextSecretRefs = normalizeStringRecord(req.secretRefs ?? existing?.secretRefs ?? {});
    this.validateToolInstanceBindings({
      template: toolTemplate,
      config: nextConfig,
      secretRefs: nextSecretRefs,
    });
    const nextTool = {
      id,
      templateRef: nextTemplateRef,
      capabilities: [...toolTemplate.capabilities],
      config: nextConfig,
      secretRefs: nextSecretRefs,
      createdAt: existing?.createdAt ?? now(),
      updatedAt: now(),
    };
    const changed =
      existing === undefined ||
      existing.templateRef !== nextTool.templateRef ||
      !areStringListsEqual(existing.capabilities, nextTool.capabilities) ||
      !areStringRecordsEqual(existing.config, nextTool.config) ||
      !areStringRecordsEqual(existing.secretRefs, nextTool.secretRefs);
    if (!changed) {
      return {
        tool: {
          id: existing.id,
          templateRef: existing.templateRef,
          capabilities: [...existing.capabilities],
          config: { ...existing.config },
          secretRefs: { ...existing.secretRefs },
        },
        changed: false,
      };
    }

    runtimeConfig.sovereignTools.instances = [
      ...runtimeConfig.sovereignTools.instances.filter((entry) => entry.id !== id),
      nextTool,
    ].sort((left, right) => left.id.localeCompare(right.id));
    await this.persistManagedAgentTopologyDocument(runtimeConfig);

    return {
      tool: {
        id: nextTool.id,
        templateRef: nextTool.templateRef,
        capabilities: [...nextTool.capabilities],
        config: { ...nextTool.config },
        secretRefs: { ...nextTool.secretRefs },
      },
      changed: true,
    };
  }

  private toManagedAgentOutput(entry: RuntimeAgentEntry): ManagedAgent {
    return {
      id: entry.id,
      workspace: entry.workspace,
      ...(entry.matrix?.userId === undefined ? {} : { matrixUserId: entry.matrix.userId }),
      ...(entry.templateRef === undefined ? {} : { templateRef: entry.templateRef }),
      ...(entry.toolInstanceIds === undefined || entry.toolInstanceIds.length === 0
        ? {}
        : { toolInstanceIds: [...entry.toolInstanceIds] }),
    };
  }

  private async resolveInstalledToolTemplate(
    runtimeConfig: RuntimeConfig,
    ref: string,
  ): Promise<ToolTemplateDefinition> {
    const parsed = parseTemplateRef(ref);
    const installed = runtimeConfig.templates.installed.find(
      (entry) => entry.id === parsed.id && entry.version === parsed.version,
    );
    if (installed === undefined) {
      throw {
        code: "TEMPLATE_NOT_INSTALLED",
        message: `Template '${ref}' is not installed`,
        retryable: false,
      };
    }
    if (installed.kind !== "tool") {
      throw {
        code: "TEMPLATE_KIND_MISMATCH",
        message: `Template '${ref}' is not a tool template`,
        retryable: false,
      };
    }
    if (!installed.pinned) {
      throw {
        code: "TEMPLATE_NOT_PINNED",
        message: `Template '${ref}' must be pinned before use`,
        retryable: false,
      };
    }
    const coreManifest = findCoreTemplateManifest(ref);
    if (coreManifest !== undefined && coreManifest.kind === "sovereign-tool-template") {
      const verified = verifySignedTemplateManifest(coreManifest, CORE_TRUSTED_TEMPLATE_KEYS);
      if (
        verified.manifestSha256 !== installed.manifestSha256 ||
        verified.keyId !== installed.keyId
      ) {
        throw {
          code: "TEMPLATE_PIN_MISMATCH",
          message: `Pinned metadata does not match trusted manifest for '${ref}'`,
          retryable: false,
        };
      }
      return coreManifest;
    }

    const botTemplate = this.findBotToolTemplate(await this.listBotPackages(), ref);
    if (botTemplate === null) {
      throw {
        code: "TEMPLATE_MANIFEST_UNAVAILABLE",
        message: `Trusted manifest for '${ref}' is unavailable`,
        retryable: false,
      };
    }
    if (
      botTemplate.manifestSha256 !== installed.manifestSha256 ||
      botTemplate.keyId !== installed.keyId
    ) {
      throw {
        code: "TEMPLATE_PIN_MISMATCH",
        message: `Pinned metadata does not match trusted manifest for '${ref}'`,
        retryable: false,
      };
    }
    return botTemplate.manifest;
  }

  private async resolveInstalledAgentTemplate(
    runtimeConfig: RuntimeConfig,
    ref: string,
  ): Promise<AgentTemplateManifest> {
    const parsed = parseTemplateRef(ref);
    const installed = runtimeConfig.templates.installed.find(
      (entry) => entry.id === parsed.id && entry.version === parsed.version,
    );
    if (installed === undefined) {
      throw {
        code: "TEMPLATE_NOT_INSTALLED",
        message: `Template '${ref}' is not installed`,
        retryable: false,
      };
    }
    if (installed.kind !== "agent") {
      throw {
        code: "TEMPLATE_KIND_MISMATCH",
        message: `Template '${ref}' is not an agent template`,
        retryable: false,
      };
    }
    if (!installed.pinned) {
      throw {
        code: "TEMPLATE_NOT_PINNED",
        message: `Template '${ref}' must be pinned before use`,
        retryable: false,
      };
    }
    const botPackage = await this.botCatalog.findPackageByTemplateRef(ref);
    if (botPackage === null) {
      throw {
        code: "TEMPLATE_MANIFEST_UNAVAILABLE",
        message: `Trusted manifest for '${ref}' is unavailable`,
        retryable: false,
      };
    }
    if (
      botPackage.manifestSha256 !== installed.manifestSha256 ||
      botPackage.keyId !== installed.keyId
    ) {
      throw {
        code: "TEMPLATE_PIN_MISMATCH",
        message: `Pinned metadata does not match trusted manifest for '${ref}'`,
        retryable: false,
      };
    }
    return botPackage.template;
  }

  private resolveBoundToolInstances(
    runtimeConfig: RuntimeConfig,
    toolInstanceIds: string[],
  ): RuntimeConfig["sovereignTools"]["instances"] {
    return toolInstanceIds
      .map((id) => runtimeConfig.sovereignTools.instances.find((entry) => entry.id === id))
      .filter(
        (entry): entry is RuntimeConfig["sovereignTools"]["instances"][number] =>
          entry !== undefined,
      );
  }

  private resolveSovereignToolCommandContext(
    runtimeConfig: RuntimeConfig,
    toolInstanceId: string,
  ): {
    agentWorkspace?: string;
  } {
    const tool = runtimeConfig.sovereignTools.instances.find(
      (entry) => entry.id === toolInstanceId,
    );
    const configuredAgentId = tool?.config.agentId;
    const agent =
      (typeof configuredAgentId === "string"
        ? runtimeConfig.openclawProfile.agents.find((entry) => entry.id === configuredAgentId)
        : undefined) ??
      runtimeConfig.openclawProfile.agents.find((entry) =>
        entry.toolInstanceIds?.includes(toolInstanceId),
      );
    return {
      ...(agent === undefined ? {} : { agentWorkspace: agent.workspace }),
    };
  }

  private renderSovereignToolCommand(
    runtimeConfig: RuntimeConfig,
    toolInstanceId: string,
    command: string,
  ): string {
    const context = this.resolveSovereignToolCommandContext(runtimeConfig, toolInstanceId);
    let rendered = command.replaceAll("<tool-instance-id>", toolInstanceId);
    if (rendered.includes("<agent-workspace>")) {
      if (context.agentWorkspace === undefined) {
        throw new Error(`Tool instance '${toolInstanceId}' is missing an agent workspace binding`);
      }
      rendered = rendered.replaceAll("<agent-workspace>", context.agentWorkspace);
    }
    const [executable, ...rest] = rendered.split(" ");
    const resolvedExecutable =
      executable === undefined ? "" : (SOVEREIGN_EXECUTABLE_PATHS[executable] ?? executable);
    return [resolvedExecutable, ...rest].filter((part) => part.length > 0).join(" ");
  }

  private listDocumentedSovereignToolCommands(
    runtimeConfig: RuntimeConfig,
    toolInstanceId: string,
    manifest: ToolTemplateDefinition,
  ): string[] {
    const commands = manifest.allowedCommands.map((command) =>
      this.renderSovereignToolCommand(runtimeConfig, toolInstanceId, command),
    );
    if (manifest.id === "node-cli-ops") {
      commands.push(
        this.renderSovereignToolCommand(
          runtimeConfig,
          toolInstanceId,
          "sovereign-node onboarding issue --ttl-minutes <minutes> --json",
        ),
        this.renderSovereignToolCommand(
          runtimeConfig,
          toolInstanceId,
          "sovereign-node users invite <username> --json",
        ),
        this.renderSovereignToolCommand(
          runtimeConfig,
          toolInstanceId,
          "sovereign-node users invite <username> --ttl-minutes <minutes> --json",
        ),
        this.renderSovereignToolCommand(
          runtimeConfig,
          toolInstanceId,
          "sovereign-node users remove <username> --json",
        ),
      );
    }
    return Array.from(new Set(commands));
  }

  private listDocumentedSovereignToolNotes(manifest: ToolTemplateDefinition): string[] {
    if (manifest.id === "imap-readonly") {
      return [
        "  note: searches already run inside the configured mailbox",
        "  note: use `--query ALL` for the whole mailbox and do not prefix the query with `INBOX`",
      ];
    }
    if (manifest.id === "guarded-json-state") {
      return [
        `  note: use the OpenClaw tool \`${GUARDED_JSON_STATE_OPENCLAW_TOOL_NAME}\` for all reads and mutations; do not use \`exec\` or direct file tools`,
        "  note: the guarded tool resolves the current Matrix sender from the active OpenClaw session on its own; never pass `--actor` or session metadata manually",
        "  note: for upserts, pass mutation fields through the tool's `input` object and never as raw shell JSON",
        "  note: if the policy defines a generated self key for the entity, you may omit the id field in the tool `input`; the CLI will generate it",
        "  note: for string-array fields, prefer JSON arrays; the CLI also normalizes a single scalar into a one-item array",
        "  note: the CLI also normalizes numeric and boolean scalar inputs into strings",
        "  note: use `show` or `list` for reads and reserve `upsert-self` / `delete-self` for creator-owned mutations",
      ];
    }
    if (manifest.id === "node-cli-ops") {
      return [
        "  note: use `sovereign-node onboarding issue` when the operator wants to sign into an existing account on another device",
        `  note: use bare localparts like \`satoshi\`; \`users invite\` defaults to ${String(DEFAULT_MATRIX_USER_INVITE_TTL_MINUTES)} minutes`,
      ];
    }
    if (manifest.id === "mail-sentinel-tool") {
      return [
        "  note: use the Mail Sentinel workspace helper `scan` command for background polling; do not summarize the inbox manually during cron runs",
        "  note: use the Mail Sentinel workspace helper `list-alerts --view today` for 'What is important today?' requests",
        "  note: use the Mail Sentinel workspace helper `feedback --latest` only when the user clearly refers to the newest alert; otherwise pass `--alert-id` explicitly",
      ];
    }
    return [];
  }

  private listDocumentedOpenClawToolNames(manifest: ToolTemplateDefinition): string[] {
    return dedupeStrings(manifest.openclawToolNames ?? []);
  }

  private listDeclaredOpenClawPluginIds(manifest: ToolTemplateDefinition): string[] {
    return dedupeStrings([
      ...(manifest.openclawPlugins ?? []),
      ...(manifest.openclawBundledPlugins ?? []),
    ]);
  }

  private listLoadableOpenClawPluginIds(manifest: ToolTemplateDefinition): string[] {
    return dedupeStrings(manifest.openclawPlugins ?? []);
  }

  private listRequiredOpenClawPluginIds(botPackages: LoadedBotPackage[]): string[] {
    return dedupeStrings([
      "matrix",
      ...botPackages.flatMap((botPackage) =>
        botPackage.toolTemplates.flatMap((toolTemplate) =>
          this.listDeclaredOpenClawPluginIds(toolTemplate.manifest),
        ),
      ),
    ]);
  }

  private async listManagedOpenClawPluginIds(runtimeConfig: RuntimeConfig): Promise<string[]> {
    const pluginIds = new Set<string>();
    for (const agent of runtimeConfig.openclawProfile.agents) {
      for (const tool of this.resolveBoundToolInstances(
        runtimeConfig,
        agent.toolInstanceIds ?? [],
      )) {
        const manifest = await this.resolveInstalledToolTemplate(runtimeConfig, tool.templateRef);
        for (const pluginId of this.listDeclaredOpenClawPluginIds(manifest)) {
          pluginIds.add(pluginId);
        }
      }
    }
    return Array.from(pluginIds).sort();
  }

  private async listManagedLoadableOpenClawPluginIds(
    runtimeConfig: RuntimeConfig,
  ): Promise<string[]> {
    const pluginIds = new Set<string>();
    for (const agent of runtimeConfig.openclawProfile.agents) {
      for (const tool of this.resolveBoundToolInstances(
        runtimeConfig,
        agent.toolInstanceIds ?? [],
      )) {
        const manifest = await this.resolveInstalledToolTemplate(runtimeConfig, tool.templateRef);
        for (const pluginId of this.listLoadableOpenClawPluginIds(manifest)) {
          pluginIds.add(pluginId);
        }
      }
    }
    return Array.from(pluginIds).sort();
  }

  private async listManagedOpenClawPluginLoadPaths(
    runtimeConfig: RuntimeConfig,
  ): Promise<string[]> {
    const pluginIds = await this.listManagedLoadableOpenClawPluginIds(runtimeConfig);
    return pluginIds.map((pluginId) =>
      join(runtimeConfig.openclaw.openclawHome, "extensions", pluginId),
    );
  }

  private shouldEnsureLobsterCli(botPackages: LoadedBotPackage[]): boolean {
    return botPackages.some((botPackage) =>
      botPackage.toolTemplates.some((toolTemplate) => {
        const manifest = toolTemplate.manifest;
        return (
          this.listDeclaredOpenClawPluginIds(manifest).includes("lobster") ||
          this.listDocumentedOpenClawToolNames(manifest).includes("lobster")
        );
      }),
    );
  }

  private async shouldEnsureLobsterCliForRuntime(runtimeConfig: RuntimeConfig): Promise<boolean> {
    return (
      runtimeConfig.openclawProfile.agents.some((agent) => agent.id === MAIL_SENTINEL_AGENT_ID) ||
      (await this.listManagedOpenClawPluginIds(runtimeConfig)).includes("lobster")
    );
  }

  private async ensureLobsterCliInstalled(): Promise<void> {
    await ensureLobsterCliInstalled({
      execRunner: this.execRunner,
      logger: this.logger,
      packageName: SOVEREIGN_PINNED_LOBSTER_PACKAGE_NAME,
      version: SOVEREIGN_PINNED_LOBSTER_VERSION,
      installTimeoutMs: LOBSTER_CLI_INSTALL_TIMEOUT_MS,
      probeTimeoutMs: LOBSTER_CLI_PROBE_TIMEOUT_MS,
      requiredCommands: ["clawd.invoke"],
    });
  }

  private renderGuardedJsonStateWorkspacePluginManifest(): string {
    return renderGuardedJsonStateWorkspacePluginManifestFile();
  }

  private renderGuardedJsonStateWorkspacePluginConfig(input: {
    workspaceBindings: Record<string, string[]>;
    runtimeConfigPath: string;
  }): string {
    return renderGuardedJsonStateWorkspacePluginConfigFile({
      executablePath:
        SOVEREIGN_EXECUTABLE_PATHS["sovereign-tool"] ?? "/usr/local/bin/sovereign-tool",
      runtimeConfigPath: input.runtimeConfigPath,
      workspaceBindings: input.workspaceBindings,
    });
  }

  private renderGuardedJsonStateWorkspacePluginRuntime(): string {
    const exports = [
      ["isGuardedJsonStateRecord", isGuardedJsonStateRecord],
      ["normalizeGuardedJsonStateMatrixActorUserId", normalizeGuardedJsonStateMatrixActorUserId],
      [
        "extractGuardedJsonStateActorFromDirectSessionKey",
        extractGuardedJsonStateActorFromDirectSessionKey,
      ],
      ["resolveGuardedJsonStateWorkspaceDir", resolveGuardedJsonStateWorkspaceDir],
      [
        "extractGuardedJsonStateActorFromConversationInfoText",
        extractGuardedJsonStateActorFromConversationInfoText,
      ],
      ["extractGuardedJsonStateActorFromUserContent", extractGuardedJsonStateActorFromUserContent],
      [
        "extractLatestGuardedJsonStateActorFromBranch",
        extractLatestGuardedJsonStateActorFromBranch,
      ],
      ["resolveGuardedJsonStateSessionContext", resolveGuardedJsonStateSessionContext],
      ["resolveGuardedJsonStateToolContext", resolveGuardedJsonStateToolContext],
    ] as const;
    return `${exports.map(([name, fn]) => `export const ${name} = ${fn.toString()};`).join("\n\n")}\n`;
  }

  private renderGuardedJsonStateWorkspacePluginIndex(): string {
    return `import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

import {
  resolveGuardedJsonStateToolContext,
  resolveGuardedJsonStateWorkspaceDir,
} from "./runtime.js";

const TOOL_NAME = ${JSON.stringify(GUARDED_JSON_STATE_OPENCLAW_TOOL_NAME)};
const ACTIONS = ["show", "list", "upsert-self", "delete-self"];

let cachedConfig;
const loadConfig = async () => {
  if (cachedConfig !== undefined) {
    return cachedConfig;
  }
  cachedConfig = JSON.parse(await readFile(new URL("./plugin-config.json", import.meta.url), "utf8"));
  return cachedConfig;
};

const runCommand = async (command, args) =>
  await new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      resolve({
        exitCode: 127,
        stdout,
        stderr: stderr.length > 0 ? stderr : String(error?.message ?? error),
      });
    });
    child.on("close", (exitCode) => {
      resolve({
        exitCode: typeof exitCode === "number" ? exitCode : 1,
        stdout,
        stderr,
      });
    });
  });

const readJsonText = (value) => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length === 0 ? undefined : trimmed;
};

const requireString = (value, label) => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(\`Expected \${label}\`);
  }
  return value.trim();
};

const normalizeInput = (value) => {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected input to be a JSON object");
  }
  return value;
};

const buildCommandArgs = (params, config, sessionContext) => {
  const args = ["json-state", params.action, "--instance", requireString(params.instance, "instance")];
  if (typeof config.runtimeConfigPath === "string" && config.runtimeConfigPath.length > 0) {
    args.push("--config-path", config.runtimeConfigPath);
  }
  if (params.action === "show") {
    args.push("--json");
    return args;
  }
  args.push("--entity", requireString(params.entity, "entity"));
  if (params.action === "list") {
    args.push("--json");
    return args;
  }
  if (sessionContext === undefined) {
    throw new Error("Missing current Matrix session context for mutation");
  }
  if (typeof sessionContext.sessionKey === "string" && sessionContext.sessionKey.length > 0) {
    args.push("--session-key", sessionContext.sessionKey);
  }
  if (typeof sessionContext.originFrom === "string" && sessionContext.originFrom.length > 0) {
    args.push("--origin-from", sessionContext.originFrom);
  }
  if (params.action === "delete-self") {
    args.push("--id", requireString(params.id, "id"), "--json");
    return args;
  }
  const input = normalizeInput(params.input);
  args.push("--input-json", JSON.stringify(input ?? {}), "--json");
  return args;
};

const parseCommandOutput = (stdout) => {
  const text = readJsonText(stdout);
  if (text === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export default function (api) {
  api.registerTool(
    (toolContext) => ({
      name: TOOL_NAME,
      label: TOOL_NAME,
      description: "Read and mutate guarded JSON state for this agent's bound tool instances. Matrix actor resolution is derived from the active OpenClaw session.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["instance", "action"],
        properties: {
          instance: {
            type: "string",
            description: "Bound guarded state tool instance id",
          },
          action: {
            type: "string",
            enum: ACTIONS,
            description: "State operation to perform",
          },
          entity: {
            type: "string",
            description: "Entity id for list or mutation calls",
          },
          id: {
            type: "string",
            description: "Record id for delete-self",
          },
          input: {
            type: "object",
            additionalProperties: true,
            description: "Mutation payload for upsert-self",
          },
        },
      },
      async execute(_toolCallId, params) {
        const config = await loadConfig();
        const workspaceDir = resolveGuardedJsonStateWorkspaceDir(toolContext?.workspaceDir);
        const allowedInstanceIds = Array.isArray(config.workspaceBindings?.[workspaceDir])
          ? config.workspaceBindings[workspaceDir]
          : [];
        if (!allowedInstanceIds.includes(params.instance)) {
          return {
            content: [{ type: "text", text: \`Instance '\${String(params.instance ?? "")}' is not bound to this agent.\` }],
            details: {
              status: "failed",
              exitCode: 2,
              command: TOOL_NAME,
            },
          };
        }

        let sessionContext;
        if (params.action === "upsert-self" || params.action === "delete-self") {
          sessionContext = resolveGuardedJsonStateToolContext(toolContext ?? {});
        }

        const args = buildCommandArgs(params, config, sessionContext);
        const result = await runCommand(config.executablePath, args);
        const parsed = parseCommandOutput(result.stdout);
        const text =
          readJsonText(result.stdout)
          ?? readJsonText(result.stderr)
          ?? \`\${TOOL_NAME} exited with code \${String(result.exitCode)}\`;
        return {
          content: [{ type: "text", text }],
          details: {
            status: result.exitCode === 0 ? "completed" : "failed",
            exitCode: result.exitCode,
            command: [config.executablePath, ...args].join(" "),
            ...(sessionContext === undefined
              ? {}
              : {
                  actor: sessionContext.actor,
                  ...(typeof sessionContext.sessionKey === "string"
                    ? { sessionKey: sessionContext.sessionKey }
                    : {}),
                  ...(typeof sessionContext.originFrom === "string"
                    ? { originFrom: sessionContext.originFrom }
                    : {}),
                }),
            ...(parsed === undefined ? {} : { parsed }),
          },
        };
      },
    }),
    { optional: true },
  );
}
`;
  }

  private async writeManagedOpenClawExtensions(input: {
    runtimeConfig: RuntimeConfig;
  }): Promise<void> {
    const workspaceBindings: Record<string, string[]> = {};
    for (const agent of input.runtimeConfig.openclawProfile.agents) {
      const toolInstanceIds = agent.toolInstanceIds ?? [];
      if (toolInstanceIds.length === 0) {
        continue;
      }
      for (const tool of this.resolveBoundToolInstances(input.runtimeConfig, toolInstanceIds)) {
        const manifest = await this.resolveInstalledToolTemplate(
          input.runtimeConfig,
          tool.templateRef,
        );
        if (
          !manifest.openclawPlugins?.includes(GUARDED_JSON_STATE_OPENCLAW_PLUGIN_ID) &&
          !manifest.openclawToolNames?.includes(GUARDED_JSON_STATE_OPENCLAW_TOOL_NAME)
        ) {
          continue;
        }
        workspaceBindings[agent.workspace] = [
          ...(workspaceBindings[agent.workspace] ?? []),
          tool.id,
        ];
      }
    }
    if (Object.keys(workspaceBindings).length === 0) {
      return;
    }

    const extensionDir = join(
      input.runtimeConfig.openclaw.openclawHome,
      "extensions",
      GUARDED_JSON_STATE_OPENCLAW_PLUGIN_ID,
    );
    await mkdir(extensionDir, { recursive: true });
    await this.applyTrustedOpenClawExtensionOwnership(extensionDir);
    const files = [
      {
        path: join(extensionDir, "openclaw.plugin.json"),
        content: this.renderGuardedJsonStateWorkspacePluginManifest(),
      },
      {
        path: join(extensionDir, "plugin-config.json"),
        content: this.renderGuardedJsonStateWorkspacePluginConfig({
          workspaceBindings,
          runtimeConfigPath: this.paths.configPath,
        }),
      },
      {
        path: join(extensionDir, "runtime.js"),
        content: this.renderGuardedJsonStateWorkspacePluginRuntime(),
      },
      {
        path: join(extensionDir, "index.js"),
        content: this.renderGuardedJsonStateWorkspacePluginIndex(),
      },
    ];
    for (const file of files) {
      await writeFile(file.path, `${file.content}\n`, "utf8");
      await this.applyTrustedOpenClawExtensionOwnership(file.path);
    }
  }

  private async listAgentExecAllowlistPatterns(
    runtimeConfig: RuntimeConfig,
    toolInstanceIds: string[],
  ): Promise<string[]> {
    const patterns = new Set<string>();
    for (const tool of this.resolveBoundToolInstances(runtimeConfig, toolInstanceIds)) {
      const manifest = await this.resolveInstalledToolTemplate(runtimeConfig, tool.templateRef);
      for (const command of manifest.allowedCommands) {
        const rendered = this.renderSovereignToolCommand(runtimeConfig, tool.id, command);
        const [executable] = rendered.split(" ");
        if (executable?.startsWith("/")) {
          patterns.add(executable);
        }
      }
    }
    return Array.from(patterns);
  }

  private async buildOpenClawAgentToolPolicy(
    runtimeConfig: RuntimeConfig,
    toolInstanceIds: string[],
  ): Promise<{
    allow: string[];
    elevated?: {
      enabled: boolean;
    };
    exec?: {
      host: "gateway";
      security: "allowlist";
      ask: "off";
    };
  } | null> {
    const boundToolManifests = await Promise.all(
      this.resolveBoundToolInstances(runtimeConfig, toolInstanceIds).map(
        async (tool) => await this.resolveInstalledToolTemplate(runtimeConfig, tool.templateRef),
      ),
    );
    const openclawToolNames = dedupeStrings(
      boundToolManifests.flatMap((manifest) => manifest.openclawToolNames ?? []),
    );
    const execPatterns = await this.listAgentExecAllowlistPatterns(runtimeConfig, toolInstanceIds);
    if (execPatterns.length === 0 && openclawToolNames.length === 0) {
      return null;
    }
    const allow = dedupeStrings([
      ...(openclawToolNames.length === 0 ? [] : [OPENCLAW_SESSION_STATUS_TOOL_ID]),
      ...openclawToolNames,
      ...(execPatterns.length === 0 ? [] : [OPENCLAW_EXEC_TOOL_ID]),
    ]);
    return {
      allow,
      elevated: {
        enabled: true,
      },
      ...(execPatterns.length === 0
        ? {}
        : {
            exec: {
              host: "gateway",
              security: "allowlist",
              ask: "off",
            } as const,
          }),
    };
  }

  private validateToolInstanceBindings(input: {
    template: ToolTemplateDefinition;
    config: Record<string, string>;
    secretRefs: Record<string, string>;
  }): void {
    const missingConfigKeys = input.template.requiredConfigKeys.filter(
      (key) => input.config[key] === undefined || input.config[key].trim().length === 0,
    );
    const missingSecretRefs = input.template.requiredSecretRefs.filter(
      (key) => input.secretRefs[key] === undefined || input.secretRefs[key].trim().length === 0,
    );
    if (missingConfigKeys.length > 0 || missingSecretRefs.length > 0) {
      throw {
        code: "TOOL_INSTANCE_BINDINGS_INVALID",
        message: "Tool instance is missing required config or secret refs",
        retryable: false,
        details: {
          templateRef: formatTemplateRef(input.template.id, input.template.version),
          missingConfigKeys,
          missingSecretRefs,
        },
      };
    }
  }

  private async validateAgentTemplateAndTools(input: {
    runtimeConfig: RuntimeConfig;
    templateRef?: string;
    toolInstanceIds: string[];
  }): Promise<{ templateRef: string | undefined; toolInstanceIds: string[] }> {
    const toolInstanceIds = input.toolInstanceIds;
    const unknownToolInstanceIds = toolInstanceIds.filter(
      (id) => !input.runtimeConfig.sovereignTools.instances.some((entry) => entry.id === id),
    );
    if (unknownToolInstanceIds.length > 0) {
      throw {
        code: "TOOL_INSTANCE_NOT_FOUND",
        message: "One or more tool instance ids do not exist",
        retryable: false,
        details: {
          unknownToolInstanceIds,
        },
      };
    }

    if (input.templateRef === undefined) {
      return {
        templateRef: undefined,
        toolInstanceIds,
      };
    }

    const template = await this.resolveInstalledAgentTemplate(
      input.runtimeConfig,
      input.templateRef,
    );
    const boundRefs = new Set(
      toolInstanceIds.flatMap((id) => {
        const tool = input.runtimeConfig.sovereignTools.instances.find((entry) => entry.id === id);
        return tool === undefined ? [] : [tool.templateRef];
      }),
    );
    const requiredRefs = template.requiredToolTemplates.map((entry) =>
      formatTemplateRef(entry.id, entry.version),
    );
    const missingRequiredRefs = requiredRefs.filter((ref) => !boundRefs.has(ref));
    const allowedRefs = new Set([
      ...requiredRefs,
      ...template.optionalToolTemplates.map((entry) => formatTemplateRef(entry.id, entry.version)),
    ]);
    const disallowedBindings = Array.from(boundRefs).filter((ref) => !allowedRefs.has(ref));
    if (missingRequiredRefs.length > 0 || disallowedBindings.length > 0) {
      throw {
        code: "AGENT_TEMPLATE_TOOL_BINDINGS_INVALID",
        message: "Agent tool bindings do not satisfy template requirements",
        retryable: false,
        details: {
          templateRef: input.templateRef,
          missingRequiredRefs,
          disallowedBindings,
        },
      };
    }
    return {
      templateRef: input.templateRef,
      toolInstanceIds,
    };
  }

  private async resolveManagedAgentMatrixLocalpartFallback(
    runtimeConfig: RuntimeConfig,
    entry: RuntimeAgentEntry,
    agentId: string,
  ): Promise<string> {
    const fallback = sanitizeMatrixLocalpartFromAgentId(agentId);
    if (entry.templateRef === undefined) {
      return fallback;
    }
    try {
      const template = await this.resolveInstalledAgentTemplate(runtimeConfig, entry.templateRef);
      const templatePrefix = sanitizeManagedAgentLocalpart(
        template.matrix.localpartPrefix,
        fallback,
      );
      const agentLocalpart = sanitizeManagedAgentLocalpart(agentId, fallback);
      if (agentLocalpart === templatePrefix || agentLocalpart.startsWith(`${templatePrefix}-`)) {
        return agentLocalpart;
      }
      return sanitizeManagedAgentLocalpart(`${templatePrefix}-${agentId}`, fallback);
    } catch {
      return fallback;
    }
  }

  async createManagedAgent(req: {
    id: string;
    workspace?: string;
    templateRef?: string;
    toolInstanceIds?: string[];
  }): Promise<ManagedAgentUpsertResult> {
    return this.upsertManagedAgent(req, "create");
  }

  async updateManagedAgent(req: {
    id: string;
    workspace?: string;
    templateRef?: string;
    toolInstanceIds?: string[];
  }): Promise<ManagedAgentUpsertResult> {
    return this.upsertManagedAgent(req, "update");
  }

  async deleteManagedAgent(req: { id: string }): Promise<ManagedAgentDeleteResult> {
    const runtimeConfig = await this.readRuntimeConfig();
    const id = sanitizeManagedAgentId(req.id);
    if (RESERVED_AGENT_IDS.has(id)) {
      throw {
        code: "AGENT_DELETE_FORBIDDEN",
        message: `Managed core agent '${id}' cannot be deleted`,
        retryable: false,
      };
    }

    const existing = runtimeConfig.openclawProfile.agents.find((entry) => entry.id === id);
    if (existing === undefined) {
      return {
        id,
        deleted: false,
        restartRequiredServices: [],
      };
    }

    runtimeConfig.openclawProfile.agents = runtimeConfig.openclawProfile.agents.filter(
      (entry) => entry.id !== id,
    );
    runtimeConfig.openclawProfile.agents = ensureCoreManagedAgents(
      runtimeConfig.openclawProfile.agents,
    );
    await this.persistManagedAgentTopology(runtimeConfig);
    return {
      id,
      deleted: true,
      restartRequiredServices: ["openclaw-gateway"],
    };
  }

  private async upsertManagedAgent(
    req: {
      id: string;
      workspace?: string;
      botId?: string;
      templateRef?: string;
      toolInstanceIds?: string[];
    },
    mode: "create" | "update",
  ): Promise<ManagedAgentUpsertResult> {
    const runtimeConfig = await this.readRuntimeConfig();
    const id = sanitizeManagedAgentId(req.id);
    const workspace = sanitizeManagedWorkspace(
      req.workspace,
      join(this.paths.stateDir, id, "workspace"),
    );
    const requestedTemplateRef = sanitizeOptionalTemplateRef(req.templateRef);
    const requestedToolInstanceIds = sanitizeOptionalToolInstanceIds(req.toolInstanceIds);
    const existing = runtimeConfig.openclawProfile.agents.find((entry) => entry.id === id);

    if (mode === "create" && existing !== undefined) {
      const nextTemplateRef = requestedTemplateRef ?? existing.templateRef;
      const nextToolInstanceIds = requestedToolInstanceIds ?? existing.toolInstanceIds ?? [];
      const validated = await this.validateAgentTemplateAndTools(
        nextTemplateRef === undefined
          ? {
              runtimeConfig,
              toolInstanceIds: nextToolInstanceIds,
            }
          : {
              runtimeConfig,
              templateRef: nextTemplateRef,
              toolInstanceIds: nextToolInstanceIds,
            },
      );
      const changed =
        existing.workspace !== workspace ||
        existing.botId !== req.botId ||
        existing.templateRef !== nextTemplateRef ||
        !areStringListsEqual(existing.toolInstanceIds ?? [], validated.toolInstanceIds);
      if (changed) {
        existing.workspace = workspace;
        if (req.botId === undefined) {
          delete existing.botId;
        } else {
          existing.botId = req.botId;
        }
        if (nextTemplateRef === undefined) {
          delete existing.templateRef;
        } else {
          existing.templateRef = nextTemplateRef;
        }
        existing.toolInstanceIds = validated.toolInstanceIds;
        runtimeConfig.openclawProfile.agents = ensureCoreManagedAgents(
          runtimeConfig.openclawProfile.agents,
        );
        await this.refreshRuntimeHostResources(runtimeConfig);
        await this.ensureManagedAgentWorkspace({
          id,
          workspace,
          runtimeConfig,
        });
        await this.persistManagedAgentTopology(runtimeConfig);
      }
      const ensured = await this.ensureManagedAgentMatrixIdentity(runtimeConfig, id);
      if (ensured.changed) {
        await this.persistManagedAgentTopology(ensured.runtimeConfig);
      }
      const agent = ensured.runtimeConfig.openclawProfile.agents.find((entry) => entry.id === id);
      return {
        agent: this.toManagedAgentOutput(agent ?? existing),
        changed: changed || ensured.changed,
        restartRequiredServices: changed || ensured.changed ? ["openclaw-gateway"] : [],
      };
    }

    if (mode === "update" && existing === undefined) {
      throw {
        code: "AGENT_NOT_FOUND",
        message: `Managed agent '${id}' does not exist`,
        retryable: false,
      };
    }

    if (existing !== undefined) {
      const nextTemplateRef = requestedTemplateRef ?? existing.templateRef;
      const nextToolInstanceIds = requestedToolInstanceIds ?? existing.toolInstanceIds ?? [];
      const validated = await this.validateAgentTemplateAndTools(
        nextTemplateRef === undefined
          ? {
              runtimeConfig,
              toolInstanceIds: nextToolInstanceIds,
            }
          : {
              runtimeConfig,
              templateRef: nextTemplateRef,
              toolInstanceIds: nextToolInstanceIds,
            },
      );
      const changed =
        existing.workspace !== workspace ||
        (req.botId !== undefined && existing.botId !== req.botId) ||
        existing.templateRef !== nextTemplateRef ||
        !areStringListsEqual(existing.toolInstanceIds ?? [], validated.toolInstanceIds);
      if (changed) {
        existing.workspace = workspace;
        if (req.botId !== undefined) {
          existing.botId = req.botId;
        }
        if (nextTemplateRef === undefined) {
          delete existing.templateRef;
        } else {
          existing.templateRef = nextTemplateRef;
        }
        existing.toolInstanceIds = validated.toolInstanceIds;
        runtimeConfig.openclawProfile.agents = ensureCoreManagedAgents(
          runtimeConfig.openclawProfile.agents,
        );
        await this.refreshRuntimeHostResources(runtimeConfig);
        await this.ensureManagedAgentWorkspace({
          id,
          workspace,
          runtimeConfig,
        });
        await this.persistManagedAgentTopology(runtimeConfig);
      }
      const ensured = await this.ensureManagedAgentMatrixIdentity(runtimeConfig, id);
      if (ensured.changed) {
        await this.persistManagedAgentTopology(ensured.runtimeConfig);
      }
      const agent = ensured.runtimeConfig.openclawProfile.agents.find((entry) => entry.id === id);
      return {
        agent: this.toManagedAgentOutput(agent ?? existing),
        changed: changed || ensured.changed,
        restartRequiredServices: changed || ensured.changed ? ["openclaw-gateway"] : [],
      };
    }

    const validated = await this.validateAgentTemplateAndTools(
      requestedTemplateRef === undefined
        ? {
            runtimeConfig,
            toolInstanceIds: requestedToolInstanceIds ?? [],
          }
        : {
            runtimeConfig,
            templateRef: requestedTemplateRef,
            toolInstanceIds: requestedToolInstanceIds ?? [],
          },
    );
    runtimeConfig.openclawProfile.agents = ensureCoreManagedAgents([
      ...runtimeConfig.openclawProfile.agents,
      {
        id,
        workspace,
        ...(req.botId === undefined ? {} : { botId: req.botId }),
        ...(validated.templateRef === undefined ? {} : { templateRef: validated.templateRef }),
        ...(validated.toolInstanceIds.length === 0
          ? {}
          : { toolInstanceIds: validated.toolInstanceIds }),
      },
    ]);
    await this.refreshRuntimeHostResources(runtimeConfig);
    await this.ensureManagedAgentWorkspace({
      id,
      workspace,
      runtimeConfig,
    });
    const ensured = await this.ensureManagedAgentMatrixIdentity(runtimeConfig, id);
    runtimeConfig.openclawProfile.agents = ensured.runtimeConfig.openclawProfile.agents;
    await this.persistManagedAgentTopology(runtimeConfig);
    const created = runtimeConfig.openclawProfile.agents.find((entry) => entry.id === id);
    return {
      agent: this.toManagedAgentOutput(
        created ?? {
          id,
          workspace,
          ...(req.botId === undefined ? {} : { botId: req.botId }),
          ...(validated.templateRef === undefined ? {} : { templateRef: validated.templateRef }),
          ...(validated.toolInstanceIds.length === 0
            ? {}
            : { toolInstanceIds: validated.toolInstanceIds }),
        },
      ),
      changed: true,
      restartRequiredServices: ["openclaw-gateway"],
    };
  }

  private async persistManagedAgentTopology(runtimeConfig: RuntimeConfig): Promise<void> {
    runtimeConfig.openclawProfile.agents = ensureCoreManagedAgents(
      runtimeConfig.openclawProfile.agents,
    );
    await this.refreshRuntimeHostResources(runtimeConfig);
    for (const agent of runtimeConfig.openclawProfile.agents) {
      await this.ensureManagedAgentWorkspace({
        id: agent.id,
        workspace: agent.workspace,
        runtimeConfig,
      });
    }

    await this.applyCompiledSystemdResources(runtimeConfig);
    await this.persistManagedAgentTopologyDocument(runtimeConfig);
    await this.writeOpenClawRuntimeArtifacts(runtimeConfig);
    this.setManagedOpenClawEnv(runtimeConfig);
    await this.refreshGatewayAfterRuntimeConfig(runtimeConfig);
  }

  private async persistManagedAgentTopologyDocument(runtimeConfig: RuntimeConfig): Promise<void> {
    const raw = await readFile(this.paths.configPath, "utf8");
    const parsed = parseJsonDocument(raw);
    if (!isRecord(parsed)) {
      throw {
        code: "CONFIG_INVALID",
        message: "Sovereign runtime config does not match expected shape",
        retryable: false,
        details: {
          configPath: this.paths.configPath,
        },
      };
    }

    parsed.generatedAt = now();
    parsed.openclawProfile = {
      plugins: {
        allow: runtimeConfig.openclawProfile.plugins.allow,
      },
      session: {
        dmScope: runtimeConfig.openclawProfile.session?.dmScope ?? MANAGED_OPENCLAW_DM_SCOPE,
      },
      channels: {
        matrix: {
          enabled: true,
          homeserver: runtimeConfig.matrix.adminBaseUrl,
          roomId: runtimeConfig.matrix.alertRoom.roomId,
        },
      },
      agents: runtimeConfig.openclawProfile.agents,
      crons: runtimeConfig.openclawProfile.crons,
      ...(runtimeConfig.openclawProfile.crons[0] === undefined
        ? {}
        : {
            cron: {
              id: runtimeConfig.openclawProfile.crons[0].id,
              every: runtimeConfig.openclawProfile.crons[0].every,
            },
          }),
    };
    parsed.bots = runtimeConfig.bots;
    parsed.templates = runtimeConfig.templates;
    parsed.sovereignTools = runtimeConfig.sovereignTools;
    parsed.matrix = {
      ...(isRecord(parsed.matrix) ? parsed.matrix : {}),
      bot: {
        localpart: runtimeConfig.matrix.bot.localpart,
        userId: runtimeConfig.matrix.bot.userId,
        ...(runtimeConfig.matrix.bot.passwordSecretRef === undefined
          ? {}
          : { passwordSecretRef: runtimeConfig.matrix.bot.passwordSecretRef }),
        accessTokenSecretRef: runtimeConfig.matrix.bot.accessTokenSecretRef,
        ...(runtimeConfig.matrix.bot.avatarSha256 === undefined
          ? {}
          : { avatarSha256: runtimeConfig.matrix.bot.avatarSha256 }),
      },
      alertRoom: runtimeConfig.matrix.alertRoom,
    };

    await this.writeInstallerJsonFile(this.paths.configPath, parsed, 0o644);
  }

  private async ensureManagedAgentWorkspace(input: {
    id: string;
    workspace: string;
    runtimeConfig: RuntimeConfig;
  }): Promise<void> {
    await mkdir(input.workspace, { recursive: true });
    const openclawWorkspaceStateDir = join(input.workspace, ".openclaw");
    await mkdir(openclawWorkspaceStateDir, { recursive: true });
    await this.applyLocalWorkspaceHostResources(input.runtimeConfig, input.id, input.workspace);
    await this.applyRuntimeOwnership(openclawWorkspaceStateDir);
    await this.applyRuntimeOwnership(input.workspace);
  }

  private async applyLocalWorkspaceHostResources(
    runtimeConfig: RuntimeConfig,
    agentId: string,
    workspaceDir: string,
  ): Promise<void> {
    const agent = runtimeConfig.openclawProfile.agents.find((entry) => entry.id === agentId);
    if (agent?.botId === undefined) {
      return;
    }
    const normalizedWorkspace = workspaceDir.endsWith("/") ? workspaceDir : `${workspaceDir}/`;
    for (const resource of runtimeConfig.hostResources?.resources ?? []) {
      if (resource.agentId !== agent.id) {
        continue;
      }
      if (resource.kind === "directory") {
        if (!resource.path.startsWith(normalizedWorkspace) && resource.path !== workspaceDir) {
          continue;
        }
        await mkdir(resource.path, { recursive: true });
        if (resource.mode !== undefined) {
          await chmod(resource.path, Number.parseInt(resource.mode, 8));
        }
        await this.applyRuntimeOwnership(resource.path);
        continue;
      }
      if (resource.kind !== "managedFile" && resource.kind !== "stateFile") {
        continue;
      }
      if (!resource.path.startsWith(normalizedWorkspace)) {
        continue;
      }
      await mkdir(dirname(resource.path), { recursive: true });
      if (resource.writePolicy === "ifMissing") {
        try {
          await access(resource.path, fsConstants.F_OK);
          continue;
        } catch (error) {
          if (!isNodeError(error) || error.code !== "ENOENT") {
            throw error;
          }
        }
      }
      await writeFile(resource.path, resource.content, "utf8");
      if (resource.mode !== undefined) {
        await chmod(resource.path, Number.parseInt(resource.mode, 8));
      }
      await this.applyRuntimeOwnership(resource.path);
    }
  }

  private async applyCompiledSystemdResources(runtimeConfig: RuntimeConfig): Promise<void> {
    if (typeof process.getuid !== "function" || process.getuid() !== 0) {
      return;
    }

    const systemdResources = (runtimeConfig.hostResources?.resources ?? []).filter(
      (
        resource,
      ): resource is Extract<typeof resource, { kind: "systemdService" | "systemdTimer" }> =>
        resource.kind === "systemdService" || resource.kind === "systemdTimer",
    );
    if (systemdResources.length === 0) {
      return;
    }

    const changedUnits: Array<{
      name: string;
      desiredState: { enabled: boolean; active: boolean };
    }> = [];
    for (const resource of systemdResources) {
      const systemdDir =
        process.env.SOVEREIGN_NODE_SYSTEMD_UNIT_DIR?.trim() || "/etc/systemd/system";
      const unitPath = join(systemdDir, resource.name);
      let existingContent: string | undefined;
      try {
        existingContent = await readFile(unitPath, "utf8");
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") {
          this.logger.warn(
            {
              unitPath,
              error: describeError(error),
            },
            "Failed to read existing systemd unit for comparison",
          );
        }
      }
      if (existingContent === resource.content) {
        continue;
      }
      try {
        await writeFile(unitPath, resource.content, "utf8");
      } catch (error) {
        this.logger.warn(
          {
            unitPath,
            error: describeError(error),
          },
          "Failed to write bot systemd unit",
        );
        continue;
      }
      changedUnits.push({
        name: resource.name,
        desiredState: resource.desiredState,
      });
      this.logger.info(
        { unitName: resource.name, botId: resource.botId },
        "Updated bot systemd unit",
      );
    }

    if (changedUnits.length === 0) {
      return;
    }

    const reloadResult = await this.safeExec("systemctl", ["daemon-reload"]);
    if (!reloadResult.ok || reloadResult.result.exitCode !== 0) {
      this.logger.warn("systemctl daemon-reload failed after writing bot systemd units");
      return;
    }

    for (const unit of changedUnits) {
      if (unit.desiredState.enabled) {
        await this.safeExec("systemctl", ["enable", unit.name]);
      }
      if (unit.desiredState.active) {
        await this.safeExec("systemctl", ["restart", unit.name]);
      }
    }
  }

  private resolveManagedAgentSessionsDir(runtimeConfig: RuntimeConfig, agentId: string): string {
    return join(runtimeConfig.openclaw.openclawHome, ".openclaw", "agents", agentId, "sessions");
  }

  private async resetManagedAgentSessions(
    runtimeConfig: RuntimeConfig,
    agentId: string,
  ): Promise<void> {
    const sessionsDir = this.resolveManagedAgentSessionsDir(runtimeConfig, agentId);
    let sessionsStat: Awaited<ReturnType<typeof stat>>;
    try {
      sessionsStat = await stat(sessionsDir);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        await mkdir(sessionsDir, { recursive: true });
        await this.applyRuntimeOwnership(sessionsDir);
        this.logger.info(
          { agentId, sessionsDir },
          "Created managed agent sessions directory (first install)",
        );
        return;
      }
      throw error;
    }
    if (!sessionsStat.isDirectory()) {
      return;
    }

    const resetSuffix = now().replaceAll(":", "-").replaceAll(".", "-");
    const resetPath = `${sessionsDir}.reset.${resetSuffix}`;
    await rename(sessionsDir, resetPath);
    await mkdir(sessionsDir, { recursive: true });
    await this.applyRuntimeOwnership(sessionsDir);
    this.logger.info(
      {
        agentId,
        sessionsDir,
        resetPath,
      },
      "Reset managed agent sessions to apply refreshed workspace instructions",
    );
  }

  private resolveManagedAgentAlertRoom(
    runtimeConfig: RuntimeConfig,
    entry: RuntimeAgentEntry,
  ): { roomId: string; roomName: string } {
    return (
      this.getRuntimeBotInstanceForAgent(runtimeConfig, entry)?.matrix?.alertRoom ??
      runtimeConfig.matrix.alertRoom
    );
  }

  private async ensureManagedAgentAllowedUsersInAlertRoom(input: {
    runtimeConfig: RuntimeConfig;
    entry: RuntimeAgentEntry;
    roomId: string;
    inviterAccessToken: string;
  }): Promise<void> {
    const botInstance = this.getRuntimeBotInstanceForAgent(input.runtimeConfig, input.entry);
    const allowedUsers = botInstance?.matrix?.allowedUsers ?? [];
    for (const user of allowedUsers) {
      const normalized = this.normalizeMatrixUserIdentifier(user, input.runtimeConfig);
      await this.inviteMatrixUserToRoom({
        adminBaseUrl: input.runtimeConfig.matrix.adminBaseUrl,
        roomId: input.roomId,
        inviterAccessToken: input.inviterAccessToken,
        inviteeUserId: normalized.userId,
        failureCode: "MATRIX_AGENT_IDENTITY_FAILED",
        failureMessage: `Failed to invite ${normalized.userId} into bot alert room`,
      });
    }
  }

  private async ensureManagedAgentMatrixIdentity(
    runtimeConfig: RuntimeConfig,
    agentId: string,
  ): Promise<{ runtimeConfig: RuntimeConfig; changed: boolean }> {
    const entry = runtimeConfig.openclawProfile.agents.find((agent) => agent.id === agentId);
    if (entry === undefined) {
      return { runtimeConfig, changed: false };
    }
    const botPackage = await this.findBotPackageByTemplateRef(entry.templateRef);
    if (
      botPackage?.manifest.matrixIdentity.mode === "service-account" ||
      (botPackage === null && agentId === MAIL_SENTINEL_AGENT_ID)
    ) {
      const mappedIdentity = {
        localpart:
          runtimeConfig.matrix.bot.localpart ??
          botPackage?.manifest.matrixIdentity.localpartPrefix ??
          "service-bot",
        userId: runtimeConfig.matrix.bot.userId,
        ...(runtimeConfig.matrix.bot.passwordSecretRef === undefined
          ? {}
          : { passwordSecretRef: runtimeConfig.matrix.bot.passwordSecretRef }),
        accessTokenSecretRef: runtimeConfig.matrix.bot.accessTokenSecretRef,
        ...(runtimeConfig.matrix.bot.avatarSha256 === undefined
          ? {}
          : { avatarSha256: runtimeConfig.matrix.bot.avatarSha256 }),
      };
      const changed = !areMatrixIdentitiesEqual(entry.matrix, mappedIdentity);
      if (changed) {
        entry.matrix = mappedIdentity;
      }
      return { runtimeConfig, changed };
    }

    const fallbackLocalpart = await this.resolveManagedAgentMatrixLocalpartFallback(
      runtimeConfig,
      entry,
      agentId,
    );
    const localpart = sanitizeManagedAgentLocalpart(
      this.getRuntimeBotInstanceForAgent(runtimeConfig, entry)?.matrix?.localpart ??
        entry.matrix?.localpart,
      fallbackLocalpart,
    );
    const expectedUserId = `@${localpart}:${runtimeConfig.matrix.homeserverDomain}`;

    let passwordSecretRef = entry.matrix?.passwordSecretRef;
    if (passwordSecretRef === undefined || passwordSecretRef.trim().length === 0) {
      passwordSecretRef = await this.writeManagedSecretFile(
        `matrix-agent-${agentId}-password`,
        generateAgentPassword(),
      );
    }
    const password = await this.resolveSecretRef(passwordSecretRef);

    const operatorTokenSecretRef = runtimeConfig.matrix.operator.accessTokenSecretRef;
    if (operatorTokenSecretRef === undefined || operatorTokenSecretRef.length === 0) {
      throw {
        code: "MATRIX_AGENT_IDENTITY_FAILED",
        message: "Operator Matrix access token is required to provision agent identities",
        retryable: false,
      };
    }
    const operatorAccessToken = await this.resolveSecretRef(operatorTokenSecretRef);

    const upsertedUserId = await this.ensureSynapseUserViaAdminApi({
      adminBaseUrl: runtimeConfig.matrix.adminBaseUrl,
      adminAccessToken: operatorAccessToken,
      expectedUserId,
      password,
    });
    const loginSession = await this.loginMatrixUser({
      adminBaseUrl: runtimeConfig.matrix.adminBaseUrl,
      localpart,
      password,
      expectedUserId: upsertedUserId,
    });
    const accessTokenSecretRef = await this.writeManagedAgentAccessTokenFile(
      runtimeConfig,
      `matrix-agent-${agentId}-access-token`,
      loginSession.accessToken,
    );
    const alertRoom = this.resolveManagedAgentAlertRoom(runtimeConfig, entry);

    // Persist the agent identity BEFORE attempting room-membership calls.
    // If the invite/join steps below fail transiently (e.g. the bot + agent
    // share a localpart so Synapse returns a 403 "already in the room" that
    // isAlreadyJoinedOrInvitedRoomError fails to tolerate, or an
    // eventual-consistency blip during a fresh Matrix provision), we still
    // want entry.matrix populated. Without this, the mail-sentinel CLI and
    // downstream managed-agent tooling all choke on a missing secretRef
    // and the only recovery is hand-editing the runtime config on the VPS.
    const previousAvatarSha256 = entry.matrix?.avatarSha256;
    const nextIdentity: NonNullable<RuntimeAgentEntry["matrix"]> = {
      localpart,
      userId: loginSession.userId,
      passwordSecretRef,
      accessTokenSecretRef,
      ...(previousAvatarSha256 === undefined ? {} : { avatarSha256: previousAvatarSha256 }),
    };
    const previousIdentitySnapshot = entry.matrix;
    entry.matrix = nextIdentity;
    const primaryBotChanged = this.syncPrimaryDedicatedMatrixBotIdentity(runtimeConfig, {
      localpart: nextIdentity.localpart,
      userId: nextIdentity.userId,
      ...(nextIdentity.passwordSecretRef === undefined
        ? {}
        : { passwordSecretRef: nextIdentity.passwordSecretRef }),
      accessTokenSecretRef,
    });

    await this.ensureMatrixUserInAlertRoom({
      adminBaseUrl: runtimeConfig.matrix.adminBaseUrl,
      roomId: alertRoom.roomId,
      inviterAccessToken: operatorAccessToken,
      inviteeUserId: loginSession.userId,
      inviteeAccessToken: loginSession.accessToken,
    });
    await this.ensureManagedAgentAllowedUsersInAlertRoom({
      runtimeConfig,
      entry,
      roomId: alertRoom.roomId,
      inviterAccessToken: operatorAccessToken,
    });

    const appliedAvatarSha256 = await this.tryApplyManagedAgentAvatar({
      runtimeConfig,
      agentId,
      botPackage,
      userId: loginSession.userId,
      accessToken: loginSession.accessToken,
      previousAvatarSha256,
    });
    if (appliedAvatarSha256 === undefined) {
      if ("avatarSha256" in nextIdentity) {
        delete nextIdentity.avatarSha256;
      }
    } else {
      nextIdentity.avatarSha256 = appliedAvatarSha256;
    }

    const changed = !areMatrixIdentitiesEqual(previousIdentitySnapshot, nextIdentity);

    return {
      runtimeConfig,
      changed: changed || primaryBotChanged,
    };
  }

  private async tryApplyManagedAgentAvatar(input: {
    runtimeConfig: RuntimeConfig;
    agentId: string;
    botPackage: LoadedBotPackage | null;
    userId: string;
    accessToken: string;
    previousAvatarSha256: string | undefined;
  }): Promise<string | undefined> {
    const uploadMedia = this.matrixProvisioner.uploadMedia?.bind(this.matrixProvisioner);
    const setUserAvatar = this.matrixProvisioner.setUserAvatar?.bind(this.matrixProvisioner);
    if (uploadMedia === undefined || setUserAvatar === undefined) {
      return input.previousAvatarSha256;
    }
    try {
      const resolver = new FilesystemMatrixAvatarResolver(this.botCatalog);
      let asset: Awaited<ReturnType<MatrixAvatarResolver["resolveBotAvatar"]>> = null;
      if (input.botPackage !== null) {
        asset = await resolver.resolveBotAvatar(input.botPackage.manifest.id);
      }
      if (asset === null) {
        asset = await resolver.resolveServiceBotAvatar();
      }
      if (asset === null) {
        return input.previousAvatarSha256;
      }
      if (input.previousAvatarSha256 === asset.sha256) {
        return asset.sha256;
      }
      const uploaded = await uploadMedia({
        baseUrl: input.runtimeConfig.matrix.adminBaseUrl,
        accessToken: input.accessToken,
        fileName: asset.fileName,
        contentType: asset.contentType,
        data: asset.data,
      });
      await setUserAvatar({
        baseUrl: input.runtimeConfig.matrix.adminBaseUrl,
        userId: input.userId,
        accessToken: input.accessToken,
        contentUri: uploaded.contentUri,
      });
      this.logger.info(
        {
          agentId: input.agentId,
          userId: input.userId,
          avatarSha256: asset.sha256,
          source: input.botPackage !== null && asset.fileName === "avatar.png" ? "bot" : "service",
        },
        "Applied Matrix managed agent avatar",
      );
      return asset.sha256;
    } catch (error) {
      this.logger.warn(
        {
          agentId: input.agentId,
          userId: input.userId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to apply Matrix managed agent avatar; leaving user avatar unchanged",
      );
      return input.previousAvatarSha256;
    }
  }

  private async ensureSynapseUserViaAdminApi(input: {
    adminBaseUrl: string;
    adminAccessToken: string;
    expectedUserId: string;
    password: string;
    failureCode?: string;
  }): Promise<string> {
    const endpoint = new URL(
      `/_synapse/admin/v2/users/${encodeURIComponent(input.expectedUserId)}`,
      ensureTrailingSlash(input.adminBaseUrl),
    ).toString();
    const response = await this.fetchImpl(endpoint, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${input.adminAccessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        password: input.password,
        admin: false,
        deactivated: false,
      }),
    });
    const bodyText = await response.text();
    const parsed = parseJsonSafely(bodyText);
    if (!response.ok) {
      throw {
        code: input.failureCode ?? "MATRIX_AGENT_IDENTITY_FAILED",
        message: `Failed to upsert Matrix account ${input.expectedUserId}`,
        retryable: true,
        details: {
          endpoint,
          status: response.status,
          body: summarizeUnknown(parsed),
        },
      };
    }
    if (isRecord(parsed) && typeof parsed.name === "string" && parsed.name.length > 0) {
      return parsed.name;
    }
    return input.expectedUserId;
  }

  private async loginMatrixUser(input: {
    adminBaseUrl: string;
    localpart: string;
    password: string;
    expectedUserId: string;
  }): Promise<{ userId: string; accessToken: string }> {
    const endpoint = new URL(
      "/_matrix/client/v3/login",
      ensureTrailingSlash(input.adminBaseUrl),
    ).toString();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          type: "m.login.password",
          identifier: {
            type: "m.id.user",
            user: input.localpart,
          },
          password: input.password,
        }),
      });
      const bodyText = await response.text();
      const parsed = parseJsonSafely(bodyText);
      if (response.ok) {
        const userId =
          isRecord(parsed) && typeof parsed.user_id === "string"
            ? parsed.user_id
            : input.expectedUserId;
        const accessToken =
          isRecord(parsed) && typeof parsed.access_token === "string" ? parsed.access_token : "";
        if (accessToken.length === 0) {
          throw {
            code: "MATRIX_AGENT_IDENTITY_FAILED",
            message: `Matrix login for ${input.expectedUserId} returned no access token`,
            retryable: true,
          };
        }
        return { userId, accessToken };
      }

      if (
        response.status === 429 &&
        isRecord(parsed) &&
        typeof parsed.retry_after_ms === "number" &&
        Number.isFinite(parsed.retry_after_ms)
      ) {
        await delay(Math.min(Math.max(Math.trunc(parsed.retry_after_ms), 100), 5_000));
        continue;
      }

      throw {
        code: "MATRIX_AGENT_IDENTITY_FAILED",
        message: `Matrix login failed for ${input.expectedUserId}`,
        retryable: true,
        details: {
          endpoint,
          status: response.status,
          body: summarizeUnknown(parsed),
        },
      };
    }

    throw {
      code: "MATRIX_AGENT_IDENTITY_FAILED",
      message: `Matrix login was rate-limited for ${input.expectedUserId}`,
      retryable: true,
    };
  }

  private async ensureMatrixUserInAlertRoom(input: {
    adminBaseUrl: string;
    roomId: string;
    inviterAccessToken: string;
    inviteeUserId: string;
    inviteeAccessToken: string;
  }): Promise<void> {
    await this.inviteMatrixUserToRoom({
      adminBaseUrl: input.adminBaseUrl,
      roomId: input.roomId,
      inviterAccessToken: input.inviterAccessToken,
      inviteeUserId: input.inviteeUserId,
    });

    const joinEndpoint = new URL(
      `/_matrix/client/v3/rooms/${encodeURIComponent(input.roomId)}/join`,
      ensureTrailingSlash(input.adminBaseUrl),
    ).toString();
    const joinResponse = await this.fetchImpl(joinEndpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.inviteeAccessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({}),
    });
    const joinText = await joinResponse.text();
    const joinParsed = parseJsonSafely(joinText);
    if (!joinResponse.ok && !isAlreadyJoinedOrInvitedRoomError(joinResponse.status, joinParsed)) {
      throw {
        code: "MATRIX_AGENT_IDENTITY_FAILED",
        message: `Failed to join ${input.inviteeUserId} into alert room`,
        retryable: true,
        details: {
          endpoint: joinEndpoint,
          status: joinResponse.status,
          body: summarizeUnknown(joinParsed),
        },
      };
    }
  }

  private async inviteMatrixUserToRoom(input: {
    adminBaseUrl: string;
    roomId: string;
    inviterAccessToken: string;
    inviteeUserId: string;
    failureCode?: string;
    failureMessage?: string;
  }): Promise<void> {
    const inviteEndpoint = new URL(
      `/_matrix/client/v3/rooms/${encodeURIComponent(input.roomId)}/invite`,
      ensureTrailingSlash(input.adminBaseUrl),
    ).toString();
    const inviteResponse = await this.fetchImpl(inviteEndpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.inviterAccessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ user_id: input.inviteeUserId }),
    });
    const inviteText = await inviteResponse.text();
    const inviteParsed = parseJsonSafely(inviteText);
    if (
      !inviteResponse.ok &&
      !isAlreadyJoinedOrInvitedRoomError(inviteResponse.status, inviteParsed)
    ) {
      throw {
        code: input.failureCode ?? "MATRIX_AGENT_IDENTITY_FAILED",
        message: input.failureMessage ?? `Failed to invite ${input.inviteeUserId} to alert room`,
        retryable: true,
        details: {
          endpoint: inviteEndpoint,
          status: inviteResponse.status,
          body: summarizeUnknown(inviteParsed),
        },
      };
    }
  }

  private async deactivateSynapseUserViaAdminApi(input: {
    adminBaseUrl: string;
    adminAccessToken: string;
    expectedUserId: string;
  }): Promise<boolean> {
    const endpoint = new URL(
      `/_synapse/admin/v1/deactivate/${encodeURIComponent(input.expectedUserId)}`,
      ensureTrailingSlash(input.adminBaseUrl),
    ).toString();
    const response = await this.fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.adminAccessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({}),
    });
    const bodyText = await response.text();
    const parsed = parseJsonSafely(bodyText);
    if (response.ok) {
      return true;
    }
    if (response.status === 404) {
      return false;
    }
    throw {
      code: "MATRIX_USER_REMOVE_FAILED",
      message: `Failed to deactivate Matrix account ${input.expectedUserId}`,
      retryable: true,
      details: {
        endpoint,
        status: response.status,
        body: summarizeUnknown(parsed),
      },
    };
  }

  private normalizeMatrixUserIdentifier(
    rawUsername: string,
    runtimeConfig: RuntimeConfig,
  ): { localpart: string; userId: string } {
    const candidate = rawUsername.trim();
    if (candidate.length === 0) {
      throw {
        code: "MATRIX_USER_INVALID",
        message: "Provide a local Matrix username or same-server Matrix user ID",
        retryable: false,
      };
    }

    const withoutAt = candidate.startsWith("@") ? candidate.slice(1) : candidate;
    const separatorIndex = withoutAt.indexOf(":");
    const localpartInput = separatorIndex >= 0 ? withoutAt.slice(0, separatorIndex) : withoutAt;
    const homeserverInput = separatorIndex >= 0 ? withoutAt.slice(separatorIndex + 1) : "";
    if (homeserverInput.length > 0 && homeserverInput !== runtimeConfig.matrix.homeserverDomain) {
      throw {
        code: "MATRIX_USER_INVALID",
        message: "Only local Matrix users on this node can be invited or removed",
        retryable: false,
        details: {
          requestedDomain: homeserverInput,
          expectedDomain: runtimeConfig.matrix.homeserverDomain,
        },
      };
    }

    const localpart = sanitizeExpectedMatrixLocalpart(localpartInput, "");
    if (localpart.length === 0) {
      throw {
        code: "MATRIX_USER_INVALID",
        message: "Provide a valid Matrix username/localpart",
        retryable: false,
        details: {
          input: rawUsername,
        },
      };
    }

    return {
      localpart,
      userId: `@${localpart}:${runtimeConfig.matrix.homeserverDomain}`,
    };
  }

  private assertHumanMatrixUserTarget(
    runtimeConfig: RuntimeConfig,
    target: { localpart: string; userId: string },
    action: "invite" | "remove",
  ): void {
    const reservedUserIds = new Set<string>([
      runtimeConfig.matrix.operator.userId,
      runtimeConfig.matrix.bot.userId,
      ...runtimeConfig.openclawProfile.agents.flatMap((entry) =>
        entry.matrix?.userId === undefined ? [] : [entry.matrix.userId],
      ),
    ]);
    const reservedLocalparts = new Set<string>(
      [
        runtimeConfig.matrix.operator.localpart ?? "",
        runtimeConfig.matrix.bot.localpart ?? "",
        ...runtimeConfig.openclawProfile.agents.flatMap((entry) =>
          entry.matrix?.localpart === undefined ? [] : [entry.matrix.localpart],
        ),
      ].filter((value) => value.length > 0),
    );
    if (!reservedUserIds.has(target.userId) && !reservedLocalparts.has(target.localpart)) {
      return;
    }
    if (
      target.userId === runtimeConfig.matrix.operator.userId ||
      target.localpart === runtimeConfig.matrix.operator.localpart
    ) {
      throw {
        code: action === "invite" ? "MATRIX_USER_REQUIRES_ONBOARDING" : "MATRIX_USER_PROTECTED",
        message:
          action === "invite"
            ? "The operator account already exists; use 'sovereign-node onboarding issue' for another operator device"
            : "The operator account cannot be removed with 'sovereign-node users remove'",
        retryable: false,
        details: {
          userId: target.userId,
        },
      };
    }
    throw {
      code: "MATRIX_USER_PROTECTED",
      message: "Reserved Matrix service accounts cannot be managed with the human-user commands",
      retryable: false,
      details: {
        userId: target.userId,
      },
    };
  }

  private async tryReadRuntimeConfig(): Promise<RuntimeConfig | null> {
    try {
      const raw = await readFile(this.paths.configPath, "utf8");
      return parseRuntimeConfigDocument(raw);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      this.logger.warn(
        {
          configPath: this.paths.configPath,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to read runtime config for status/doctor probes",
      );
      return null;
    }
  }

  private async tryReadInstallProvenance(): Promise<InstallProvenance | null> {
    try {
      const raw = await readFile(this.paths.provenancePath, "utf8");
      return parseInstallProvenance(raw);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      this.logger.warn(
        {
          provenancePath: this.paths.provenancePath,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to read install provenance",
      );
      return null;
    }
  }

  /**
   * The bot configuration step may change the bot user's Synapse password via the
   * admin API and store it under a different secret file name (matrix-agent-*-password)
   * than what bootstrapAccounts expects (matrix-<localpart>.password).
   * Sync the runtime config's bot password to the bootstrap file so the next
   * bootstrapAccounts call uses the current password.
   */
  private async syncBotPasswordFromRuntimeConfig(
    homeserverDomain: string,
    botLocalpart: string,
  ): Promise<void> {
    try {
      const runtimeConfig = await this.tryReadRuntimeConfig();
      if (runtimeConfig === null) {
        return;
      }
      if (runtimeConfig.matrix.homeserverDomain !== homeserverDomain) {
        return;
      }
      const botPasswordRef = runtimeConfig.matrix.bot.passwordSecretRef;
      if (botPasswordRef === undefined || botPasswordRef.length === 0) {
        return;
      }
      const bootstrapFileName = `matrix-${botLocalpart}.password`;
      const bootstrapRef = `file:${join(this.paths.secretsDir, bootstrapFileName)}`;
      if (botPasswordRef === bootstrapRef) {
        return;
      }
      const currentBotPassword = await this.resolveSecretRef(botPasswordRef);
      if (currentBotPassword.length > 0) {
        await this.writeManagedSecretFile(bootstrapFileName, currentBotPassword);
        this.logger.info(
          { botLocalpart, from: botPasswordRef, to: bootstrapRef },
          "Synced bot password from runtime config to bootstrap file",
        );
      }
    } catch {
      // best-effort: if we can't sync, bootstrapAccounts will try its normal flow
    }
  }

  private async tryReuseExistingMatrixAccounts(input: {
    req: InstallRequest;
    provision: BundledMatrixProvisionResult;
    error: unknown;
    botLocalpart?: string;
  }): Promise<BundledMatrixAccountsResult | null> {
    if (!isRateLimitedMatrixLoginFailure(input.error)) {
      return null;
    }

    const runtimeConfig = await this.tryReadRuntimeConfig();
    if (runtimeConfig === null) {
      return null;
    }
    if (runtimeConfig.matrix.homeserverDomain !== input.provision.homeserverDomain) {
      return null;
    }

    const expectedOperatorLocalpart = sanitizeExpectedMatrixLocalpart(
      input.req.operator.username,
      "operator",
    );
    const expectedBotLocalpart = resolveExpectedBundledBotLocalpart(
      expectedOperatorLocalpart,
      input.botLocalpart,
    );
    const operator = runtimeConfig.matrix.operator;
    const bot = runtimeConfig.matrix.bot;
    if (
      operator.localpart !== expectedOperatorLocalpart ||
      bot.localpart !== expectedBotLocalpart ||
      operator.passwordSecretRef === undefined ||
      operator.accessTokenSecretRef === undefined ||
      bot.passwordSecretRef === undefined
    ) {
      return null;
    }

    try {
      const [operatorAccessToken, botAccessToken] = await Promise.all([
        this.resolveSecretRef(operator.accessTokenSecretRef),
        this.resolveSecretRef(bot.accessTokenSecretRef),
      ]);
      this.logger.warn(
        {
          homeserverDomain: input.provision.homeserverDomain,
          operatorUserId: operator.userId,
          botUserId: bot.userId,
        },
        "Matrix login is rate limited; reusing existing persisted Matrix account tokens",
      );
      return {
        operator: {
          localpart: operator.localpart,
          userId: operator.userId,
          passwordSecretRef: operator.passwordSecretRef,
          accessToken: operatorAccessToken,
        },
        bot: {
          localpart: bot.localpart,
          userId: bot.userId,
          passwordSecretRef: bot.passwordSecretRef,
          accessToken: botAccessToken,
        },
      };
    } catch (reuseError) {
      this.logger.warn(
        {
          error: reuseError instanceof Error ? reuseError.message : String(reuseError),
        },
        "Failed to reuse persisted Matrix account tokens after login rate limiting",
      );
      return null;
    }
  }

  private async tryRecoverRateLimitedMatrixReconfigure(input: {
    req: InstallRequest;
    provision: BundledMatrixProvisionResult;
    error: unknown;
    botLocalpart?: string;
  }): Promise<BundledMatrixAccountsResult | null> {
    if (
      !isRateLimitedMatrixLoginFailure(input.error) ||
      this.matrixProvisioner.resetState === undefined
    ) {
      return null;
    }

    const runtimeConfig = await this.tryReadRuntimeConfig();
    if (
      runtimeConfig === null ||
      runtimeConfig.matrix.homeserverDomain === input.provision.homeserverDomain
    ) {
      return null;
    }

    this.logger.warn(
      {
        currentHomeserverDomain: runtimeConfig.matrix.homeserverDomain,
        targetHomeserverDomain: input.provision.homeserverDomain,
        projectDir: input.provision.projectDir,
      },
      "Matrix login is rate limited while switching to a new bundled homeserver; resetting the new Matrix state and retrying",
    );

    await this.matrixProvisioner.resetState(input.provision);
    return this.matrixProvisioner.bootstrapAccounts(input.req, input.provision, {
      ...(input.botLocalpart === undefined ? {} : { botLocalpart: input.botLocalpart }),
      avatarResolver: new FilesystemMatrixAvatarResolver(this.botCatalog),
    });
  }

  private async safeDetectOpenClaw(): Promise<{
    binaryPath: string;
    version: string;
  } | null> {
    try {
      return await this.openclawBootstrapper.detectInstalled();
    } catch (error) {
      this.logger.warn(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        "OpenClaw CLI detection failed during status/doctor probe",
      );
      return null;
    }
  }

  private async inspectGatewayService(): Promise<{
    installed: boolean;
    state: GatewayState;
    message?: string;
  }> {
    const sovereignSystemctl = await this.inspectGatewayViaSystemctl([
      SOVEREIGN_GATEWAY_SYSTEMD_UNIT,
    ]);
    if (sovereignSystemctl !== null) {
      return sovereignSystemctl;
    }

    const openclawGatewayStatus = await this.safeExec("openclaw", ["gateway", "status"]);
    if (openclawGatewayStatus.ok) {
      const output = `${openclawGatewayStatus.result.stdout}\n${openclawGatewayStatus.result.stderr}`;
      const state = parseGatewayState(output);
      if (
        openclawGatewayStatus.result.exitCode === 0 ||
        state !== "unknown" ||
        !looksLikeMissingGateway(output)
      ) {
        return {
          installed: !looksLikeMissingGateway(output),
          state,
          message: summarizeText(output, 220),
        };
      }
    }

    const systemctl = await this.inspectGatewayViaSystemctl([
      "openclaw-gateway.service",
      "openclaw-gateway",
    ]);
    if (systemctl !== null) {
      return systemctl;
    }

    return {
      installed: false,
      state: "unknown",
      message: openclawGatewayStatus.ok
        ? summarizeText(
            `${openclawGatewayStatus.result.stdout}\n${openclawGatewayStatus.result.stderr}`,
            220,
          )
        : openclawGatewayStatus.error,
    };
  }

  private async inspectRelayTunnelService(): Promise<{
    installed: boolean;
    state: GatewayState;
    message?: string;
  }> {
    const systemctl = await this.inspectGatewayViaSystemctl([RELAY_TUNNEL_SYSTEMD_UNIT]);
    if (systemctl !== null) {
      return systemctl;
    }
    return {
      installed: false,
      state: "unknown",
    };
  }

  private async inspectGatewayViaSystemctl(candidates: string[]): Promise<{
    installed: boolean;
    state: GatewayState;
    message?: string;
  } | null> {
    for (const unit of candidates) {
      const result = await this.safeExec("systemctl", ["is-active", unit]);
      if (!result.ok) {
        if (isMissingBinaryError(result.error)) {
          return null;
        }
        continue;
      }

      const output = `${result.result.stdout}\n${result.result.stderr}`;
      const state = parseGatewayState(output);
      if (result.result.exitCode === 0 || state !== "unknown") {
        return {
          installed: !/not-found|could not be found|no such file/i.test(output),
          state,
          message: summarizeText(output, 220),
        };
      }
    }

    return null;
  }

  private async probeOpenClawHealth(): Promise<{
    ok: boolean;
    message: string;
  }> {
    for (let attempt = 1; attempt <= OPENCLAW_EMPTY_HEALTH_RETRY_ATTEMPTS; attempt += 1) {
      const probe = await this.safeExec("openclaw", ["health"], {
        timeoutMs: OPENCLAW_STATUS_PROBE_TIMEOUT_MS,
      });
      if (!probe.ok) {
        return {
          ok: false,
          message: probe.error,
        };
      }
      const body = `${probe.result.stdout}\n${probe.result.stderr}`;
      if (probe.result.exitCode === 0 || this.looksLikeHealthyOpenClawHealth(body)) {
        return {
          ok: true,
          message: summarizeText(probe.result.stdout || body, 220) || "openclaw health ok",
        };
      }
      if (body.trim().length > 0 || attempt === OPENCLAW_EMPTY_HEALTH_RETRY_ATTEMPTS) {
        return {
          ok: false,
          message: summarizeText(body, 220),
        };
      }
      await delay(OPENCLAW_EMPTY_HEALTH_RETRY_DELAY_MS);
    }
    return {
      ok: false,
      message: "",
    };
  }

  private looksLikeHealthyOpenClawHealth(value: string): boolean {
    const normalized = value.toLowerCase();
    if (!/matrix:\s*ok/.test(normalized)) {
      return false;
    }
    if (!/agents?:/.test(normalized)) {
      return false;
    }
    return !/\bunhealthy\b|\bfailed\b|\berror\b|\bpanic\b/.test(normalized);
  }

  private async inspectOpenClawListContains(
    baseArgs: string[],
    expectedId: string,
  ): Promise<{ present: boolean; verified: boolean }> {
    const attempts = [baseArgs, [...baseArgs, "--json"]];
    let verified = false;
    for (const args of attempts) {
      const probe = await this.safeExec("openclaw", args, {
        timeoutMs: OPENCLAW_STATUS_PROBE_TIMEOUT_MS,
      });
      if (!probe.ok) {
        continue;
      }
      if (probe.result.exitCode !== 0) {
        continue;
      }
      verified = true;
      const body = `${probe.result.stdout}\n${probe.result.stderr}`;
      if (textContainsId(body, expectedId)) {
        return {
          present: true,
          verified: true,
        };
      }
    }

    return {
      present: false,
      verified,
    };
  }

  private async inspectManagedOpenClawListContains(
    runtimeConfig: RuntimeConfig | null,
    baseArgs: string[],
    expectedId: string,
  ): Promise<{ present: boolean; verified: boolean }> {
    if (runtimeConfig === null) {
      return await this.inspectOpenClawListContains(baseArgs, expectedId);
    }

    let result: { present: boolean; verified: boolean } = { present: false, verified: false };
    await this.withManagedOpenClawServiceIdentityEnv(runtimeConfig, async () => {
      result = await this.inspectOpenClawListContains(baseArgs, expectedId);
    });
    return result;
  }

  private async waitForOpenClawListContains(
    baseArgs: string[],
    expectedId: string,
  ): Promise<{ present: boolean; verified: boolean }> {
    let last = { present: false, verified: false };
    for (let attempt = 1; attempt <= OPENCLAW_RUNTIME_SETTLE_ATTEMPTS; attempt += 1) {
      last = await this.inspectOpenClawListContains(baseArgs, expectedId);
      if (last.present || !last.verified || attempt === OPENCLAW_RUNTIME_SETTLE_ATTEMPTS) {
        return last;
      }
      await delay(OPENCLAW_RUNTIME_SETTLE_DELAY_MS);
    }
    return last;
  }

  private async readManagedOpenClawRuntimeJson(
    runtimeConfig: RuntimeConfig,
  ): Promise<Record<string, unknown> | null> {
    try {
      const raw = await readFile(runtimeConfig.openclaw.runtimeConfigPath, "utf8");
      const parsed = parseJsonSafely(raw);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private managedOpenClawRuntimeHasAgent(
    runtimeJson: Record<string, unknown> | null,
    agentId: string,
  ): boolean {
    const agents = runtimeJson?.agents;
    if (!isRecord(agents) || !Array.isArray(agents.list)) {
      return false;
    }
    return agents.list.some((entry) => isRecord(entry) && entry.id === agentId);
  }

  private managedOpenClawRuntimeHasCron(
    runtimeJson: Record<string, unknown> | null,
    cronId: string,
  ): boolean {
    const cron = runtimeJson?.cron;
    if (!isRecord(cron)) {
      return false;
    }
    const jobs = cron.jobs;
    if (Array.isArray(jobs)) {
      return jobs.some(
        (entry) => isRecord(entry) && (entry.id === cronId || entry.name === cronId),
      );
    }
    const singleId = cron.id;
    return singleId === cronId;
  }

  private async inspectMatrixStatus(runtimeConfig: RuntimeConfig | null): Promise<{
    health: ComponentHealth;
    roomReachable: boolean;
    message?: string;
  }> {
    if (runtimeConfig === null) {
      return {
        health: "unknown",
        roomReachable: false,
        message: "Sovereign runtime config does not exist yet",
      };
    }

    const matrixBaseUrl = runtimeConfig.matrix.adminBaseUrl;
    const matrixResult = await this.testMatrix({
      publicBaseUrl: matrixBaseUrl,
      federationEnabled: runtimeConfig.matrix.federationEnabled,
    });
    if (!matrixResult.ok) {
      return {
        health: "unhealthy",
        roomReachable: false,
        message: "Matrix endpoint probe failed",
      };
    }

    const roomReachable = await this.probeMatrixRoomReachable(runtimeConfig);
    return {
      health: roomReachable ? "healthy" : "degraded",
      roomReachable,
      ...(roomReachable
        ? {}
        : { message: "Matrix homeserver is reachable but alert room probe failed" }),
    };
  }

  private async inspectOpenClawRuntimeWiring(
    runtimeConfig: RuntimeConfig | null,
  ): Promise<CheckResult> {
    const defaults = this.getOpenClawRuntimePaths();
    const openclawHome = runtimeConfig?.openclaw.openclawHome ?? defaults.openclawHome;
    const runtimeConfigPath =
      runtimeConfig?.openclaw.runtimeConfigPath ?? defaults.runtimeConfigPath;
    const runtimeProfilePath =
      runtimeConfig?.openclaw.runtimeProfilePath ?? defaults.runtimeProfilePath;
    const gatewayEnvPath = runtimeConfig?.openclaw.gatewayEnvPath ?? defaults.gatewayEnvPath;
    const missing: string[] = [];

    for (const path of [openclawHome, runtimeConfigPath, runtimeProfilePath, gatewayEnvPath]) {
      const exists = await this.pathExists(path);
      if (!exists) {
        missing.push(path);
      }
    }

    if (missing.length > 0) {
      return check(
        "openclaw-runtime-wiring",
        "OpenClaw runtime wiring",
        "fail",
        "OpenClaw runtime files are missing",
        { missing },
      );
    }

    try {
      const envRaw = await readFile(gatewayEnvPath, "utf8");
      const env = parseEnvFile(envRaw);
      const configRef = env.OPENCLAW_CONFIG ?? env.OPENCLAW_CONFIG_PATH;
      const homeRef = env.OPENCLAW_HOME;
      const expectedOpenclawHome = dirname(openclawHome);
      const matches = configRef === runtimeConfigPath && homeRef === expectedOpenclawHome;

      return check(
        "openclaw-runtime-wiring",
        "OpenClaw runtime wiring",
        matches ? "pass" : "warn",
        matches
          ? "OpenClaw runtime env wiring matches Sovereign-managed paths"
          : "OpenClaw runtime env wiring is present but does not match expected paths",
        {
          expectedConfigPath: runtimeConfigPath,
          expectedOpenclawHome,
          envConfigPath: configRef,
          envOpenclawHome: homeRef,
        },
      );
    } catch (error) {
      return check(
        "openclaw-runtime-wiring",
        "OpenClaw runtime wiring",
        "fail",
        "OpenClaw runtime env file is not readable",
        {
          gatewayEnvPath,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  private async validateAndRefreshMatrixIdentityToken(
    input: {
      label: string;
      adminBaseUrl: string;
      localpart?: string | undefined;
      userId: string;
      accessTokenSecretRef?: string | undefined;
      passwordSecretRef?: string | undefined;
    },
    runtimeConfig: RuntimeConfig,
  ): Promise<boolean> {
    const tokenRef = input.accessTokenSecretRef;
    const passwordRef = input.passwordSecretRef;
    if (tokenRef === undefined || passwordRef === undefined) {
      return false;
    }

    let currentToken: string;
    try {
      currentToken = await this.resolveSecretRef(tokenRef);
    } catch {
      this.logger.warn(
        {
          label: input.label,
          userId: input.userId,
        },
        "Matrix access token file is missing or empty; will attempt re-login",
      );
      currentToken = "";
    }

    if (currentToken.length > 0) {
      const whoamiEndpoint = new URL(
        "/_matrix/client/v3/account/whoami",
        ensureTrailingSlash(input.adminBaseUrl),
      ).toString();
      try {
        const response = await this.fetchImpl(whoamiEndpoint, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${currentToken}`,
            Accept: "application/json",
          },
        });
        if (response.ok) {
          return false;
        }
        if (response.status !== 401 && response.status !== 403) {
          this.logger.warn(
            {
              label: input.label,
              userId: input.userId,
              status: response.status,
            },
            "Matrix access token validation returned a non-auth failure; skipping token refresh",
          );
          return false;
        }
      } catch (error) {
        this.logger.warn(
          {
            label: input.label,
            userId: input.userId,
            error: describeError(error),
          },
          "Matrix access token validation failed before refresh attempt",
        );
        return false;
      }
      this.logger.warn(
        {
          label: input.label,
          userId: input.userId,
        },
        "Matrix access token is invalid; re-logging in to refresh",
      );
    }

    const localpart = input.localpart;
    if (localpart === undefined || localpart.length === 0) {
      this.logger.warn(
        {
          label: input.label,
          userId: input.userId,
        },
        "Matrix localpart is not set; cannot refresh token",
      );
      return false;
    }
    let password: string;
    try {
      password = await this.resolveSecretRef(passwordRef);
    } catch {
      this.logger.warn(
        {
          label: input.label,
          userId: input.userId,
        },
        "Matrix password secret is missing; cannot refresh token",
      );
      return false;
    }

    const expectedUserId = input.userId;
    const session = await this.loginMatrixUser({
      adminBaseUrl: input.adminBaseUrl,
      localpart,
      password,
      expectedUserId,
    });

    const tokenFileName = tokenRef.startsWith("file:")
      ? basename(tokenRef.slice("file:".length)) || "matrix-bot-access-token"
      : "matrix-bot-access-token";
    if (isManagedAgentMatrixAccessTokenFileName(tokenFileName)) {
      await this.writeManagedAgentAccessTokenFile(
        runtimeConfig,
        tokenFileName,
        session.accessToken,
      );
    } else {
      await this.writeManagedSecretFile(tokenFileName, session.accessToken);
    }

    this.logger.info(
      {
        label: input.label,
        userId: session.userId,
      },
      "Refreshed Matrix access token after detecting stale credentials",
    );

    return true;
  }

  private async ensureManagedMatrixAccessTokens(runtimeConfig: RuntimeConfig): Promise<boolean> {
    const candidates = [
      {
        label: "primary bot",
        adminBaseUrl: runtimeConfig.matrix.adminBaseUrl,
        localpart: runtimeConfig.matrix.bot.localpart,
        userId: runtimeConfig.matrix.bot.userId,
        accessTokenSecretRef: runtimeConfig.matrix.bot.accessTokenSecretRef,
        passwordSecretRef: runtimeConfig.matrix.bot.passwordSecretRef,
      },
      ...ensureCoreManagedAgents(runtimeConfig.openclawProfile.agents)
        .filter((agent) => agent.matrix !== undefined)
        .map((agent) => ({
          label: `managed bot ${agent.id}`,
          adminBaseUrl: runtimeConfig.matrix.adminBaseUrl,
          localpart: agent.matrix?.localpart,
          userId: agent.matrix?.userId ?? "",
          accessTokenSecretRef: agent.matrix?.accessTokenSecretRef,
          passwordSecretRef: agent.matrix?.passwordSecretRef,
        })),
    ];

    const seen = new Set<string>();
    let refreshed = false;
    for (const candidate of candidates) {
      if (candidate.userId.length === 0) {
        continue;
      }
      const dedupeKey = [
        candidate.userId,
        candidate.localpart ?? "",
        candidate.accessTokenSecretRef ?? "",
        candidate.passwordSecretRef ?? "",
      ].join("\u0000");
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      refreshed =
        (await this.validateAndRefreshMatrixIdentityToken(candidate, runtimeConfig)) || refreshed;
    }

    if (!refreshed) {
      return false;
    }

    await this.refreshManagedMatrixRuntimeArtifacts(runtimeConfig);
    await this.refreshGatewayAfterRuntimeConfig(runtimeConfig);

    return true;
  }

  private async refreshManagedMatrixRuntimeArtifacts(runtimeConfig: RuntimeConfig): Promise<void> {
    const canPatchExistingRuntime =
      (await this.pathExists(runtimeConfig.openclaw.runtimeConfigPath)) &&
      (await this.pathExists(runtimeConfig.openclaw.gatewayEnvPath));
    if (!canPatchExistingRuntime) {
      await this.writeOpenClawRuntimeArtifacts(runtimeConfig);
      return;
    }

    await this.patchManagedMatrixRuntimeArtifacts(runtimeConfig);
  }

  private async patchManagedMatrixRuntimeArtifacts(runtimeConfig: RuntimeConfig): Promise<void> {
    const tokenByUserId = new Map<string, string>();
    tokenByUserId.set(
      runtimeConfig.matrix.bot.userId,
      await this.resolveSecretRef(runtimeConfig.matrix.bot.accessTokenSecretRef),
    );
    for (const agent of ensureCoreManagedAgents(runtimeConfig.openclawProfile.agents)) {
      if (agent.matrix?.accessTokenSecretRef === undefined || agent.matrix.userId.length === 0) {
        continue;
      }
      tokenByUserId.set(
        agent.matrix.userId,
        await this.resolveSecretRef(agent.matrix.accessTokenSecretRef),
      );
    }

    const runtimeRaw = await readFile(runtimeConfig.openclaw.runtimeConfigPath, "utf8");
    const parsedRuntime = parseJsonDocument(runtimeRaw);
    if (!isRecord(parsedRuntime)) {
      throw {
        code: "OPENCLAW_CONFIG_WRITE_FAILED",
        message: "OpenClaw runtime config is not a JSON object",
        retryable: true,
        details: {
          runtimeConfigPath: runtimeConfig.openclaw.runtimeConfigPath,
        },
      };
    }

    const channels = isRecord(parsedRuntime.channels) ? parsedRuntime.channels : null;
    const matrix = channels !== null && isRecord(channels.matrix) ? channels.matrix : null;
    const accounts = matrix !== null && isRecord(matrix.accounts) ? matrix.accounts : null;
    let runtimeChanged = false;
    if (accounts !== null) {
      for (const entry of Object.values(accounts)) {
        if (!isRecord(entry) || typeof entry.userId !== "string") {
          continue;
        }
        const nextToken = tokenByUserId.get(entry.userId);
        if (nextToken === undefined || entry.accessToken === nextToken) {
          continue;
        }
        entry.accessToken = nextToken;
        runtimeChanged = true;
      }
    }
    if (runtimeChanged) {
      await this.writeProtectedJsonFile(
        runtimeConfig.openclaw.runtimeConfigPath,
        parsedRuntime,
        runtimeConfig,
      );
    }

    const primaryToken = tokenByUserId.get(runtimeConfig.matrix.bot.userId) ?? "";
    const envRaw = await readFile(runtimeConfig.openclaw.gatewayEnvPath, "utf8");
    const env = parseEnvFile(envRaw);
    env.MATRIX_HOMESERVER = runtimeConfig.matrix.adminBaseUrl;
    env.MATRIX_USER_ID = runtimeConfig.matrix.bot.userId;
    env.MATRIX_ACCESS_TOKEN = primaryToken;
    const envTempPath = `${runtimeConfig.openclaw.gatewayEnvPath}.${randomUUID()}.tmp`;
    await writeFile(
      envTempPath,
      `${Object.entries(env)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n")}
`,
      "utf8",
    );
    await chmod(envTempPath, 0o600);
    await rename(envTempPath, runtimeConfig.openclaw.gatewayEnvPath);
    await this.applyConfiguredRuntimeOwnership(
      runtimeConfig.openclaw.gatewayEnvPath,
      runtimeConfig,
    );
  }

  private async probeMatrixRoomReachable(runtimeConfig: RuntimeConfig): Promise<boolean> {
    try {
      await this.ensureManagedMatrixAccessTokens(runtimeConfig);
    } catch {
      return false;
    }

    try {
      const accessToken = await this.resolveSecretRef(
        runtimeConfig.matrix.bot.accessTokenSecretRef,
      );
      const endpoint = new URL(
        `/_matrix/client/v3/rooms/${encodeURIComponent(runtimeConfig.matrix.alertRoom.roomId)}/joined_members`,
        ensureTrailingSlash(runtimeConfig.matrix.adminBaseUrl),
      ).toString();
      const response = await this.fetchImpl(endpoint, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async safeExec(
    command: string,
    args: string[],
    options?: {
      timeoutMs?: number;
    },
  ): Promise<
    | {
        ok: true;
        result: ExecResult;
      }
    | {
        ok: false;
        error: string;
      }
  > {
    if (this.execRunner === null) {
      return {
        ok: false,
        error: "Exec runner is not configured",
      };
    }

    const openclawEnv = command === "openclaw" ? await this.resolveManagedOpenClawEnv() : null;
    const openclawServiceUser =
      command === "openclaw" ? await this.resolveManagedOpenClawServiceUser() : null;
    const shouldRunOpenClawAsServiceUser =
      command === "openclaw" &&
      typeof process.getuid === "function" &&
      process.getuid() === 0 &&
      openclawServiceUser !== null &&
      openclawServiceUser !== "root";
    const delegatedCommand =
      shouldRunOpenClawAsServiceUser && command === "openclaw"
        ? ((await resolveExecutablePath(command)) ?? command)
        : command;
    const effectiveCommand = shouldRunOpenClawAsServiceUser ? "sudo" : command;
    const effectiveArgs = shouldRunOpenClawAsServiceUser
      ? [
          "-u",
          openclawServiceUser,
          "--preserve-env=HOME,OPENCLAW_HOME,OPENCLAW_CONFIG,OPENCLAW_CONFIG_PATH,SOVEREIGN_NODE_CONFIG,SOVEREIGN_NODE_SERVICE_USER,SOVEREIGN_NODE_SERVICE_GROUP,CI,TMPDIR,TMP,TEMP,PATH",
          "--",
          delegatedCommand,
          ...args,
        ]
      : args;

    try {
      const result = await this.execRunner.run({
        command: effectiveCommand,
        args: effectiveArgs,
        options: {
          timeout: options?.timeoutMs ?? INSTALLER_EXEC_TIMEOUT_MS,
          ...(command === "openclaw"
            ? {
                env: {
                  CI: "1",
                  PATH: process.env.PATH ?? "",
                  ...(openclawEnv ?? {}),
                },
              }
            : {}),
        },
      });
      return {
        ok: true,
        result,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await access(path, fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  private getOpenClawRuntimePaths(): {
    openclawHome: string;
    runtimeConfigPath: string;
    runtimeProfilePath: string;
    gatewayEnvPath: string;
  } {
    const openclawHome = join(this.paths.openclawServiceHome, ".openclaw");
    return {
      openclawHome,
      runtimeConfigPath: join(openclawHome, "openclaw.json5"),
      runtimeProfilePath: join(
        this.paths.openclawServiceHome,
        "profiles",
        "sovereign-runtime-profile.json5",
      ),
      gatewayEnvPath: join(this.paths.openclawServiceHome, "gateway.env"),
    };
  }

  private buildManagedOpenClawEnv(runtimeConfig: RuntimeConfig): Record<string, string> {
    const tempDir = this.getManagedOpenClawTempDir(runtimeConfig);
    const openclawServiceHome = dirname(runtimeConfig.openclaw.openclawHome);
    return {
      HOME: openclawServiceHome,
      OPENCLAW_HOME: openclawServiceHome,
      OPENCLAW_CONFIG: runtimeConfig.openclaw.runtimeConfigPath,
      OPENCLAW_CONFIG_PATH: runtimeConfig.openclaw.runtimeConfigPath,
      SOVEREIGN_NODE_CONFIG: this.paths.configPath,
      TMPDIR: tempDir,
      TMP: tempDir,
      TEMP: tempDir,
    };
  }

  private getManagedOpenClawTempDir(runtimeConfig?: RuntimeConfig): string {
    const gatewayEnvPath =
      runtimeConfig?.openclaw.gatewayEnvPath ?? join(this.paths.openclawServiceHome, "gateway.env");
    return join(dirname(gatewayEnvPath), "tmp");
  }

  private setManagedOpenClawEnv(runtimeConfig: RuntimeConfig): void {
    const env = this.buildManagedOpenClawEnv(runtimeConfig);
    this.managedOpenClawEnv = env;
    for (const [key, value] of Object.entries(env)) {
      if (key === "TMPDIR" || key === "TMP" || key === "TEMP") {
        continue;
      }
      process.env[key] = value;
    }
  }

  private async withManagedOpenClawServiceIdentityEnv<T>(
    runtimeConfig: RuntimeConfig,
    action: () => Promise<T>,
  ): Promise<T> {
    const priorUser = process.env.SOVEREIGN_NODE_SERVICE_USER;
    const priorGroup = process.env.SOVEREIGN_NODE_SERVICE_GROUP;
    process.env.SOVEREIGN_NODE_SERVICE_USER = runtimeConfig.openclaw.serviceUser;
    process.env.SOVEREIGN_NODE_SERVICE_GROUP = runtimeConfig.openclaw.serviceGroup;
    try {
      return await action();
    } finally {
      if (priorUser === undefined) {
        delete process.env.SOVEREIGN_NODE_SERVICE_USER;
      } else {
        process.env.SOVEREIGN_NODE_SERVICE_USER = priorUser;
      }
      if (priorGroup === undefined) {
        delete process.env.SOVEREIGN_NODE_SERVICE_GROUP;
      } else {
        process.env.SOVEREIGN_NODE_SERVICE_GROUP = priorGroup;
      }
    }
  }

  private async resolveManagedOpenClawEnv(): Promise<Record<string, string> | null> {
    if (this.managedOpenClawEnv !== undefined) {
      return this.managedOpenClawEnv;
    }

    const runtimeConfig = await this.tryReadRuntimeConfig();
    if (runtimeConfig === null) {
      this.managedOpenClawEnv = null;
      return null;
    }

    const env = this.buildManagedOpenClawEnv(runtimeConfig);
    this.managedOpenClawEnv = env;
    return env;
  }

  private async resolveManagedOpenClawServiceUser(): Promise<string | null> {
    const runtimeConfig = await this.tryReadRuntimeConfig();
    if (runtimeConfig === null) {
      return null;
    }
    const configuredUser = runtimeConfig.openclaw.serviceUser?.trim();
    if (configuredUser === undefined || configuredUser.length === 0) {
      return null;
    }
    return configuredUser;
  }

  private buildInstallSteps(req: InstallRequest): InstallStep[] {
    const stepState: {
      effectiveRequest?: InstallRequest;
      relayEnrollment?: RelayEnrollmentResult;
      matrixProvision?: BundledMatrixProvisionResult;
      matrixAccounts?: BundledMatrixAccountsResult;
      matrixRoom?: BundledMatrixRoomBootstrapResult;
      runtimeConfig?: RuntimeConfig;
      selectedBots?: LoadedBotPackage[];
      sharedServiceBotLocalpart?: string;
      botRegistrations?: ManagedAgentRegistrationResult[];
      gatewayServiceSkipped?: boolean;
      relayTunnelServiceInstalled?: boolean;
    } = {};

    return [
      {
        id: "preflight",
        label: "Preflight",
        run: async () => {
          const result = await this.preflight(req);
          if (result.overall === "fail") {
            throw {
              code: "PREFLIGHT_FAILED",
              message: "Preflight checks failed",
              retryable: false,
              details: {
                recommendedActions: result.recommendedActions,
              },
            };
          }
        },
      },
      {
        id: "openclaw_bootstrap_cli",
        label: "Install OpenClaw CLI",
        run: async () => {
          const openclaw = req.openclaw;
          const manageInstallation = openclaw?.manageInstallation ?? true;

          if (!manageInstallation) {
            const detected = await this.openclawBootstrapper.detectInstalled();
            if (detected === null) {
              throw {
                code: "OPENCLAW_MISSING",
                message:
                  "OpenClaw is not installed but the request disabled Sovereign-managed installation",
                retryable: false,
              };
            }
            return;
          }

          await this.openclawBootstrapper.ensureInstalled({
            version: resolveRequestedOpenClawVersion(openclaw?.version),
            noOnboard: true,
            noPrompt: true,
            forceReinstall: openclaw?.forceReinstall ?? false,
            skipIfCompatibleInstalled: openclaw?.skipIfCompatibleInstalled ?? true,
          });
        },
      },
      {
        id: "openclaw_bundled_plugin_tools",
        label: "Install bundled plugin CLI tools",
        run: async () => {
          if (stepState.selectedBots === undefined) {
            stepState.selectedBots = (
              await this.resolveRequestedBots(stepState.effectiveRequest ?? req)
            ).packages;
          }
          if (!this.shouldEnsureLobsterCli(stepState.selectedBots)) {
            return;
          }
          if (this.execRunner === null) {
            this.logger.warn(
              "Exec runner unavailable; skipping explicit Lobster CLI capability gate during install",
            );
            return;
          }
          await this.ensureLobsterCliInstalled();
        },
      },
      {
        id: "imap_validate",
        label: "Validate IMAP",
        softFail: true,
        run: async () => {
          if (req.imap === undefined) {
            this.logger.info(
              "IMAP validation skipped because install request left IMAP in pending mode",
            );
            return;
          }
          const result = await this.testImap({ imap: req.imap });
          if (!result.ok) {
            throw {
              code: "IMAP_TEST_FAILED",
              message: result.error?.message ?? "IMAP validation failed",
              retryable: result.error?.retryable ?? true,
            };
          }
        },
      },
      {
        id: "relay_enroll",
        label: "Enroll managed relay",
        run: async (ctx) => {
          if (!this.isRelayModeRequest(req)) {
            stepState.effectiveRequest = req;
            return;
          }
          stepState.relayEnrollment = await this.resolveRelayEnrollment(req, ctx.installationId);
          const previousRuntimeConfig = await this.tryReadRuntimeConfig();
          stepState.effectiveRequest = this.buildRelayProvisionRequest(
            req,
            stepState.relayEnrollment,
            previousRuntimeConfig,
          );
        },
      },
      {
        id: "matrix_provision",
        label: "Provision bundled Matrix stack",
        run: async () => {
          stepState.matrixProvision = await this.matrixProvisioner.provision(
            stepState.effectiveRequest ?? req,
          );
        },
      },
      {
        id: "matrix_bootstrap_accounts",
        label: "Bootstrap Matrix accounts",
        run: async () => {
          if (stepState.matrixProvision === undefined) {
            throw {
              code: "INSTALL_INTERNAL_STATE",
              message: "Matrix provisioning output is missing before account bootstrap",
              retryable: false,
            };
          }
          if (stepState.selectedBots === undefined) {
            stepState.selectedBots = (
              await this.resolveRequestedBots(stepState.effectiveRequest ?? req)
            ).packages;
          }
          const bootstrapBotLocalpart = this.resolveBootstrapMatrixBotLocalpart(
            stepState.selectedBots,
          );
          if (bootstrapBotLocalpart !== undefined) {
            await this.syncBotPasswordFromRuntimeConfig(
              stepState.matrixProvision.homeserverDomain,
              bootstrapBotLocalpart,
            );
          }
          const previousAccountsRuntimeConfig = await this.tryReadRuntimeConfig();
          const previousBotAvatarSha256 =
            previousAccountsRuntimeConfig !== null &&
            previousAccountsRuntimeConfig.matrix.homeserverDomain ===
              stepState.matrixProvision.homeserverDomain
              ? previousAccountsRuntimeConfig.matrix.bot.avatarSha256
              : undefined;
          const accountsAvatarResolver = new FilesystemMatrixAvatarResolver(this.botCatalog);
          try {
            stepState.matrixAccounts = await this.matrixProvisioner.bootstrapAccounts(
              stepState.effectiveRequest ?? req,
              stepState.matrixProvision,
              {
                ...(bootstrapBotLocalpart === undefined
                  ? {}
                  : { botLocalpart: bootstrapBotLocalpart }),
                avatarResolver: accountsAvatarResolver,
                ...(previousBotAvatarSha256 === undefined ? {} : { previousBotAvatarSha256 }),
              },
            );
          } catch (error) {
            const reusedAccounts = await this.tryReuseExistingMatrixAccounts({
              req: stepState.effectiveRequest ?? req,
              provision: stepState.matrixProvision,
              error,
              ...(bootstrapBotLocalpart === undefined
                ? {}
                : { botLocalpart: bootstrapBotLocalpart }),
            });
            if (reusedAccounts !== null) {
              stepState.matrixAccounts = reusedAccounts;
              return;
            }

            const resetAccounts = await this.tryRecoverRateLimitedMatrixReconfigure({
              req: stepState.effectiveRequest ?? req,
              provision: stepState.matrixProvision,
              error,
              ...(bootstrapBotLocalpart === undefined
                ? {}
                : { botLocalpart: bootstrapBotLocalpart }),
            });
            if (resetAccounts !== null) {
              stepState.matrixAccounts = resetAccounts;
              return;
            }

            throw error;
          }
        },
      },
      {
        id: "matrix_bootstrap_room",
        label: "Bootstrap Matrix alert room",
        run: async () => {
          if (stepState.matrixProvision === undefined) {
            throw {
              code: "INSTALL_INTERNAL_STATE",
              message: "Matrix provisioning output is missing before room bootstrap",
              retryable: false,
            };
          }
          if (stepState.matrixAccounts === undefined) {
            throw {
              code: "INSTALL_INTERNAL_STATE",
              message: "Matrix account bootstrap output is missing before room bootstrap",
              retryable: false,
            };
          }
          const previousRuntimeConfig = await this.tryReadRuntimeConfig();
          const sameHomeserver =
            previousRuntimeConfig !== null &&
            previousRuntimeConfig.matrix.homeserverDomain ===
              stepState.matrixProvision.homeserverDomain;
          const previousAlertRoom =
            sameHomeserver && previousRuntimeConfig.matrix.alertRoom.roomId.length > 0
              ? previousRuntimeConfig.matrix.alertRoom
              : undefined;
          const previousAvatarSha256 = sameHomeserver
            ? previousRuntimeConfig.matrix.alertRoom.avatarSha256
            : undefined;
          const avatarResolver = new FilesystemMatrixAvatarResolver(this.botCatalog);

          stepState.matrixRoom = await this.matrixProvisioner.bootstrapRoom(
            stepState.effectiveRequest ?? req,
            stepState.matrixProvision,
            stepState.matrixAccounts,
            {
              ...(previousAlertRoom === undefined ? {} : { previousAlertRoom }),
              avatarResolver,
              ...(previousAvatarSha256 === undefined ? {} : { previousAvatarSha256 }),
            },
          );
        },
      },
      {
        id: "openclaw_gateway_service_install",
        label: "Install OpenClaw gateway service",
        run: async () => {
          if (stepState.matrixRoom === undefined) {
            throw {
              code: "INSTALL_INTERNAL_STATE",
              message: "Matrix room bootstrap output is missing before gateway service install",
              retryable: false,
            };
          }

          if (this.shouldPreferSystemGatewayService()) {
            stepState.gatewayServiceSkipped = true;
            this.logger.info(
              {
                serviceUser: this.getConfiguredServiceIdentity().user,
              },
              "Skipping OpenClaw user-service gateway install in root install context; using system-level service flow",
            );
            return;
          }

          try {
            await this.openclawGatewayServiceManager.install({
              force: req.openclaw?.forceReinstall ?? false,
            });
            await this.openclawGatewayServiceManager.start();
          } catch (error) {
            if (!isGatewayUserSystemdUnavailableError(error)) {
              throw error;
            }
            stepState.gatewayServiceSkipped = true;
            this.logger.warn(
              {
                error: describeError(error),
              },
              "OpenClaw gateway service install/start skipped because systemd user services are unavailable",
            );
          }
        },
      },
      {
        id: "openclaw_configure",
        label: "Configure OpenClaw runtime",
        run: async () => {
          if (stepState.matrixProvision === undefined) {
            throw {
              code: "INSTALL_INTERNAL_STATE",
              message: "Matrix provisioning output is missing before OpenClaw configure",
              retryable: false,
            };
          }
          if (stepState.matrixAccounts === undefined) {
            throw {
              code: "INSTALL_INTERNAL_STATE",
              message: "Matrix account output is missing before OpenClaw configure",
              retryable: false,
            };
          }
          if (stepState.matrixRoom === undefined) {
            throw {
              code: "INSTALL_INTERNAL_STATE",
              message: "Matrix room output is missing before OpenClaw configure",
              retryable: false,
            };
          }

          let runtimeConfig = await this.writeSovereignConfig({
            req: stepState.effectiveRequest ?? req,
            matrixProvision: stepState.matrixProvision,
            matrixAccounts: stepState.matrixAccounts,
            matrixRoom: stepState.matrixRoom,
            ...(stepState.relayEnrollment === undefined
              ? {}
              : { relayEnrollment: stepState.relayEnrollment }),
          });
          await this.ensureManagedMatrixAccessTokens(runtimeConfig);
          if (stepState.selectedBots === undefined) {
            stepState.selectedBots = (
              await this.resolveRequestedBots(stepState.effectiveRequest ?? req)
            ).packages;
          }
          for (const agent of runtimeConfig.openclawProfile.agents) {
            await this.ensureManagedAgentWorkspace({
              id: agent.id,
              workspace: agent.workspace,
              runtimeConfig,
            });
            await this.resetManagedAgentSessions(runtimeConfig, agent.id);
          }
          let topologyChanged = false;
          for (const agent of runtimeConfig.openclawProfile.agents) {
            const priorMatrixIdentity = agent.matrix;
            try {
              const ensuredAgent = await this.ensureManagedAgentMatrixIdentity(
                runtimeConfig,
                agent.id,
              );
              runtimeConfig = ensuredAgent.runtimeConfig;
              topologyChanged = topologyChanged || ensuredAgent.changed;
            } catch (error) {
              this.logger.warn(
                {
                  agentId: agent.id,
                  error: describeError(error),
                },
                "Managed bot Matrix identity provisioning failed during install; continuing with degraded bot setup",
              );
              // ensureManagedAgentMatrixIdentity persists entry.matrix in
              // memory BEFORE the room-membership calls that can throw
              // (invite/join). When it does throw partway through, the
              // in-memory mutation survives but we still need to flag
              // topologyChanged so persistManagedAgentTopologyDocument
              // flushes the new agent identity to disk. Without this,
              // the next install would still see entry.matrix == null and
              // repeat the failure loop.
              const currentMatrixIdentity = runtimeConfig.openclawProfile.agents.find(
                (candidate) => candidate.id === agent.id,
              )?.matrix;
              if (!areMatrixIdentitiesEqual(priorMatrixIdentity, currentMatrixIdentity)) {
                topologyChanged = true;
              }
            }
          }
          if (topologyChanged) {
            await this.persistManagedAgentTopologyDocument(runtimeConfig);
          }
          await this.applyCompiledSystemdResources(runtimeConfig);
          await this.writeOpenClawRuntimeArtifacts(runtimeConfig);
          stepState.runtimeConfig = runtimeConfig;
          this.setManagedOpenClawEnv(runtimeConfig);
          if (await this.shouldEnsureLobsterCliForRuntime(runtimeConfig)) {
            if (this.execRunner === null) {
              this.logger.warn(
                "Exec runner unavailable; skipping Lobster CLI verification during OpenClaw configure",
              );
            } else {
              await this.ensureLobsterCliInstalled();
            }
          }
          if (runtimeConfig.relay?.enabled === true) {
            stepState.relayTunnelServiceInstalled =
              await this.ensureRelayTunnelService(runtimeConfig);
          }

          if (stepState.gatewayServiceSkipped === true) {
            const fallbackStarted = await this.ensureSystemGatewayServiceFallback(runtimeConfig);
            if (fallbackStarted) {
              stepState.gatewayServiceSkipped = false;
              return;
            }
            this.logger.warn(
              "OpenClaw gateway restart skipped because neither user-service nor system-service startup succeeded",
            );
            return;
          }

          try {
            await this.refreshGatewayAfterRuntimeConfig(runtimeConfig);
          } catch (error) {
            if (isGatewayUserSystemdUnavailableError(error)) {
              stepState.gatewayServiceSkipped = true;
              this.logger.warn(
                {
                  error: describeError(error),
                },
                "OpenClaw gateway restart skipped because systemd user services are unavailable",
              );
              return;
            }
            throw error;
          }
        },
      },
      {
        id: "bots_configure",
        label: "Register managed bots",
        run: async () => {
          if (stepState.runtimeConfig === undefined) {
            throw {
              code: "INSTALL_INTERNAL_STATE",
              message: "Runtime config is missing before managed bot registration",
              retryable: false,
            };
          }
          stepState.botRegistrations = await this.registerManagedBots(
            stepState.runtimeConfig,
            stepState.selectedBots ?? [],
            {
              allowGatewayUnavailableFallback: stepState.gatewayServiceSkipped === true,
            },
          );
        },
      },
      {
        id: "smoke_checks",
        label: "Run smoke checks",
        run: async () => {
          if (stepState.matrixProvision === undefined) {
            throw {
              code: "INSTALL_INTERNAL_STATE",
              message: "Matrix provisioning output is missing before smoke checks",
              retryable: false,
            };
          }
          await this.runSmokeChecks(
            stepState.matrixProvision,
            stepState.runtimeConfig ?? (await this.readRuntimeConfig()),
            stepState.gatewayServiceSkipped ?? false,
            stepState.relayEnrollment !== undefined,
          );
        },
      },
      {
        id: "test_alert",
        label: "Send hello alert",
        run: async () => {
          await this.sendInstalledBotHelloMessages();
        },
      },
    ];
  }

  private isRelayModeRequest(req: InstallRequest): boolean {
    return isRelayModeRequestFile(req);
  }

  private getRelayRequest(req: InstallRequest): NonNullable<InstallRequest["relay"]> {
    return getRelayRequestFile(req);
  }

  private isDefaultManagedRelayControlUrl(controlUrl: string): boolean {
    return isDefaultManagedRelayControlUrlFile(controlUrl);
  }

  private async tryReuseExistingRelayEnrollment(
    relay: NonNullable<InstallRequest["relay"]>,
  ): Promise<RelayEnrollmentResult | null> {
    const runtimeConfig = await this.tryReadRuntimeConfig();
    if (runtimeConfig?.relay?.enabled !== true) {
      return null;
    }
    if (runtimeConfig.relay.controlUrl !== relay.controlUrl) {
      return null;
    }

    try {
      const token = await this.resolveSecretRef(runtimeConfig.relay.tunnel.tokenSecretRef);
      return {
        controlUrl: runtimeConfig.relay.controlUrl,
        hostname: runtimeConfig.relay.hostname,
        publicBaseUrl: runtimeConfig.relay.publicBaseUrl,
        tunnel: {
          serverAddr: runtimeConfig.relay.tunnel.serverAddr,
          serverPort: runtimeConfig.relay.tunnel.serverPort,
          token,
          proxyName: runtimeConfig.relay.tunnel.proxyName,
          ...(runtimeConfig.relay.tunnel.subdomain === undefined
            ? {}
            : { subdomain: runtimeConfig.relay.tunnel.subdomain }),
          type: runtimeConfig.relay.tunnel.type,
          localIp: runtimeConfig.relay.tunnel.localIp,
          localPort: runtimeConfig.relay.tunnel.localPort,
        },
      };
    } catch (error) {
      this.logger.warn(
        {
          error: describeError(error),
        },
        "Existing relay runtime config was found but could not be reused",
      );
      return null;
    }
  }

  private tryUsePreEnrolledRelay(
    relay: NonNullable<InstallRequest["relay"]>,
  ): RelayEnrollmentResult | null {
    return tryUsePreEnrolledRelayFile({ relay, localEdgePort: RELAY_LOCAL_EDGE_PORT });
  }

  private async resolveRelayEnrollment(
    req: InstallRequest,
    installationId: string,
  ): Promise<RelayEnrollmentResult> {
    const relay = this.getRelayRequest(req);

    const preEnrolled = this.tryUsePreEnrolledRelay(relay);
    if (preEnrolled !== null) {
      this.logger.info(
        { hostname: preEnrolled.hostname, publicBaseUrl: preEnrolled.publicBaseUrl },
        "Using pre-enrolled relay configuration from request file",
      );
      return preEnrolled;
    }

    const reused = await this.tryReuseExistingRelayEnrollment(relay);
    if (reused !== null) {
      this.logger.info(
        {
          hostname: reused.hostname,
          publicBaseUrl: reused.publicBaseUrl,
        },
        "Reusing existing managed relay assignment",
      );
      return reused;
    }

    const enrollmentToken = relay.enrollmentToken?.trim();
    const usesManagedPublicEnroll =
      this.isDefaultManagedRelayControlUrl(relay.controlUrl) &&
      (enrollmentToken === undefined || enrollmentToken.length === 0);
    if (
      !usesManagedPublicEnroll &&
      (enrollmentToken === undefined || enrollmentToken.length === 0)
    ) {
      throw {
        code: "RELAY_CONFIG_MISSING",
        message: "Custom relay mode requires relay.enrollmentToken",
        retryable: false,
        details: {
          controlUrl: relay.controlUrl,
        },
      };
    }

    const endpoint = new URL(
      usesManagedPublicEnroll ? "/api/v1/enroll-public" : "/api/v1/enroll",
      ensureTrailingSlash(relay.controlUrl),
    ).toString();
    // On authenticated enrollment (caller presents an enrollmentToken) we
    // honour relay.requestedSlug when supplied, so operators running their
    // own relay or re-enrolling with a known token can pick a stable,
    // human-readable hostname. On public enrollment (no token, shared
    // control plane) we always generate to prevent slug squatting. If the
    // caller's slug is already taken we fall back to generated names on
    // subsequent attempts.
    const callerSlug = relay.requestedSlug?.trim();
    const callerSlugEligible =
      !usesManagedPublicEnroll && typeof callerSlug === "string" && callerSlug.length > 0;
    let lastFailure: { status?: number; responseText?: string; error?: unknown } | null = null;
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const requestedSlug =
        attempt === 1 && callerSlugEligible
          ? (callerSlug as string)
          : this.generateManagedRelayRequestedSlug();
      let response: Response;
      try {
        response = await this.fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            ...(usesManagedPublicEnroll ? { installationId } : { enrollmentToken }),
            requestedSlug,
            version: process.env.npm_package_version ?? "2.0.0",
          }),
        });
      } catch (error) {
        lastFailure = {
          error,
        };
        continue;
      }

      const responseText = await response.text();
      if (!response.ok) {
        lastFailure = {
          status: response.status,
          responseText,
        };
        const responseTextLower = responseText.toLowerCase();
        const slugConflict =
          response.status === 409 ||
          ((response.status === 400 || response.status === 422) &&
            responseTextLower.includes("slug") &&
            (responseTextLower.includes("taken") ||
              responseTextLower.includes("already") ||
              responseTextLower.includes("exists")));
        if (slugConflict && attempt < 6) {
          this.logger.warn(
            {
              requestedSlug,
              controlUrl: relay.controlUrl,
              status: response.status,
            },
            "Managed relay slug collision detected; retrying with a new generated node name",
          );
          continue;
        }
        throw {
          code: "RELAY_ENROLL_FAILED",
          message: "Managed relay enrollment was rejected",
          retryable: response.status >= 500,
          details: {
            controlUrl: relay.controlUrl,
            status: response.status,
            requestedSlug,
            body: summarizeText(responseText, 1200),
          },
        };
      }

      const enrollment = parseManagedRelayEnrollmentResponse({
        responseText,
        controlUrl: relay.controlUrl,
        requestedSlug,
        localEdgePort: RELAY_LOCAL_EDGE_PORT,
      });

      this.logger.info(
        {
          hostname: enrollment.hostname,
          publicBaseUrl: enrollment.publicBaseUrl,
          controlUrl: relay.controlUrl,
          requestedSlug,
        },
        "Managed relay enrollment succeeded",
      );

      return enrollment;
    }

    throw {
      code: "RELAY_ENROLL_FAILED",
      message: "Managed relay enrollment request failed",
      retryable: true,
      details: {
        controlUrl: relay.controlUrl,
        ...(lastFailure?.status === undefined ? {} : { status: lastFailure.status }),
        ...(lastFailure?.responseText === undefined
          ? {}
          : { body: summarizeText(lastFailure.responseText, 1200) }),
        ...(lastFailure?.error === undefined ? {} : { error: describeError(lastFailure.error) }),
      },
    };
  }

  private generateManagedRelayRequestedSlug(): string {
    return generateManagedRelayRequestedSlugFile();
  }

  private buildRelayProvisionRequest(
    req: InstallRequest,
    enrollment: RelayEnrollmentResult,
    previousRuntimeConfig?: RuntimeConfig | null,
  ): InstallRequest {
    return buildRelayProvisionRequestFile({
      req,
      hostname: enrollment.hostname,
      publicBaseUrl: enrollment.publicBaseUrl,
      previousRuntimeConfig,
    });
  }

  private getRelayTunnelConfigPath(): string {
    return join(this.paths.stateDir, "relay", "frpc.toml");
  }

  private async ensureRelayTunnelService(runtimeConfig: RuntimeConfig): Promise<boolean> {
    if (runtimeConfig.relay?.enabled !== true) {
      return false;
    }

    const relay = runtimeConfig.relay;
    const configPath = relay.configPath;
    const unitPath = join("/etc/systemd/system", relay.serviceName);
    const containerName = relay.serviceName.replace(/\.service$/, "");
    let token: string;

    try {
      token = await this.resolveSecretRef(relay.tunnel.tokenSecretRef);
      await mkdir(dirname(configPath), { recursive: true });
      await this.applyRuntimeOwnership(dirname(configPath));
      const configText = [
        `serverAddr = "${relay.tunnel.serverAddr}"`,
        `serverPort = ${relay.tunnel.serverPort}`,
        "",
        "[auth]",
        'method = "token"',
        `token = "${token}"`,
        "",
        "[[proxies]]",
        `name = "${relay.tunnel.proxyName}"`,
        `type = "${relay.tunnel.type}"`,
        `localIP = "${relay.tunnel.localIp}"`,
        `localPort = ${relay.tunnel.localPort}`,
        `customDomains = ["${relay.hostname}"]`,
        ...(relay.tunnel.subdomain === undefined
          ? []
          : [`subdomain = "${relay.tunnel.subdomain}"`]),
      ].join("\n");
      await writeFile(configPath, `${configText}\n`, "utf8");
      await chmod(configPath, 0o600);
      await this.applyRuntimeOwnership(configPath);
    } catch (error) {
      this.logger.warn(
        {
          configPath,
          error: describeError(error),
        },
        "Failed to write managed relay tunnel config",
      );
      return false;
    }

    const unitContents = [
      "[Unit]",
      "Description=Sovereign Matrix Relay Tunnel",
      "After=network-online.target docker.service",
      "Wants=network-online.target",
      "Requires=docker.service",
      "",
      "[Service]",
      "Type=simple",
      `ExecStartPre=-/usr/bin/docker rm -f ${containerName}`,
      `ExecStart=/usr/bin/docker run --rm --name ${containerName} --network host -v ${configPath}:/etc/frp/frpc.toml:ro ${RELAY_TUNNEL_DEFAULT_IMAGE} -c /etc/frp/frpc.toml`,
      `ExecStop=/usr/bin/docker stop ${containerName}`,
      "Restart=always",
      "RestartSec=3",
      "",
      "[Install]",
      "WantedBy=multi-user.target",
      "",
    ].join("\n");

    try {
      await mkdir(dirname(unitPath), { recursive: true });
      await writeFile(unitPath, unitContents, "utf8");
    } catch (error) {
      this.logger.warn(
        {
          unitPath,
          error: describeError(error),
        },
        "Failed to write managed relay tunnel systemd unit",
      );
      return false;
    }

    const commands: string[][] = [
      ["daemon-reload"],
      ["enable", "--now", relay.serviceName],
      ["restart", relay.serviceName],
      ["is-active", relay.serviceName],
    ];
    for (const args of commands) {
      const result = await this.safeExec("systemctl", args);
      if (!result.ok) {
        this.logger.warn(
          {
            command: ["systemctl", ...args].join(" "),
            error: result.error,
          },
          "Managed relay tunnel systemd command failed",
        );
        return false;
      }
      if (result.result.exitCode !== 0) {
        this.logger.warn(
          {
            command: result.result.command,
            exitCode: result.result.exitCode,
            stderr: truncateText(result.result.stderr, 1200),
            stdout: truncateText(result.result.stdout, 1200),
          },
          "Managed relay tunnel systemd command exited non-zero",
        );
        return false;
      }
    }

    this.logger.info(
      {
        unitName: relay.serviceName,
        hostname: relay.hostname,
        publicBaseUrl: relay.publicBaseUrl,
      },
      "Managed relay tunnel service started successfully",
    );
    return true;
  }

  private async persistJobSnapshot(input: {
    installationId: string;
    request: InstallRequest;
    snapshot: JobRunnerSnapshot;
  }): Promise<void> {
    const response: InstallJobStatusResponse = {
      job: input.snapshot.job,
      ...(input.snapshot.error === undefined ? {} : { error: input.snapshot.error }),
    };

    const record: PersistedInstallJobRecord = {
      version: 1,
      installationId: input.installationId,
      request: installRequestSchema.parse(input.request),
      response: installJobStatusResponseSchema.parse(response),
      updatedAt: now(),
    };

    await this.writeJobRecord(record);
  }

  private async writeJobRecord(record: PersistedInstallJobRecord): Promise<void> {
    const filePath = await this.getJobFilePath(record.response.job.jobId);
    const tempPath = `${filePath}.${randomUUID()}.tmp`;
    const payload = `${JSON.stringify(record, null, 2)}\n`;
    await writeFile(tempPath, payload, "utf8");
    await rename(tempPath, filePath);
  }

  private async readJobRecord(jobId: string): Promise<PersistedInstallJobRecord | null> {
    const filePath = await this.getJobFilePath(jobId);
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedInstallJobRecord>;
      if (parsed.response === undefined || parsed.request === undefined) {
        throw new Error(`Install job record is missing required fields: ${jobId}`);
      }

      return {
        version: 1,
        installationId:
          typeof parsed.installationId === "string"
            ? parsed.installationId
            : `inst_unknown_${jobId}`,
        request: installRequestSchema.parse(parsed.request),
        response: installJobStatusResponseSchema.parse(parsed.response),
        updatedAt:
          typeof parsed.updatedAt === "string" && parsed.updatedAt.length > 0
            ? parsed.updatedAt
            : now(),
      };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private async getJobFilePath(jobId: string): Promise<string> {
    const dir = await this.ensureInstallJobsDir();
    return join(dir, `${jobId}.json`);
  }

  private async ensureInstallJobsDir(): Promise<string> {
    if (this.resolvedInstallJobsDir !== null) {
      return this.resolvedInstallJobsDir;
    }

    const override = process.env.SOVEREIGN_NODE_INSTALL_JOBS_DIR;
    if (override !== undefined && override.length > 0) {
      await mkdir(override, { recursive: true });
      await access(override, fsConstants.W_OK);
      this.resolvedInstallJobsDir = override;
      return override;
    }

    try {
      await mkdir(this.paths.installJobsDir, { recursive: true });
      await access(this.paths.installJobsDir, fsConstants.W_OK);
      this.resolvedInstallJobsDir = this.paths.installJobsDir;
      return this.resolvedInstallJobsDir;
    } catch (error) {
      const fallback = resolve(process.cwd(), ".sovereign-node-dev", "install-jobs");
      await mkdir(fallback, { recursive: true });
      this.logger.debug(
        {
          preferredInstallJobsDir: this.paths.installJobsDir,
          fallbackInstallJobsDir: fallback,
          error: error instanceof Error ? error.message : String(error),
        },
        "Install jobs dir is not writable; using local fallback for scaffold/dev execution",
      );
      this.resolvedInstallJobsDir = fallback;
      return fallback;
    }
  }

  private async registerManagedBots(
    runtimeConfig: RuntimeConfig,
    botPackages: LoadedBotPackage[],
    options?: {
      allowGatewayUnavailableFallback?: boolean;
    },
  ): Promise<ManagedAgentRegistrationResult[]> {
    const registrations: ManagedAgentRegistrationResult[] = [];
    let deferred = false;

    for (const botPackage of botPackages) {
      const agent = runtimeConfig.openclawProfile.agents.find(
        (entry) => entry.botId === botPackage.manifest.id || entry.id === botPackage.manifest.id,
      );
      if (agent === undefined) {
        continue;
      }
      const cronEntry = runtimeConfig.openclawProfile.crons.find(
        (entry) => entry.botId === botPackage.manifest.id || entry.agentId === agent.id,
      );
      const compiledCron = (runtimeConfig.hostResources?.resources ?? []).find(
        (entry) =>
          entry.kind === "openclawCron" &&
          entry.desiredState === "present" &&
          entry.botId === botPackage.manifest.id &&
          entry.spec?.agentId === agent.id,
      );
      const staleCronMatchers = (runtimeConfig.hostResources?.resources ?? []).flatMap((entry) =>
        entry.kind === "openclawCron" &&
        entry.desiredState === "absent" &&
        entry.botId === botPackage.manifest.id &&
        entry.agentId === agent.id
          ? [entry.match]
          : [],
      );
      try {
        const registration = await this.withManagedOpenClawServiceIdentityEnv(
          runtimeConfig,
          async () =>
            await this.managedAgentRegistrar.register({
              agentId: agent.id,
              workspaceDir: agent.workspace,
              ...(staleCronMatchers.length === 0 ? {} : { removeCronMatchers: staleCronMatchers }),
              ...(cronEntry === undefined ||
              compiledCron?.kind !== "openclawCron" ||
              compiledCron.spec === undefined
                ? {}
                : {
                    cron: {
                      id: cronEntry.id,
                      every: cronEntry.every,
                      message: compiledCron.spec.message,
                      ...(compiledCron.spec.announceRoomId === undefined
                        ? {}
                        : { announceRoomId: compiledCron.spec.announceRoomId }),
                      ...(compiledCron.spec.session === undefined
                        ? {}
                        : { session: compiledCron.spec.session }),
                    },
                  }),
            }),
        );
        registrations.push(registration);
      } catch (error) {
        if (
          options?.allowGatewayUnavailableFallback !== true ||
          !isMailSentinelGatewayUnavailableError(error)
        ) {
          throw error;
        }
        deferred = true;
        this.logger.warn(
          {
            botId: botPackage.manifest.id,
            error: describeError(error),
          },
          "Managed bot registration deferred because OpenClaw gateway is unavailable",
        );
        registrations.push({
          agentId: agent.id,
          workspaceDir: agent.workspace,
          agentCommand: "deferred: gateway unavailable",
          ...(cronEntry === undefined
            ? {}
            : {
                cronJobId: cronEntry.id,
                cronCommand: "deferred: gateway unavailable",
              }),
        });
      }
    }

    await this.persistManagedBotRegistrationRecords(registrations);

    if (!deferred) {
      try {
        await this.ensureManagedAgentOpenClawBindings(runtimeConfig);
      } catch (error) {
        if (!isCoreAgentBindingBestEffortSkippable(error)) {
          throw error;
        }
        this.logger.warn(
          {
            error: describeError(error),
          },
          "Managed bot Matrix binding commands are unavailable in this OpenClaw runtime; continuing without explicit per-agent bindings",
        );
      }
    }

    return registrations;
  }

  private async persistManagedBotRegistrationRecords(
    registrations: ManagedAgentRegistrationResult[],
  ): Promise<void> {
    for (const registration of registrations) {
      await this.writeInstallerJsonFile(
        join(this.paths.stateDir, registration.agentId, "registration.json"),
        {
          agentId: registration.agentId,
          ...(registration.cronJobId === undefined ? {} : { cronJobId: registration.cronJobId }),
          deferred:
            registration.agentCommand.startsWith("deferred:") ||
            registration.cronCommand?.startsWith("deferred:") === true,
        },
        0o600,
      );
    }
  }

  private async ensureManagedAgentOpenClawBindings(runtimeConfig: RuntimeConfig): Promise<void> {
    if (this.execRunner === null) {
      this.logger.warn(
        "Exec runner unavailable; skipping explicit OpenClaw per-agent matrix account/binding setup",
      );
      return;
    }
    const matrixPluginEnable = await this.safeExec("openclaw", ["plugins", "enable", "matrix"]);
    if (!matrixPluginEnable.ok) {
      throw {
        code: "MANAGED_AGENT_REGISTER_FAILED",
        message: "OpenClaw matrix plugin could not be enabled",
        retryable: true,
        details: {
          error: matrixPluginEnable.error,
        },
      };
    }
    if (matrixPluginEnable.result.exitCode !== 0) {
      throw {
        code: "MANAGED_AGENT_REGISTER_FAILED",
        message: "OpenClaw matrix plugin enable command exited with non-zero status",
        retryable: true,
        details: {
          command: matrixPluginEnable.result.command,
          exitCode: matrixPluginEnable.result.exitCode,
          stderr: truncateText(matrixPluginEnable.result.stderr, 1200),
          stdout: truncateText(matrixPluginEnable.result.stdout, 1200),
        },
      };
    }

    for (const agent of runtimeConfig.openclawProfile.agents) {
      if (agent.matrix === undefined || agent.matrix.accessTokenSecretRef === undefined) {
        this.logger.warn(
          {
            agentId: agent.id,
          },
          "Managed agent has no Matrix identity yet; skipping OpenClaw matrix account binding",
        );
        continue;
      }
      const botPackage = await this.findBotPackageByTemplateRef(agent.templateRef);
      const usesSharedServiceIdentity =
        agent.matrix.userId === runtimeConfig.matrix.bot.userId &&
        botPackage?.manifest.matrixIdentity.mode === "service-account";
      const usesPrimaryDedicatedIdentity =
        !usesSharedServiceIdentity && agent.matrix.userId === runtimeConfig.matrix.bot.userId;
      await this.runOpenClawCommandAlternatives({
        label: `${agent.id}-agent`,
        commands: [
          ["agents", "add", agent.id, "--workspace", agent.workspace],
          ["agents", "create", agent.id, "--workspace", agent.workspace],
          ["agents", "upsert", agent.id, "--workspace", agent.workspace],
          ["agents", "upsert", "--id", agent.id, "--workspace", agent.workspace],
          ["agents", "add", "--id", agent.id, "--workspace", agent.workspace],
          ["agents", "create", "--id", agent.id, "--workspace", agent.workspace],
        ],
        allowAlreadyExists: true,
      });
      await this.runOpenClawCommandAlternatives({
        label: `${agent.id}-matrix-bind`,
        commands: usesSharedServiceIdentity
          ? [["agents", "bind", "--agent", agent.id, "--bind", "matrix"]]
          : [
              ["agents", "bind", "--agent", agent.id, "--bind", `matrix:${agent.id}`],
              ["agents", "bind", "--agent", agent.id, "--bind", "matrix"],
            ],
        allowAlreadyExists: true,
      });
      if (usesPrimaryDedicatedIdentity) {
        await this.runOpenClawCommandAlternatives({
          label: `${agent.id}-matrix-default-bind`,
          commands: [["agents", "bind", "--agent", agent.id, "--bind", "matrix"]],
          allowAlreadyExists: true,
        });
      }
      for (const pattern of await this.listAgentExecAllowlistPatterns(
        runtimeConfig,
        agent.toolInstanceIds ?? [],
      )) {
        await this.runOpenClawCommandAlternatives({
          label: `${agent.id}-exec-allowlist`,
          commands: [["approvals", "allowlist", "add", "--agent", agent.id, pattern]],
          allowAlreadyExists: true,
        });
      }
    }
  }

  private async runOpenClawCommandAlternatives(input: {
    label: string;
    commands: string[][];
    allowAlreadyExists?: boolean;
  }): Promise<void> {
    const failures: {
      command: string;
      exitCode: number;
      stderr: string;
      stdout: string;
    }[] = [];
    for (const args of input.commands) {
      const result = await this.safeExec("openclaw", args);
      if (!result.ok) {
        failures.push({
          command: `openclaw ${args.join(" ")}`,
          exitCode: -1,
          stderr: truncateText(result.error, 1200),
          stdout: "",
        });
        continue;
      }
      if (result.result.exitCode === 0) {
        return;
      }
      const output = `${result.result.stderr}\n${result.result.stdout}`;
      if (input.allowAlreadyExists === true && isAlreadyExistsOutput(output)) {
        return;
      }
      failures.push({
        command: result.result.command,
        exitCode: result.result.exitCode,
        stderr: truncateText(result.result.stderr, 1200),
        stdout: truncateText(result.result.stdout, 1200),
      });
    }
    throw {
      code: "MANAGED_AGENT_REGISTER_FAILED",
      message: `OpenClaw ${input.label} registration commands failed`,
      retryable: true,
      details: {
        failures,
      },
    };
  }

  private async sendInstalledBotHelloMessages(): Promise<void> {
    const runtimeConfig = await this.readRuntimeConfig();
    let candidateCount = 0;
    let deliveredCount = 0;
    for (const agent of runtimeConfig.openclawProfile.agents) {
      const botPackage = await this.findBotPackageByTemplateRef(agent.templateRef);
      if (botPackage?.manifest.helloMessage === undefined) {
        continue;
      }
      candidateCount += 1;
      if (agent.matrix?.accessTokenSecretRef === undefined) {
        this.logger.warn(
          {
            agentId: agent.id,
          },
          "Managed bot has no Matrix access token; skipping hello message",
        );
        continue;
      }
      const accessToken = await this.resolveSecretRef(agent.matrix.accessTokenSecretRef);
      await this.sendMatrixRoomMessage({
        adminBaseUrl: runtimeConfig.matrix.adminBaseUrl,
        roomId: runtimeConfig.matrix.alertRoom.roomId,
        accessToken,
        text: botPackage.manifest.helloMessage,
      });
      deliveredCount += 1;
    }
    if (candidateCount > 0 && deliveredCount === 0) {
      throw {
        code: "TEST_ALERT_FAILED",
        message: "No managed bot hello messages could be delivered",
        retryable: true,
      };
    }
  }

  private async sendMatrixRoomMessage(input: {
    adminBaseUrl: string;
    roomId: string;
    accessToken: string;
    text: string;
  }): Promise<void> {
    const txnId = randomUUID();
    const endpoint = new URL(
      `/_matrix/client/v3/rooms/${encodeURIComponent(input.roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`,
      ensureTrailingSlash(input.adminBaseUrl),
    ).toString();
    const response = await this.fetchImpl(endpoint, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        msgtype: "m.text",
        body: input.text,
      }),
    });
    const bodyText = await response.text();
    if (!response.ok) {
      throw {
        code: "TEST_ALERT_FAILED",
        message: "Matrix hello message delivery failed",
        retryable: true,
        details: {
          endpoint,
          status: response.status,
          body: summarizeText(bodyText, 1200),
        },
      };
    }
  }

  private async ensureSystemGatewayServiceFallback(runtimeConfig: RuntimeConfig): Promise<boolean> {
    if (this.execRunner === null) {
      return false;
    }

    const serviceIdentity = this.getConfiguredServiceIdentity(runtimeConfig);
    const managedTempDir = this.getManagedOpenClawTempDir(runtimeConfig);
    const openclawCommand = (await resolveExecutablePath("openclaw")) ?? "openclaw";
    const unitName = SOVEREIGN_GATEWAY_SYSTEMD_UNIT;
    const waitsForLocalMatrix = shouldGateSystemGatewayOnLocalMatrix(
      runtimeConfig.matrix.adminBaseUrl,
    );
    const unitPath =
      process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH?.trim() ||
      `/etc/systemd/system/${unitName}`;
    const unitContents = [
      "[Unit]",
      "Description=Sovereign OpenClaw Gateway",
      waitsForLocalMatrix
        ? "After=network-online.target docker.service"
        : "After=network-online.target",
      "Wants=network-online.target",
      ...(waitsForLocalMatrix ? ["Requires=docker.service"] : []),
      "",
      "[Service]",
      "Type=simple",
      `User=${serviceIdentity.user}`,
      `Group=${serviceIdentity.group}`,
      `WorkingDirectory=${this.paths.openclawServiceHome}`,
      `Environment=HOME=${this.paths.openclawServiceHome}`,
      `Environment=PATH=${process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}`,
      `Environment=TMPDIR=${managedTempDir}`,
      `Environment=TMP=${managedTempDir}`,
      `Environment=TEMP=${managedTempDir}`,
      `EnvironmentFile=-${runtimeConfig.openclaw.gatewayEnvPath}`,
      ...(waitsForLocalMatrix
        ? [
            `ExecStartPre=${renderSystemGatewayMatrixWaitCommand({
              adminBaseUrl: runtimeConfig.matrix.adminBaseUrl,
              attempts: SYSTEM_GATEWAY_MATRIX_WAIT_ATTEMPTS,
              delaySeconds: SYSTEM_GATEWAY_MATRIX_WAIT_DELAY_SECONDS,
              timeoutSeconds: SYSTEM_GATEWAY_MATRIX_WAIT_TIMEOUT_SECONDS,
            })}`,
          ]
        : []),
      `ExecStart=${openclawCommand} gateway run --allow-unconfigured --bind loopback`,
      "Restart=always",
      "RestartSec=3",
      "",
      "[Install]",
      "WantedBy=multi-user.target",
      "",
    ].join("\n");

    try {
      await mkdir(this.paths.openclawServiceHome, { recursive: true });
      await mkdir(managedTempDir, { recursive: true });
      await this.cleanStaleTempEntries(managedTempDir);
      await chmod(managedTempDir, 0o700);
      await this.applyConfiguredRuntimeOwnership(this.paths.openclawServiceHome, runtimeConfig);
      await this.applyConfiguredRuntimeOwnership(managedTempDir, runtimeConfig);
      await mkdir(dirname(unitPath), { recursive: true });
      await writeFile(unitPath, unitContents, "utf8");
    } catch (error) {
      this.logger.warn(
        {
          unitPath,
          error: describeError(error),
        },
        "Failed to write system-level OpenClaw gateway unit",
      );
      return false;
    }

    const commands: string[][] = [
      ["daemon-reload"],
      ["enable", "--now", unitName],
      ["restart", unitName],
      ["is-active", unitName],
    ];
    for (const args of commands) {
      const result = await this.safeExec("systemctl", args);
      if (!result.ok) {
        this.logger.warn(
          {
            command: ["systemctl", ...args].join(" "),
            error: result.error,
          },
          "System-level OpenClaw gateway command failed",
        );
        return false;
      }
      if (result.result.exitCode !== 0) {
        const output = `${result.result.stdout}\n${result.result.stderr}`;
        const systemctlStillStarting = args[0] === "is-active" && /\bactivating\b/i.test(output);
        if (systemctlStillStarting) {
          continue;
        }
        this.logger.warn(
          {
            command: result.result.command,
            exitCode: result.result.exitCode,
            stderr: truncateText(result.result.stderr, 1200),
            stdout: truncateText(result.result.stdout, 1200),
          },
          "System-level OpenClaw gateway command exited non-zero",
        );
        return false;
      }
    }

    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const health = await this.probeOpenClawHealth();
      if (health.ok) {
        this.logger.info(
          {
            unitName,
            unitPath,
            health: health.message,
          },
          "System-level OpenClaw gateway service started successfully",
        );
        return true;
      }
      if (attempt < 20) {
        await delay(1000);
      } else {
        this.logger.warn(
          {
            unitName,
            health: health.message,
          },
          "System-level OpenClaw gateway service did not become healthy in time",
        );
      }
    }

    return false;
  }

  private async runSmokeChecks(
    matrixProvision: BundledMatrixProvisionResult,
    runtimeConfig: RuntimeConfig,
    gatewayServiceSkipped: boolean,
    relayModeEnabled: boolean,
  ): Promise<void> {
    const matrix = await this.testMatrix({
      publicBaseUrl: matrixProvision.adminBaseUrl,
      federationEnabled: matrixProvision.federationEnabled,
    });
    if (!matrix.ok) {
      throw {
        code: "SMOKE_CHECKS_FAILED",
        message: "Matrix smoke check failed",
        retryable: true,
        details: {
          checks: matrix.checks,
        },
      };
    }

    const openclaw = await this.safeDetectOpenClaw();
    if (openclaw === null) {
      throw {
        code: "SMOKE_CHECKS_FAILED",
        message: "OpenClaw CLI is not detectable during smoke checks",
        retryable: true,
      };
    }

    if (!(await this.probeMatrixRoomReachable(runtimeConfig))) {
      throw {
        code: "SMOKE_CHECKS_FAILED",
        message: "Matrix alert room is not reachable with the configured bot token",
        retryable: true,
        details: {
          roomId: runtimeConfig.matrix.alertRoom.roomId,
        },
      };
    }

    if (relayModeEnabled) {
      const relay = await this.inspectRelayTunnelService();
      if (!relay.installed || relay.state !== "running") {
        throw {
          code: "SMOKE_CHECKS_FAILED",
          message: "Managed relay tunnel service is not running during smoke checks",
          retryable: true,
          details: {
            state: relay.state,
            message: relay.message,
          },
        };
      }
    }

    const wiringCheck = await this.inspectOpenClawRuntimeWiring(runtimeConfig);
    if (wiringCheck.status === "fail") {
      throw {
        code: "SMOKE_CHECKS_FAILED",
        message: "OpenClaw runtime wiring check failed",
        retryable: true,
        details: wiringCheck.details,
      };
    }

    if (this.execRunner !== null && !gatewayServiceSkipped) {
      const gateway = await this.inspectGatewayService();
      if (!gateway.installed || gateway.state !== "running") {
        throw {
          code: "SMOKE_CHECKS_FAILED",
          message: "OpenClaw gateway service is not running during smoke checks",
          retryable: true,
          details: {
            state: gateway.state,
            message: gateway.message,
          },
        };
      }

      const health = await this.probeOpenClawHealth();
      if (!health.ok) {
        if (gateway.state === "running") {
          this.logger.warn(
            { health: health.message },
            "OpenClaw health probe failed during smoke checks but gateway service is running; continuing",
          );
        } else {
          throw {
            code: "SMOKE_CHECKS_FAILED",
            message: "OpenClaw health probe failed during smoke checks",
            retryable: true,
            details: {
              health: health.message,
            },
          };
        }
      }

      const requiredAgentIds = dedupeStrings(
        ensureCoreManagedAgents(runtimeConfig.openclawProfile.agents).map((entry) => entry.id),
      );
      const missingAgentIds: string[] = [];
      let verifiedAgentProbe = false;
      for (const agentId of requiredAgentIds) {
        const agentProbe = await this.waitForOpenClawListContains(["agents", "list"], agentId);
        verifiedAgentProbe = verifiedAgentProbe || agentProbe.verified;
        if (agentProbe.verified && !agentProbe.present) {
          missingAgentIds.push(agentId);
        }
      }
      if (verifiedAgentProbe && missingAgentIds.length > 0) {
        const runtimeJson = await this.readManagedOpenClawRuntimeJson(runtimeConfig);
        const unresolvedAgentIds = missingAgentIds.filter(
          (agentId) => !this.managedOpenClawRuntimeHasAgent(runtimeJson, agentId),
        );
        if (unresolvedAgentIds.length === 0) {
          this.logger.warn(
            {
              missingAgentIds,
            },
            "OpenClaw CLI agent listing did not reflect all managed agents yet, but the managed runtime config already contains them; continuing",
          );
        } else {
          throw {
            code: "SMOKE_CHECKS_FAILED",
            message: "One or more managed agents are missing from OpenClaw runtime",
            retryable: true,
            details: {
              missingAgentIds: unresolvedAgentIds,
            },
          };
        }
      }

      const expectedCronIds = dedupeStrings(
        runtimeConfig.openclawProfile.crons.map((entry) => entry.id),
      );
      const missingCronJobIds: string[] = [];
      let verifiedCronProbe = false;
      for (const cronJobId of expectedCronIds) {
        const cronProbe = await this.waitForOpenClawListContains(["cron", "list"], cronJobId);
        verifiedCronProbe = verifiedCronProbe || cronProbe.verified;
        if (cronProbe.verified && !cronProbe.present) {
          missingCronJobIds.push(cronJobId);
        }
      }
      if (verifiedCronProbe && missingCronJobIds.length > 0) {
        const runtimeJson = await this.readManagedOpenClawRuntimeJson(runtimeConfig);
        const configuredCronIds = new Set(
          runtimeConfig.openclawProfile.crons.map((entry) => entry.id),
        );
        const unresolvedCronJobIds = missingCronJobIds.filter(
          (cronId) =>
            !this.managedOpenClawRuntimeHasCron(runtimeJson, cronId) &&
            !configuredCronIds.has(cronId),
        );
        if (unresolvedCronJobIds.length === 0) {
          this.logger.warn(
            {
              missingCronJobIds,
            },
            "OpenClaw CLI cron listing did not reflect all managed cron jobs yet, but the managed runtime config already contains them; continuing",
          );
        } else {
          throw {
            code: "SMOKE_CHECKS_FAILED",
            message: "One or more managed cron jobs are missing from OpenClaw runtime",
            retryable: true,
            details: {
              missingCronJobIds: unresolvedCronJobIds,
            },
          };
        }
      }
    }
  }

  private async readRuntimeConfig(): Promise<RuntimeConfig> {
    let raw = "";
    try {
      raw = await readFile(this.paths.configPath, "utf8");
    } catch (error) {
      throw {
        code: "CONFIG_NOT_FOUND",
        message: "Sovereign runtime config does not exist yet",
        retryable: false,
        details: {
          configPath: this.paths.configPath,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }

    const parsed = parseRuntimeConfigDocument(raw);
    if (parsed === null) {
      throw {
        code: "CONFIG_INVALID",
        message: "Sovereign runtime config does not match expected shape",
        retryable: false,
        details: {
          configPath: this.paths.configPath,
        },
      };
    }

    return parsed;
  }

  private getMatrixOnboardingStatePath(runtimeConfig: RuntimeConfig): string {
    const configured = runtimeConfig.matrix.onboardingStatePath?.trim();
    if (configured !== undefined && configured.length > 0) {
      return configured;
    }
    const projectDir = runtimeConfig.matrix.projectDir?.trim();
    if (projectDir !== undefined && projectDir.length > 0) {
      return join(projectDir, "onboarding", "state.json");
    }
    throw {
      code: "MATRIX_ONBOARDING_UNAVAILABLE",
      message: "Matrix onboarding is unavailable for this installation",
      retryable: false,
      details: {
        reason: "missing_project_dir",
      },
    };
  }

  private assertMatrixOnboardingAvailable(runtimeConfig: RuntimeConfig): string {
    if (
      runtimeConfig.matrix.accessMode !== "relay" &&
      !runtimeConfig.matrix.publicBaseUrl.startsWith("https://")
    ) {
      throw {
        code: "MATRIX_ONBOARDING_UNAVAILABLE",
        message:
          "Matrix onboarding is unavailable because this installation does not expose the HTTPS onboarding page",
        retryable: false,
        details: {
          publicBaseUrl: runtimeConfig.matrix.publicBaseUrl,
          accessMode: runtimeConfig.matrix.accessMode,
        },
      };
    }
    return buildMatrixOnboardingUrl(runtimeConfig.matrix.publicBaseUrl);
  }

  private async writeMatrixOnboardingState(
    runtimeConfig: RuntimeConfig,
    state: unknown,
  ): Promise<void> {
    await this.writeInstallerJsonFile(
      this.getMatrixOnboardingStatePath(runtimeConfig),
      state,
      0o600,
    );
  }

  private getInstallRequestPath(): string {
    const configured = process.env.SOVEREIGN_NODE_REQUEST_FILE?.trim();
    if (configured !== undefined && configured.length > 0) {
      return configured;
    }
    const configDir = dirname(this.paths.configPath);
    if (configDir.length > 0 && configDir !== ".") {
      return join(configDir, "install-request.json");
    }
    return DEFAULT_INSTALL_REQUEST_FILE;
  }

  private async tryReadSavedInstallRequest(): Promise<{
    requestFile: string;
    request: InstallRequest;
  } | null> {
    const requestFile = this.getInstallRequestPath();
    let raw = "";
    try {
      raw = await readFile(requestFile, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw {
        code: "REQUEST_READ_FAILED",
        message: "Failed to read the saved install request file",
        retryable: false,
        details: {
          requestFile,
          error: describeError(error),
        },
      };
    }

    const parsed = parseJsonDocument(raw);
    const validated = installRequestSchema.safeParse(parsed);
    if (!validated.success) {
      throw {
        code: "REQUEST_INVALID",
        message: "Saved install request file is invalid",
        retryable: false,
        details: {
          requestFile,
        },
      };
    }
    return {
      requestFile,
      request: validated.data,
    };
  }

  private async readSavedInstallRequestOrThrow(): Promise<{
    requestFile: string;
    request: InstallRequest;
  }> {
    const loaded = await this.tryReadSavedInstallRequest();
    if (loaded !== null) {
      return loaded;
    }
    const requestFile = this.getInstallRequestPath();
    throw {
      code: "REQUEST_NOT_FOUND",
      message: "Saved install request file was not found",
      retryable: false,
      details: {
        requestFile,
      },
    };
  }

  private async writeSavedInstallRequest(request: InstallRequest): Promise<string> {
    const requestFile = this.getInstallRequestPath();
    await this.writeInstallerJsonFile(requestFile, request, 0o640);
    return requestFile;
  }

  private async listPendingMigrations(): Promise<PendingMigration[]> {
    const request = await this.tryReadSavedInstallRequest();
    const runtimeConfig = await this.tryReadRuntimeConfig();
    const pending: PendingMigration[] = [];
    if (await this.isMailSentinelMigrationPending(request?.request ?? null, runtimeConfig)) {
      pending.push({
        id: MAIL_SENTINEL_MIGRATION_ID,
        description: "Migrate the legacy single mail-sentinel into bot-instance configuration",
        interactive: true,
      });
    }
    return pending;
  }

  private async isMailSentinelMigrationPending(
    request: InstallRequest | null,
    runtimeConfig: RuntimeConfig | null,
  ): Promise<boolean> {
    if (request === null || runtimeConfig === null) {
      return false;
    }
    const hasLegacyMailSentinel =
      runtimeConfig.openclawProfile.agents.some((entry) => entry.id === MAIL_SENTINEL_AGENT_ID) ||
      request.bots?.selected?.includes(MAIL_SENTINEL_AGENT_ID) === true ||
      request.bots?.config?.[MAIL_SENTINEL_AGENT_ID] !== undefined ||
      request.imap !== undefined;
    const hasInstanceConfig =
      request.bots?.instances?.some((entry) => entry.packageId === MAIL_SENTINEL_AGENT_ID) === true;
    return hasLegacyMailSentinel && !hasInstanceConfig;
  }

  private async assertNoPendingMigrations(): Promise<void> {
    const pending = await this.listPendingMigrations();
    if (pending.length === 0) {
      return;
    }
    throw {
      code: "MIGRATION_REQUIRED",
      message: `Pending migration '${pending[0]?.id ?? MAIL_SENTINEL_MIGRATION_ID}' must be completed before this command can run`,
      retryable: false,
      details: {
        command: "sovereign-node migrate",
      },
    };
  }

  private async createMatrixRoomViaClientApi(input: {
    runtimeConfig: RuntimeConfig;
    roomName: string;
  }): Promise<{ roomId: string; roomName: string }> {
    const operatorTokenSecretRef = input.runtimeConfig.matrix.operator.accessTokenSecretRef;
    if (operatorTokenSecretRef === undefined || operatorTokenSecretRef.length === 0) {
      throw {
        code: "MATRIX_ROOM_CREATE_FAILED",
        message: "Operator Matrix access token is required to create a Mail Sentinel alert room",
        retryable: false,
      };
    }
    const operatorAccessToken = await this.resolveSecretRef(operatorTokenSecretRef);
    const endpoint = new URL(
      "/_matrix/client/v3/createRoom",
      ensureTrailingSlash(input.runtimeConfig.matrix.adminBaseUrl),
    ).toString();
    const response = await this.fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${operatorAccessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        name: input.roomName,
        preset: "private_chat",
        visibility: "private",
      }),
    });
    const bodyText = await response.text();
    const parsed = parseJsonSafely(bodyText);
    if (!response.ok) {
      throw {
        code: "MATRIX_ROOM_CREATE_FAILED",
        message: "Failed to create a Mail Sentinel alert room",
        retryable: true,
        details: {
          endpoint,
          status: response.status,
          body: summarizeUnknown(parsed),
        },
      };
    }
    const roomId = isRecord(parsed) && typeof parsed.room_id === "string" ? parsed.room_id : "";
    if (roomId.length === 0) {
      throw {
        code: "MATRIX_ROOM_CREATE_FAILED",
        message: "Matrix room creation returned an invalid room id",
        retryable: true,
      };
    }
    return {
      roomId,
      roomName: input.roomName,
    };
  }

  private toMailSentinelSummary(
    instance: RequestedBotInstance | RuntimeBotInstance,
    runtimeConfig: RuntimeConfig | null,
  ): MailSentinelSummary {
    const agent = runtimeConfig?.openclawProfile.agents.find(
      (entry) => entry.botInstanceId === instance.id || entry.id === instance.id,
    );
    return {
      id: instance.id,
      packageId: instance.packageId,
      workspace: instance.workspace,
      ...(instance.matrix?.localpart === undefined
        ? agent?.matrix?.localpart === undefined
          ? {}
          : { matrixLocalpart: agent.matrix.localpart }
        : { matrixLocalpart: instance.matrix.localpart }),
      ...(agent?.matrix?.userId === undefined ? {} : { matrixUserId: agent.matrix.userId }),
      ...(instance.matrix?.alertRoom?.roomId === undefined
        ? {}
        : { alertRoomId: instance.matrix.alertRoom.roomId }),
      ...(instance.matrix?.alertRoom?.roomName === undefined
        ? {}
        : { alertRoomName: instance.matrix.alertRoom.roomName }),
      allowedUsers: instance.matrix?.allowedUsers ?? [],
      ...(typeof instance.config[MAIL_SENTINEL_IMAP_HOST_KEY] === "string"
        ? { imapHost: instance.config[MAIL_SENTINEL_IMAP_HOST_KEY] }
        : {}),
      ...(typeof instance.config[MAIL_SENTINEL_IMAP_USERNAME_KEY] === "string"
        ? { imapUsername: instance.config[MAIL_SENTINEL_IMAP_USERNAME_KEY] }
        : {}),
      ...(typeof instance.config[MAIL_SENTINEL_IMAP_MAILBOX_KEY] === "string"
        ? { mailbox: instance.config[MAIL_SENTINEL_IMAP_MAILBOX_KEY] }
        : {}),
      ...(typeof instance.config.pollInterval === "string"
        ? { pollInterval: instance.config.pollInterval }
        : {}),
    };
  }

  private syncSelectedBotsWithInstances(request: InstallRequest): void {
    const explicitPackageIds = dedupeStrings(
      (request.bots?.instances ?? [])
        .map((entry) => entry.packageId.trim())
        .filter((entry) => entry.length > 0),
    );
    const selected = request.bots?.selected ?? [];
    request.bots = {
      ...(request.bots ?? {}),
      selected: dedupeStrings([
        ...selected.filter((entry) => !explicitPackageIds.includes(entry)),
        ...explicitPackageIds,
      ]),
    };
  }

  private async applyMailSentinelInstance(
    req: {
      id: string;
      imapHost?: string;
      imapPort?: number;
      imapTls?: boolean;
      imapUsername?: string;
      imapPassword?: string;
      imapSecretRef?: string;
      mailbox?: string;
      matrixLocalpart?: string;
      alertRoomId?: string;
      alertRoomName?: string;
      createAlertRoomName?: string;
      allowedUsers?: string[];
      pollInterval?: string;
      lookbackWindow?: string;
      defaultReminderDelay?: string;
      digestInterval?: string;
    },
    mode: "create" | "update",
  ): Promise<MailSentinelApplyResult> {
    await this.assertNoPendingMigrations();
    const runtimeConfig = await this.readRuntimeConfig();
    const { request } = await this.readSavedInstallRequestOrThrow();
    const id = sanitizeManagedAgentId(req.id);
    const existingRaw = (request.bots?.instances ?? []).find((entry) => entry.id === id) as
      | NonNullable<NonNullable<InstallRequest["bots"]>["instances"]>[number]
      | undefined;
    if (mode === "create" && existingRaw !== undefined) {
      throw {
        code: "MAIL_SENTINEL_EXISTS",
        message: `Mail Sentinel instance '${id}' already exists`,
        retryable: false,
      };
    }
    if (mode === "update" && existingRaw === undefined) {
      throw {
        code: "MAIL_SENTINEL_NOT_FOUND",
        message: `Mail Sentinel instance '${id}' does not exist`,
        retryable: false,
      };
    }
    const base =
      existingRaw === undefined
        ? this.applyLegacyMailSentinelRequestedInstanceDefaults({
            entry: {
              id,
              packageId: MAIL_SENTINEL_AGENT_ID,
              workspace: join(this.paths.stateDir, id, "workspace"),
              config: {},
              secretRefs: {},
              matrix: {
                allowedUsers: [],
              },
            },
            imap: runtimeConfig.imap,
            matrixRoom: runtimeConfig.matrix.alertRoom,
            homeserverDomain: runtimeConfig.matrix.homeserverDomain,
            previousRuntimeConfig: runtimeConfig,
          })
        : this.normalizeRequestedBotInstance({
            entry: existingRaw,
            configById: isBotConfigRecordMap(request.bots?.config)
              ? (request.bots?.config ?? {})
              : {},
            matrixRoom: runtimeConfig.matrix.alertRoom,
            homeserverDomain: runtimeConfig.matrix.homeserverDomain,
            previousRuntimeConfig: runtimeConfig,
          });
    const imapSecretRef =
      req.imapPassword === undefined
        ? (req.imapSecretRef ?? base.secretRefs[MAIL_SENTINEL_IMAP_PASSWORD_SECRET_KEY])
        : await this.writeManagedSecretFile(`mail-sentinel-${id}-imap-password`, req.imapPassword);
    if (imapSecretRef === undefined || imapSecretRef.length === 0) {
      throw {
        code: "MAIL_SENTINEL_IMAP_SECRET_REQUIRED",
        message: "Provide --imap-secret-ref or --imap-password for the Mail Sentinel instance",
        retryable: false,
      };
    }
    const alertRoom =
      req.createAlertRoomName === undefined
        ? {
            roomId:
              req.alertRoomId?.trim() ||
              base.matrix?.alertRoom?.roomId ||
              runtimeConfig.matrix.alertRoom.roomId,
            roomName:
              req.alertRoomName?.trim() ||
              base.matrix?.alertRoom?.roomName ||
              runtimeConfig.matrix.alertRoom.roomName,
          }
        : await this.createMatrixRoomViaClientApi({
            runtimeConfig,
            roomName: req.createAlertRoomName,
          });
    const allowedUsers = normalizeMatrixUserList(
      (req.allowedUsers ?? base.matrix?.allowedUsers ?? []).map(
        (entry) => this.normalizeMatrixUserIdentifier(entry, runtimeConfig).userId,
      ),
    );
    if (allowedUsers.length === 0) {
      throw {
        code: "MAIL_SENTINEL_ALLOWED_USERS_REQUIRED",
        message: "Provide at least one allowed Matrix user for the Mail Sentinel instance",
        retryable: false,
      };
    }
    const next: RequestedBotInstance = {
      ...base,
      config: {
        ...base.config,
        [MAIL_SENTINEL_IMAP_CONFIGURED_KEY]: true,
        [MAIL_SENTINEL_IMAP_HOST_KEY]:
          req.imapHost ?? String(base.config[MAIL_SENTINEL_IMAP_HOST_KEY] ?? ""),
        [MAIL_SENTINEL_IMAP_PORT_KEY]:
          req.imapPort ?? Number(base.config[MAIL_SENTINEL_IMAP_PORT_KEY] ?? 0),
        [MAIL_SENTINEL_IMAP_TLS_KEY]:
          req.imapTls ?? Boolean(base.config[MAIL_SENTINEL_IMAP_TLS_KEY] ?? false),
        [MAIL_SENTINEL_IMAP_USERNAME_KEY]:
          req.imapUsername ?? String(base.config[MAIL_SENTINEL_IMAP_USERNAME_KEY] ?? ""),
        [MAIL_SENTINEL_IMAP_MAILBOX_KEY]:
          req.mailbox ?? base.config[MAIL_SENTINEL_IMAP_MAILBOX_KEY] ?? "INBOX",
        ...(req.pollInterval === undefined ? {} : { pollInterval: req.pollInterval }),
        ...(req.lookbackWindow === undefined ? {} : { lookbackWindow: req.lookbackWindow }),
        ...(req.defaultReminderDelay === undefined
          ? {}
          : { defaultReminderDelay: req.defaultReminderDelay }),
        ...(req.digestInterval === undefined ? {} : { digestInterval: req.digestInterval }),
      },
      secretRefs: normalizeStringRecord({
        ...base.secretRefs,
        [MAIL_SENTINEL_IMAP_PASSWORD_SECRET_KEY]: imapSecretRef,
      }),
      matrix: {
        localpart: sanitizeManagedAgentLocalpart(req.matrixLocalpart ?? base.matrix?.localpart, id),
        alertRoom,
        allowedUsers,
      },
    };
    if (
      typeof next.config[MAIL_SENTINEL_IMAP_HOST_KEY] !== "string" ||
      typeof next.config[MAIL_SENTINEL_IMAP_PORT_KEY] !== "number" ||
      typeof next.config[MAIL_SENTINEL_IMAP_TLS_KEY] !== "boolean" ||
      typeof next.config[MAIL_SENTINEL_IMAP_USERNAME_KEY] !== "string"
    ) {
      throw {
        code: "MAIL_SENTINEL_IMAP_CONFIG_INVALID",
        message: "Mail Sentinel IMAP host, port, tls, and username must be configured",
        retryable: false,
      };
    }
    request.bots = {
      ...(request.bots ?? {}),
      selected: dedupeStrings([...(request.bots?.selected ?? []), MAIL_SENTINEL_AGENT_ID]),
      instances: sortBotInstances([
        ...((request.bots?.instances ?? []).filter(
          (entry) => entry.id !== id,
        ) as RequestedBotInstance[]),
        next,
      ]),
    };
    this.syncSelectedBotsWithInstances(request);
    await this.writeSavedInstallRequest(request);
    const result = await this.startInstall(request);
    return {
      instance: this.toMailSentinelSummary(next, runtimeConfig),
      changed: true,
      job: result.job,
    };
  }

  private async writeInstallerJsonFile(path: string, value: unknown, mode: number): Promise<void> {
    const tempPath = `${path}.${randomUUID()}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await chmod(tempPath, mode);
    await rename(tempPath, path);
    await this.applyRuntimeOwnership(path);
  }

  private async updateInstallRequestOpenrouter(input: {
    model: string;
    secretRef: string;
    modelChanged: boolean;
    credentialsChanged: boolean;
  }): Promise<{ changed: string[]; validation: CheckResult[] }> {
    const requestPath = this.getInstallRequestPath();
    let raw = "";
    try {
      raw = await readFile(requestPath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return {
          changed: [],
          validation: [
            check(
              "install-request-sync",
              "Saved install request sync",
              "warn",
              "Saved install request file was not found; future installer updates will keep the previous OpenRouter settings until the request file is refreshed",
              {
                requestFile: requestPath,
              },
            ),
          ],
        };
      }
      throw {
        code: "REQUEST_UPDATE_FAILED",
        message: "Failed to read the saved install request file",
        retryable: false,
        details: {
          requestFile: requestPath,
          error: describeError(error),
        },
      };
    }

    const parsed = parseJsonDocument(raw);
    const validated = installRequestSchema.safeParse(parsed);
    if (!validated.success) {
      return {
        changed: [],
        validation: [
          check(
            "install-request-sync",
            "Saved install request sync",
            "warn",
            "Saved install request could not be updated because it is invalid",
            {
              requestFile: requestPath,
            },
          ),
        ],
      };
    }

    const requestPayload = validated.data;
    const changed: string[] = [];
    if (input.modelChanged && requestPayload.openrouter.model !== input.model) {
      requestPayload.openrouter.model = input.model;
      changed.push("request.openrouter.model");
    }
    if (input.credentialsChanged) {
      requestPayload.openrouter.secretRef = input.secretRef;
      delete requestPayload.openrouter.apiKey;
      changed.push("request.openrouter.secretRef");
    }

    if (changed.length === 0) {
      return {
        changed,
        validation: [
          check(
            "install-request-sync",
            "Saved install request sync",
            "pass",
            "Saved install request already matched the current OpenRouter settings",
            {
              requestFile: requestPath,
            },
          ),
        ],
      };
    }

    try {
      await this.writeInstallerJsonFile(requestPath, requestPayload, 0o640);
    } catch (error) {
      throw {
        code: "REQUEST_UPDATE_FAILED",
        message: "Failed to write the saved install request file",
        retryable: false,
        details: {
          requestFile: requestPath,
          error: describeError(error),
        },
      };
    }

    return {
      changed,
      validation: [
        check(
          "install-request-sync",
          "Saved install request sync",
          "pass",
          "Saved install request updated to match the new OpenRouter settings",
          {
            requestFile: requestPath,
          },
        ),
      ],
    };
  }

  private async updateInstallRequestFederation(input: {
    federationEnabled: boolean;
    changed: boolean;
  }): Promise<{ changed: string[]; validation: CheckResult[] }> {
    const requestPath = this.getInstallRequestPath();
    let raw = "";
    try {
      raw = await readFile(requestPath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return {
          changed: [],
          validation: [
            check(
              "install-request-sync",
              "Saved install request sync",
              "warn",
              "Saved install request file was not found; future installer updates will keep the previous federation settings until the request file is refreshed",
              { requestFile: requestPath },
            ),
          ],
        };
      }
      throw {
        code: "REQUEST_UPDATE_FAILED",
        message: "Failed to read the saved install request file",
        retryable: false,
        details: { requestFile: requestPath, error: describeError(error) },
      };
    }

    const parsed = parseJsonDocument(raw);
    const validated = installRequestSchema.safeParse(parsed);
    if (!validated.success) {
      return {
        changed: [],
        validation: [
          check(
            "install-request-sync",
            "Saved install request sync",
            "warn",
            "Saved install request could not be updated because it is invalid",
            { requestFile: requestPath },
          ),
        ],
      };
    }

    const requestPayload = validated.data;
    const changed: string[] = [];
    if (input.changed && requestPayload.matrix.federationEnabled !== input.federationEnabled) {
      requestPayload.matrix.federationEnabled = input.federationEnabled;
      changed.push("request.matrix.federationEnabled");
    }

    if (changed.length === 0) {
      return {
        changed,
        validation: [
          check(
            "install-request-sync",
            "Saved install request sync",
            "pass",
            "Saved install request already matched the current federation settings",
            { requestFile: requestPath },
          ),
        ],
      };
    }

    try {
      await this.writeInstallerJsonFile(requestPath, requestPayload, 0o640);
    } catch (error) {
      throw {
        code: "REQUEST_UPDATE_FAILED",
        message: "Failed to write the saved install request file",
        retryable: false,
        details: { requestFile: requestPath, error: describeError(error) },
      };
    }

    return {
      changed,
      validation: [
        check(
          "install-request-sync",
          "Saved install request sync",
          "pass",
          "Saved install request updated to match the new federation settings",
          { requestFile: requestPath },
        ),
      ],
    };
  }

  private async refreshGatewayAfterRuntimeConfig(runtimeConfig: RuntimeConfig): Promise<void> {
    if (this.shouldPreferSystemGatewayService(runtimeConfig)) {
      const started = await this.ensureSystemGatewayServiceFallback(runtimeConfig);
      if (started) {
        return;
      }
      throw {
        code: "OPENCLAW_GATEWAY_RESTART_FAILED",
        message: "Failed to restart the system-level OpenClaw gateway service",
        retryable: true,
      };
    }

    try {
      await this.openclawGatewayServiceManager.restart();
    } catch (error) {
      if (isGatewayUserSystemdUnavailableError(error)) {
        throw error;
      }
      this.logger.warn(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        "OpenClaw gateway restart failed after runtime configure; retrying with start",
      );
      await this.openclawGatewayServiceManager.start();
    }

    if (this.execRunner === null) {
      return;
    }

    let gatewayState = await this.inspectGatewayRuntimeState();
    if (gatewayState.health.ok) {
      return;
    }

    for (let probe = 1; probe <= 5; probe += 1) {
      await delay(2000);
      gatewayState = await this.inspectGatewayRuntimeState();
      if (gatewayState.health.ok) {
        this.logger.info({ probe }, "OpenClaw gateway became healthy after post-restart wait");
        return;
      }
    }

    this.logger.warn(
      {
        state: gatewayState.gateway.state,
        message: gatewayState.gateway.message,
        health: gatewayState.health.message,
      },
      "OpenClaw gateway did not become healthy after runtime configure; trying system-level fallback",
    );
    const fallbackStarted = await this.ensureSystemGatewayServiceFallback(runtimeConfig);
    if (fallbackStarted) {
      return;
    }

    throw {
      code: "OPENCLAW_GATEWAY_RESTART_FAILED",
      message: "OpenClaw gateway did not become healthy after runtime configure",
      retryable: true,
      details: {
        state: gatewayState.gateway.state,
        message: gatewayState.gateway.message,
        health: gatewayState.health.message,
      },
    };
  }

  private async inspectGatewayRuntimeState(): Promise<{
    gateway: {
      installed: boolean;
      state: GatewayState;
      message?: string;
    };
    health: {
      ok: boolean;
      message: string;
    };
  }> {
    const [gateway, health] = await Promise.all([
      this.inspectGatewayService(),
      this.probeOpenClawHealth(),
    ]);
    return {
      gateway,
      health,
    };
  }

  private async resolveSecretRef(secretRef: string): Promise<string> {
    if (secretRef.startsWith("file:")) {
      const filePath = secretRef.slice("file:".length);
      const raw = await readFile(filePath, "utf8");
      const value = stripSingleTrailingNewline(raw);
      if (value.length === 0) {
        throw {
          code: "SECRET_READ_FAILED",
          message: "Secret file is empty",
          retryable: false,
          details: {
            secretRef,
          },
        };
      }
      return value;
    }

    if (secretRef.startsWith("env:")) {
      const key = secretRef.slice("env:".length);
      const value = process.env[key];
      if (value !== undefined && value.length > 0) {
        return value;
      }
      throw {
        code: "SECRET_READ_FAILED",
        message: "Secret environment variable is not set",
        retryable: false,
        details: {
          secretRef,
        },
      };
    }

    throw {
      code: "SECRET_REF_UNSUPPORTED",
      message: "Unsupported secretRef format",
      retryable: false,
      details: {
        secretRef,
      },
    };
  }

  private async writeSovereignConfig(input: {
    req: InstallRequest;
    relayEnrollment?: RelayEnrollmentResult;
    matrixProvision: BundledMatrixProvisionResult;
    matrixAccounts: BundledMatrixAccountsResult;
    matrixRoom: BundledMatrixRoomBootstrapResult;
  }): Promise<RuntimeConfig> {
    const imapConfig = await this.resolveImapConfig(input.req.imap);
    const openrouterSecretRef = await this.resolveOpenRouterSecretRef(input.req.openrouter);
    const openrouterModel = input.req.openrouter.model ?? DEFAULT_OPENROUTER_MODEL;
    const operatorTokenSecretRef = await this.writeSecretFile(
      "matrix-operator-access-token",
      input.matrixAccounts.operator.accessToken,
    );
    const botTokenSecretRef = await this.writeSecretFile(
      "matrix-bot-access-token",
      input.matrixAccounts.bot.accessToken,
    );
    const relayTokenSecretRef =
      input.relayEnrollment === undefined
        ? undefined
        : await this.writeSecretFile("relay-tunnel-token", input.relayEnrollment.tunnel.token);
    const serviceIdentity = this.getConfiguredServiceIdentity();
    const openclawPaths = this.getOpenClawRuntimePaths();
    const { packages: selectedBotPackages, configById: selectedBotConfig } =
      await this.resolveRequestedBots(input.req);
    const allBotPackages = await this.listBotPackages();
    const previousRuntimeConfig = await this.tryReadRuntimeConfig();
    const allBotTemplateRefs = new Set(allBotPackages.map((entry) => entry.templateRef));
    const allManagedBotToolIds = new Set(
      allBotPackages.flatMap((entry) =>
        entry.manifest.toolInstances.map(
          (tool: LoadedBotPackage["manifest"]["toolInstances"][number]) => tool.id,
        ),
      ),
    );
    const requiredCoreTemplateRefs = dedupeStrings(
      selectedBotPackages
        .flatMap((entry) => [
          ...entry.manifest.toolInstances.map(
            (tool: LoadedBotPackage["manifest"]["toolInstances"][number]) => tool.templateRef,
          ),
          ...entry.template.requiredToolTemplates.map((tool) =>
            formatTemplateRef(tool.id, tool.version),
          ),
          ...entry.template.optionalToolTemplates.map((tool) =>
            formatTemplateRef(tool.id, tool.version),
          ),
        ])
        .filter((ref: string) => findCoreTemplateManifest(ref) !== undefined),
    );
    const requiredPluginIds = this.listRequiredOpenClawPluginIds(selectedBotPackages);
    const preservedUserAgents =
      previousRuntimeConfig?.openclawProfile.agents.filter(
        (entry) =>
          !allBotTemplateRefs.has(entry.templateRef ?? "") &&
          !selectedBotPackages.some((botPackage) => botPackage.manifest.id === entry.botId),
      ) ?? [];
    const preservedInstalledTemplates = previousRuntimeConfig?.templates.installed ?? [];
    const preservedToolInstances = previousRuntimeConfig?.sovereignTools.instances ?? [];
    let installedTemplates = this.withRequiredCoreTemplates(
      preservedInstalledTemplates,
      requiredCoreTemplateRefs,
    );
    for (const botPackage of selectedBotPackages) {
      installedTemplates = this.upsertInstalledBotTemplateEntry(
        installedTemplates,
        botPackage,
      ).installed;
      installedTemplates = this.upsertInstalledBotToolTemplateEntries(
        installedTemplates,
        botPackage,
      ).installed;
    }

    const baseMatrixConfig = {
      accessMode: input.relayEnrollment === undefined ? ("direct" as const) : ("relay" as const),
      homeserverDomain: input.matrixProvision.homeserverDomain,
      federationEnabled: input.matrixProvision.federationEnabled,
      publicBaseUrl: input.matrixProvision.publicBaseUrl,
      adminBaseUrl: input.matrixProvision.adminBaseUrl,
      projectDir: input.matrixProvision.projectDir,
      onboardingStatePath: join(input.matrixProvision.projectDir, "onboarding", "state.json"),
      operator: {
        localpart: input.matrixAccounts.operator.localpart,
        userId: input.matrixAccounts.operator.userId,
        passwordSecretRef: input.matrixAccounts.operator.passwordSecretRef,
        accessTokenSecretRef: operatorTokenSecretRef,
      },
      bot: {
        localpart: input.matrixAccounts.bot.localpart,
        userId: input.matrixAccounts.bot.userId,
        passwordSecretRef: input.matrixAccounts.bot.passwordSecretRef,
        accessTokenSecretRef: botTokenSecretRef,
        ...(input.matrixAccounts.bot.avatarSha256 === undefined
          ? {}
          : { avatarSha256: input.matrixAccounts.bot.avatarSha256 }),
      },
      alertRoom: {
        roomId: input.matrixRoom.roomId,
        roomName: input.matrixRoom.roomName,
        ...(input.matrixRoom.avatarSha256 === undefined
          ? {}
          : { avatarSha256: input.matrixRoom.avatarSha256 }),
      },
    };
    const provisionalRuntimeConfig: RuntimeConfig = {
      openclaw: {
        managedInstallation: input.req.openclaw?.manageInstallation ?? true,
        installMethod: input.req.openclaw?.installMethod ?? "install_sh",
        requestedVersion: resolveRequestedOpenClawVersion(input.req.openclaw?.version),
        openclawHome: openclawPaths.openclawHome,
        runtimeConfigPath: openclawPaths.runtimeConfigPath,
        runtimeProfilePath: openclawPaths.runtimeProfilePath,
        gatewayEnvPath: openclawPaths.gatewayEnvPath,
        serviceUser: serviceIdentity.user,
        serviceGroup: serviceIdentity.group,
      },
      openrouter: {
        model: openrouterModel,
        apiKeySecretRef: openrouterSecretRef,
      },
      openclawProfile: {
        plugins: {
          allow: requiredPluginIds,
        },
        session: {
          dmScope: MANAGED_OPENCLAW_DM_SCOPE,
        },
        agents: [],
        crons: [],
      },
      imap: {
        status: imapConfig.status,
        host: imapConfig.host,
        port: imapConfig.port,
        tls: imapConfig.tls,
        username: imapConfig.username,
        mailbox: imapConfig.mailbox,
        secretRef: imapConfig.secretRef,
      },
      matrix: baseMatrixConfig,
      bots: {
        config: selectedBotConfig,
        instances: [],
      },
      templates: {
        installed: installedTemplates,
      },
      sovereignTools: {
        instances: [],
      },
      hostResources: {
        planPath: join(dirname(this.paths.configPath), "host-resources.json"),
        resources: [],
        botStatus: [],
      },
      ...(input.relayEnrollment === undefined
        ? {}
        : {
            relay: {
              enabled: true,
              controlUrl: input.relayEnrollment.controlUrl,
              hostname: input.relayEnrollment.hostname,
              publicBaseUrl: input.relayEnrollment.publicBaseUrl,
              connected: false,
              serviceName: RELAY_TUNNEL_SYSTEMD_UNIT,
              configPath: this.getRelayTunnelConfigPath(),
              tunnel: {
                serverAddr: input.relayEnrollment.tunnel.serverAddr,
                serverPort: input.relayEnrollment.tunnel.serverPort,
                tokenSecretRef: relayTokenSecretRef ?? "env:SOVEREIGN_RELAY_TOKEN_UNSET",
                proxyName: input.relayEnrollment.tunnel.proxyName,
                ...(input.relayEnrollment.tunnel.subdomain === undefined
                  ? {}
                  : { subdomain: input.relayEnrollment.tunnel.subdomain }),
                type: input.relayEnrollment.tunnel.type,
                localIp: input.relayEnrollment.tunnel.localIp,
                localPort: input.relayEnrollment.tunnel.localPort,
              },
            } satisfies RelayRuntimeConfig,
          }),
    };
    const requestedBotInstances = this.resolveRequestedBotInstances({
      req: input.req,
      packages: selectedBotPackages,
      configById: selectedBotConfig,
      imap: imapConfig,
      matrixRoom: input.matrixRoom,
      homeserverDomain: provisionalRuntimeConfig.matrix.homeserverDomain,
      previousRuntimeConfig,
    });
    provisionalRuntimeConfig.bots.instances = requestedBotInstances;
    const managedBotToolInstances = selectedBotPackages.flatMap((botPackage) => {
      const instances = requestedBotInstances.filter(
        (entry) => entry.packageId === botPackage.manifest.id,
      );
      if (instances.length === 0) {
        const toolInstanceIdMap = this.buildManagedBotToolInstanceIdMap(
          botPackage,
          botPackage.manifest.id,
        );
        return botPackage.manifest.toolInstances.flatMap(
          (tool: LoadedBotPackage["manifest"]["toolInstances"][number]) =>
            this.isBotToolInstanceEnabled(provisionalRuntimeConfig, tool.enabledWhen, {
              botPackage,
              botInstance: undefined,
              toolInstanceIdMap,
            })
              ? [
                  this.buildManagedBotToolInstance({
                    runtimeConfig: provisionalRuntimeConfig,
                    availableBotPackages: selectedBotPackages,
                    botPackage,
                    tool,
                    existing: preservedToolInstances.find(
                      (entry) => entry.id === (toolInstanceIdMap[tool.id] ?? tool.id),
                    ),
                    toolInstanceIdMap,
                  }),
                ]
              : [],
        );
      }
      return instances.flatMap((botInstance) => {
        const toolInstanceIdMap = this.buildManagedBotToolInstanceIdMap(botPackage, botInstance.id);
        return botPackage.manifest.toolInstances.flatMap(
          (tool: LoadedBotPackage["manifest"]["toolInstances"][number]) =>
            this.isBotToolInstanceEnabled(provisionalRuntimeConfig, tool.enabledWhen, {
              botPackage,
              botInstance,
              toolInstanceIdMap,
            })
              ? [
                  this.buildManagedBotToolInstance({
                    runtimeConfig: provisionalRuntimeConfig,
                    availableBotPackages: selectedBotPackages,
                    botPackage,
                    botInstance,
                    tool,
                    existing: preservedToolInstances.find(
                      (entry) => entry.id === (toolInstanceIdMap[tool.id] ?? tool.id),
                    ),
                    toolInstanceIdMap,
                  }),
                ]
              : [],
        );
      });
    });
    const previousManagedBotToolIds = new Set(
      previousRuntimeConfig?.openclawProfile.agents
        .filter((agent) =>
          allBotPackages.some(
            (botPackage) =>
              agent.botId === botPackage.manifest.id ||
              agent.templateRef === botPackage.templateRef,
          ),
        )
        .flatMap((agent) => agent.toolInstanceIds ?? []) ?? [],
    );
    const managedBotToolIds = new Set([
      ...previousManagedBotToolIds,
      ...managedBotToolInstances.map((entry) => entry.id),
      ...Array.from(allManagedBotToolIds),
    ]);
    const preservedUserToolInstances = preservedToolInstances.filter(
      (entry) => !managedBotToolIds.has(entry.id),
    );
    provisionalRuntimeConfig.sovereignTools.instances = sortToolInstances([
      ...preservedUserToolInstances,
      ...managedBotToolInstances.map(
        ({
          botId: _botId,
          botInstanceId: _botInstanceId,
          manifestToolId: _manifestToolId,
          ...tool
        }) => tool,
      ),
    ]);
    const managedBotAgents = selectedBotPackages.flatMap((botPackage) => {
      const instances = requestedBotInstances.filter(
        (entry) => entry.packageId === botPackage.manifest.id,
      );
      if (instances.length === 0) {
        const toolInstanceIds = managedBotToolInstances
          .filter(
            (tool) => tool.botId === botPackage.manifest.id && tool.botInstanceId === undefined,
          )
          .map((tool) => tool.id);
        const configuredModel =
          selectedBotConfig[botPackage.manifest.id]?.model ?? botPackage.template.model;
        return [
          {
            id: botPackage.manifest.id,
            workspace: join(this.paths.stateDir, botPackage.manifest.id, "workspace"),
            ...(typeof configuredModel === "string" && configuredModel.trim().length > 0
              ? { model: configuredModel.trim() }
              : {}),
            templateRef: botPackage.templateRef,
            botId: botPackage.manifest.id,
            ...(toolInstanceIds.length === 0 ? {} : { toolInstanceIds }),
            ...(botPackage.manifest.matrixIdentity.mode !== "service-account"
              ? {}
              : {
                  matrix: {
                    localpart: input.matrixAccounts.bot.localpart,
                    userId: input.matrixAccounts.bot.userId,
                    ...(input.matrixAccounts.bot.passwordSecretRef === undefined
                      ? {}
                      : { passwordSecretRef: input.matrixAccounts.bot.passwordSecretRef }),
                    accessTokenSecretRef: botTokenSecretRef,
                  },
                }),
          },
        ];
      }
      return instances.map((botInstance) => {
        const toolInstanceIds = managedBotToolInstances
          .filter(
            (tool) =>
              tool.botId === botPackage.manifest.id && tool.botInstanceId === botInstance.id,
          )
          .map((tool) => tool.id);
        const configuredModel =
          typeof botInstance.config.model === "string" && botInstance.config.model.trim().length > 0
            ? botInstance.config.model.trim()
            : (selectedBotConfig[botPackage.manifest.id]?.model ?? botPackage.template.model);
        return {
          id: botInstance.id,
          workspace: botInstance.workspace,
          ...(typeof configuredModel === "string" && configuredModel.trim().length > 0
            ? { model: configuredModel }
            : {}),
          templateRef: botPackage.templateRef,
          botId: botPackage.manifest.id,
          botInstanceId: botInstance.id,
          ...(toolInstanceIds.length === 0 ? {} : { toolInstanceIds }),
          ...(botPackage.manifest.matrixIdentity.mode !== "service-account"
            ? {}
            : {
                matrix: {
                  localpart: input.matrixAccounts.bot.localpart,
                  userId: input.matrixAccounts.bot.userId,
                  ...(input.matrixAccounts.bot.passwordSecretRef === undefined
                    ? {}
                    : { passwordSecretRef: input.matrixAccounts.bot.passwordSecretRef }),
                  accessTokenSecretRef: botTokenSecretRef,
                },
              }),
        };
      });
    });
    const managedAgents = ensureCoreManagedAgents([...preservedUserAgents, ...managedBotAgents]);
    const runtimeConfig: RuntimeConfig = {
      ...provisionalRuntimeConfig,
      openclawProfile: {
        plugins: {
          allow: requiredPluginIds,
        },
        session: {
          dmScope:
            provisionalRuntimeConfig.openclawProfile.session?.dmScope ?? MANAGED_OPENCLAW_DM_SCOPE,
        },
        agents: managedAgents,
        crons: [],
      },
      sovereignTools: {
        instances: provisionalRuntimeConfig.sovereignTools.instances,
      },
    };

    const hostPlan = await this.compileHostResourcePlan(runtimeConfig, selectedBotPackages);
    runtimeConfig.hostResources = {
      planPath: join(dirname(this.paths.configPath), "host-resources.json"),
      resources: hostPlan.resources,
      botStatus: hostPlan.botStatus,
    };
    runtimeConfig.openclawProfile.crons = hostPlan.resources.flatMap((resource) =>
      resource.kind !== "openclawCron" ||
      resource.desiredState !== "present" ||
      resource.spec === undefined
        ? []
        : [
            {
              id: resource.spec.id,
              every: resource.spec.every,
              agentId: resource.spec.agentId,
              botId: resource.botId,
            },
          ],
    );
    if (runtimeConfig.openclawProfile.crons[0] !== undefined) {
      runtimeConfig.openclawProfile.cron = {
        id: runtimeConfig.openclawProfile.crons[0].id,
        every: runtimeConfig.openclawProfile.crons[0].every,
      };
    }

    const configPayload = {
      contractVersion: CONTRACT_VERSION,
      mode: "bundled_matrix" as const,
      generatedAt: now(),
      connectivity: {
        mode: runtimeConfig.matrix.accessMode,
      },
      openclaw: {
        managedInstallation: runtimeConfig.openclaw.managedInstallation,
        installMethod: runtimeConfig.openclaw.installMethod,
        requestedVersion: runtimeConfig.openclaw.requestedVersion,
        openclawHome: runtimeConfig.openclaw.openclawHome,
        runtimeConfigPath: runtimeConfig.openclaw.runtimeConfigPath,
        runtimeProfilePath: runtimeConfig.openclaw.runtimeProfilePath,
        gatewayEnvPath: runtimeConfig.openclaw.gatewayEnvPath,
        serviceUser: runtimeConfig.openclaw.serviceUser,
        serviceGroup: runtimeConfig.openclaw.serviceGroup,
        serviceHome: this.paths.openclawServiceHome,
      },
      openclawProfile: {
        plugins: {
          allow: runtimeConfig.openclawProfile.plugins.allow,
        },
        session: {
          dmScope: runtimeConfig.openclawProfile.session?.dmScope ?? MANAGED_OPENCLAW_DM_SCOPE,
        },
        channels: {
          matrix: {
            enabled: true,
            homeserver: runtimeConfig.matrix.adminBaseUrl,
            roomId: runtimeConfig.matrix.alertRoom.roomId,
          },
        },
        agents: runtimeConfig.openclawProfile.agents,
        crons: runtimeConfig.openclawProfile.crons,
        ...(runtimeConfig.openclawProfile.crons[0] === undefined
          ? {}
          : {
              cron: {
                id: runtimeConfig.openclawProfile.crons[0].id,
                every: runtimeConfig.openclawProfile.crons[0].every,
              },
            }),
      },
      openrouter: {
        provider: "openrouter",
        model: runtimeConfig.openrouter.model,
        apiKeySecretRef: runtimeConfig.openrouter.apiKeySecretRef,
      },
      imap:
        runtimeConfig.imap.status === "configured" && input.req.imap !== undefined
          ? {
              status: "configured",
              host: runtimeConfig.imap.host,
              port: runtimeConfig.imap.port,
              tls: runtimeConfig.imap.tls,
              username: runtimeConfig.imap.username,
              secretRef: runtimeConfig.imap.secretRef,
              mailbox: runtimeConfig.imap.mailbox,
            }
          : {
              status: "pending",
              host: runtimeConfig.imap.host,
              port: runtimeConfig.imap.port,
              tls: runtimeConfig.imap.tls,
              username: runtimeConfig.imap.username,
              secretRef: runtimeConfig.imap.secretRef,
              mailbox: runtimeConfig.imap.mailbox,
            },
      matrix: {
        accessMode: runtimeConfig.matrix.accessMode,
        homeserverDomain: input.matrixProvision.homeserverDomain,
        publicBaseUrl: runtimeConfig.matrix.publicBaseUrl,
        adminBaseUrl: runtimeConfig.matrix.adminBaseUrl,
        federationEnabled: runtimeConfig.matrix.federationEnabled,
        tlsMode: input.matrixProvision.tlsMode,
        projectDir: runtimeConfig.matrix.projectDir,
        onboardingStatePath: runtimeConfig.matrix.onboardingStatePath,
        operator: {
          localpart: input.matrixAccounts.operator.localpart,
          userId: runtimeConfig.matrix.operator.userId,
          passwordSecretRef: input.matrixAccounts.operator.passwordSecretRef,
          accessTokenSecretRef: operatorTokenSecretRef,
        },
        bot: {
          localpart: input.matrixAccounts.bot.localpart,
          userId: runtimeConfig.matrix.bot.userId,
          passwordSecretRef: input.matrixAccounts.bot.passwordSecretRef,
          accessTokenSecretRef: runtimeConfig.matrix.bot.accessTokenSecretRef,
          ...(runtimeConfig.matrix.bot.avatarSha256 === undefined
            ? {}
            : { avatarSha256: runtimeConfig.matrix.bot.avatarSha256 }),
        },
        alertRoom: {
          roomId: runtimeConfig.matrix.alertRoom.roomId,
          roomName: runtimeConfig.matrix.alertRoom.roomName,
          ...(runtimeConfig.matrix.alertRoom.avatarSha256 === undefined
            ? {}
            : { avatarSha256: runtimeConfig.matrix.alertRoom.avatarSha256 }),
        },
      },
      ...(runtimeConfig.relay === undefined
        ? {}
        : {
            relay: {
              enabled: runtimeConfig.relay.enabled,
              controlUrl: runtimeConfig.relay.controlUrl,
              hostname: runtimeConfig.relay.hostname,
              publicBaseUrl: runtimeConfig.relay.publicBaseUrl,
              connected: runtimeConfig.relay.connected,
              serviceName: runtimeConfig.relay.serviceName,
              configPath: runtimeConfig.relay.configPath,
              tunnel: runtimeConfig.relay.tunnel,
            },
          }),
      bots: runtimeConfig.bots,
      hostResources: runtimeConfig.hostResources,
      templates: runtimeConfig.templates,
      sovereignTools: runtimeConfig.sovereignTools,
    };

    try {
      const configDir = dirname(this.paths.configPath);
      await mkdir(configDir, { recursive: true });
      const tempPath = `${this.paths.configPath}.${randomUUID()}.tmp`;
      await writeFile(tempPath, `${JSON.stringify(configPayload, null, 2)}\n`, "utf8");
      await chmod(tempPath, 0o644);
      await rename(tempPath, this.paths.configPath);
      await this.applyRuntimeOwnership(this.paths.configPath);
      if (runtimeConfig.hostResources !== undefined) {
        await this.writeInstallerJsonFile(
          runtimeConfig.hostResources.planPath,
          runtimeConfig.hostResources,
          0o644,
        );
        await this.applyRuntimeOwnership(runtimeConfig.hostResources.planPath);
      }
    } catch (error) {
      throw {
        code: "OPENCLAW_CONFIG_WRITE_FAILED",
        message: "Failed to persist Sovereign/OpenClaw runtime config",
        retryable: true,
        details: {
          configPath: this.paths.configPath,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }

    return runtimeConfig;
  }

  private async writeOpenClawRuntimeArtifacts(runtimeConfig: RuntimeConfig): Promise<void> {
    await this.writeManagedOpenClawExtensions({ runtimeConfig });
    const openrouterApiKey = await this.resolveSecretRef(runtimeConfig.openrouter.apiKeySecretRef);
    const existingRuntimePayload = await this.readManagedOpenClawRuntimeJson(runtimeConfig);
    const preservedMeta = isRecord(existingRuntimePayload?.meta)
      ? existingRuntimePayload.meta
      : undefined;
    const preservedGatewayAuth =
      isRecord(existingRuntimePayload?.gateway) && isRecord(existingRuntimePayload.gateway.auth)
        ? existingRuntimePayload.gateway.auth
        : undefined;
    const managedAgents = ensureCoreManagedAgents(runtimeConfig.openclawProfile.agents);
    const operatorAllowlist = [runtimeConfig.matrix.operator.userId];
    const managedAgentPackages = new Map(
      await Promise.all(
        managedAgents.map(
          async (agent) =>
            [agent.id, await this.findBotPackageByTemplateRef(agent.templateRef)] as const,
        ),
      ),
    );
    const hasSharedServiceBot = managedAgents.some((agent) => {
      const botPackage = managedAgentPackages.get(agent.id);
      return botPackage?.manifest.matrixIdentity.mode === "service-account";
    });
    const dedicatedBotPackages = Array.from(managedAgentPackages.values()).filter(
      (entry): entry is LoadedBotPackage => entry !== null,
    );
    const preferredDefaultAccountId =
      this.resolvePreferredDedicatedMatrixBot(dedicatedBotPackages)?.manifest.id;
    const matrixParticipantAllowlist = dedupeStrings([
      ...operatorAllowlist,
      ...(await this.listInvitedHumanMatrixUserIds(runtimeConfig)),
    ]);
    const federationOpen = runtimeConfig.matrix.federationEnabled;
    const pluginEntries: Record<string, unknown> = {
      matrix: {
        enabled: true,
      },
    };
    for (const pluginId of await this.listManagedOpenClawPluginIds(runtimeConfig)) {
      pluginEntries[pluginId] = {
        enabled: true,
        ...(pluginId !== "llm-task"
          ? {}
          : {
              config: {
                defaultProvider: "openrouter",
                defaultModel: runtimeConfig.openrouter.model,
                allowedModels: [`openrouter/${runtimeConfig.openrouter.model}`],
                timeoutMs: 30_000,
              },
            }),
      };
    }
    const managedPluginLoadPaths = await this.listManagedOpenClawPluginLoadPaths(runtimeConfig);
    const matrixAccounts: Record<
      string,
      {
        homeserver: string;
        userId: string;
        accessToken: string;
        dm?: {
          enabled: boolean;
          policy?: "allowlist" | "open";
          allowFrom?: string[];
        };
        groupPolicy?: "allowlist" | "open";
        groupAllowFrom?: string[];
        groups?: Record<
          string,
          {
            enabled: boolean;
            allow: boolean;
            autoReply?: boolean;
            requireMention?: boolean;
            users: string[];
          }
        >;
      }
    > = {};
    const buildMatrixGroupEntries = (input: {
      roomId: string;
      users: string[];
      autoReply: boolean;
      requireMention: boolean;
    }): Record<
      string,
      {
        enabled: boolean;
        allow: boolean;
        autoReply?: boolean;
        requireMention?: boolean;
        users: string[];
      }
    > => ({
      "*": {
        enabled: true,
        allow: true,
        autoReply: input.autoReply,
        requireMention: input.requireMention,
        users: input.users,
      },
      [input.roomId]: {
        enabled: true,
        allow: true,
        autoReply: input.autoReply,
        requireMention: input.requireMention,
        users: input.users,
      },
    });
    const matrixBindings: Array<{
      agentId: string;
      match: {
        channel: "matrix";
        accountId?: string;
      };
    }> = [];
    for (const agent of managedAgents) {
      if (agent.matrix === undefined || agent.matrix.accessTokenSecretRef === undefined) {
        continue;
      }
      const botPackage = managedAgentPackages.get(agent.id);
      const usesSharedServiceIdentity =
        agent.matrix.userId === runtimeConfig.matrix.bot.userId &&
        botPackage?.manifest.matrixIdentity.mode === "service-account";
      if (usesSharedServiceIdentity) {
        matrixBindings.push({
          agentId: agent.id,
          match: {
            channel: "matrix",
          },
        });
        continue;
      }
      matrixBindings.push({
        agentId: agent.id,
        match: {
          channel: "matrix",
          accountId: agent.id,
        },
      });
      if (agent.matrix.userId === runtimeConfig.matrix.bot.userId) {
        matrixBindings.push({
          agentId: agent.id,
          match: {
            channel: "matrix",
          },
        });
      }
      const routing = this.resolveBotMatrixRouting(botPackage?.manifest);
      const botInstance = this.getRuntimeBotInstanceForAgent(runtimeConfig, agent);
      const alertRoom = botInstance?.matrix?.alertRoom ?? runtimeConfig.matrix.alertRoom;
      const explicitAllowlist = botInstance?.matrix?.allowedUsers;
      const agentAllowlist = explicitAllowlist ?? matrixParticipantAllowlist;
      matrixAccounts[agent.id] = {
        homeserver: runtimeConfig.matrix.adminBaseUrl,
        userId: agent.matrix.userId,
        accessToken: await this.resolveSecretRef(agent.matrix.accessTokenSecretRef),
        ...(explicitAllowlist !== undefined || !federationOpen
          ? {
              dm: {
                enabled: routing.dmEnabled,
                policy: "allowlist" as const,
                allowFrom: agentAllowlist,
              },
              groupPolicy: "allowlist" as const,
              groupAllowFrom: agentAllowlist,
              groups: buildMatrixGroupEntries({
                roomId: alertRoom.roomId,
                users: agentAllowlist,
                autoReply: routing.alertRoom.autoReply,
                requireMention: routing.alertRoom.requireMention,
              }),
            }
          : {
              dm: {
                enabled: routing.dmEnabled,
                policy: "open" as const,
              },
              groupPolicy: "open" as const,
              groups: buildMatrixGroupEntries({
                roomId: alertRoom.roomId,
                users: [],
                autoReply: routing.alertRoom.autoReply,
                requireMention: routing.alertRoom.requireMention,
              }),
            }),
      };
    }
    if (hasSharedServiceBot || Object.keys(matrixAccounts).length === 0) {
      matrixAccounts.default = {
        homeserver: runtimeConfig.matrix.adminBaseUrl,
        userId: runtimeConfig.matrix.bot.userId,
        accessToken: await this.resolveSecretRef(runtimeConfig.matrix.bot.accessTokenSecretRef),
        ...(federationOpen
          ? {
              dm: {
                enabled: true,
                policy: "open" as const,
              },
              groupPolicy: "open" as const,
              groups: buildMatrixGroupEntries({
                roomId: runtimeConfig.matrix.alertRoom.roomId,
                users: [],
                autoReply: true,
                requireMention: false,
              }),
            }
          : {
              dm: {
                enabled: true,
                policy: "allowlist" as const,
                allowFrom: matrixParticipantAllowlist,
              },
              groupPolicy: "allowlist" as const,
              groupAllowFrom: matrixParticipantAllowlist,
              groups: buildMatrixGroupEntries({
                roomId: runtimeConfig.matrix.alertRoom.roomId,
                users: matrixParticipantAllowlist,
                autoReply: true,
                requireMention: false,
              }),
            }),
      };
    }

    const runtimePayload = {
      ...(preservedMeta === undefined ? {} : { meta: preservedMeta }),
      gateway: {
        bind: "loopback" as const,
        ...(preservedGatewayAuth === undefined ? {} : { auth: preservedGatewayAuth }),
      },
      session: {
        dmScope: runtimeConfig.openclawProfile.session?.dmScope ?? MANAGED_OPENCLAW_DM_SCOPE,
      },
      plugins: {
        allow: runtimeConfig.openclawProfile.plugins.allow,
        ...(managedPluginLoadPaths.length === 0
          ? {}
          : {
              load: {
                paths: managedPluginLoadPaths,
              },
            }),
        entries: pluginEntries,
      },
      ...(matrixBindings[0] === undefined ? {} : { bindings: matrixBindings }),
      channels: {
        matrix: {
          enabled: true,
          homeserver: runtimeConfig.matrix.adminBaseUrl,
          threadReplies: "always",
          ...(!hasSharedServiceBot && preferredDefaultAccountId !== undefined
            ? { defaultAccount: preferredDefaultAccountId }
            : {}),
          ...(Object.keys(matrixAccounts).length === 0
            ? {}
            : {
                accounts: matrixAccounts,
              }),
          ...(federationOpen
            ? {
                dm: {
                  policy: "open" as const,
                },
                groupPolicy: "open" as const,
                groups: buildMatrixGroupEntries({
                  roomId: runtimeConfig.matrix.alertRoom.roomId,
                  users: [],
                  autoReply: true,
                  requireMention: false,
                }),
              }
            : {
                dm: {
                  policy: "allowlist" as const,
                  allowFrom: matrixParticipantAllowlist,
                },
                groupPolicy: "allowlist" as const,
                groupAllowFrom: matrixParticipantAllowlist,
                groups: buildMatrixGroupEntries({
                  roomId: runtimeConfig.matrix.alertRoom.roomId,
                  users: matrixParticipantAllowlist,
                  autoReply: true,
                  requireMention: false,
                }),
              }),
        },
      },
      agents: {
        defaults: {
          model: normalizeOpenClawAgentModel(runtimeConfig.openrouter.model),
        },
        list: await Promise.all(
          managedAgents.map(async (entry) => {
            const tools = await this.buildOpenClawAgentToolPolicy(
              runtimeConfig,
              entry.toolInstanceIds ?? [],
            );
            return {
              id: entry.id,
              workspace: entry.workspace,
              ...(entry.default === true ? { default: true } : {}),
              ...(entry.model === undefined
                ? {}
                : { model: normalizeOpenClawAgentModel(entry.model) }),
              ...(tools === null ? {} : { tools }),
            };
          }),
        ),
      },
      cron: {
        enabled: true,
      },
    };

    const profilePayload = {
      generatedAt: now(),
      source: "sovereign-node",
      openclawProfile: runtimeConfig.openclawProfile,
      bots: runtimeConfig.bots,
      matrix: {
        publicBaseUrl: runtimeConfig.matrix.publicBaseUrl,
        adminBaseUrl: runtimeConfig.matrix.adminBaseUrl,
        roomId: runtimeConfig.matrix.alertRoom.roomId,
      },
      imap: {
        status: runtimeConfig.imap.status,
        host: runtimeConfig.imap.host,
        mailbox: runtimeConfig.imap.mailbox,
      },
      openrouter: runtimeConfig.openrouter,
    };
    const managedTempDir = this.getManagedOpenClawTempDir(runtimeConfig);

    try {
      await mkdir(this.paths.openclawServiceHome, { recursive: true });
      await mkdir(runtimeConfig.openclaw.openclawHome, { recursive: true });
      await mkdir(dirname(runtimeConfig.openclaw.runtimeProfilePath), { recursive: true });
      await mkdir(managedTempDir, { recursive: true });
      await chmod(managedTempDir, 0o700);
      await this.applyConfiguredRuntimeOwnership(this.paths.openclawServiceHome, runtimeConfig);
      await this.applyConfiguredRuntimeOwnership(
        runtimeConfig.openclaw.openclawHome,
        runtimeConfig,
      );
      await this.applyConfiguredRuntimeOwnership(
        dirname(runtimeConfig.openclaw.runtimeProfilePath),
        runtimeConfig,
      );
      await this.applyConfiguredRuntimeOwnership(managedTempDir, runtimeConfig);
      await this.writeProtectedJsonFile(
        runtimeConfig.openclaw.runtimeConfigPath,
        runtimePayload,
        runtimeConfig,
      );
      await this.writeProtectedJsonFile(
        runtimeConfig.openclaw.runtimeProfilePath,
        profilePayload,
        runtimeConfig,
      );

      const envFileLines = [
        `HOME=${this.paths.openclawServiceHome}`,
        `OPENCLAW_HOME=${this.paths.openclawServiceHome}`,
        `OPENCLAW_CONFIG=${runtimeConfig.openclaw.runtimeConfigPath}`,
        `OPENCLAW_CONFIG_PATH=${runtimeConfig.openclaw.runtimeConfigPath}`,
        `SOVEREIGN_NODE_CONFIG=${this.paths.configPath}`,
        `TMPDIR=${managedTempDir}`,
        `TMP=${managedTempDir}`,
        `TEMP=${managedTempDir}`,
        `OPENROUTER_API_KEY=${openrouterApiKey}`,
        `MATRIX_HOMESERVER=${runtimeConfig.matrix.adminBaseUrl}`,
        `MATRIX_USER_ID=${runtimeConfig.matrix.bot.userId}`,
      ];
      const matrixAccessToken = await this.resolveSecretRef(
        runtimeConfig.matrix.bot.accessTokenSecretRef,
      );
      envFileLines.push(`MATRIX_ACCESS_TOKEN=${matrixAccessToken}`);
      const envTempPath = `${runtimeConfig.openclaw.gatewayEnvPath}.${randomUUID()}.tmp`;
      await writeFile(envTempPath, `${envFileLines.join("\n")}\n`, "utf8");
      await chmod(envTempPath, 0o600);
      await rename(envTempPath, runtimeConfig.openclaw.gatewayEnvPath);
      await this.applyConfiguredRuntimeOwnership(
        runtimeConfig.openclaw.gatewayEnvPath,
        runtimeConfig,
      );
    } catch (error) {
      throw {
        code: "OPENCLAW_CONFIG_WRITE_FAILED",
        message: "Failed to write OpenClaw runtime artifacts",
        retryable: true,
        details: {
          openclawHome: runtimeConfig.openclaw.openclawHome,
          runtimeConfigPath: runtimeConfig.openclaw.runtimeConfigPath,
          runtimeProfilePath: runtimeConfig.openclaw.runtimeProfilePath,
          gatewayEnvPath: runtimeConfig.openclaw.gatewayEnvPath,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private async writeProtectedJsonFile(
    path: string,
    value: unknown,
    runtimeConfig?: RuntimeConfig,
  ): Promise<void> {
    const tempPath = `${path}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await chmod(tempPath, 0o600);
    await rename(tempPath, path);
    if (runtimeConfig === undefined) {
      await this.applyRuntimeOwnership(path);
      return;
    }
    await this.applyConfiguredRuntimeOwnership(path, runtimeConfig);
  }

  private async resolveImapConfig(imap: InstallRequest["imap"]): Promise<RuntimeConfig["imap"]> {
    if (imap === undefined) {
      return {
        status: "pending",
        host: "pending",
        port: 993,
        tls: true,
        username: "pending",
        mailbox: "INBOX",
        secretRef: "env:SOVEREIGN_IMAP_SECRET_UNSET",
      };
    }

    if (imap.secretRef !== undefined && imap.secretRef.length > 0) {
      return {
        status: "configured",
        host: imap.host,
        port: imap.port,
        tls: imap.tls,
        username: imap.username,
        mailbox: imap.mailbox ?? "INBOX",
        secretRef: imap.secretRef,
      };
    }

    if (imap.password !== undefined && imap.password.length > 0) {
      return {
        status: "configured",
        host: imap.host,
        port: imap.port,
        tls: imap.tls,
        username: imap.username,
        mailbox: imap.mailbox ?? "INBOX",
        secretRef: await this.writeSecretFile("imap-password", imap.password),
      };
    }

    return {
      status: "pending",
      host: imap.host,
      port: imap.port,
      tls: imap.tls,
      username: imap.username,
      mailbox: imap.mailbox ?? "INBOX",
      secretRef: "env:SOVEREIGN_IMAP_SECRET_UNSET",
    };
  }

  private async resolveOpenRouterSecretRef(
    openrouter: InstallRequest["openrouter"],
  ): Promise<string> {
    if (openrouter.secretRef !== undefined && openrouter.secretRef.length > 0) {
      return openrouter.secretRef;
    }

    if (openrouter.apiKey !== undefined && openrouter.apiKey.length > 0) {
      return this.writeSecretFile("openrouter-api-key", openrouter.apiKey);
    }

    if (process.env.OPENROUTER_API_KEY !== undefined && process.env.OPENROUTER_API_KEY.length > 0) {
      return "env:OPENROUTER_API_KEY";
    }

    throw {
      code: "OPENROUTER_SECRET_MISSING",
      message:
        "OpenRouter credentials are missing (provide openrouter.apiKey or openrouter.secretRef)",
      retryable: false,
    };
  }

  private async writeSecretFile(fileName: string, value: string): Promise<string> {
    const secretsDir = await this.ensureSecretsDir();
    const filePath = join(secretsDir, fileName);
    const tempPath = `${filePath}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${value}\n`, "utf8");
    await chmod(tempPath, 0o600);
    await rename(tempPath, filePath);
    await this.applyServiceOwnership(filePath);
    return `file:${filePath}`;
  }

  private async writeManagedSecretFile(fileName: string, value: string): Promise<string> {
    try {
      await mkdir(this.paths.secretsDir, { recursive: true });
      await chmod(this.paths.secretsDir, 0o700);
      await this.applyServiceOwnership(this.paths.secretsDir);
      await access(this.paths.secretsDir, fsConstants.W_OK);
    } catch (error) {
      throw {
        code: "SECRET_WRITE_FAILED",
        message: "Managed secrets directory is not writable; rerun with sufficient privileges",
        retryable: false,
        details: {
          secretsDir: this.paths.secretsDir,
          error: describeError(error),
        },
      };
    }

    const filePath = join(this.paths.secretsDir, fileName);
    const tempPath = `${filePath}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${value}\n`, "utf8");
    await chmod(tempPath, 0o600);
    await rename(tempPath, filePath);
    await this.applyServiceOwnership(filePath);
    return `file:${filePath}`;
  }

  private async writeManagedAgentAccessTokenFile(
    runtimeConfig: RuntimeConfig,
    fileName: string,
    value: string,
  ): Promise<string> {
    const secretsDir = await this.ensureManagedAgentAccessTokenDir(runtimeConfig);
    const filePath = join(secretsDir, fileName);
    const tempPath = `${filePath}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${value}\n`, "utf8");
    await chmod(tempPath, 0o640);
    await rename(tempPath, filePath);
    await this.applyManagedAgentAccessTokenOwnership(filePath, runtimeConfig);
    return `file:${filePath}`;
  }

  private async ensureManagedAgentAccessTokenDir(runtimeConfig: RuntimeConfig): Promise<string> {
    const dir = this.getManagedAgentAccessTokenDir();
    try {
      await mkdir(dir, { recursive: true });
      // The API user owns this directory while the configured service group can read tokens.
      await chmod(dir, 0o2750);
      await this.applyManagedAgentAccessTokenOwnership(dir, runtimeConfig);
      await access(dir, fsConstants.W_OK);
      return dir;
    } catch (error) {
      throw {
        code: "SECRET_WRITE_FAILED",
        message:
          "Managed agent access token directory is not writable; rerun with sufficient privileges",
        retryable: false,
        details: {
          secretsDir: dir,
          error: describeError(error),
        },
      };
    }
  }

  private getManagedAgentAccessTokenDir(): string {
    return join(dirname(this.paths.configPath), "matrix-agent-access-tokens");
  }

  private async ensureSecretsDir(): Promise<string> {
    if (this.resolvedSecretsDir !== null) {
      return this.resolvedSecretsDir;
    }

    try {
      await mkdir(this.paths.secretsDir, { recursive: true });
      await chmod(this.paths.secretsDir, 0o700);
      await this.applyServiceOwnership(this.paths.secretsDir);
      await access(this.paths.secretsDir, fsConstants.W_OK);
      this.resolvedSecretsDir = this.paths.secretsDir;
      return this.resolvedSecretsDir;
    } catch (error) {
      const fallback = resolve(process.cwd(), ".sovereign-node-dev", "secrets");
      await mkdir(fallback, { recursive: true });
      await chmod(fallback, 0o700);
      this.logger.debug(
        {
          preferredSecretsDir: this.paths.secretsDir,
          fallbackSecretsDir: fallback,
          error: error instanceof Error ? error.message : String(error),
        },
        "Secrets dir is not writable; using local fallback for scaffold/dev execution",
      );
      this.resolvedSecretsDir = fallback;
      return fallback;
    }
  }

  private getConfiguredServiceIdentity(runtimeConfig?: RuntimeConfig): {
    user: string;
    group: string;
  } {
    const envUser = process.env.SOVEREIGN_NODE_SERVICE_USER?.trim();
    const envGroup = process.env.SOVEREIGN_NODE_SERVICE_GROUP?.trim();
    const configUser = runtimeConfig?.openclaw.serviceUser?.trim();
    const configGroup = runtimeConfig?.openclaw.serviceGroup?.trim();
    const sudoUser =
      typeof process.getuid === "function" && process.getuid() === 0
        ? process.env.SUDO_USER?.trim()
        : undefined;
    const fallbackUser =
      sudoUser !== undefined && sudoUser.length > 0 && sudoUser !== "root" ? sudoUser : undefined;
    const user =
      envUser !== undefined && envUser.length > 0
        ? envUser
        : configUser !== undefined && configUser.length > 0
          ? configUser
          : (fallbackUser ?? DEFAULT_SERVICE_USER);
    const group =
      envGroup !== undefined && envGroup.length > 0
        ? envGroup
        : configGroup !== undefined && configGroup.length > 0
          ? configGroup
          : user || DEFAULT_SERVICE_GROUP;
    return {
      user,
      group,
    };
  }

  private shouldPreferSystemGatewayService(runtimeConfig?: RuntimeConfig): boolean {
    if (typeof process.getuid !== "function" || process.getuid() !== 0) {
      return false;
    }
    const serviceIdentity = this.getConfiguredServiceIdentity(runtimeConfig);
    return serviceIdentity.user !== "root";
  }

  private async resolveRuntimeOwnership(): Promise<{ uid: number; gid: number } | null> {
    if (this.resolvedRuntimeOwnership !== undefined) {
      return this.resolvedRuntimeOwnership;
    }

    if (typeof process.getuid === "function" && process.getuid() !== 0) {
      this.resolvedRuntimeOwnership = null;
      return null;
    }

    const candidates = [
      this.paths.stateDir,
      this.paths.openclawServiceHome,
      this.paths.secretsDir,
      dirname(this.paths.configPath),
    ];
    for (const candidate of candidates) {
      try {
        const info = await stat(candidate);
        this.resolvedRuntimeOwnership = {
          uid: info.uid,
          gid: info.gid,
        };
        return this.resolvedRuntimeOwnership;
      } catch (error) {
        if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
        }
      }
    }

    this.resolvedRuntimeOwnership = null;
    return null;
  }

  private async resolveManagedAgentAccessTokenOwnership(
    runtimeConfig: RuntimeConfig,
  ): Promise<{ uid: number; gid: number } | null> {
    const serviceOwnership = await this.resolveConfiguredRuntimeOwnership(runtimeConfig);
    if (serviceOwnership === null) {
      return null;
    }

    let ownerUid: number | null = null;
    for (const candidate of [dirname(this.paths.configPath), this.paths.secretsDir]) {
      try {
        ownerUid = (await stat(candidate)).uid;
        break;
      } catch (error) {
        if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
        }
      }
    }

    return {
      uid: ownerUid ?? serviceOwnership.uid,
      gid: serviceOwnership.gid,
    };
  }

  private async applyRuntimeOwnership(path: string): Promise<void> {
    const ownership = await this.resolveRuntimeOwnership();
    await this.applyOwnership(path, ownership);
  }

  private async applyManagedAgentAccessTokenOwnership(
    path: string,
    runtimeConfig: RuntimeConfig,
  ): Promise<void> {
    const ownership = await this.resolveManagedAgentAccessTokenOwnership(runtimeConfig);
    await this.applyOwnership(path, ownership);
  }

  private async applyServiceOwnership(path: string, runtimeConfig?: RuntimeConfig): Promise<void> {
    const ownership = await this.resolveServiceOwnership(runtimeConfig);
    if (ownership !== null) {
      this.resolvedRuntimeOwnership = ownership;
      await this.applyOwnership(path, ownership);
      return;
    }
    await this.applyRuntimeOwnership(path);
  }

  private async resolveConfiguredRuntimeOwnership(
    runtimeConfig: RuntimeConfig,
  ): Promise<{ uid: number; gid: number } | null> {
    return this.resolveServiceOwnership(runtimeConfig);
  }

  private async resolveServiceOwnership(
    runtimeConfig?: RuntimeConfig,
  ): Promise<{ uid: number; gid: number } | null> {
    if (typeof process.getuid !== "function" || process.getuid() !== 0) {
      return null;
    }

    const serviceIdentity = this.getConfiguredServiceIdentity(runtimeConfig);
    if (serviceIdentity.user === "root" && serviceIdentity.group === "root") {
      return { uid: 0, gid: 0 };
    }
    if (this.execRunner === null) {
      return null;
    }

    try {
      const passwdResult = await this.execRunner.run({
        command: "getent",
        args: ["passwd", serviceIdentity.user],
        options: {
          timeout: INSTALLER_EXEC_TIMEOUT_MS,
        },
      });
      if (passwdResult.exitCode !== 0) {
        return null;
      }

      const passwdFields = passwdResult.stdout.trim().split(":");
      const uid = Number.parseInt(passwdFields[2] ?? "", 10);
      const primaryGid = Number.parseInt(passwdFields[3] ?? "", 10);
      if (!Number.isInteger(uid) || !Number.isInteger(primaryGid)) {
        return null;
      }

      if (serviceIdentity.group.length === 0 || serviceIdentity.group === serviceIdentity.user) {
        return { uid, gid: primaryGid };
      }

      const groupResult = await this.execRunner.run({
        command: "getent",
        args: ["group", serviceIdentity.group],
        options: {
          timeout: INSTALLER_EXEC_TIMEOUT_MS,
        },
      });
      if (groupResult.exitCode !== 0) {
        return { uid, gid: primaryGid };
      }

      const groupFields = groupResult.stdout.trim().split(":");
      const groupGid = Number.parseInt(groupFields[2] ?? "", 10);
      if (!Number.isInteger(groupGid)) {
        return { uid, gid: primaryGid };
      }

      return { uid, gid: groupGid };
    } catch {
      return null;
    }
  }

  private async cleanStaleTempEntries(tempDir: string): Promise<void> {
    try {
      const entries = await readdir(tempDir);
      for (const entry of entries) {
        try {
          await rm(join(tempDir, entry), { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      }
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return;
      }
      this.logger.debug(
        { tempDir, error: describeError(error) },
        "Failed to clean stale temp entries",
      );
    }
  }

  private async applyConfiguredRuntimeOwnership(
    path: string,
    runtimeConfig: RuntimeConfig,
  ): Promise<void> {
    const ownership = await this.resolveConfiguredRuntimeOwnership(runtimeConfig);
    if (ownership !== null) {
      this.resolvedRuntimeOwnership = ownership;
      await this.applyOwnership(path, ownership);
      return;
    }
    await this.applyRuntimeOwnership(path);
  }

  private async applyOwnership(
    path: string,
    ownership: { uid: number; gid: number } | null,
  ): Promise<void> {
    if (ownership === null) {
      return;
    }

    try {
      await chown(path, ownership.uid, ownership.gid);
    } catch (error) {
      if (
        isNodeError(error) &&
        (error.code === "ENOENT" || error.code === "EPERM" || error.code === "EACCES")
      ) {
        return;
      }
      this.logger.debug(
        {
          path,
          error: describeError(error),
        },
        "Failed to apply runtime ownership to installer artifact",
      );
    }
  }

  private async applyTrustedOpenClawExtensionOwnership(path: string): Promise<void> {
    if (typeof process.getuid !== "function" || process.getuid() !== 0) {
      return;
    }

    try {
      await chown(path, 0, 0);
    } catch (error) {
      if (
        isNodeError(error) &&
        (error.code === "ENOENT" || error.code === "EPERM" || error.code === "EACCES")
      ) {
        return;
      }
      this.logger.debug(
        {
          path,
          error: describeError(error),
        },
        "Failed to apply trusted ownership to OpenClaw extension artifact",
      );
    }
  }
}
