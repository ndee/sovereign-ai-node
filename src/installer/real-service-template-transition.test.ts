import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FilesystemBotCatalog } from "../bots/catalog.js";
import type { SovereignPaths } from "../config/paths.js";
import { createLogger } from "../logging/logger.js";
import type { OpenClawBootstrapper } from "../openclaw/bootstrap.js";
import type { ImapTester } from "../system/imap.js";
import type { BundledMatrixProvisioner } from "../system/matrix.js";
import type { HostPreflightChecker } from "../system/preflight.js";
import { RealInstallerService } from "./real-service.js";

/**
 * End-to-end (in-process) coverage of the verified-release template pin
 * transition: the exact defect shape from the Phase 5 incident — a bot
 * release whose tool template legitimately widened its capability/command
 * surface while keeping the same template id@version — driven through
 * reconcileAgentWorkspaces against a real on-disk catalog and config.
 */

const currentUid = process.getuid?.() ?? 0;

const noopDeps = {
  openclawBootstrapper: {
    detectInstalled: async () => null,
    ensureInstalled: async () => ({
      binaryPath: "/usr/local/bin/openclaw",
      version: "pinned",
      installMethod: "install_sh" as const,
    }),
  } as unknown as OpenClawBootstrapper,
  openclawGatewayServiceManager: {
    install: async () => {},
    start: async () => {},
    restart: async () => {},
  },
  preflightChecker: {
    run: async () => ({ mode: "bundled_matrix", overall: "pass", checks: [], recommendedActions: [] }),
  } as unknown as HostPreflightChecker,
  imapTester: {
    test: async () => ({ ok: true, host: "h", port: 993, tls: true, auth: "ok" as const }),
  } as unknown as ImapTester,
  matrixProvisioner: {
    provision: async () => {
      throw new Error("not used");
    },
  } as unknown as BundledMatrixProvisioner,
};

type FixtureTemplateShape = {
  botVersion: string;
  capabilities: string[];
  allowedCommands: string[];
};

const V1: FixtureTemplateShape = {
  botVersion: "1.0.0",
  capabilities: ["fixture.read"],
  allowedCommands: ["<agent-workspace>/bin/fixture.js read --json"],
};

/** Mirrors the incident: bot version bumps, the tool template keeps its
 * id@version but gains a capability and a command. */
const V2: FixtureTemplateShape = {
  botVersion: "1.0.1",
  capabilities: ["fixture.read", "fixture.status.read"],
  allowedCommands: [
    "<agent-workspace>/bin/fixture.js read --json",
    "<agent-workspace>/bin/fixture.js status --instance <tool-instance-id> --json",
  ],
};

const fixtureManifest = (shape: FixtureTemplateShape): string =>
  `${JSON.stringify(
    {
      kind: "sovereign-bot-package",
      manifestVersion: 2,
      id: "fixture-bot",
      version: shape.botVersion,
      displayName: "Fixture Bot",
      description: "Template transition fixture bot",
      matrixIdentity: { mode: "dedicated-account", localpartPrefix: "fixture-bot" },
      configDefaults: {},
      toolTemplates: [
        {
          kind: "sovereign-tool-template",
          id: "fixture-tool",
          version: "1.0.0",
          description: "Fixture tool",
          capabilities: shape.capabilities,
          allowedCommands: shape.allowedCommands,
        },
      ],
      toolInstances: [{ id: "fixture-core", templateRef: "fixture-tool@1.0.0" }],
      hostResources: [
        {
          id: "workspace-tools",
          kind: "managedFile",
          spec: {
            path: { join: [{ from: "agent.workspace" }, "/TOOLS.md"] },
            inlineContent: "# Fixture tools\n\n{{TOOL_SECTION}}\n",
            writePolicy: "always",
          },
        },
      ],
      agentTemplate: {
        id: "fixture-bot",
        version: shape.botVersion,
        description: "Template transition fixture bot",
        matrix: { localpartPrefix: "fixture-bot" },
        requiredToolTemplates: [{ id: "fixture-tool", version: "1.0.0" }],
      },
    },
    null,
    2,
  )}\n`;

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

