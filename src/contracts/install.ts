import { z } from "zod";

import {
  checkResultSchema,
  componentHealthSchema,
  errorDetailSchema,
  idSchema,
  isoTimestampSchema,
} from "./common.js";

export const jobStateSchema = z.enum(["pending", "running", "succeeded", "failed", "canceled"]);

export const stepStateSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "canceled",
  "skipped",
  "warned",
]);

export const jobStepIdSchema = z.enum([
  "preflight",
  "openclaw_bootstrap_cli",
  "openclaw_bundled_plugin_tools",
  "imap_validate",
  "relay_enroll",
  "matrix_provision",
  "matrix_bootstrap_accounts",
  "matrix_bootstrap_room",
  "openclaw_gateway_service_install",
  "openclaw_configure",
  "bots_configure",
  "mail_sentinel_scan_timer",
  "mail_sentinel_register",
  "smoke_checks",
  "test_alert",
]);

export const jobStepSchema = z.object({
  id: jobStepIdSchema,
  label: z.string().min(1),
  state: stepStateSchema,
  startedAt: isoTimestampSchema.optional(),
  endedAt: isoTimestampSchema.optional(),
  error: errorDetailSchema.optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const installJobSummarySchema = z.object({
  jobId: idSchema,
  state: jobStateSchema,
  createdAt: isoTimestampSchema,
  startedAt: isoTimestampSchema.optional(),
  endedAt: isoTimestampSchema.optional(),
  steps: z.array(jobStepSchema),
  currentStepId: jobStepIdSchema.optional(),
});

export const openclawInstallRequestSchema = z.object({
  manageInstallation: z.boolean().optional(),
  installMethod: z.literal("install_sh").optional(),
  version: z.string().min(1).optional(),
  skipIfCompatibleInstalled: z.boolean().optional(),
  forceReinstall: z.boolean().optional(),
  runOnboard: z.literal(false).optional(),
});

export const imapInstallInputSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive(),
  tls: z.boolean(),
  username: z.string().min(1),
  password: z.string().min(1).optional(),
  secretRef: z.string().min(1).optional(),
  mailbox: z.string().min(1).optional(),
});

export const openrouterInstallInputSchema = z
  .object({
    model: z.string().min(1).optional(),
    apiKey: z.string().min(1).optional(),
    secretRef: z.string().min(1).optional(),
  })
  .refine(
    (value: {
      model?: string | undefined;
      apiKey?: string | undefined;
      secretRef?: string | undefined;
    }) => value.apiKey !== undefined || value.secretRef !== undefined,
    {
      message: "openrouter.apiKey or openrouter.secretRef is required",
      path: ["secretRef"],
    },
  );

export const connectivityInstallInputSchema = z.object({
  mode: z.enum(["direct", "relay"]).optional(),
});

export const relayInstallInputSchema = z.object({
  controlUrl: z.string().min(1),
  enrollmentToken: z.string().min(1).optional(),
});

export const matrixInstallInputSchema = z.object({
  homeserverDomain: z.string().min(1),
  publicBaseUrl: z.string().min(1),
  federationEnabled: z.boolean().optional(),
  tlsMode: z.enum(["auto", "internal", "manual", "local-dev"]).optional(),
  alertRoomName: z.string().min(1).optional(),
});

export const operatorInstallInputSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1).optional(),
});

export const botConfigValueSchema = z.union([z.string(), z.number().finite(), z.boolean()]);

export const botsInstallInputSchema = z.object({
  selected: z.array(z.string().min(1)).optional(),
  config: z.record(z.string(), z.record(z.string(), botConfigValueSchema)).optional(),
});

export const advancedInstallInputSchema = z.object({
  rollbackPolicy: z.enum(["safe_partial", "manual", "aggressive_non_destructive"]).optional(),
  skipPreflight: z.boolean().optional(),
  nonInteractive: z.boolean().optional(),
});

export const installRequestSchema = z.object({
  mode: z.literal("bundled_matrix"),
  connectivity: connectivityInstallInputSchema.optional(),
  relay: relayInstallInputSchema.optional(),
  openclaw: openclawInstallRequestSchema.optional(),
  openrouter: openrouterInstallInputSchema,
  imap: imapInstallInputSchema.optional(),
  matrix: matrixInstallInputSchema,
  operator: operatorInstallInputSchema,
  bots: botsInstallInputSchema.optional(),
  advanced: advancedInstallInputSchema.optional(),
});

