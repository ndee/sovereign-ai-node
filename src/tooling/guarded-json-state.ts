import { appendFile, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { z } from "zod";

import { DEFAULT_PATHS } from "../config/paths.js";
import type { RuntimeConfig } from "../installer/real-service-shared.js";
import { parseRuntimeConfigDocument } from "../installer/real-service-shared.js";
import { parseTemplateRef } from "../templates/catalog.js";

const GUARDED_JSON_STATE_TEMPLATE_ID = "guarded-json-state";
const LOCK_RETRY_DELAY_MS = 50;
const LOCK_RETRY_ATTEMPTS = 200;

type RuntimeConfigLoader = (configPath: string) => Promise<RuntimeConfig>;

type ScalarFields = Record<string, string>;
type ArrayFields = Record<string, string[]>;

type FieldType = "string" | "string[]";

type ResolvedToolInstance = {
  instanceId: string;
  configPath: string;
  statePath: string;
  policyPath: string;
  auditPath?: string;
};

type RootArrayEntityPolicy = z.infer<typeof rootArrayEntityPolicySchema>;
type ChildArrayEntityPolicy = z.infer<typeof childArrayEntityPolicySchema>;
type GuardedJsonStateEntityPolicy = RootArrayEntityPolicy | ChildArrayEntityPolicy;
type GuardedJsonStatePolicy = z.infer<typeof guardedJsonStatePolicySchema>;

const defaultValueSchema = z.union([z.string(), z.array(z.string())]);

const rootArrayEntityPolicySchema = z.object({
  kind: z.literal("owner-root-array"),
  collection: z.string().min(1),
  ownerField: z.string().min(1),
  keyField: z.string().min(1),
  selfKeyTemplate: z.string().min(1).optional(),
  createdAtField: z.string().min(1).optional(),
  updatedAtField: z.string().min(1).optional(),
  updatedByField: z.string().min(1).optional(),
  createdByDisplayField: z.string().min(1).optional(),
  updatedByDisplayField: z.string().min(1).optional(),
  defaults: z.record(z.string(), defaultValueSchema).default({}),
  inputFields: z.record(z.string(), z.enum(["string", "string[]"])).default({}),
});

const childArrayEntityPolicySchema = z.object({
  kind: z.literal("owner-child-array"),
  parentCollection: z.string().min(1),
  parentOwnerField: z.string().min(1),
  parentKeyField: z.string().min(1),
  parentSelfKeyTemplate: z.string().min(1),
  ensureParentEntity: z.string().min(1).optional(),
  childArrayField: z.string().min(1),
  keyField: z.string().min(1),
  selfKeyTemplate: z.string().min(1).optional(),
  updatedAtField: z.string().min(1).optional(),
  defaults: z.record(z.string(), defaultValueSchema).default({}),
  inputFields: z.record(z.string(), z.enum(["string", "string[]"])).default({}),
});

const guardedJsonStatePolicySchema = z.object({
  version: z.literal(1),
  lastUpdatedPath: z.string().min(1).optional(),
  entities: z.record(
    z.string(),
    z.union([rootArrayEntityPolicySchema, childArrayEntityPolicySchema]),
  ),
});

export class GuardedJsonStateToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly details?: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GuardedJsonStateToolError";
  }
}

const defaultRuntimeConfigLoader: RuntimeConfigLoader = async (configPath) => {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    throw new GuardedJsonStateToolError(
      "RUNTIME_CONFIG_READ_FAILED",
      `Failed to read Sovereign runtime config at ${configPath}`,
      false,
      {
        configPath,
        error: error instanceof Error ? error.message : String(error),
      },
      { cause: error instanceof Error ? error : undefined },
    );
  }

  const parsed = parseRuntimeConfigDocument(raw);
  if (parsed === null) {
    throw new GuardedJsonStateToolError(
      "RUNTIME_CONFIG_INVALID",
      `Sovereign runtime config at ${configPath} is missing required fields`,
      false,
      {
        configPath,
      },
    );
  }

  return parsed;
};

const defaultConfigPath = (): string =>
  process.env.SOVEREIGN_NODE_CONFIG ?? DEFAULT_PATHS.configPath;

const stripSingleTrailingNewline = (value: string): string => value.replace(/\r?\n$/, "");

const actorUserIdSchema = z.string().regex(/^@[^:\s]+:[^\s]+$/, "Expected a full Matrix user id");
const directMatrixSessionKeySchema = z
  .string()
  .regex(
    /(^|:)(session:)?agent:[^:\s]+:matrix:direct:@[^:\s]+:[^\s]+$/,
    "Expected a Matrix direct-message session key",
  );
