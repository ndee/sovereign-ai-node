import { randomBytes } from "node:crypto";
import { join } from "node:path";

import JSON5 from "json5";

import type { BotConfigValue } from "../bots/catalog.js";
import type { CheckResult, ComponentHealth } from "../contracts/common.js";
import type { DoctorReport } from "../contracts/index.js";
import { resolveRequestedOpenClawVersion } from "../openclaw/bootstrap.js";
import { formatTemplateRef, parseTemplateRef } from "../templates/catalog.js";
import type { SovereignTemplateKind } from "./service.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type RelayTunnelConfig = {
  serverAddr: string;
  serverPort: number;
  token: string;
  proxyName: string;
  subdomain?: string;
  type: "http";
  localIp: string;
  localPort: number;
};

export type RelayRuntimeConfig = {
  enabled: boolean;
  controlUrl: string;
  hostname: string;
  publicBaseUrl: string;
  connected: boolean;
  serviceName: string;
  configPath: string;
  tunnel: {
    serverAddr: string;
    serverPort: number;
    tokenSecretRef: string;
    proxyName: string;
    subdomain?: string;
    type: "http";
    localIp: string;
    localPort: number;
  };
};

export type CompiledHostResourceCheck =
  | {
      kind: "field-threshold";
      id: string;
      field: string;
      warnGte?: number;
      failGte?: number;
    }
  | {
      kind: "resource-state";
      id: string;
      property: "present" | "enabled" | "active" | "absent";
      equals: boolean | string;
      severity: "warn" | "fail";
    };

export type CompiledHostResource =
  | {
      id: string;
      botId: string;
      kind: "directory";
      path: string;
      mode?: string;
      owner?: string;
      group?: string;
      checks: CompiledHostResourceCheck[];
    }
  | {
      id: string;
      botId: string;
      kind: "managedFile" | "stateFile";
      path: string;
      content: string;
      mode?: string;
      owner?: string;
      group?: string;
      writePolicy: "always" | "ifMissing";
      statusFields?: Record<
        string,
        {
          path: string;
          type: "string" | "int" | "boolean" | "timestamp" | "object";
          default?: string | number | boolean | undefined;
        }
      >;
      checks: CompiledHostResourceCheck[];
    }
  | {
      id: string;
      botId: string;
      kind: "systemdService";
      name: string;
      content: string;
      desiredState: {
        enabled: boolean;
        active: boolean;
      };
      checks: CompiledHostResourceCheck[];
    }
  | {
      id: string;
      botId: string;
      kind: "systemdTimer";
      name: string;
      content: string;
      desiredState: {
        enabled: boolean;
        active: boolean;
      };
      checks: CompiledHostResourceCheck[];
    }
  | {
      id: string;
      botId: string;
      kind: "openclawCron";
      desiredState: "present" | "absent";
      match: {
        id?: string;
        name?: string;
        agentId?: string;
      };
      spec?: {
        id: string;
        agentId: string;
        every: string;
        session: "isolated";
        message: string;
        announceRoomId?: string;
      };
      checks: CompiledHostResourceCheck[];
    };

export type CompiledBotStatus = {
  botId: string;
  resourceId: string;
  path: string;
  fields: Record<
    string,
    {
      path: string;
      type: "string" | "int" | "boolean" | "timestamp" | "object";
      default?: string | number | boolean | undefined;
    }
  >;
};

export type RuntimeConfig = {
  openrouter: {
    model: string;
    apiKeySecretRef: string;
  };
  openclaw: {
    managedInstallation: boolean;
    installMethod: "install_sh";
    requestedVersion: string;
    openclawHome: string;
    runtimeConfigPath: string;
    runtimeProfilePath: string;
    gatewayEnvPath: string;
    serviceUser?: string;
    serviceGroup?: string;
  };
  openclawProfile: {
    plugins: {
      allow: string[];
    };
    session?: {
      dmScope: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
    };
    agents: Array<{
      id: string;
      workspace: string;
      default?: boolean;
      model?: string;
      templateRef?: string;
      toolInstanceIds?: string[];
      botId?: string;
      matrix?: {
        localpart: string;
        userId: string;
        passwordSecretRef?: string;
        accessTokenSecretRef?: string;
      };
    }>;
    crons: Array<{
      id: string;
      every: string;
      agentId: string;
      botId?: string;
    }>;
    cron?: {
      id: string;
      every: string;
    };
  };
  imap: {
    status: "configured" | "pending";
    host: string;
    port: number;
    tls: boolean;
    username: string;
    mailbox: string;
    secretRef: string;
  };
  bots: {
    config: Record<string, Record<string, BotConfigValue>>;
  };
  matrix: {
    accessMode: "direct" | "relay";
    homeserverDomain: string;
    federationEnabled: boolean;
    publicBaseUrl: string;
    adminBaseUrl: string;
    projectDir?: string;
    onboardingStatePath?: string;
    operator: {
      localpart?: string;
      userId: string;
      passwordSecretRef?: string;
      accessTokenSecretRef?: string;
    };
    bot: {
      localpart?: string;
      userId: string;
      passwordSecretRef?: string;
      accessTokenSecretRef: string;
    };
    alertRoom: {
      roomId: string;
      roomName: string;
    };
  };
  templates: {
    installed: Array<{
      kind: SovereignTemplateKind;
      id: string;
      version: string;
      description: string;
      trusted: boolean;
      pinned: boolean;
      keyId: string;
      manifestSha256: string;
      installedAt: string;
      source: "core" | "bot-repo";
    }>;
  };
  sovereignTools: {
    instances: Array<{
      id: string;
      templateRef: string;
      capabilities: string[];
      config: Record<string, string>;
      secretRefs: Record<string, string>;
      createdAt: string;
      updatedAt: string;
    }>;
  };
  hostResources?: {
    planPath: string;
    resources: CompiledHostResource[];
    botStatus: CompiledBotStatus[];
  };
  relay?: RelayRuntimeConfig;
};

export type RuntimeAgentEntry = RuntimeConfig["openclawProfile"]["agents"][number];

export type InstallProvenance = {
  nodeRepoUrl: string;
  nodeRef: string;
  nodeCommitSha: string;
  botsRepoUrl: string;
  botsRef: string;
  botsCommitSha: string;
  installedAt: string;
  installSource: "curl-installer" | "local-copy" | "git-clone";
};

const INSTALL_SOURCE_VALUES = new Set(["curl-installer", "local-copy", "git-clone"]);