export const preflightResultSchema = z.object({
  mode: z.literal("bundled_matrix"),
  overall: z.enum(["pass", "warn", "fail"]),
  checks: z.array(checkResultSchema),
  recommendedActions: z.array(z.string()),
});

export const serviceStatusSchema = z.object({
  name: z.string().min(1),
  kind: z.enum([
    "sovereign-node",
    "openclaw",
    "synapse",
    "postgres",
    "reverse-proxy",
    "relay-tunnel",
  ]),
  health: componentHealthSchema,
  state: z.enum(["running", "stopped", "failed", "unknown"]),
  message: z.string().optional(),
});

export const testAlertResultSchema = z.object({
  delivered: z.boolean(),
  target: z.object({
    channel: z.literal("matrix"),
    roomId: z.string().min(1),
  }),
  messageId: z.string().min(1).optional(),
  sentAt: isoTimestampSchema.optional(),
  error: errorDetailSchema.optional(),
});

const hostResourceStateSchema = z.object({
  id: z.string().min(1),
  botId: z.string().min(1),
  kind: z.enum(["directory", "managedFile", "stateFile", "systemdService", "systemdTimer", "openclawCron"]),
  target: z.string().min(1),
  present: z.boolean().optional(),
  enabled: z.boolean().optional(),
  active: z.boolean().optional(),
  health: componentHealthSchema,
  message: z.string().min(1).optional(),
});

const botRuntimeStatusSchema = z.object({
  fields: z.record(z.string(), z.union([z.string(), z.number().int(), z.boolean(), z.record(z.string(), z.unknown())])).default({}),
  health: componentHealthSchema,
});

export const installResultSchema = z.object({
  installationId: idSchema,
  job: installJobSummarySchema,
  mode: z.literal("bundled_matrix"),
  matrix: z.object({
    homeserverUrl: z.string().min(1),
    federationEnabled: z.boolean(),
    operatorUserId: z.string().min(1),
    botUserId: z.string().min(1),
    alertRoomId: z.string().min(1),
    alertRoomName: z.string().min(1),
    e2eeEnabled: z.boolean(),
  }),
  relay: z
    .object({
      enabled: z.boolean(),
      hostname: z.string().min(1),
      publicBaseUrl: z.string().min(1),
      serviceInstalled: z.boolean(),
      serviceState: z.enum(["running", "stopped", "failed", "unknown"]).optional(),
      connected: z.boolean(),
    })
    .optional(),
  openclaw: z.object({
    installManagedBySovereign: z.boolean(),
    installMethod: z.literal("install_sh"),
    version: z.string().min(1),
    binaryPath: z.string().min(1),
    configPath: z.string().min(1),
    openclawHome: z.string().min(1),
    gatewayServiceInstalled: z.boolean(),
    gatewayServiceName: z.string().min(1).optional(),
    managedAgentIds: z.array(z.string().min(1)),
    managedCronIds: z.array(z.string().min(1)),
    pluginIds: z.array(z.string().min(1)),
  }),
  paths: z.object({
    configPath: z.string().min(1),
    hostResourcesPlanPath: z.string().min(1),
    secretsDir: z.string().min(1),
    stateDir: z.string().min(1),
    logsDir: z.string().min(1),
  }),
  checks: z.object({
    preflight: preflightResultSchema,
    smoke: z.array(checkResultSchema),
    testAlert: testAlertResultSchema,
  }),
  nextSteps: z.object({
    elementHomeserverUrl: z.string().min(1),
    operatorUsername: z.string().min(1),
    roomId: z.string().min(1),
    roomName: z.string().min(1),
    notes: z.array(z.string()),
  }),
});

export const installJobStatusResponseSchema = z.object({
  job: installJobSummarySchema,
  result: installResultSchema.optional(),
  error: errorDetailSchema.optional(),
});