const matrixOriginFromSchema = z
  .string()
  .regex(/^(matrix:)?@[^:\s]+:[^\s]+$/, "Expected a Matrix sender reference");

const nowIso = (): string => new Date().toISOString();

const compactIsoTimestamp = (value: string): string =>
  value.replaceAll("-", "").replaceAll(":", "").replaceAll(".", "");

export const normalizeMatrixActorUserId = (value: string): string => {
  const trimmed = value.trim();
  const candidate = trimmed.startsWith("matrix:") ? trimmed.slice("matrix:".length) : trimmed;
  return actorUserIdSchema.parse(candidate);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const _normalizePath = (value: string): string =>
  isAbsolute(value) ? value : resolve(process.cwd(), value);

const resolveRelativeToBase = (value: string, baseDir: string): string =>
  isAbsolute(value) ? value : resolve(baseDir, value);

const ensureRecord = (value: unknown, message: string): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new GuardedJsonStateToolError("STATE_INVALID", message, false);
  }
  return value;
};

const ensureArray = (value: unknown, message: string): Array<Record<string, unknown>> => {
  if (!Array.isArray(value)) {
    throw new GuardedJsonStateToolError("STATE_INVALID", message, false);
  }
  for (const entry of value) {
    if (!isRecord(entry)) {
      throw new GuardedJsonStateToolError("STATE_INVALID", message, false);
    }
  }
  return value as Array<Record<string, unknown>>;
};

const getPathValue = (root: Record<string, unknown>, path: string): unknown =>
  path.split(".").reduce<unknown>((current, segment) => {
    if (!isRecord(current) || !(segment in current)) {
      return undefined;
    }
    return current[segment];
  }, root);

const setPathValue = (root: Record<string, unknown>, path: string, value: unknown): void => {
  const segments = path.split(".").filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return;
  }
  let current: Record<string, unknown> = root;
  for (const segment of segments.slice(0, -1)) {
    const existing = current[segment];
    if (!isRecord(existing)) {
      current[segment] = {};
    }
    current = ensureRecord(current[segment], `State path '${path}' could not be created`);
  }
  current[segments[segments.length - 1]!] = value;
};

const renderTemplateString = (
  template: string,
  context: {
    actor: string;
    actorLocalpart: string;
    now: string;
    input: Record<string, string | string[]>;
  },
): string =>
  template.replaceAll(/\{([^}]+)\}/g, (_match, token: string) => {
    if (token === "actor") {
      return context.actor;
    }
    if (token === "actorLocalpart") {
      return context.actorLocalpart;
    }
    if (token === "now") {
      return context.now;
    }
    if (token === "nowCompact") {
      return compactIsoTimestamp(context.now);
    }
    if (token.startsWith("input.")) {
      const key = token.slice("input.".length);
      const value = context.input[key];
      if (typeof value === "string") {
        return value;
      }
      throw new GuardedJsonStateToolError(
        "POLICY_TEMPLATE_INPUT_MISSING",
        `Template requires scalar input field '${key}'`,
        false,
        {
          template,
          key,
        },
      );
    }
    throw new GuardedJsonStateToolError(
      "POLICY_TEMPLATE_INVALID",
      `Unsupported template token '${token}'`,
      false,
      {
        template,
        token,
      },
    );
  });

const expandDefaults = (
  defaults: Record<string, string | string[]>,
  context: {
    actor: string;
    actorLocalpart: string;
    now: string;
    input: Record<string, string | string[]>;
  },
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(defaults).map(([key, value]) => [
      key,
      typeof value === "string"
        ? renderTemplateString(value, context)
        : value.map((entry) => renderTemplateString(entry, context)),
    ]),
  );

const actorLocalpart = (actor: string): string => {
  const normalized = actorUserIdSchema.parse(actor);
  const withoutAt = normalized.slice(1);
  const separatorIndex = withoutAt.indexOf(":");
  return separatorIndex >= 0 ? withoutAt.slice(0, separatorIndex) : withoutAt;
};

const extractActorFromDirectMatrixSessionKey = (sessionKey: string): string | null => {
  if (!directMatrixSessionKeySchema.safeParse(sessionKey).success) {
    return null;
  }
  const marker = ":matrix:direct:";
  const markerIndex = sessionKey.lastIndexOf(marker);
  if (markerIndex < 0) {
    return null;
  }
  const candidate = sessionKey.slice(markerIndex + marker.length);
  return actorUserIdSchema.safeParse(candidate).success ? candidate : null;
};