export const parseInstallProvenance = (raw: string): InstallProvenance | null => {
  if (raw.trim().length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const fields = [
    "nodeRepoUrl",
    "nodeRef",
    "nodeCommitSha",
    "botsRepoUrl",
    "botsRef",
    "botsCommitSha",
    "installedAt",
    "installSource",
  ] as const;
  for (const field of fields) {
    if (typeof record[field] !== "string" || (record[field] as string).length === 0) {
      return null;
    }
  }
  if (!INSTALL_SOURCE_VALUES.has(record.installSource as string)) {
    return null;
  }
  return {
    nodeRepoUrl: record.nodeRepoUrl as string,
    nodeRef: record.nodeRef as string,
    nodeCommitSha: record.nodeCommitSha as string,
    botsRepoUrl: record.botsRepoUrl as string,
    botsRef: record.botsRef as string,
    botsCommitSha: record.botsCommitSha as string,
    installedAt: record.installedAt as string,
    installSource: record.installSource as InstallProvenance["installSource"],
  };
};

export type GatewayState = "running" | "stopped" | "failed" | "unknown";

export const MAIL_SENTINEL_AGENT_ID = "mail-sentinel";
export const MAIL_SENTINEL_CRON_ID = "mail-sentinel-poll";
export const NODE_OPERATOR_AGENT_ID = "node-operator";
export const MAIL_SENTINEL_HELLO_MESSAGE =
  "Hello from Mail Sentinel. I watch incoming mail, alert only on important signals, and learn from your feedback.";
export const NODE_OPERATOR_HELLO_MESSAGE =
  "Hello from Node Operator. DM me for Sovereign Node status, install health, and system checks.";
export const NODE_CLI_OPS_TEMPLATE_REF = "node-cli-ops@1.0.0";
export const IMAP_READONLY_TEMPLATE_REF = "imap-readonly@1.0.0";
export const MAIL_SENTINEL_TEMPLATE_REF = "mail-sentinel@2.0.0";
export const NODE_OPERATOR_TEMPLATE_REF = "node-operator@2.0.0";
export const NODE_OPERATOR_TOOL_INSTANCE_ID = "node-operator-cli";
export const MAIL_SENTINEL_TOOL_INSTANCE_ID = "mail-sentinel-core";
export const INSTALLER_EXEC_TIMEOUT_MS = 60_000;
export const SOVEREIGN_GATEWAY_SYSTEMD_UNIT = "sovereign-openclaw-gateway.service";
export const DEFAULT_OPENROUTER_MODEL = "qwen/qwen3.5-9b";
export const MANAGED_OPENCLAW_DM_SCOPE = "per-channel-peer";
export const DEFAULT_INSTALL_REQUEST_FILE = "/etc/sovereign-node/install-request.json";
export const DEFAULT_HOST_RESOURCES_PLAN_FILE = "/etc/sovereign-node/host-resources.json";
export const DEFAULT_SERVICE_USER = "root";
export const DEFAULT_SERVICE_GROUP = "root";
export const RELAY_TUNNEL_SYSTEMD_UNIT = "sovereign-matrix-relay-tunnel.service";
export const MAIL_SENTINEL_SCAN_SYSTEMD_SERVICE = "sovereign-mail-sentinel-scan.service";
export const MAIL_SENTINEL_SCAN_SYSTEMD_TIMER = "sovereign-mail-sentinel-scan.timer";
export const RELAY_TUNNEL_DEFAULT_IMAGE = "ghcr.io/fatedier/frpc:v0.61.1";
export const RELAY_LOCAL_EDGE_PORT = 18080;
export const RESERVED_AGENT_IDS = new Set<string>();
const now = () => new Date().toISOString();

const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

const ensureTrailingSlash = (value: string): string => (value.endsWith("/") ? value : `${value}/`);

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

const parseJsonDocument = (raw: string): unknown => {
  if (raw.trim().length === 0) {
    return {};
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    try {
      return JSON5.parse(raw) as unknown;
    } catch {
      return raw;
    }
  }
};

const parseRuntimeConfigDocument = (raw: string): RuntimeConfig | null => {
  const parsed = parseJsonDocument(raw);
  if (!isRecord(parsed)) {
    return null;
  }

  const matrix = parsed.matrix;
  if (!isRecord(matrix)) {
    return null;
  }
  const bot = matrix.bot;
  const alertRoom = matrix.alertRoom;
  const adminBaseUrl =
    typeof matrix.adminBaseUrl === "string" && matrix.adminBaseUrl.length > 0
      ? matrix.adminBaseUrl
      : matrix.publicBaseUrl;
  if (
    typeof matrix.publicBaseUrl !== "string" ||
    matrix.publicBaseUrl.length === 0 ||
    typeof adminBaseUrl !== "string" ||
    adminBaseUrl.length === 0 ||
    !isRecord(bot) ||
    typeof bot.accessTokenSecretRef !== "string" ||
    bot.accessTokenSecretRef.length === 0 ||
    !isRecord(alertRoom) ||
    typeof alertRoom.roomId !== "string" ||
    alertRoom.roomId.length === 0
  ) {
    return null;
  }

  const openclaw = isRecord(parsed.openclaw) ? parsed.openclaw : {};
  const openclawServiceHome =
    typeof openclaw.serviceHome === "string" && openclaw.serviceHome.length > 0
      ? openclaw.serviceHome
      : "/var/lib/sovereign-node/openclaw-home";
  const openclawHome =
    typeof openclaw.openclawHome === "string" && openclaw.openclawHome.length > 0
      ? openclaw.openclawHome
      : join(openclawServiceHome, ".openclaw");
  const runtimeConfigPath =
    typeof openclaw.runtimeConfigPath === "string" && openclaw.runtimeConfigPath.length > 0
      ? openclaw.runtimeConfigPath
      : join(openclawHome, "openclaw.json5");
  const runtimeProfilePath =
    typeof openclaw.runtimeProfilePath === "string" && openclaw.runtimeProfilePath.length > 0
      ? openclaw.runtimeProfilePath
      : join(openclawServiceHome, "profiles", "sovereign-runtime-profile.json5");
  const gatewayEnvPath =
    typeof openclaw.gatewayEnvPath === "string" && openclaw.gatewayEnvPath.length > 0
      ? openclaw.gatewayEnvPath
      : join(openclawServiceHome, "gateway.env");
  const serviceUser =
    typeof openclaw.serviceUser === "string" && openclaw.serviceUser.length > 0
      ? openclaw.serviceUser
      : undefined;
  const serviceGroup =
    typeof openclaw.serviceGroup === "string" && openclaw.serviceGroup.length > 0
      ? openclaw.serviceGroup
      : undefined;
  const openclawProfile = isRecord(parsed.openclawProfile) ? parsed.openclawProfile : {};
  const openclawPlugins = isRecord(openclawProfile.plugins) ? openclawProfile.plugins : {};
  const openclawSession = isRecord(openclawProfile.session) ? openclawProfile.session : {};
  const openclawDmScope =
    openclawSession.dmScope === "main" ||
    openclawSession.dmScope === "per-peer" ||
    openclawSession.dmScope === "per-channel-peer" ||
    openclawSession.dmScope === "per-account-channel-peer"
      ? openclawSession.dmScope
      : MANAGED_OPENCLAW_DM_SCOPE;
  const openclawAgents = Array.isArray(openclawProfile.agents)
    ? openclawProfile.agents.flatMap((agent): RuntimeAgentEntry[] => {
        if (
          !isRecord(agent) ||
          typeof agent.id !== "string" ||
          agent.id.length === 0 ||
          typeof agent.workspace !== "string" ||
          agent.workspace.length === 0
        ) {
          return [];
        }
        const matrixIdentity =
          isRecord(agent.matrix) &&
          typeof agent.matrix.localpart === "string" &&
          agent.matrix.localpart.length > 0 &&
          typeof agent.matrix.userId === "string" &&
          agent.matrix.userId.length > 0
            ? {
                localpart: agent.matrix.localpart,
                userId: agent.matrix.userId,
                ...(typeof agent.matrix.passwordSecretRef === "string" &&
                agent.matrix.passwordSecretRef.length > 0
                  ? { passwordSecretRef: agent.matrix.passwordSecretRef }
                  : {}),
                ...(typeof agent.matrix.accessTokenSecretRef === "string" &&
                agent.matrix.accessTokenSecretRef.length > 0
                  ? { accessTokenSecretRef: agent.matrix.accessTokenSecretRef }
                  : {}),
              }
            : undefined;
        const templateRef =
          typeof agent.templateRef === "string" && agent.templateRef.length > 0
            ? agent.templateRef
            : undefined;
        const toolInstanceIds = Array.isArray(agent.toolInstanceIds)
          ? agent.toolInstanceIds.filter(
              (entry): entry is string => typeof entry === "string" && entry.length > 0,
            )
          : undefined;
        const isDefault = agent.default === true;
        const model =
          typeof agent.model === "string" && agent.model.length > 0 ? agent.model : undefined;
        const botId =
          typeof agent.botId === "string" && agent.botId.length > 0 ? agent.botId : undefined;
        return [
          {
            id: agent.id,
            workspace: agent.workspace,
            ...(isDefault ? { default: true } : {}),
            ...(model === undefined ? {} : { model }),
            ...(templateRef === undefined ? {} : { templateRef }),
            ...(botId === undefined ? {} : { botId }),
            ...(toolInstanceIds === undefined || toolInstanceIds.length === 0
              ? {}
              : { toolInstanceIds }),
            ...(matrixIdentity === undefined ? {} : { matrix: matrixIdentity }),
          },
        ];
      })
    : [];
  const openclawCrons = Array.isArray(openclawProfile.crons)
    ? openclawProfile.crons.flatMap((entry) => {
        if (
          !isRecord(entry) ||
          typeof entry.id !== "string" ||
          entry.id.length === 0 ||
          typeof entry.every !== "string" ||
          entry.every.length === 0 ||
          typeof entry.agentId !== "string" ||
          entry.agentId.length === 0
        ) {
          return [];
        }
        return [
          {
            id: entry.id,
            every: entry.every,
            agentId: entry.agentId,
            ...(typeof entry.botId === "string" && entry.botId.length > 0
              ? { botId: entry.botId }
              : {}),
          },
        ];
      })
    : [];
  const openrouter = isRecord(parsed.openrouter) ? parsed.openrouter : {};
  const imap = isRecord(parsed.imap) ? parsed.imap : {};
  const bots = isRecord(parsed.bots) ? parsed.bots : {};
  const botConfig = isRecord(bots.config)
    ? Object.fromEntries(
        Object.entries(bots.config).flatMap((pair) => {
          const [botId, value] = pair;
          if (!isRecord(value) || botId.length === 0) {
            return [];
          }
          const configEntries = Object.entries(value).filter(
            (entry): entry is [string, BotConfigValue] =>
              typeof entry[0] === "string" &&
              entry[0].length > 0 &&
              (typeof entry[1] === "string" ||
                typeof entry[1] === "number" ||
                typeof entry[1] === "boolean"),
          );
          return [[botId, Object.fromEntries(configEntries)]];
        }),
      )
    : {};
  const templates = isRecord(parsed.templates) ? parsed.templates : {};
  const templateInstalledEntries = Array.isArray(templates.installed)
    ? templates.installed.flatMap((entry) => {
        if (
          !isRecord(entry) ||
          (entry.kind !== "agent" && entry.kind !== "tool") ||
          typeof entry.id !== "string" ||
          entry.id.length === 0 ||
          typeof entry.version !== "string" ||
          entry.version.length === 0 ||
          typeof entry.description !== "string" ||
          typeof entry.keyId !== "string" ||
          entry.keyId.length === 0 ||
          typeof entry.manifestSha256 !== "string" ||
          entry.manifestSha256.length === 0
        ) {
          return [];
        }
        const kind: SovereignTemplateKind = entry.kind === "agent" ? "agent" : "tool";
        return [
          {
            kind,
            id: entry.id,
            version: entry.version,
            description: entry.description,
            trusted: typeof entry.trusted === "boolean" ? entry.trusted : true,
            pinned: typeof entry.pinned === "boolean" ? entry.pinned : true,
            keyId: entry.keyId,
            manifestSha256: entry.manifestSha256,
            installedAt:
              typeof entry.installedAt === "string" && entry.installedAt.length > 0
                ? entry.installedAt
                : now(),
            source: entry.source === "bot-repo" ? ("bot-repo" as const) : ("core" as const),
          },
        ];
      })
    : [];
  const sovereignTools = isRecord(parsed.sovereignTools) ? parsed.sovereignTools : {};
  const sovereignToolInstances = Array.isArray(sovereignTools.instances)
    ? sovereignTools.instances.flatMap((entry) => {
        if (
          !isRecord(entry) ||
          typeof entry.id !== "string" ||
          entry.id.length === 0 ||
          typeof entry.templateRef !== "string" ||
          entry.templateRef.length === 0
        ) {
          return [];
        }
        const capabilities = Array.isArray(entry.capabilities)
          ? entry.capabilities.filter(
              (item): item is string => typeof item === "string" && item.length > 0,
            )
          : [];
        const config = isRecord(entry.config)
          ? Object.fromEntries(
              Object.entries(entry.config).filter(
                (pair): pair is [string, string] =>
                  typeof pair[0] === "string" &&
                  pair[0].length > 0 &&
                  typeof pair[1] === "string" &&
                  pair[1].length > 0,
              ),
            )
          : {};
        const secretRefs = isRecord(entry.secretRefs)
          ? Object.fromEntries(
              Object.entries(entry.secretRefs).filter(
                (pair): pair is [string, string] =>
                  typeof pair[0] === "string" &&
                  pair[0].length > 0 &&
                  typeof pair[1] === "string" &&
                  pair[1].length > 0,
              ),
            )
          : {};
        return [
          {
            id: entry.id,
            templateRef: entry.templateRef,
            capabilities,
            config,
            secretRefs,
            createdAt:
              typeof entry.createdAt === "string" && entry.createdAt.length > 0
                ? entry.createdAt
                : now(),
            updatedAt:
              typeof entry.updatedAt === "string" && entry.updatedAt.length > 0
                ? entry.updatedAt
                : now(),
          },
        ];
      })
    : [];
  const hostResources = isRecord(parsed.hostResources) ? parsed.hostResources : {};
  const compiledHostResources: CompiledHostResource[] = [];
  const parseHostChecks = (value: unknown): CompiledHostResourceCheck[] => {
    if (!Array.isArray(value)) {
      return [];
    }
    const parsedChecks: CompiledHostResourceCheck[] = [];
    for (const check of value) {
      if (!isRecord(check) || typeof check.kind !== "string" || typeof check.id !== "string") {
        continue;
      }
      if (check.kind === "field-threshold" && typeof check.field === "string") {
        const parsedCheck: CompiledHostResourceCheck = {
          kind: "field-threshold",
          id: check.id,
          field: check.field,
          ...(typeof check.warnGte === "number" ? { warnGte: check.warnGte } : {}),
          ...(typeof check.failGte === "number" ? { failGte: check.failGte } : {}),
        };
        parsedChecks.push(parsedCheck);
        continue;
      }
      if (
        check.kind === "resource-state" &&
        (check.property === "present" ||
          check.property === "enabled" ||
          check.property === "active" ||
          check.property === "absent") &&
        (typeof check.equals === "boolean" || typeof check.equals === "string") &&
        (check.severity === "warn" || check.severity === "fail")
      ) {
        parsedChecks.push({
          kind: "resource-state",
          id: check.id,
          property: check.property,
          equals: check.equals,
          severity: check.severity,
        });
      }
    }
    return parsedChecks;
  };
  const parseStatusFields = (
    value: unknown,
  ): Record<
    string,
    {
      path: string;
      type: "string" | "int" | "boolean" | "timestamp" | "object";
      default?: string | number | boolean | undefined;
    }
  > | null => {
    if (!isRecord(value)) {
      return null;
    }
    const parsedFields: Record<
      string,
      {
        path: string;
        type: "string" | "int" | "boolean" | "timestamp" | "object";
        default?: string | number | boolean | undefined;
      }
    > = {};
    for (const [fieldName, fieldValue] of Object.entries(value)) {
      if (
        !isRecord(fieldValue) ||
        typeof fieldValue.path !== "string" ||
        (fieldValue.type !== "string" &&
          fieldValue.type !== "int" &&
          fieldValue.type !== "boolean" &&
          fieldValue.type !== "timestamp" &&
          fieldValue.type !== "object")
      ) {
        continue;
      }
      parsedFields[fieldName] = {
        path: fieldValue.path,
        type: fieldValue.type,
        ...((typeof fieldValue.default === "string" ||
          typeof fieldValue.default === "number" ||
          typeof fieldValue.default === "boolean")
          ? { default: fieldValue.default }
          : {}),
      };
    }
    return parsedFields;
  };
  if (Array.isArray(hostResources.resources)) {
    for (const entry of hostResources.resources) {
      if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.botId !== "string") {
        continue;
      }
      const checks = parseHostChecks(entry.checks);
      if (entry.kind === "directory" && typeof entry.path === "string") {
        compiledHostResources.push({
          id: entry.id,
          botId: entry.botId,
          kind: "directory",
          path: entry.path,
          ...(typeof entry.mode === "string" ? { mode: entry.mode } : {}),
          ...(typeof entry.owner === "string" ? { owner: entry.owner } : {}),
          ...(typeof entry.group === "string" ? { group: entry.group } : {}),
          checks,
        });
        continue;
      }
      if (
        (entry.kind === "managedFile" || entry.kind === "stateFile") &&
        typeof entry.path === "string" &&
        typeof entry.content === "string" &&
        (entry.writePolicy === "always" || entry.writePolicy === "ifMissing")
      ) {
        const statusFields = parseStatusFields(entry.statusFields);
        compiledHostResources.push({
          id: entry.id,
          botId: entry.botId,
          kind: entry.kind,
          path: entry.path,
          content: entry.content,
          ...(typeof entry.mode === "string" ? { mode: entry.mode } : {}),
          ...(typeof entry.owner === "string" ? { owner: entry.owner } : {}),
          ...(typeof entry.group === "string" ? { group: entry.group } : {}),
          writePolicy: entry.writePolicy,
          ...(statusFields === null || Object.keys(statusFields).length === 0 ? {} : { statusFields }),
          checks,
        });
        continue;
      }
      if (
        (entry.kind === "systemdService" || entry.kind === "systemdTimer") &&
        typeof entry.name === "string" &&
        typeof entry.content === "string" &&
        isRecord(entry.desiredState) &&
        typeof entry.desiredState.enabled === "boolean" &&
        typeof entry.desiredState.active === "boolean"
      ) {
        compiledHostResources.push({
          id: entry.id,
          botId: entry.botId,
          kind: entry.kind,
          name: entry.name,
          content: entry.content,
          desiredState: {
            enabled: entry.desiredState.enabled,
            active: entry.desiredState.active,
          },
          checks,
        });
        continue;
      }
      if (
        entry.kind === "openclawCron" &&
        (entry.desiredState === "present" || entry.desiredState === "absent") &&
        isRecord(entry.match)
      ) {
        compiledHostResources.push({
          id: entry.id,
          botId: entry.botId,
          kind: "openclawCron",
          desiredState: entry.desiredState,
          match: {
            ...(typeof entry.match.id === "string" ? { id: entry.match.id } : {}),
            ...(typeof entry.match.name === "string" ? { name: entry.match.name } : {}),
            ...(typeof entry.match.agentId === "string" ? { agentId: entry.match.agentId } : {}),
          },
          ...(entry.desiredState === "present" &&
          isRecord(entry.spec) &&
          typeof entry.spec.id === "string" &&
          typeof entry.spec.agentId === "string" &&
          typeof entry.spec.every === "string" &&
          typeof entry.spec.message === "string"
            ? {
                spec: {
                  id: entry.spec.id,
                  agentId: entry.spec.agentId,
                  every: entry.spec.every,
                  session: entry.spec.session === "isolated" ? "isolated" : "isolated",
                  message: entry.spec.message,
                  ...(typeof entry.spec.announceRoomId === "string"
                    ? { announceRoomId: entry.spec.announceRoomId }
                    : {}),
                },
              }
            : {}),
          checks,
        });
      }
    }
  }
  const compiledBotStatus: CompiledBotStatus[] = [];
  if (Array.isArray(hostResources.botStatus)) {
    for (const entry of hostResources.botStatus) {
      if (
        !isRecord(entry) ||
        typeof entry.botId !== "string" ||
        typeof entry.resourceId !== "string" ||
        typeof entry.path !== "string"
      ) {
        continue;
      }
      const fields = parseStatusFields(entry.fields);
      if (fields === null) {
        continue;
      }
      compiledBotStatus.push({
        botId: entry.botId,
        resourceId: entry.resourceId,
        path: entry.path,
        fields,
      });
    }
  }
  const relay = isRecord(parsed.relay) ? parsed.relay : {};
  const operator = isRecord(matrix.operator) ? matrix.operator : {};
  const homeserverDomain =
    typeof matrix.homeserverDomain === "string" && matrix.homeserverDomain.length > 0
      ? matrix.homeserverDomain
      : inferMatrixHomeserverDomain(matrix.publicBaseUrl);
  const projectDir =
    typeof matrix.projectDir === "string" && matrix.projectDir.length > 0
      ? matrix.projectDir
      : undefined;
  const onboardingStatePath =
    typeof matrix.onboardingStatePath === "string" && matrix.onboardingStatePath.length > 0
      ? matrix.onboardingStatePath
      : undefined;
  const inferredImapConfigured =
    typeof imap.host === "string" &&
    imap.host.length > 0 &&
    imap.host !== "pending" &&
    typeof imap.secretRef === "string" &&
    imap.secretRef.length > 0;
  const relayTunnel = isRecord(relay.tunnel) ? relay.tunnel : {};
  const accessMode = matrix.accessMode === "relay" || relay.enabled === true ? "relay" : "direct";
  const relayConfig =
    relay.enabled === true &&
    typeof relay.controlUrl === "string" &&
    relay.controlUrl.length > 0 &&
    typeof relay.hostname === "string" &&
    relay.hostname.length > 0 &&
    typeof relay.publicBaseUrl === "string" &&
    relay.publicBaseUrl.length > 0 &&
    typeof relay.serviceName === "string" &&
    relay.serviceName.length > 0 &&
    typeof relay.configPath === "string" &&
    relay.configPath.length > 0 &&
    typeof relayTunnel.serverAddr === "string" &&
    relayTunnel.serverAddr.length > 0 &&
    typeof relayTunnel.serverPort === "number" &&
    Number.isFinite(relayTunnel.serverPort) &&
    typeof relayTunnel.tokenSecretRef === "string" &&
    relayTunnel.tokenSecretRef.length > 0 &&
    typeof relayTunnel.proxyName === "string" &&
    relayTunnel.proxyName.length > 0
      ? {
          enabled: true,
          controlUrl: relay.controlUrl,
          hostname: relay.hostname,
          publicBaseUrl: relay.publicBaseUrl,
          connected: typeof relay.connected === "boolean" ? relay.connected : false,
          serviceName: relay.serviceName,
          configPath: relay.configPath,
          tunnel: {
            serverAddr: relayTunnel.serverAddr,
            serverPort: Math.trunc(relayTunnel.serverPort),
            tokenSecretRef: relayTunnel.tokenSecretRef,
            proxyName: relayTunnel.proxyName,
            ...(typeof relayTunnel.subdomain === "string" && relayTunnel.subdomain.length > 0
              ? { subdomain: relayTunnel.subdomain }
              : {}),
            type: "http" as const,
            localIp:
              typeof relayTunnel.localIp === "string" && relayTunnel.localIp.length > 0
                ? relayTunnel.localIp
                : "127.0.0.1",
            localPort:
              typeof relayTunnel.localPort === "number" && Number.isFinite(relayTunnel.localPort)
                ? Math.trunc(relayTunnel.localPort)
                : RELAY_LOCAL_EDGE_PORT,
          },
        }
      : undefined;

  return {
    openclaw: {
      managedInstallation:
        typeof openclaw.managedInstallation === "boolean" ? openclaw.managedInstallation : true,
      installMethod:
        openclaw.installMethod === "install_sh" ? openclaw.installMethod : "install_sh",
      requestedVersion: resolveRequestedOpenClawVersion(
        typeof openclaw.requestedVersion === "string" ? openclaw.requestedVersion : undefined,
      ),
      openclawHome,
      runtimeConfigPath,
      runtimeProfilePath,
      gatewayEnvPath,
      ...(serviceUser === undefined ? {} : { serviceUser }),
      ...(serviceGroup === undefined ? {} : { serviceGroup }),
    },
    openrouter: {
      model:
        typeof openrouter.model === "string" && openrouter.model.length > 0
          ? openrouter.model
          : DEFAULT_OPENROUTER_MODEL,
      apiKeySecretRef:
        typeof openrouter.apiKeySecretRef === "string" && openrouter.apiKeySecretRef.length > 0
          ? openrouter.apiKeySecretRef
          : "env:OPENROUTER_API_KEY",
    },
    openclawProfile: {
      plugins: {
        allow: Array.isArray(openclawPlugins.allow)
          ? openclawPlugins.allow.filter(
              (entry): entry is string => typeof entry === "string" && entry.length > 0,
            )
          : ["matrix"],
      },
      session: {
        dmScope: openclawDmScope,
      },
      agents: openclawAgents,
      crons: openclawCrons,
      ...(openclawCrons[0] === undefined
        ? {}
        : {
            cron: {
              id: openclawCrons[0].id,
              every: openclawCrons[0].every,
            },
          }),
    },
    imap: {
      status:
        imap.status === "configured" || imap.status === "pending"
          ? imap.status
          : inferredImapConfigured
            ? "configured"
            : "pending",
      host: typeof imap.host === "string" && imap.host.length > 0 ? imap.host : "unknown",
      port:
        typeof imap.port === "number" && Number.isFinite(imap.port) ? Math.trunc(imap.port) : 993,
      tls: typeof imap.tls === "boolean" ? imap.tls : true,
      username:
        typeof imap.username === "string" && imap.username.length > 0 ? imap.username : "pending",
      mailbox: typeof imap.mailbox === "string" && imap.mailbox.length > 0 ? imap.mailbox : "INBOX",
      secretRef:
        typeof imap.secretRef === "string" && imap.secretRef.length > 0
          ? imap.secretRef
          : "env:SOVEREIGN_IMAP_SECRET_UNSET",
    },
    matrix: {
      accessMode,
      homeserverDomain,
      federationEnabled:
        typeof matrix.federationEnabled === "boolean" ? matrix.federationEnabled : false,
      publicBaseUrl: matrix.publicBaseUrl,
      adminBaseUrl,
      ...(projectDir === undefined ? {} : { projectDir }),
      ...(onboardingStatePath === undefined ? {} : { onboardingStatePath }),
      operator: {
        userId:
          typeof operator.userId === "string" && operator.userId.length > 0
            ? operator.userId
            : "@operator:local",
        ...(typeof operator.localpart === "string" && operator.localpart.length > 0
          ? { localpart: operator.localpart }
          : {}),
        ...(typeof operator.passwordSecretRef === "string" && operator.passwordSecretRef.length > 0
          ? { passwordSecretRef: operator.passwordSecretRef }
          : {}),
        ...(typeof operator.accessTokenSecretRef === "string" &&
        operator.accessTokenSecretRef.length > 0
          ? { accessTokenSecretRef: operator.accessTokenSecretRef }
          : {}),
      },
      bot: {
        userId:
          typeof bot.userId === "string" && bot.userId.length > 0
            ? bot.userId
            : "@sovereign-bot:local",
        ...(typeof bot.localpart === "string" && bot.localpart.length > 0
          ? { localpart: bot.localpart }
          : {}),
        ...(typeof bot.passwordSecretRef === "string" && bot.passwordSecretRef.length > 0
          ? { passwordSecretRef: bot.passwordSecretRef }
          : {}),
        accessTokenSecretRef: bot.accessTokenSecretRef,
      },
      alertRoom: {
        roomId: alertRoom.roomId,
        roomName:
          typeof alertRoom.roomName === "string" && alertRoom.roomName.length > 0
            ? alertRoom.roomName
            : "Sovereign Alerts",
      },
    },
    ...(relayConfig === undefined ? {} : { relay: relayConfig }),
    bots: {
      config: botConfig,
    },
    templates: {
      installed: templateInstalledEntries,
    },
    sovereignTools: {
      instances: sovereignToolInstances,
    },
    hostResources: {
      planPath:
        typeof hostResources.planPath === "string" && hostResources.planPath.length > 0
          ? hostResources.planPath
          : DEFAULT_HOST_RESOURCES_PLAN_FILE,
      resources: compiledHostResources,
      botStatus: compiledBotStatus,
    },
  };
};

