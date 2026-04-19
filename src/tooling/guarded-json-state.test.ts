import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeConfig } from "../installer/real-service-shared.js";
import {
  GuardedJsonStateToolError,
  GuardedJsonStateToolService,
  normalizeMatrixActorUserId,
  resolveMatrixActorFromSessionStatus,
} from "./guarded-json-state.js";

const tempRoots: string[] = [];

const buildRuntimeConfig = (input: {
  statePath: string;
  policyPath: string;
  auditPath: string;
  workspace?: string;
}): RuntimeConfig => ({
  openrouter: {
    model: "qwen/qwen3.5-9b",
    apiKeySecretRef: "env:OPENROUTER_API_KEY",
  },
  openclaw: {
    managedInstallation: true,
    installMethod: "install_sh",
    requestedVersion: "pinned-by-sovereign",
    openclawHome: "/tmp/openclaw-home",
    runtimeConfigPath: "/tmp/openclaw.json5",
    runtimeProfilePath: "/tmp/sovereign-runtime-profile.json5",
    gatewayEnvPath: "/tmp/gateway.env",
  },
  openclawProfile: {
    plugins: {
      allow: ["matrix"],
    },
    agents:
      input.workspace === undefined
        ? []
        : [
            {
              id: "bitcoin-skill-match",
              workspace: input.workspace,
              toolInstanceIds: ["bitcoin-state"],
            },
          ],
    crons: [],
    cron: {
      id: "poll",
      every: "5m",
    },
  },
  imap: {
    status: "pending",
    host: "imap.example.org",
    port: 993,
    tls: true,
    username: "pending",
    mailbox: "INBOX",
    secretRef: "env:IMAP_SECRET",
  },
  bots: {
    config: {
      "bitcoin-skill-match": {
        statePath: input.statePath,
        statePolicyPath: input.policyPath,
        stateAuditPath: input.auditPath,
      },
    },
    instances: [],
  },
  matrix: {
    accessMode: "direct",
    homeserverDomain: "matrix.example.org",
    federationEnabled: false,
    publicBaseUrl: "https://matrix.example.org",
    adminBaseUrl: "http://127.0.0.1:8008",
    operator: {
      userId: "@operator:matrix.example.org",
    },
    bot: {
      userId: "@bitcoin-skill-match:matrix.example.org",
      accessTokenSecretRef: "env:MATRIX_BOT_TOKEN",
    },
    alertRoom: {
      roomId: "!alerts:matrix.example.org",
      roomName: "Sovereign Alerts",
    },
  },
  templates: {
    installed: [],
  },
  sovereignTools: {
    instances: [
      {
        id: "bitcoin-state",
        templateRef: "guarded-json-state@1.0.0",
        capabilities: ["json-state.read", "json-state.self-upsert", "json-state.self-delete"],
        config: {
          statePath: input.statePath,
          policyPath: input.policyPath,
          auditPath: input.auditPath,
        },
        secretRefs: {},
        createdAt: "2026-03-09T00:00:00.000Z",
        updatedAt: "2026-03-09T00:00:00.000Z",
      },
    ],
  },
});

const buildPolicy = () => ({
  version: 1,
  lastUpdatedPath: "community.lastUpdated",
  entities: {
    members: {
      kind: "owner-root-array",
      collection: "members",
      ownerField: "createdByMatrixUserId",
      keyField: "memberId",
      selfKeyTemplate: "member:{actor}",
      createdAtField: "createdAt",
      updatedAtField: "updatedAt",
      updatedByField: "updatedByMatrixUserId",
      createdByDisplayField: "createdByDisplayName",
      updatedByDisplayField: "updatedByDisplayName",
      defaults: {
        matrixHandle: "{actor}",
        displayName: "{actorLocalpart}",
        offers: [],
        seeks: [],
        contactLevel: "intro-only",
        settlementPreferences: ["lightning"],
        trustLinks: [],
        notes: [],
      },
      inputFields: {
        region: "string",
        contactLevel: "string",
        displayName: "string",
        settlementPreferences: "string[]",
      },
    },
    offers: {
      kind: "owner-child-array",
      parentCollection: "members",
      parentOwnerField: "createdByMatrixUserId",
      parentKeyField: "memberId",
      parentSelfKeyTemplate: "member:{actor}",
      ensureParentEntity: "members",
      childArrayField: "offers",
      keyField: "marker",
      selfKeyTemplate: "OFFER_{actorLocalpart}_{nowCompact}",
      updatedAtField: "updatedAt",
      defaults: {
        notes: [],
        settlementPreferences: ["lightning"],
      },
      inputFields: {
        marker: "string",
        title: "string",
        description: "string",
        summary: "string",
        region: "string",
        regions: "string[]",
        radiusKm: "string",
        price: "string",
        visibility: "string",
        contactLevel: "string",
        notes: "string[]",
        settlementPreferences: "string[]",
      },
    },
  },
});

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