export const sovereignStatusSchema = z.object({
  installationId: idSchema.optional(),
  mode: z.literal("bundled_matrix"),
  services: z.array(serviceStatusSchema),
  relay: z
    .object({
      enabled: z.boolean(),
      controlUrl: z.string().min(1).optional(),
      hostname: z.string().min(1).optional(),
      publicBaseUrl: z.string().min(1).optional(),
      connected: z.boolean(),
      serviceInstalled: z.boolean(),
      serviceState: z.enum(["running", "stopped", "failed", "unknown"]).optional(),
    })
    .optional(),
  matrix: z.object({
    homeserverUrl: z.string().min(1).optional(),
    health: componentHealthSchema,
    roomReachable: z.boolean(),
    federationEnabled: z.boolean(),
    alertRoomId: z.string().min(1).optional(),
  }),
  openclaw: z.object({
    managedBySovereign: z.boolean(),
    cliInstalled: z.boolean(),
    binaryPath: z.string().min(1).optional(),
    version: z.string().min(1).optional(),
    health: componentHealthSchema,
    serviceInstalled: z.boolean(),
    serviceState: z.enum(["running", "stopped", "failed", "unknown"]).optional(),
    configPath: z.string().min(1).optional(),
    agentPresent: z.boolean(),
    cronPresent: z.boolean(),
    pluginIds: z.array(z.string().min(1)).optional(),
  }),
  bots: z.record(z.string().min(1), botRuntimeStatusSchema),
  hostResources: z.array(hostResourceStateSchema),
  imap: z.object({
    lastCredentialTestAt: isoTimestampSchema.optional(),
    authStatus: z.enum(["ok", "failed", "unknown"]),
    host: z.string().min(1).optional(),
    mailbox: z.string().min(1).optional(),
  }),
  version: z.object({
    sovereignNode: z.string().min(1).optional(),
    contractVersion: z.string().min(1),
    openclaw: z.string().min(1).optional(),
    plugins: z.record(z.string(), z.string()).optional(),
    provenance: z
      .object({
        nodeRepoUrl: z.string().min(1),
        nodeRef: z.string().min(1),
        nodeCommitSha: z.string().min(1),
        botsRepoUrl: z.string().min(1),
        botsRef: z.string().min(1),
        botsCommitSha: z.string().min(1),
        installedAt: z.string().min(1),
        installSource: z.enum(["curl-installer", "local-copy", "git-clone"]),
      })
      .optional(),
  }),
});

export const doctorReportSchema = z.object({
  overall: z.enum(["pass", "warn", "fail"]),
  checks: z.array(checkResultSchema),
  suggestedCommands: z.array(z.string()),
});

export const reconfigureResultSchema = z.object({
  target: z.enum(["imap", "matrix", "openrouter"]),
  changed: z.array(z.string()),
  restartRequiredServices: z.array(z.string()),
  validation: z.array(checkResultSchema),
});

export const matrixOnboardingIssueResultSchema = z.object({
  code: z.string().min(1),
  expiresAt: isoTimestampSchema,
  onboardingUrl: z.string().min(1),
  onboardingLink: z.string().min(1),
  username: z.string().min(1),
});

export const testImapResultSchema = z.object({
  ok: z.boolean(),
  host: z.string().min(1),
  port: z.number().int().positive(),
  tls: z.boolean(),
  auth: z.enum(["ok", "failed"]),
  mailbox: z.string().min(1).optional(),
  capabilities: z.array(z.string()).optional(),
  error: errorDetailSchema.optional(),
});

export const testMatrixResultSchema = z.object({
  ok: z.boolean(),
  homeserverUrl: z.string().min(1),
  clientDiscovery: z
    .object({
      required: z.boolean(),
      ok: z.boolean(),
    })
    .optional(),
  serverDiscovery: z
    .object({
      required: z.boolean(),
      ok: z.boolean(),
    })
    .optional(),
  checks: z.array(checkResultSchema),
});

export const startInstallResultSchema = z.object({
  job: installJobSummarySchema,
});

export type JobStepId = z.infer<typeof jobStepIdSchema>;
export type JobStep = z.infer<typeof jobStepSchema>;
export type InstallRequest = z.infer<typeof installRequestSchema>;
export type PreflightResult = z.infer<typeof preflightResultSchema>;
export type InstallJobSummary = z.infer<typeof installJobSummarySchema>;
export type InstallResult = z.infer<typeof installResultSchema>;
export type InstallJobStatusResponse = z.infer<typeof installJobStatusResponseSchema>;
export type SovereignStatus = z.infer<typeof sovereignStatusSchema>;
export type DoctorReport = z.infer<typeof doctorReportSchema>;
export type TestAlertResult = z.infer<typeof testAlertResultSchema>;
export type ReconfigureResult = z.infer<typeof reconfigureResultSchema>;
export type TestImapResult = z.infer<typeof testImapResultSchema>;
export type TestMatrixResult = z.infer<typeof testMatrixResultSchema>;
export type StartInstallResult = z.infer<typeof startInstallResultSchema>;
export type MatrixOnboardingIssueResult = z.infer<typeof matrixOnboardingIssueResultSchema>;