const inferMatrixHomeserverDomain = (publicBaseUrl: string): string => {
  try {
    return new URL(publicBaseUrl).hostname;
  } catch {
    return "unknown";
  }
};

const sanitizeExpectedMatrixLocalpart = (value: string, fallback: string): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._=+\-/]/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : fallback;
};

const sanitizeManagedAgentId = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,62}$/.test(normalized)) {
    throw {
      code: "AGENT_ID_INVALID",
      message: "Agent id must match ^[a-z0-9][a-z0-9._-]{1,62}$",
      retryable: false,
      details: {
        input: value,
      },
    };
  }
  return normalized;
};

const sanitizeToolInstanceId = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,62}$/.test(normalized)) {
    throw {
      code: "TOOL_INSTANCE_ID_INVALID",
      message: "Tool instance id must match ^[a-z0-9][a-z0-9._-]{1,62}$",
      retryable: false,
      details: {
        input: value,
      },
    };
  }
  return normalized;
};

const sanitizeOptionalTemplateRef = (value: string | undefined): string | undefined => {
  const candidate = value?.trim();
  if (candidate === undefined || candidate.length === 0) {
    return undefined;
  }
  const parsed = parseTemplateRef(candidate);
  return formatTemplateRef(parsed.id, parsed.version);
};

