import { z } from "zod";

const hostBindingPrimitiveSchema = z.union([z.string(), z.number().finite(), z.boolean()]);

export const enabledWhenSchema = z.object({
  path: z.string().min(1),
  equals: hostBindingPrimitiveSchema.optional(),
});

type HostValueExpr =
  | z.infer<typeof hostBindingPrimitiveSchema>
  | { from: string }
  | { join: HostValueExpr[] }
  | { default: [HostValueExpr, z.infer<typeof hostBindingPrimitiveSchema>] }
  | { convert: "duration.toSystemd"; value: HostValueExpr };

export const hostValueExprSchema: z.ZodType<HostValueExpr> = z.lazy(() =>
  z.union([
    hostBindingPrimitiveSchema,
    z.object({ from: z.string().min(1) }),
    z.object({ join: z.array(hostValueExprSchema).min(1) }),
    z.object({ default: z.tuple([hostValueExprSchema, hostBindingPrimitiveSchema]) }),
    z.object({ convert: z.literal("duration.toSystemd"), value: hostValueExprSchema }),
  ]),
);

export const hostWritePolicySchema = z.enum(["always", "ifMissing"]);

export const hostStateFieldSchema = z.object({
  path: z.string().min(1),
  type: z.enum(["string", "int", "boolean", "timestamp", "object"]),
  default: z.union([z.string(), z.number().int(), z.boolean()]).optional(),
});

export const hostStateCheckSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("field-threshold"),
    id: z.string().min(1),
    field: z.string().min(1),
    warnGte: z.number().finite().optional(),
    failGte: z.number().finite().optional(),
  }),
  z.object({
    kind: z.literal("resource-state"),
    id: z.string().min(1),
    property: z.enum(["present", "enabled", "active", "absent"]),
    equals: z.union([z.boolean(), z.string().min(1)]),
    severity: z.enum(["warn", "fail"]),
  }),
]);

export const hostSupersedeMatcherSchema = z.object({
  kind: z.enum(["openclawCron", "systemdService", "systemdTimer", "file", "directory"]),
  match: z.object({
    id: z.string().min(1).optional(),
    name: hostValueExprSchema.optional(),
    agentId: hostValueExprSchema.optional(),
    path: z.string().min(1).optional(),
  }),
});

const hostDirectoryResourceSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("directory"),
  enabledWhen: enabledWhenSchema.optional(),
  dependsOn: z.array(z.string().min(1)).default([]),
  supersedes: z.array(hostSupersedeMatcherSchema).default([]),
  spec: z.object({
    path: hostValueExprSchema,
    mode: z
      .string()
      .regex(/^[0-7]{3,4}$/)
      .optional(),
    owner: hostValueExprSchema.optional(),
    group: hostValueExprSchema.optional(),
  }),
  status: z
    .object({
      reportAs: z.string().min(1).optional(),
    })
    .optional(),
  checks: z.array(hostStateCheckSchema).default([]),
});

const hostManagedFileResourceSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("managedFile"),
  enabledWhen: enabledWhenSchema.optional(),
  dependsOn: z.array(z.string().min(1)).default([]),
  supersedes: z.array(hostSupersedeMatcherSchema).default([]),
  spec: z.object({
    path: hostValueExprSchema,
    source: z.string().min(1).optional(),
    inlineContent: z.string().optional(),
    mode: z
      .string()
      .regex(/^[0-7]{3,4}$/)
      .optional(),
    owner: hostValueExprSchema.optional(),
    group: hostValueExprSchema.optional(),
    writePolicy: hostWritePolicySchema.default("always"),
  }),
  status: z
    .object({
      reportAs: z.string().min(1).optional(),
    })
    .optional(),
  checks: z.array(hostStateCheckSchema).default([]),
});

const hostStateFileResourceSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("stateFile"),
  enabledWhen: enabledWhenSchema.optional(),
  dependsOn: z.array(z.string().min(1)).default([]),
  supersedes: z.array(hostSupersedeMatcherSchema).default([]),
  spec: z.object({
    path: hostValueExprSchema,
    source: z.string().min(1).optional(),
    inlineContent: z.string().optional(),
    mode: z
      .string()
      .regex(/^[0-7]{3,4}$/)
      .optional(),
    owner: hostValueExprSchema.optional(),
    group: hostValueExprSchema.optional(),
    writePolicy: hostWritePolicySchema.default("ifMissing"),
  }),
  status: z
    .object({
      fields: z.record(z.string(), hostStateFieldSchema).default({}),
    })
    .default({ fields: {} }),
  checks: z.array(hostStateCheckSchema).default([]),
});

const hostSystemdServiceResourceSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("systemdService"),
  enabledWhen: enabledWhenSchema.optional(),
  dependsOn: z.array(z.string().min(1)).default([]),
  supersedes: z.array(hostSupersedeMatcherSchema).default([]),
  spec: z.object({
    name: hostValueExprSchema,
    description: hostValueExprSchema,
    after: z.array(hostValueExprSchema).default([]),
    wants: z.array(hostValueExprSchema).default([]),
    type: z.enum(["simple", "oneshot"]).default("simple"),
    user: hostValueExprSchema.optional(),
    group: hostValueExprSchema.optional(),
    workingDirectory: hostValueExprSchema.optional(),
    environment: z.record(z.string(), hostValueExprSchema).default({}),
    execStart: z.array(hostValueExprSchema).min(1),
    timeoutStartSec: z.number().int().positive().optional(),
    restart: z.string().min(1).optional(),
    restartSec: hostValueExprSchema.optional(),
    wantedBy: z.array(hostValueExprSchema).default([]),
    desiredState: z
      .object({
        enabled: z.boolean().default(true),
        active: z.boolean().default(true),
      })
      .default({ enabled: true, active: true }),
  }),
  status: z.object({ reportAs: z.string().min(1).optional() }).optional(),
  checks: z.array(hostStateCheckSchema).default([]),
});

const hostSystemdTimerResourceSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("systemdTimer"),
  enabledWhen: enabledWhenSchema.optional(),
  dependsOn: z.array(z.string().min(1)).default([]),
  supersedes: z.array(hostSupersedeMatcherSchema).default([]),
  spec: z.object({
    name: hostValueExprSchema,
    description: hostValueExprSchema,
    unit: hostValueExprSchema.optional(),
    onActiveSec: hostValueExprSchema.optional(),
    onBootSec: hostValueExprSchema.optional(),
    onUnitActiveSec: hostValueExprSchema.optional(),
    accuracySec: hostValueExprSchema.optional(),
    persistent: z.boolean().optional(),
    wantedBy: z.array(hostValueExprSchema).default([]),
    desiredState: z
      .object({
        enabled: z.boolean().default(true),
        active: z.boolean().default(true),
      })
      .default({ enabled: true, active: true }),
  }),
  status: z.object({ reportAs: z.string().min(1).optional() }).optional(),
  checks: z.array(hostStateCheckSchema).default([]),
});

const hostOpenClawCronResourceSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("openclawCron"),
  enabledWhen: enabledWhenSchema.optional(),
  dependsOn: z.array(z.string().min(1)).default([]),
  supersedes: z.array(hostSupersedeMatcherSchema).default([]),
  spec: z.object({
    id: hostValueExprSchema,
    agentId: hostValueExprSchema,
    every: hostValueExprSchema,
    session: z.enum(["isolated"]).default("isolated"),
    message: hostValueExprSchema,
    announceRoomId: hostValueExprSchema.optional(),
    desiredState: z.enum(["present", "absent"]).default("present"),
  }),
  status: z.object({ reportAs: z.string().min(1).optional() }).optional(),
  checks: z.array(hostStateCheckSchema).default([]),
});

export const hostResourceSchema = z.discriminatedUnion("kind", [
  hostDirectoryResourceSchema,
  hostManagedFileResourceSchema,
  hostStateFileResourceSchema,
  hostSystemdServiceResourceSchema,
  hostSystemdTimerResourceSchema,
  hostOpenClawCronResourceSchema,
]);

export const hostResourcesSchema = z.array(hostResourceSchema).default([]);

export type HostBindingPrimitive = z.infer<typeof hostBindingPrimitiveSchema>;
export type HostResourceValueExpr = z.infer<typeof hostValueExprSchema>;
export type SovereignBotHostResource = z.infer<typeof hostResourceSchema>;
export type SovereignBotHostStateCheck = z.infer<typeof hostStateCheckSchema>;