const extractActorFromMatrixOriginFrom = (originFrom: string): string | null => {
  if (!matrixOriginFromSchema.safeParse(originFrom).success) {
    return null;
  }
  return normalizeMatrixActorUserId(originFrom);
};

export const resolveMatrixActorFromSessionStatus = (input: {
  sessionKey?: string;
  originFrom?: string;
}): string => {
  const fromSessionKey =
    input.sessionKey === undefined
      ? null
      : extractActorFromDirectMatrixSessionKey(input.sessionKey);
  const fromOrigin =
    input.originFrom === undefined ? null : extractActorFromMatrixOriginFrom(input.originFrom);
  if (fromSessionKey !== null && fromOrigin !== null && fromSessionKey !== fromOrigin) {
    throw new GuardedJsonStateToolError(
      "SESSION_STATUS_ACTOR_MISMATCH",
      "session_status exposed conflicting Matrix senders",
      false,
      {
        sessionKey: input.sessionKey,
        originFrom: input.originFrom,
        sessionKeyActor: fromSessionKey,
        originActor: fromOrigin,
      },
    );
  }
  if (fromSessionKey !== null) {
    return fromSessionKey;
  }
  if (fromOrigin !== null) {
    return fromOrigin;
  }
  throw new GuardedJsonStateToolError(
    "SESSION_STATUS_ACTOR_UNAVAILABLE",
    "Could not resolve the current Matrix sender from session_status",
    false,
    {
      sessionKey: input.sessionKey,
      originFrom: input.originFrom,
    },
  );
};

const parseRootArray = (
  state: Record<string, unknown>,
  collectionPath: string,
): Array<Record<string, unknown>> => {
  const existing = getPathValue(state, collectionPath);
  if (existing === undefined) {
    const created: Array<Record<string, unknown>> = [];
    setPathValue(state, collectionPath, created);
    return created;
  }
  return ensureArray(existing, `State collection '${collectionPath}' must be an array`);
};

const cloneRecord = (value: Record<string, unknown>): Record<string, unknown> =>
  JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

const delay = async (ms: number): Promise<void> =>
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

const parseFieldAssignments = (
  fields: ScalarFields,
  arrayFields: ArrayFields,
  entity: GuardedJsonStateEntityPolicy,
): Record<string, string | string[]> => {
  const allowed = entity.inputFields;
  const payload: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(fields)) {
    const expected = allowed[key];
    if (expected === undefined) {
      throw new GuardedJsonStateToolError(
        "STATE_INPUT_FIELD_UNKNOWN",
        `Field '${key}' is not allowed for entity '${entity.kind}'`,
        false,
        {
          field: key,
        },
      );
    }
    if (expected === "string[]") {
      payload[key] = [value];
      continue;
    }
    payload[key] = value;
  }
  for (const [key, value] of Object.entries(arrayFields)) {
    const expected = allowed[key];
    if (expected === undefined) {
      throw new GuardedJsonStateToolError(
        "STATE_INPUT_FIELD_UNKNOWN",
        `Field '${key}' is not allowed for entity '${entity.kind}'`,
        false,
        {
          field: key,
        },
      );
    }
    if (expected === "string") {
      if (value.length !== 1) {
        throw new GuardedJsonStateToolError(
          "STATE_INPUT_FIELD_TYPE_INVALID",
          `Field '${key}' expects a scalar input`,
          false,
          {
            field: key,
          },
        );
      }
      payload[key] = value[0]!;
      continue;
    }
    if (expected !== "string[]") {
      throw new GuardedJsonStateToolError(
        "STATE_INPUT_FIELD_TYPE_INVALID",
        `Field '${key}' expects a scalar input`,
        false,
        {
          field: key,
        },
      );
    }
    payload[key] = [...value];
  }
  return payload;
};

type MutationContext = {
  actor: string;
  actorLocalpart: string;
  now: string;
  input: Record<string, string | string[]>;
};

const findRootRecordIndex = (
  collection: Array<Record<string, unknown>>,
  keyField: string,
  keyValue: string,
): number => collection.findIndex((entry) => entry[keyField] === keyValue);