const sanitizeOptionalToolInstanceIds = (value: string[] | undefined): string[] | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const deduped = Array.from(new Set(value.map((entry) => sanitizeToolInstanceId(entry))));
  return deduped;
};

const normalizeStringRecord = (value: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(value)
      .map(([key, entry]) => [key.trim(), entry.trim()] as const)
      .filter(([key, entry]) => key.length > 0 && entry.length > 0)
      .sort(([left], [right]) => left.localeCompare(right)),
  );

const areStringRecordsEqual = (
  left: Record<string, string>,
  right: Record<string, string>,
): boolean => {
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }
  for (let index = 0; index < leftEntries.length; index += 1) {
    const leftEntry = leftEntries[index];
    const rightEntry = rightEntries[index];
    if (leftEntry === undefined || rightEntry === undefined) {
      return false;
    }
    if (leftEntry[0] !== rightEntry[0] || leftEntry[1] !== rightEntry[1]) {
      return false;
    }
  }
  return true;
};

const areStringListsEqual = (left: string[], right: string[]): boolean => {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((entry, index) => entry === right[index]);
};

const sanitizeManagedWorkspace = (value: string | undefined, fallback: string): string => {
  const candidate = value?.trim();
  if (candidate === undefined || candidate.length === 0) {
    return fallback;
  }
  return candidate;
};