describe("guarded-json-state tool service", () => {
  it("resolves the actor from a direct-message session key before origin metadata", () => {
    expect(
      resolveMatrixActorFromSessionStatus({
        sessionKey: "agent:bitcoin-skill-match:matrix:direct:@satoshi:matrix.example.org",
        originFrom: "matrix:@satoshi:matrix.example.org",
      }),
    ).toBe("@satoshi:matrix.example.org");
  });

  it("falls back to origin.from when the current session is not a direct-message scope", () => {
    expect(
      resolveMatrixActorFromSessionStatus({
        sessionKey: "agent:bitcoin-skill-match:matrix:room:!marktplatz:matrix.example.org",
        originFrom: "@ndee:matrix.example.org",
      }),
    ).toBe("@ndee:matrix.example.org");
  });

  it("accepts session keys that include OpenClaw's session: prefix", () => {
    expect(
      resolveMatrixActorFromSessionStatus({
        sessionKey: "session:agent:bitcoin-skill-match:matrix:direct:@satoshi:matrix.example.org",
      }),
    ).toBe("@satoshi:matrix.example.org");
  });

  it("accepts actor values with or without the matrix: prefix", () => {
    expect(normalizeMatrixActorUserId("@satoshi:matrix.example.org")).toBe(
      "@satoshi:matrix.example.org",
    );
    expect(normalizeMatrixActorUserId("matrix:@satoshi:matrix.example.org")).toBe(
      "@satoshi:matrix.example.org",
    );
  });

  it("fails closed when session_status fields disagree about the current Matrix sender", () => {
    expect(() =>
      resolveMatrixActorFromSessionStatus({
        sessionKey: "agent:bitcoin-skill-match:matrix:direct:@satoshi:matrix.example.org",
        originFrom: "matrix:@ndee:matrix.example.org",
      }),
    ).toThrowError(/conflicting Matrix senders/);
  });

  it("fails closed when session_status does not expose a Matrix actor", () => {
    expect(() =>
      resolveMatrixActorFromSessionStatus({
        sessionKey: "agent:bitcoin-skill-match:shell:default",
        originFrom: "email:alice@example.org",
      }),
    ).toThrowError(GuardedJsonStateToolError);
    expect(() =>
      resolveMatrixActorFromSessionStatus({
        sessionKey: "agent:bitcoin-skill-match:shell:default",
        originFrom: "email:alice@example.org",
      }),
    ).toThrowError(/Could not resolve the current Matrix sender/);
  });

  it("creates a self-owned parent record automatically for child upserts", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "guarded-json-state-test-"));
    tempRoots.push(tempRoot);
    const statePath = join(tempRoot, "community-state.json");
    const policyPath = join(tempRoot, "community-state.policy.json");
    const auditPath = join(tempRoot, "community-state.audit.jsonl");
    await writeFile(
      statePath,
      `${JSON.stringify({ community: { lastUpdated: "2026-03-09T00:00:00.000Z" }, members: [] }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(policyPath, `${JSON.stringify(buildPolicy(), null, 2)}\n`, "utf8");

    const service = new GuardedJsonStateToolService({
      configLoader: async () => buildRuntimeConfig({ statePath, policyPath, auditPath }),
    });

    const result = await service.upsertSelf({
      instanceId: "bitcoin-state",
      entityId: "offers",
      actor: "@satoshi:matrix.example.org",
      fields: {
        marker: "OFFER_1",
        summary: "Lightning workshops",
      },
      arrayFields: {
        settlementPreferences: ["lightning", "skill-swap"],
      },
    });

    expect(result.created).toBe(true);
    expect(result.record).toMatchObject({
      marker: "OFFER_1",
      summary: "Lightning workshops",
      settlementPreferences: ["lightning", "skill-swap"],
    });

    const stored = JSON.parse(await readFile(statePath, "utf8")) as {
      community: { lastUpdated?: string };
      members: Array<{
        memberId: string;
        createdByMatrixUserId: string;
        offers: Array<{ marker: string; summary: string }>;
      }>;
    };
    expect(stored.community.lastUpdated).not.toBe("2026-03-09T00:00:00.000Z");
    expect(stored.members).toEqual([
      expect.objectContaining({
        memberId: "member:@satoshi:matrix.example.org",
        createdByMatrixUserId: "@satoshi:matrix.example.org",
        offers: [
          expect.objectContaining({
            marker: "OFFER_1",
            summary: "Lightning workshops",
          }),
        ],
      }),
    ]);
  });

  it("coerces scalar inputs for string-array fields and singleton arrays for scalar fields", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "guarded-json-state-test-"));
    tempRoots.push(tempRoot);
    const statePath = join(tempRoot, "community-state.json");
    const policyPath = join(tempRoot, "community-state.policy.json");
    const auditPath = join(tempRoot, "community-state.audit.jsonl");
    await writeFile(
      statePath,
      `${JSON.stringify({ community: { lastUpdated: "2026-03-09T00:00:00.000Z" }, members: [] }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(policyPath, `${JSON.stringify(buildPolicy(), null, 2)}\n`, "utf8");

    const service = new GuardedJsonStateToolService({
      configLoader: async () => buildRuntimeConfig({ statePath, policyPath, auditPath }),
    });

    const result = await service.upsertSelf({
      instanceId: "bitcoin-state",
      entityId: "offers",
      actor: "@hal:matrix.example.org",
      fields: {
        marker: "OFFER_2",
        settlementPreferences: "lightning",
      },
      arrayFields: {
        summary: ["Guided node setup"],
        notes: ["remote"],
      },
    });

    expect(result.record).toMatchObject({
      marker: "OFFER_2",
      summary: "Guided node setup",
      settlementPreferences: ["lightning"],
      notes: ["remote"],
    });
  });

  it("auto-generates a child marker when the policy defines a self key template", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "guarded-json-state-test-"));
    tempRoots.push(tempRoot);
    const statePath = join(tempRoot, "community-state.json");
    const policyPath = join(tempRoot, "community-state.policy.json");
    const auditPath = join(tempRoot, "community-state.audit.jsonl");
    await writeFile(
      statePath,
      `${JSON.stringify({ community: { lastUpdated: "2026-03-09T00:00:00.000Z" }, members: [] }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(policyPath, `${JSON.stringify(buildPolicy(), null, 2)}\n`, "utf8");

    const service = new GuardedJsonStateToolService({
      configLoader: async () => buildRuntimeConfig({ statePath, policyPath, auditPath }),
    });

    const result = await service.upsertSelf({
      instanceId: "bitcoin-state",
      entityId: "offers",
      actor: "@ndee:matrix.example.org",
      fields: {
        title: "BitBox Einrichtung",
        summary: "BitBox Einrichtung in Mannheim",
        radiusKm: "100",
        price: "250 EUR",
      },
      arrayFields: {
        regions: ["Mannheim"],
        settlementPreferences: ["lightning", "cash-eur"],
      },
    });

    expect(result.created).toBe(true);
    expect(result.id).toMatch(/^OFFER_ndee_\d{8}T\d{9}Z$/);
    expect(result.record).toMatchObject({
      marker: result.id,
      title: "BitBox Einrichtung",
      price: "250 EUR",
      radiusKm: "100",
      regions: ["Mannheim"],
    });
  });

  it("resolves relative tool paths against the referencing agent workspace", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "guarded-json-state-test-"));
    tempRoots.push(tempRoot);
    const workspace = join(tempRoot, "workspace");
    const dataDir = join(workspace, "data");
    const configPath = join(tempRoot, "etc", "sovereign-node.json5");
    const statePath = join(dataDir, "community-state.json");
    const policyPath = join(dataDir, "community-state.policy.json");
    const _auditPath = join(dataDir, "community-state.audit.jsonl");
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      statePath,
      `${JSON.stringify({ community: { lastUpdated: "2026-03-09T00:00:00.000Z" }, members: [] }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(policyPath, `${JSON.stringify(buildPolicy(), null, 2)}\n`, "utf8");

    const service = new GuardedJsonStateToolService({
      configLoader: async () =>
        buildRuntimeConfig({
          statePath: "data/community-state.json",
          policyPath: "data/community-state.policy.json",
          auditPath: "data/community-state.audit.jsonl",
          workspace,
        }),
    });

    const result = await service.upsertSelf({
      instanceId: "bitcoin-state",
      entityId: "offers",
      actor: "@satoshi:matrix.example.org",
      fields: {
        marker: "OFFER_REL",
        summary: "Relative path offer",
      },
      arrayFields: {
        settlementPreferences: ["lightning"],
      },
      configPath,
    });

    expect(result.created).toBe(true);
    const stored = JSON.parse(await readFile(statePath, "utf8")) as {
      members: Array<{ offers: Array<{ marker: string }> }>;
    };
    expect(stored.members[0]?.offers[0]?.marker).toBe("OFFER_REL");
  });

  it("returns all matching entries for read queries across different owners", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "guarded-json-state-test-"));
    tempRoots.push(tempRoot);
    const statePath = join(tempRoot, "community-state.json");
    const policyPath = join(tempRoot, "community-state.policy.json");
    const auditPath = join(tempRoot, "community-state.audit.jsonl");
    await writeFile(
      statePath,
      `${JSON.stringify(
        {
          community: { lastUpdated: "2026-03-09T00:00:00.000Z" },
          members: [
            {
              memberId: "member:@satoshi:matrix.example.org",
              createdByMatrixUserId: "@satoshi:matrix.example.org",
              offers: [{ marker: "SAT_1", summary: "Node operations" }],
            },
            {
              memberId: "member:@ndee:matrix.example.org",
              createdByMatrixUserId: "@ndee:matrix.example.org",
              offers: [{ marker: "NDEE_1", summary: "Lightning training" }],
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(policyPath, `${JSON.stringify(buildPolicy(), null, 2)}\n`, "utf8");

    const service = new GuardedJsonStateToolService({
      configLoader: async () => buildRuntimeConfig({ statePath, policyPath, auditPath }),
    });

    const result = await service.listEntity({
      instanceId: "bitcoin-state",
      entityId: "offers",
    });

    expect(result.items).toHaveLength(2);
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "SAT_1",
          ownerMatrixUserId: "@satoshi:matrix.example.org",
        }),
        expect.objectContaining({
          id: "NDEE_1",
          ownerMatrixUserId: "@ndee:matrix.example.org",
        }),
      ]),
    );
  });

  it("rejects deletes from a different Matrix owner", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "guarded-json-state-test-"));
    tempRoots.push(tempRoot);
    const statePath = join(tempRoot, "community-state.json");
    const policyPath = join(tempRoot, "community-state.policy.json");
    const auditPath = join(tempRoot, "community-state.audit.jsonl");
    await writeFile(
      statePath,
      `${JSON.stringify(
        {
          community: { lastUpdated: "2026-03-09T00:00:00.000Z" },
          members: [
            {
              memberId: "member:@satoshi:matrix.example.org",
              createdByMatrixUserId: "@satoshi:matrix.example.org",
              offers: [{ marker: "SAT_1", summary: "Node operations" }],
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(policyPath, `${JSON.stringify(buildPolicy(), null, 2)}\n`, "utf8");

    const service = new GuardedJsonStateToolService({
      configLoader: async () => buildRuntimeConfig({ statePath, policyPath, auditPath }),
    });

    await expect(
      service.deleteSelf({
        instanceId: "bitcoin-state",
        entityId: "offers",
        actor: "@ndee:matrix.example.org",
        id: "SAT_1",
      }),
    ).rejects.toMatchObject({
      code: "STATE_MUTATION_FORBIDDEN",
    });
  });
});