const enforceOwnedRootRecord = (
  entityId: string,
  entry: Record<string, unknown>,
  ownerField: string,
  actor: string,
): void => {
  if (entry[ownerField] !== actor) {
    throw new GuardedJsonStateToolError(
      "STATE_MUTATION_FORBIDDEN",
      `Only the creator may change '${entityId}' '${String(entry[ownerField] ?? "")}'`,
      false,
      {
        entity: entityId,
        actor,
        owner: entry[ownerField],
      },
    );
  }
};

const applyRootMetadata = (
  record: Record<string, unknown>,
  policy: RootArrayEntityPolicy,
  context: MutationContext,
  creating: boolean,
): void => {
  record[policy.ownerField] = context.actor;
  if (
    creating &&
    policy.createdAtField !== undefined &&
    record[policy.createdAtField] === undefined
  ) {
    record[policy.createdAtField] = context.now;
  }
  if (policy.updatedAtField !== undefined) {
    record[policy.updatedAtField] = context.now;
  }
  if (
    creating &&
    policy.createdByDisplayField !== undefined &&
    record[policy.createdByDisplayField] === undefined
  ) {
    record[policy.createdByDisplayField] = context.actorLocalpart;
  }
  if (policy.updatedByField !== undefined) {
    record[policy.updatedByField] = context.actor;
  }
  if (policy.updatedByDisplayField !== undefined) {
    record[policy.updatedByDisplayField] = context.actorLocalpart;
  }
};

const applyChildMetadata = (
  record: Record<string, unknown>,
  policy: ChildArrayEntityPolicy,
  context: MutationContext,
): void => {
  if (policy.updatedAtField !== undefined) {
    record[policy.updatedAtField] = context.now;
  }
};