const sanitizeManagedAgentLocalpart = (value: string | undefined, fallback: string): string => {
  const candidate = value?.trim().toLowerCase() ?? fallback;
  const normalized = candidate.replace(/[^a-z0-9._=+\-/]/g, "_").replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : fallback;
};

const sanitizeMatrixLocalpartFromAgentId = (agentId: string): string =>
  sanitizeManagedAgentLocalpart(agentId, "agent-bot");

const generateAgentPassword = (): string => randomBytes(24).toString("base64url");

const areMatrixIdentitiesEqual = (
  left:
    | {
        localpart: string;
        userId: string;
        passwordSecretRef?: string;
        accessTokenSecretRef?: string;
      }
    | undefined,
  right:
    | {
        localpart: string;
        userId: string;
        passwordSecretRef?: string;
        accessTokenSecretRef?: string;
      }
    | undefined,
): boolean =>
  left?.localpart === right?.localpart &&
  left?.userId === right?.userId &&
  left?.passwordSecretRef === right?.passwordSecretRef &&
  left?.accessTokenSecretRef === right?.accessTokenSecretRef;

const isAlreadyJoinedOrInvitedRoomError = (status: number, body: unknown): boolean => {
  if (status !== 400 && status !== 403 && status !== 409) {
    return false;
  }
  const text = summarizeUnknown(body).toLowerCase();
  return /already in the room|is already in the room|already joined|already invited/.test(text);
};