describe("verified-release template pin transition", () => {
  let tempRoot: string;
  let paths: SovereignPaths;
  let catalogDir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "template-transition-test-"));
    paths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };
    catalogDir = join(tempRoot, "bots-catalog");
    workspaceDir = join(paths.stateDir, "fixture-bot", "workspace");
    await mkdir(join(catalogDir, "bots", "fixture-bot"), { recursive: true });
    await mkdir(join(tempRoot, "etc"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const writeCatalog = async (shape: FixtureTemplateShape): Promise<void> => {
    await writeFile(
      join(catalogDir, "bots", "fixture-bot", "sovereign-bot.json"),
      fixtureManifest(shape),
      "utf8",
    );
  };

  /** Digest identities the node computes for a catalog state, obtained
   * through the real catalog loader so pins match production exactly. */
  const loadIdentities = async () => {
    const catalog = new FilesystemBotCatalog(catalogDir);
    const [pkg] = await catalog.listPackages();
    if (pkg === undefined) {
      throw new Error("fixture catalog did not load");
    }
    const tool = pkg.toolTemplates[0];
    if (tool === undefined) {
      throw new Error("fixture tool template missing");
    }
    return { pkg, tool };
  };

  const writeConfig = async (installed: unknown[]): Promise<void> => {
    const document = {
      matrix: {
        publicBaseUrl: "http://matrix.example.org",
        adminBaseUrl: "http://127.0.0.1:8008",
        operator: { userId: "@operator:matrix.example.org" },
        bot: {
          localpart: "sovereign-bot",
          userId: "@sovereign-bot:matrix.example.org",
          accessTokenSecretRef: "file:/tmp/token",
        },
        alertRoom: { roomId: "!alerts:matrix.example.org" },
      },
      openclawProfile: {
        agents: [
          {
            id: "fixture-bot",
            botId: "fixture-bot",
            workspace: workspaceDir,
            templateRef: "fixture-bot@1.0.0",
            toolInstanceIds: ["fixture-core"],
          },
        ],
      },
      sovereignTools: {
        instances: [
          {
            id: "fixture-core",
            templateRef: "fixture-tool@1.0.0",
            capabilities: [],
            config: {},
            secretRefs: {},
          },
        ],
      },
      templates: { installed },
    };
    await writeFile(paths.configPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  };

  const pinEntriesFor = async (): Promise<unknown[]> => {
    const { pkg, tool } = await loadIdentities();
    return [
      {
        kind: "agent",
        id: pkg.template.id,
        version: pkg.template.version,
        description: pkg.template.description,
        trusted: true,
        pinned: true,
        keyId: pkg.keyId,
        manifestSha256: pkg.manifestSha256,
        installedAt: "2026-08-01T00:00:00.000Z",
        source: "bot-repo",
      },
      {
        kind: "tool",
        id: tool.manifest.id,
        version: tool.manifest.version,
        description: tool.manifest.description,
        trusted: true,
        pinned: true,
        keyId: tool.keyId,
        manifestSha256: tool.manifestSha256,
        installedAt: "2026-08-01T00:00:00.000Z",
        source: "bot-repo",
      },
    ];
  };

  const makeService = (ownerUids?: readonly number[]): RealInstallerService =>
    new RealInstallerService(createLogger(), paths, {
      ...noopDeps,
      botCatalog: new FilesystemBotCatalog(catalogDir),
      ...(ownerUids === undefined ? {} : { releaseAuthorizationOwnerUids: ownerUids }),
    });

  const writeAuthorization = async (input: {
    manifestFileSha256: string;
    botVersion: string;
    previousManifest?: string;
    botId?: string;
    mode?: number;
  }): Promise<string> => {
    const path = join(tempRoot, "release-authorization.json");
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        kind: "sovereign-release-authorization",
        runId: "test-run-1",
        createdAt: "2026-08-06T00:00:00Z",
        releaseId: "v9.9.9-linux-any-test",
        channel: "test",
        version: "9.9.9",
        artifactSha256: "a".repeat(64),
        signingKeyId: "release-2026-01",
        bots: [
          {
            id: input.botId ?? "fixture-bot",
            version: input.botVersion,
            manifestFileSha256: input.manifestFileSha256,
            ...(input.previousManifest === undefined
              ? {}
              : { previousManifest: input.previousManifest }),
          },
        ],
      }),
      "utf8",
    );
    await chmod(path, input.mode ?? 0o640);
    return path;
  };

  /** Seed: pins + config match catalog V1, then the catalog moves to V2
   * (the update replaced the bots tree; workspace/pins are still old). */
  const seedV1PinsWithV2Catalog = async (): Promise<{ previousManifest: string }> => {
    await writeCatalog(V1);
    const previousManifest = fixtureManifest(V1);
    await writeConfig(await pinEntriesFor());
    await writeCatalog(V2);
    return { previousManifest };
  };

  it("plain reconcile succeeds when the template is identical (bot version bump only)", async () => {
    await writeCatalog(V1);
    const pins = await pinEntriesFor();
    // Bot version bump with an UNCHANGED tool template: the tool entry digest
    // hashes only the toolTemplates[] entry, so the pin still matches.
    await writeCatalog({ ...V1, botVersion: "1.0.1" });
    await writeConfig(pins);

    const result = await makeService().reconcileAgentWorkspaces();
    expect(result.reconciled).toContain("fixture-bot");
    expect(result.templateTransitions).toEqual([]);
    expect(result.releaseAuthorization).toBeNull();
    const tools = await readFile(join(workspaceDir, "TOOLS.md"), "utf8");
    expect(tools).toContain("fixture.read");
  });

  it("refuses a changed template without release authorization (TEMPLATE_PIN_MISMATCH), touching nothing", async () => {
    await seedV1PinsWithV2Catalog();

    await expect(makeService().reconcileAgentWorkspaces()).rejects.toMatchObject({
      code: "TEMPLATE_PIN_MISMATCH",
    });

    // No workspace file was written and the pins are untouched.
    await expect(access(join(workspaceDir, "TOOLS.md"))).rejects.toThrow();
    const config = JSON.parse(await readFile(paths.configPath, "utf8")) as {
      templates: { installed: Array<{ id: string; manifestSha256: string }> };
    };
    const { tool } = await loadIdentities();
    const toolEntry = config.templates.installed.find((entry) => entry.id === "fixture-tool");
    expect(toolEntry?.manifestSha256).not.toBe(tool.manifestSha256);
  });

  it("transitions the pin under a valid verified-release authorization and reports the diff", async () => {
    const { previousManifest } = await seedV1PinsWithV2Catalog();
    const { pkg, tool } = await loadIdentities();
    const authorizationPath = await writeAuthorization({
      manifestFileSha256: pkg.manifestFileSha256,
      botVersion: V2.botVersion,
      previousManifest,
    });

    const result = await makeService([currentUid]).reconcileAgentWorkspaces({
      releaseAuthorizationPath: authorizationPath,
    });

    expect(result.reconciled).toContain("fixture-bot");
    expect(result.releaseAuthorization).toEqual({
      releaseId: "v9.9.9-linux-any-test",
      artifactSha256: "a".repeat(64),
      runId: "test-run-1",
    });
    expect(result.templateTransitions).toHaveLength(1);
    const transition = result.templateTransitions[0];
    expect(transition).toMatchObject({
      botId: "fixture-bot",
      templateRef: "fixture-tool@1.0.0",
      kind: "tool",
      newManifestSha256: tool.manifestSha256,
      committed: true,
    });
    expect(transition?.capabilitiesAdded).toEqual(["fixture.status.read"]);
    expect(transition?.commandsAdded).toEqual([
      "<agent-workspace>/bin/fixture.js status --instance <tool-instance-id> --json",
    ]);
    expect(transition?.classifications).toEqual(
      expect.arrayContaining(["capability-added", "command-added"]),
    );

    // Pin on disk moved to the release-authorized digest.
    const config = JSON.parse(await readFile(paths.configPath, "utf8")) as {
      templates: { installed: Array<{ id: string; manifestSha256: string; installedAt: string }> };
    };
    const toolEntry = config.templates.installed.find((entry) => entry.id === "fixture-tool");
    expect(toolEntry?.manifestSha256).toBe(tool.manifestSha256);
    // Original install time preserved on transition.
    expect(toolEntry?.installedAt).toBe("2026-08-01T00:00:00.000Z");

    // Workspace was refreshed from the authorized template.
    const tools = await readFile(join(workspaceDir, "TOOLS.md"), "utf8");
    expect(tools).toContain("fixture.status.read");
    expect(tools).toContain("status --instance");

    // Journal consumed.
    await expect(
      access(join(tempRoot, "etc", "template-transition-journal.json")),
    ).rejects.toThrow();

    // A later plain reconcile now succeeds: pin == trusted template.
    const followUp = await makeService().reconcileAgentWorkspaces();
    expect(followUp.templateTransitions).toEqual([]);
  });

  it("hard-fails on forged or wrong authorizations without mutating pins", async () => {
    const { previousManifest } = await seedV1PinsWithV2Catalog();
    const { pkg } = await loadIdentities();

    // Wrong artifact content digest (forged / different release).
    const wrongDigest = await writeAuthorization({
      manifestFileSha256: sha256("something else entirely"),
      botVersion: V2.botVersion,
      previousManifest,
    });
    await expect(
      makeService([currentUid]).reconcileAgentWorkspaces({
        releaseAuthorizationPath: wrongDigest,
      }),
    ).rejects.toMatchObject({ code: "TEMPLATE_PIN_MISMATCH" });

    // Wrong bot version.
    const wrongVersion = await writeAuthorization({
      manifestFileSha256: pkg.manifestFileSha256,
      botVersion: "9.9.9",
    });
    await expect(
      makeService([currentUid]).reconcileAgentWorkspaces({
        releaseAuthorizationPath: wrongVersion,
      }),
    ).rejects.toMatchObject({ code: "TEMPLATE_PIN_MISMATCH" });

    // Wrong bot id (missing target entry).
    const wrongBot = await writeAuthorization({
      manifestFileSha256: pkg.manifestFileSha256,
      botVersion: V2.botVersion,
      botId: "other-bot",
    });
    await expect(
      makeService([currentUid]).reconcileAgentWorkspaces({
        releaseAuthorizationPath: wrongBot,
      }),
    ).rejects.toMatchObject({ code: "TEMPLATE_PIN_MISMATCH" });

    // Pins never moved.
    const config = JSON.parse(await readFile(paths.configPath, "utf8")) as {
      templates: { installed: Array<{ id: string; manifestSha256: string }> };
    };
    const { tool } = await loadIdentities();
    const toolEntry = config.templates.installed.find((entry) => entry.id === "fixture-tool");
    expect(toolEntry?.manifestSha256).not.toBe(tool.manifestSha256);
  });

  it("rejects an attestation the service user could have forged (wrong owner, unsafe mode, symlink)", async () => {
    const { previousManifest } = await seedV1PinsWithV2Catalog();
    const { pkg } = await loadIdentities();
    const path = await writeAuthorization({
      manifestFileSha256: pkg.manifestFileSha256,
      botVersion: V2.botVersion,
      previousManifest,
    });

    // Production owner policy (root only): the test process's file must be
    // refused outright — an unprivileged user cannot mint authorization.
    await expect(
      makeService().reconcileAgentWorkspaces({ releaseAuthorizationPath: path }),
    ).rejects.toMatchObject({
      code: "RELEASE_AUTHORIZATION_INVALID",
      details: expect.objectContaining({ reason: "untrusted-owner" }),
    });

    // Group-writable attestation: refused even with a trusted owner.
    await chmod(path, 0o660);
    await expect(
      makeService([currentUid]).reconcileAgentWorkspaces({ releaseAuthorizationPath: path }),
    ).rejects.toMatchObject({
      code: "RELEASE_AUTHORIZATION_INVALID",
      details: expect.objectContaining({ reason: "unsafe-mode" }),
    });
  });

  it("a stale authorization cannot approve a later checkout edit", async () => {
    const { previousManifest } = await seedV1PinsWithV2Catalog();
    const { pkg, tool } = await loadIdentities();
    const authorizationPath = await writeAuthorization({
      manifestFileSha256: pkg.manifestFileSha256,
      botVersion: V2.botVersion,
      previousManifest,
    });

    // Complete the legitimate transition first.
    await makeService([currentUid]).reconcileAgentWorkspaces({
      releaseAuthorizationPath: authorizationPath,
    });

    // Attacker (or drift) edits the installed catalog AFTER the release was
    // applied — widening the surface further. The retained attestation must
    // not cover the new bytes.
    await writeCatalog({
      ...V2,
      capabilities: [...V2.capabilities, "fixture.admin.write"],
    });
    await expect(
      makeService([currentUid]).reconcileAgentWorkspaces({
        releaseAuthorizationPath: authorizationPath,
      }),
    ).rejects.toMatchObject({ code: "TEMPLATE_PIN_MISMATCH" });

    // The pin still holds the release-authorized digest, not the drifted one.
    const config = JSON.parse(await readFile(paths.configPath, "utf8")) as {
      templates: { installed: Array<{ id: string; manifestSha256: string }> };
    };
    const toolEntry = config.templates.installed.find((entry) => entry.id === "fixture-tool");
    expect(toolEntry?.manifestSha256).toBe(tool.manifestSha256);
  });

  it("keeps the old consistent state when staging the workspace fails", async () => {
    const { previousManifest } = await seedV1PinsWithV2Catalog();
    const { pkg, tool } = await loadIdentities();
    const authorizationPath = await writeAuthorization({
      manifestFileSha256: pkg.manifestFileSha256,
      botVersion: V2.botVersion,
      previousManifest,
    });

    // Make the workspace directory unwritable so the staged write fails.
    await mkdir(workspaceDir, { recursive: true });
    await chmod(workspaceDir, 0o555);
    try {
      await expect(
        makeService([currentUid]).reconcileAgentWorkspaces({
          releaseAuthorizationPath: authorizationPath,
        }),
      ).rejects.toThrow();
    } finally {
      await chmod(workspaceDir, 0o755);
    }

    // Old pin remains authoritative; no partially-committed transition.
    const config = JSON.parse(await readFile(paths.configPath, "utf8")) as {
      templates: { installed: Array<{ id: string; manifestSha256: string }> };
    };
    const toolEntry = config.templates.installed.find((entry) => entry.id === "fixture-tool");
    expect(toolEntry?.manifestSha256).not.toBe(tool.manifestSha256);

    // Retry with the same (still valid) authorization completes the repair —
    // the founder-node recovery path.
    const retry = await makeService([currentUid]).reconcileAgentWorkspaces({
      releaseAuthorizationPath: authorizationPath,
    });
    expect(retry.templateTransitions).toHaveLength(1);
    const repaired = JSON.parse(await readFile(paths.configPath, "utf8")) as {
      templates: { installed: Array<{ id: string; manifestSha256: string }> };
    };
    expect(
      repaired.templates.installed.find((entry) => entry.id === "fixture-tool")?.manifestSha256,
    ).toBe(tool.manifestSha256);
  });

  it("clears a stale transition journal once state is consistent", async () => {
    await writeCatalog(V1);
    await writeConfig(await pinEntriesFor());
    const journalPath = join(tempRoot, "etc", "template-transition-journal.json");
    await writeFile(journalPath, JSON.stringify({ schemaVersion: 1, state: "prepared" }), "utf8");

    const result = await makeService().reconcileAgentWorkspaces();
    expect(result.templateTransitions).toEqual([]);
    await expect(access(journalPath)).rejects.toThrow();
  });
});