const findScalarInput = (
  input: Record<string, string | string[]>,
  field: string,
): string | undefined => {
  const value = input[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

export class GuardedJsonStateToolService {
  constructor(
    private readonly deps: {
      configLoader?: RuntimeConfigLoader;
    } = {},
  ) {}

  private get loadRuntimeConfig(): RuntimeConfigLoader {
    return this.deps.configLoader ?? defaultRuntimeConfigLoader;
  }

  async showState(input: { instanceId: string; configPath?: string }): Promise<{
    instanceId: string;
    statePath: string;
    policyPath: string;
    state: Record<string, unknown>;
  }> {
    const instance = await this.resolveToolInstance(input.instanceId, input.configPath);
    const state = await this.readState(instance.statePath);
    return {
      instanceId: instance.instanceId,
      statePath: instance.statePath,
      policyPath: instance.policyPath,
      state,
    };
  }

  async listEntity(input: { instanceId: string; entityId: string; configPath?: string }): Promise<{
    instanceId: string;
    entity: string;
    count: number;
    items: Array<{
      id?: string;
      ownerMatrixUserId?: string;
      parentKey?: string;
      record: Record<string, unknown>;
    }>;
  }> {
    const instance = await this.resolveToolInstance(input.instanceId, input.configPath);
    const policy = await this.readPolicy(instance.policyPath);
    const entity = this.resolveEntity(policy, input.entityId);
    const state = await this.readState(instance.statePath);
    const items =
      entity.kind === "owner-root-array"
        ? parseRootArray(state, entity.collection).map((record) => ({
            ...(typeof record[entity.keyField] === "string"
              ? { id: String(record[entity.keyField]) }
              : {}),
            ...(typeof record[entity.ownerField] === "string"
              ? { ownerMatrixUserId: String(record[entity.ownerField]) }
              : {}),
            record: cloneRecord(record),
          }))
        : parseRootArray(state, entity.parentCollection).flatMap((parent) => {
            const owner =
              typeof parent[entity.parentOwnerField] === "string"
                ? String(parent[entity.parentOwnerField])
                : undefined;
            const parentKey =
              typeof parent[entity.parentKeyField] === "string"
                ? String(parent[entity.parentKeyField])
                : undefined;
            const children = Array.isArray(parent[entity.childArrayField])
              ? (parent[entity.childArrayField] as unknown[])
              : [];
            return children.flatMap((record: unknown) => {
              if (!isRecord(record)) {
                return [];
              }
              return [
                {
                  ...(typeof record[entity.keyField] === "string"
                    ? { id: String(record[entity.keyField]) }
                    : {}),
                  ...(owner === undefined ? {} : { ownerMatrixUserId: owner }),
                  ...(parentKey === undefined ? {} : { parentKey }),
                  record: cloneRecord(record),
                },
              ];
            });
          });
    return {
      instanceId: instance.instanceId,
      entity: input.entityId,
      count: items.length,
      items,
    };
  }

  async upsertSelf(input: {
    instanceId: string;
    entityId: string;
    actor: string;
    fields?: ScalarFields;
    arrayFields?: ArrayFields;
    configPath?: string;
  }): Promise<{
    instanceId: string;
    entity: string;
    actor: string;
    action: "upsert-self";
    id: string;
    changed: boolean;
    created: boolean;
    record: Record<string, unknown>;
  }> {
    const actor = actorUserIdSchema.parse(input.actor);
    const instance = await this.resolveToolInstance(input.instanceId, input.configPath);
    const policy = await this.readPolicy(instance.policyPath);
    const entity = this.resolveEntity(policy, input.entityId);
    const payload = parseFieldAssignments(input.fields ?? {}, input.arrayFields ?? {}, entity);
    return await this.withLock(instance.statePath, async () => {
      const state = await this.readState(instance.statePath);
      const context: MutationContext = {
        actor,
        actorLocalpart: actorLocalpart(actor),
        now: nowIso(),
        input: payload,
      };
      const result =
        entity.kind === "owner-root-array"
          ? this.applyRootUpsert(state, policy, input.entityId, entity, context)
          : this.applyChildUpsert(state, policy, input.entityId, entity, context);
      this.touchLastUpdated(state, policy, context.now);
      await this.writeState(instance.statePath, state);
      await this.appendAudit(instance.auditPath, {
        timestamp: context.now,
        action: "upsert-self",
        entity: input.entityId,
        actor,
        id: result.id,
        created: result.created,
      });
      return {
        instanceId: instance.instanceId,
        entity: input.entityId,
        actor,
        action: "upsert-self" as const,
        id: result.id,
        changed: true,
        created: result.created,
        record: cloneRecord(result.record),
      };
    });
  }

  async deleteSelf(input: {
    instanceId: string;
    entityId: string;
    actor: string;
    id: string;
    configPath?: string;
  }): Promise<{
    instanceId: string;
    entity: string;
    actor: string;
    action: "delete-self";
    id: string;
    changed: boolean;
    deleted: boolean;
  }> {
    const actor = actorUserIdSchema.parse(input.actor);
    const instance = await this.resolveToolInstance(input.instanceId, input.configPath);
    const policy = await this.readPolicy(instance.policyPath);
    const entity = this.resolveEntity(policy, input.entityId);
    return await this.withLock(instance.statePath, async () => {
      const state = await this.readState(instance.statePath);
      const deleted =
        entity.kind === "owner-root-array"
          ? this.applyRootDelete(state, input.entityId, entity, actor, input.id)
          : this.applyChildDelete(state, input.entityId, entity, actor, input.id);
      if (deleted) {
        const timestamp = nowIso();
        this.touchLastUpdated(state, policy, timestamp);
        await this.writeState(instance.statePath, state);
        await this.appendAudit(instance.auditPath, {
          timestamp,
          action: "delete-self",
          entity: input.entityId,
          actor,
          id: input.id,
          deleted: true,
        });
      }
      return {
        instanceId: instance.instanceId,
        entity: input.entityId,
        actor,
        action: "delete-self" as const,
        id: input.id,
        changed: deleted,
        deleted,
      };
    });
  }

  private applyRootUpsert(
    state: Record<string, unknown>,
    _policy: GuardedJsonStatePolicy,
    entityId: string,
    entity: RootArrayEntityPolicy,
    context: MutationContext,
  ): {
    id: string;
    created: boolean;
    record: Record<string, unknown>;
  } {
    const collection = parseRootArray(state, entity.collection);
    const keyValue =
      entity.selfKeyTemplate !== undefined
        ? renderTemplateString(entity.selfKeyTemplate, context)
        : this.requireScalarInput(context.input, entity.keyField, entityId);
    const existingIndex = findRootRecordIndex(collection, entity.keyField, keyValue);
    if (existingIndex >= 0) {
      const existing = ensureRecord(
        collection[existingIndex],
        `Collection '${entity.collection}' contains an invalid record`,
      );
      enforceOwnedRootRecord(entityId, existing, entity.ownerField, context.actor);
      const next = {
        ...cloneRecord(existing),
        ...context.input,
      };
      applyRootMetadata(next, entity, context, false);
      collection[existingIndex] = next;
      return {
        id: keyValue,
        created: false,
        record: next,
      };
    }

    const created = {
      ...expandDefaults(entity.defaults, context),
      ...context.input,
    };
    created[entity.keyField] = keyValue;
    applyRootMetadata(created, entity, context, true);
    collection.push(created);
    return {
      id: keyValue,
      created: true,
      record: created,
    };
  }

  private applyChildUpsert(
    state: Record<string, unknown>,
    policy: GuardedJsonStatePolicy,
    entityId: string,
    entity: ChildArrayEntityPolicy,
    context: MutationContext,
  ): {
    id: string;
    created: boolean;
    record: Record<string, unknown>;
  } {
    const parent = this.resolveOrCreateSelfParent(state, policy, entity, context);
    const childId =
      findScalarInput(context.input, entity.keyField) ??
      (entity.selfKeyTemplate === undefined
        ? this.requireScalarInput(context.input, entity.keyField, entityId)
        : renderTemplateString(entity.selfKeyTemplate, context));
    const allParents = parseRootArray(state, entity.parentCollection);
    const foreignOwner = allParents.find((candidate) => {
      const children = Array.isArray(candidate[entity.childArrayField])
        ? (candidate[entity.childArrayField] as unknown[])
        : [];
      return (
        children.some(
          (record: unknown) => isRecord(record) && record[entity.keyField] === childId,
        ) && candidate[entity.parentOwnerField] !== context.actor
      );
    });
    if (foreignOwner !== undefined) {
      throw new GuardedJsonStateToolError(
        "STATE_MUTATION_FORBIDDEN",
        `Only the creator may change '${entityId}' '${childId}'`,
        false,
        {
          entity: entityId,
          actor: context.actor,
          owner: foreignOwner[entity.parentOwnerField],
        },
      );
    }

    if (!Array.isArray(parent[entity.childArrayField])) {
      parent[entity.childArrayField] = [];
    }
    const childArray = ensureArray(
      parent[entity.childArrayField],
      `Child array '${entity.childArrayField}' must be an array`,
    );
    const existingIndex = childArray.findIndex((record) => record[entity.keyField] === childId);
    if (existingIndex >= 0) {
      const next = {
        ...cloneRecord(childArray[existingIndex]!),
        ...context.input,
      };
      applyChildMetadata(next, entity, context);
      childArray[existingIndex] = next;
      parent[entity.childArrayField] = childArray;
      return {
        id: childId,
        created: false,
        record: next,
      };
    }

    const created = {
      ...expandDefaults(entity.defaults, context),
      ...context.input,
    };
    created[entity.keyField] = childId;
    applyChildMetadata(created, entity, context);
    childArray.push(created);
    parent[entity.childArrayField] = childArray;
    return {
      id: childId,
      created: true,
      record: created,
    };
  }

  private applyRootDelete(
    state: Record<string, unknown>,
    entityId: string,
    entity: RootArrayEntityPolicy,
    actor: string,
    id: string,
  ): boolean {
    const collection = parseRootArray(state, entity.collection);
    const index = findRootRecordIndex(collection, entity.keyField, id);
    if (index < 0) {
      return false;
    }
    const existing = ensureRecord(
      collection[index],
      `Collection '${entity.collection}' contains an invalid record`,
    );
    enforceOwnedRootRecord(entityId, existing, entity.ownerField, actor);
    collection.splice(index, 1);
    return true;
  }

  private applyChildDelete(
    state: Record<string, unknown>,
    entityId: string,
    entity: ChildArrayEntityPolicy,
    actor: string,
    id: string,
  ): boolean {
    const parents = parseRootArray(state, entity.parentCollection);
    let foundForeignOwner = false;
    for (const parent of parents) {
      const children = Array.isArray(parent[entity.childArrayField])
        ? (parent[entity.childArrayField] as unknown[])
        : [];
      const index = children.findIndex(
        (record: unknown) => isRecord(record) && record[entity.keyField] === id,
      );
      if (index < 0) {
        continue;
      }
      if (parent[entity.parentOwnerField] !== actor) {
        foundForeignOwner = true;
        continue;
      }
      children.splice(index, 1);
      parent[entity.childArrayField] = children;
      return true;
    }
    if (foundForeignOwner) {
      throw new GuardedJsonStateToolError(
        "STATE_MUTATION_FORBIDDEN",
        `Only the creator may change '${entityId}' '${id}'`,
        false,
        {
          entity: entityId,
          actor,
          id,
        },
      );
    }
    return false;
  }

  private resolveOrCreateSelfParent(
    state: Record<string, unknown>,
    policy: GuardedJsonStatePolicy,
    entity: ChildArrayEntityPolicy,
    context: MutationContext,
  ): Record<string, unknown> {
    const parents = parseRootArray(state, entity.parentCollection);
    const selfParentKey = renderTemplateString(entity.parentSelfKeyTemplate, context);
    const existing = parents.find(
      (candidate) =>
        candidate[entity.parentKeyField] === selfParentKey ||
        candidate[entity.parentOwnerField] === context.actor,
    );
    if (existing !== undefined) {
      if (existing[entity.parentOwnerField] !== context.actor) {
        throw new GuardedJsonStateToolError(
          "STATE_MUTATION_FORBIDDEN",
          `Only the creator may change parent scope '${selfParentKey}'`,
          false,
          {
            actor: context.actor,
            owner: existing[entity.parentOwnerField],
          },
        );
      }
      return existing;
    }
    if (entity.ensureParentEntity === undefined) {
      throw new GuardedJsonStateToolError(
        "STATE_PARENT_REQUIRED",
        `A self-owned parent record is required before changing '${entity.childArrayField}'`,
        false,
        {
          actor: context.actor,
          entity: entity.childArrayField,
        },
      );
    }
    const parentEntity = this.resolveEntity(policy, entity.ensureParentEntity);
    if (parentEntity.kind !== "owner-root-array") {
      throw new GuardedJsonStateToolError(
        "POLICY_INVALID",
        `Entity '${entity.ensureParentEntity}' cannot be used as a parent entity`,
        false,
      );
    }
    return this.applyRootUpsert(state, policy, entity.ensureParentEntity, parentEntity, {
      ...context,
      input: {},
    }).record;
  }

  private resolveEntity(
    policy: GuardedJsonStatePolicy,
    entityId: string,
  ): GuardedJsonStateEntityPolicy {
    const entity = policy.entities[entityId];
    if (entity === undefined) {
      throw new GuardedJsonStateToolError(
        "POLICY_ENTITY_NOT_FOUND",
        `Policy does not define entity '${entityId}'`,
        false,
        {
          entity: entityId,
        },
      );
    }
    return entity;
  }

  private requireScalarInput(
    input: Record<string, string | string[]>,
    field: string,
    entityId: string,
  ): string {
    const value = input[field];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    throw new GuardedJsonStateToolError(
      "STATE_INPUT_FIELD_REQUIRED",
      `Entity '${entityId}' requires field '${field}'`,
      false,
      {
        entity: entityId,
        field,
      },
    );
  }

  private touchLastUpdated(
    state: Record<string, unknown>,
    policy: GuardedJsonStatePolicy,
    timestamp: string,
  ): void {
    if (policy.lastUpdatedPath !== undefined) {
      setPathValue(state, policy.lastUpdatedPath, timestamp);
    }
  }

  private async resolveToolInstance(
    instanceId: string,
    configPathOverride: string | undefined,
  ): Promise<ResolvedToolInstance> {
    const configPath = configPathOverride ?? defaultConfigPath();
    const runtimeConfig = await this.loadRuntimeConfig(configPath);
    const instance = runtimeConfig.sovereignTools.instances.find(
      (entry) => entry.id === instanceId,
    );
    if (instance === undefined) {
      throw new GuardedJsonStateToolError(
        "TOOL_INSTANCE_NOT_FOUND",
        `Tool instance '${instanceId}' was not found in ${configPath}`,
        false,
        {
          instanceId,
          configPath,
        },
      );
    }
    const parsedRef = parseTemplateRef(instance.templateRef);
    if (parsedRef.id !== GUARDED_JSON_STATE_TEMPLATE_ID) {
      throw new GuardedJsonStateToolError(
        "TOOL_INSTANCE_TEMPLATE_INVALID",
        `Tool instance '${instanceId}' is not a guarded json state tool`,
        false,
        {
          instanceId,
          templateRef: instance.templateRef,
        },
      );
    }
    const statePath = instance.config.statePath;
    const policyPath = instance.config.policyPath;
    if (statePath === undefined || policyPath === undefined) {
      throw new GuardedJsonStateToolError(
        "TOOL_INSTANCE_INVALID",
        `Tool instance '${instanceId}' is missing statePath or policyPath`,
        false,
        {
          instanceId,
        },
      );
    }
    const referencingWorkspaces = Array.from(
      new Set(
        runtimeConfig.openclawProfile.agents
          .filter((entry) => (entry.toolInstanceIds ?? []).includes(instanceId))
          .map((entry) => entry.workspace)
          .filter((value): value is string => typeof value === "string" && value.length > 0),
      ),
    );
    if (
      (!isAbsolute(statePath) ||
        !isAbsolute(policyPath) ||
        (instance.config.auditPath !== undefined && !isAbsolute(instance.config.auditPath))) &&
      referencingWorkspaces.length > 1
    ) {
      throw new GuardedJsonStateToolError(
        "TOOL_INSTANCE_PATH_AMBIGUOUS",
        `Tool instance '${instanceId}' uses relative paths but is referenced by multiple workspaces`,
        false,
        {
          instanceId,
          workspaces: referencingWorkspaces,
        },
      );
    }
    const baseDir = referencingWorkspaces[0] ?? dirname(configPath);
    return {
      instanceId,
      configPath,
      statePath: resolveRelativeToBase(statePath, baseDir),
      policyPath: resolveRelativeToBase(policyPath, baseDir),
      ...(instance.config.auditPath === undefined
        ? {}
        : { auditPath: resolveRelativeToBase(instance.config.auditPath, baseDir) }),
    };
  }

  private async readPolicy(path: string): Promise<GuardedJsonStatePolicy> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      throw new GuardedJsonStateToolError(
        "POLICY_READ_FAILED",
        `Failed to read guarded state policy at ${path}`,
        false,
        {
          path,
          error: error instanceof Error ? error.message : String(error),
        },
        { cause: error instanceof Error ? error : undefined },
      );
    }
    try {
      return guardedJsonStatePolicySchema.parse(
        JSON.parse(stripSingleTrailingNewline(raw)) as unknown,
      );
    } catch (error) {
      throw new GuardedJsonStateToolError(
        "POLICY_INVALID",
        `Guarded state policy at ${path} is invalid`,
        false,
        {
          path,
          error: error instanceof Error ? error.message : String(error),
        },
        { cause: error instanceof Error ? error : undefined },
      );
    }
  }

  private async readState(path: string): Promise<Record<string, unknown>> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      throw new GuardedJsonStateToolError(
        "STATE_READ_FAILED",
        `Failed to read guarded state at ${path}`,
        false,
        {
          path,
          error: error instanceof Error ? error.message : String(error),
        },
        { cause: error instanceof Error ? error : undefined },
      );
    }
    try {
      const parsed = JSON.parse(stripSingleTrailingNewline(raw)) as unknown;
      return ensureRecord(parsed, `Guarded state at ${path} must be a JSON object`);
    } catch (error) {
      if (error instanceof GuardedJsonStateToolError) {
        throw error;
      }
      throw new GuardedJsonStateToolError(
        "STATE_INVALID",
        `Guarded state at ${path} is invalid JSON`,
        false,
        {
          path,
          error: error instanceof Error ? error.message : String(error),
        },
        { cause: error instanceof Error ? error : undefined },
      );
    }
  }

  private async writeState(path: string, state: Record<string, unknown>): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tempPath, path);
  }

  private async appendAudit(
    path: string | undefined,
    event: Record<string, unknown>,
  ): Promise<void> {
    if (path === undefined) {
      return;
    }
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(event)}\n`, "utf8");
  }

  private async withLock<T>(statePath: string, action: () => Promise<T>): Promise<T> {
    const lockPath = `${statePath}.lock`;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    for (let attempt = 0; attempt < LOCK_RETRY_ATTEMPTS; attempt += 1) {
      try {
        handle = await open(lockPath, "wx");
        break;
      } catch (error) {
        const code =
          error instanceof Error && "code" in error
            ? String((error as NodeJS.ErrnoException).code)
            : "";
        if (code !== "EEXIST") {
          throw new GuardedJsonStateToolError(
            "STATE_LOCK_FAILED",
            `Failed to acquire state lock for ${statePath}`,
            true,
            {
              statePath,
              error: error instanceof Error ? error.message : String(error),
            },
            { cause: error instanceof Error ? error : undefined },
          );
        }
        await delay(LOCK_RETRY_DELAY_MS);
      }
    }
    if (handle === null) {
      throw new GuardedJsonStateToolError(
        "STATE_LOCK_TIMEOUT",
        `Timed out while waiting for the state lock on ${statePath}`,
        true,
        {
          statePath,
        },
      );
    }
    try {
      return await action();
    } finally {
      await handle.close();
      await rm(lockPath, { force: true });
    }
  }
}