const ensureCoreManagedAgents = (agents: RuntimeAgentEntry[]): RuntimeAgentEntry[] => {
  const byId = new Map<string, RuntimeAgentEntry>();
  for (const entry of agents) {
    if (entry.id.trim().length === 0 || entry.workspace.trim().length === 0) {
      continue;
    }
    byId.set(entry.id, {
      id: entry.id,
      workspace: entry.workspace,
      ...(entry.default === true ? { default: true } : {}),
      ...(entry.model === undefined ? {} : { model: entry.model }),
      ...(entry.templateRef === undefined ? {} : { templateRef: entry.templateRef }),
      ...(entry.botId === undefined ? {} : { botId: entry.botId }),
      ...(entry.toolInstanceIds === undefined || entry.toolInstanceIds.length === 0
        ? {}
        : { toolInstanceIds: entry.toolInstanceIds }),
      ...(entry.matrix === undefined ? {} : { matrix: entry.matrix }),
    });
  }
  const orderedIds = Array.from(byId.keys()).sort((left, right) => left.localeCompare(right));
  const resolvedDefaultAgentId =
    Array.from(byId.values()).find((entry) => entry.default === true)?.id ??
    (byId.has(NODE_OPERATOR_AGENT_ID) ? NODE_OPERATOR_AGENT_ID : orderedIds[0]);
  return orderedIds
    .map((id) => {
      const entry = byId.get(id);
      if (entry === undefined) {
        return undefined;
      }
      return {
        ...entry,
        ...(id === resolvedDefaultAgentId ? { default: true } : {}),
      };
    })
    .filter((entry): entry is RuntimeAgentEntry => entry !== undefined);
};

const isRateLimitedMatrixLoginFailure = (error: unknown): boolean => {
  if (
    !isStructuredError(error) ||
    error.code !== "MATRIX_LOGIN_FAILED" ||
    !isRecord(error.details)
  ) {
    return false;
  }
  if (error.details.status === 429) {
    return true;
  }
  return (
    typeof error.details.body === "string" &&
    /m_limit_exceeded|too many requests/i.test(error.details.body)
  );
};

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

const summarizeChecksOverall = (checks: CheckResult[]): DoctorReport["overall"] => {
  if (checks.some((entry) => entry.status === "fail")) {
    return "fail";
  }
  if (checks.some((entry) => entry.status === "warn")) {
    return "warn";
  }
  return "pass";
};

const mapHealthToServiceState = (
  health: ComponentHealth,
): "running" | "stopped" | "failed" | "unknown" => {
  if (health === "healthy" || health === "degraded") {
    return "running";
  }
  if (health === "unhealthy") {
    return "failed";
  }
  return "unknown";
};

const deriveOpenClawHealth = (input: {
  cliInstalled: boolean;
  gatewayState: GatewayState;
  healthProbeOk: boolean;
  agentPresent: boolean;
  cronPresent: boolean;
}): ComponentHealth => {
  if (!input.cliInstalled || input.gatewayState === "failed") {
    return "unhealthy";
  }
  if (input.gatewayState !== "running" || !input.healthProbeOk) {
    return "degraded";
  }
  if (!input.agentPresent || !input.cronPresent) {
    return "degraded";
  }
  return "healthy";
};

const parseGatewayState = (value: string): GatewayState => {
  const normalized = value.toLowerCase();
  if (/failed|error/.test(normalized)) {
    return "failed";
  }
  if (/\binactive\b|\bstopped\b|\bdead\b/.test(normalized)) {
    return "stopped";
  }
  if (/\brunning\b|\bactive\b/.test(normalized)) {
    return "running";
  }
  return "unknown";
};

const looksLikeMissingGateway = (value: string): boolean =>
  /not\s+installed|not-found|could not be found|unknown command|no such/i.test(value);

const textContainsId = (value: string, id: string): boolean => {
  if (id.length === 0) {
    return false;
  }
  const escaped = escapeRegExp(id);
  const regex = new RegExp(`(^|[^A-Za-z0-9_\\-])${escaped}([^A-Za-z0-9_\\-]|$)`);
  return regex.test(value);
};

const escapeRegExp = (value: string): string => value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

const parseEnvFile = (raw: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const index = trimmed.indexOf("=");
    if (index <= 0) {
      continue;
    }
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (key.length > 0) {
      out[key] = value;
    }
  }
  return out;
};

const summarizeText = (value: string, maxChars = 400): string =>
  truncateText(value.replace(/\s+/g, " ").trim(), maxChars);

const isMissingBinaryError = (value: string): boolean =>
  /command not found|no such file or directory|enoent/i.test(value);

const isGatewayUserSystemdUnavailableError = (error: unknown): boolean => {
  const messages: string[] = [];
  let gatewayCommandFailure = false;

  if (error instanceof Error) {
    messages.push(error.message);
  }

  if (isRecord(error)) {
    if (typeof error.code === "string") {
      gatewayCommandFailure =
        error.code === "OPENCLAW_GATEWAY_INSTALL_FAILED" ||
        error.code === "OPENCLAW_GATEWAY_START_FAILED" ||
        error.code === "OPENCLAW_GATEWAY_RESTART_FAILED";
    }

    if (typeof error.message === "string") {
      messages.push(error.message);
    }

    if (isRecord(error.details)) {
      if (typeof error.details.stderr === "string") {
        messages.push(error.details.stderr);
      }
      if (typeof error.details.stdout === "string") {
        messages.push(error.details.stdout);
      }
    }
  }

  const combined = messages.join("\n");
  if (!gatewayCommandFailure) {
    return false;
  }

  return /systemctl --user unavailable|failed to connect to bus|no medium found/i.test(combined);
};

const isMailSentinelGatewayUnavailableError = (error: unknown): boolean => {
  if (!isRecord(error) || error.code !== "MAIL_SENTINEL_REGISTER_FAILED") {
    return false;
  }

  const messages: string[] = [];
  if (typeof error.message === "string") {
    messages.push(error.message);
  }
  if (isRecord(error.details)) {
    const failures = error.details.failures;
    if (Array.isArray(failures)) {
      for (const failure of failures) {
        if (!isRecord(failure)) {
          continue;
        }
        if (typeof failure.stderr === "string") {
          messages.push(failure.stderr);
        }
        if (typeof failure.stdout === "string") {
          messages.push(failure.stdout);
        }
      }
    }
  }

  const combined = messages.join("\n");
  return /gateway closed|failed to connect|connection refused|econnrefused|no medium found/i.test(
    combined,
  );
};

const isAlreadyExistsOutput = (value: string): boolean =>
  /already\s+exists|already\s+bound|already\s+configured|already\s+registered/i.test(value);

const isCoreAgentBindingBestEffortSkippable = (error: unknown): boolean => {
  if (
    !isRecord(error) ||
    (error.code !== "MAIL_SENTINEL_REGISTER_FAILED" &&
      error.code !== "MANAGED_AGENT_REGISTER_FAILED")
  ) {
    return false;
  }
  const messages: string[] = [];
  if (typeof error.message === "string") {
    messages.push(error.message);
  }
  if (isRecord(error.details) && Array.isArray(error.details.failures)) {
    for (const failure of error.details.failures) {
      if (!isRecord(failure)) {
        continue;
      }
      if (typeof failure.stderr === "string") {
        messages.push(failure.stderr);
      }
      if (typeof failure.stdout === "string") {
        messages.push(failure.stdout);
      }
    }
  }
  if (isRecord(error.details)) {
    if (typeof error.details.stderr === "string") {
      messages.push(error.details.stderr);
    }
    if (typeof error.details.stdout === "string") {
      messages.push(error.details.stdout);
    }
  }
  const combined = messages.join("\n").toLowerCase();
  return /unknown command|unknown option|unexpected command|not implemented|plugins enable/.test(
    combined,
  );
};

const normalizeOpenClawAgentModel = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return DEFAULT_OPENROUTER_MODEL;
  }
  if (/^openrouter\//i.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.split("/").length === 2) {
    return `openrouter/${trimmed}`;
  }
  return trimmed;
};

const resolveVersionPinStatus = (
  runtimeConfig: RuntimeConfig | null,
  detectedOpenClaw: { version: string } | null,
): CheckResult["status"] => {
  if (detectedOpenClaw === null) {
    return "fail";
  }
  if (runtimeConfig === null) {
    return "warn";
  }

  const expected = resolveRequestedOpenClawVersion(runtimeConfig.openclaw.requestedVersion);
  return normalizeVersionToken(expected) === normalizeVersionToken(detectedOpenClaw.version)
    ? "pass"
    : "fail";
};

const describeVersionPin = (
  runtimeConfig: RuntimeConfig | null,
  detectedOpenClaw: { version: string } | null,
): string => {
  if (detectedOpenClaw === null) {
    return "OpenClaw version cannot be validated because CLI is missing";
  }
  if (runtimeConfig === null) {
    return "Sovereign runtime config is missing, so version pin cannot be validated";
  }

  const expected = resolveRequestedOpenClawVersion(runtimeConfig.openclaw.requestedVersion);

  if (normalizeVersionToken(expected) === normalizeVersionToken(detectedOpenClaw.version)) {
    return "OpenClaw version matches configured pin";
  }
  return "OpenClaw version does not match configured pin";
};

const normalizeVersionToken = (value: string): string => {
  const match = value.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
  return (match?.[0] ?? value).trim().toLowerCase();
};

const buildSuggestedCommands = (input: {
  runtimeConfig: RuntimeConfig | null;
  gateway: { installed: boolean; state: GatewayState };
  healthProbe: { ok: boolean };
  cliDetected: boolean;
  agentPresent: boolean;
  cronPresent: boolean;
  wiringCheck: CheckResult;
}): string[] => {
  const commands: string[] = [];
  if (!input.cliDetected) {
    commands.push(
      "curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --version <pinned-version> --no-onboard --no-prompt",
    );
  }
  if (!input.gateway.installed) {
    commands.push("openclaw gateway install --force");
  }
  if (input.gateway.state !== "running" || !input.healthProbe.ok) {
    commands.push("openclaw gateway restart");
    commands.push("openclaw health");
  }
  if (input.wiringCheck.status !== "pass") {
    const runtimeConfigPath =
      input.runtimeConfig?.openclaw.runtimeConfigPath ??
      "/var/lib/sovereign-node/openclaw-home/.openclaw/openclaw.json5";
    commands.push(`ls -l ${runtimeConfigPath}`);
  }
  if (!input.agentPresent || !input.cronPresent) {
    commands.push("openclaw agents list");
    commands.push("openclaw cron list");
  }
  commands.push("sovereign-node doctor --json");
  return Array.from(new Set(commands));
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

const truncateText = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}...(truncated)`;
};

const delay = async (ms: number): Promise<void> => {
  await new Promise<void>((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
};

const describeError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
};

const stripSingleTrailingNewline = (value: string): string =>
  value.endsWith("\r\n") ? value.slice(0, -2) : value.endsWith("\n") ? value.slice(0, -1) : value;

const normalizeTestAlertError = (
  error: unknown,
): {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
} => {
  if (isStructuredError(error)) {
    return error;
  }

  if (error instanceof Error) {
    return {
      code: "TEST_ALERT_FAILED",
      message: error.message,
      retryable: true,
    };
  }

  return {
    code: "TEST_ALERT_FAILED",
    message: String(error),
    retryable: true,
  };
};

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
    typeof value.code === "string" &&
    typeof value.message === "string" &&
    typeof value.retryable === "boolean"
  );
};

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  typeof error === "object" && error !== null && "code" in error;

export {
  now,
  defaultFetch,
  ensureTrailingSlash,
  parseJsonSafely,
  parseJsonDocument,
  parseRuntimeConfigDocument,
  sanitizeExpectedMatrixLocalpart,
  sanitizeManagedAgentId,
  sanitizeToolInstanceId,
  sanitizeOptionalTemplateRef,
  sanitizeOptionalToolInstanceIds,
  normalizeStringRecord,
  areStringRecordsEqual,
  areStringListsEqual,
  sanitizeManagedWorkspace,
  sanitizeManagedAgentLocalpart,
  sanitizeMatrixLocalpartFromAgentId,
  generateAgentPassword,
  areMatrixIdentitiesEqual,
  isAlreadyJoinedOrInvitedRoomError,
  ensureCoreManagedAgents,
  isRateLimitedMatrixLoginFailure,
  check,
  summarizeChecksOverall,
  mapHealthToServiceState,
  deriveOpenClawHealth,
  parseGatewayState,
  looksLikeMissingGateway,
  textContainsId,
  escapeRegExp,
  parseEnvFile,
  summarizeText,
  isMissingBinaryError,
  isGatewayUserSystemdUnavailableError,
  isMailSentinelGatewayUnavailableError,
  isAlreadyExistsOutput,
  isCoreAgentBindingBestEffortSkippable,
  normalizeOpenClawAgentModel,
  resolveVersionPinStatus,
  describeVersionPin,
  normalizeVersionToken,
  buildSuggestedCommands,
  summarizeUnknown,
  truncateText,
  delay,
  describeError,
  stripSingleTrailingNewline,
  normalizeTestAlertError,
  isRecord,
  isStructuredError,
  isNodeError,
};
