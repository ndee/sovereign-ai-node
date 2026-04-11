import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { LoadedBotPackage } from "../bots/catalog.js";
import type { SovereignPaths } from "../config/paths.js";
import type { InstallRequest } from "../contracts/index.js";
import { createLogger } from "../logging/logger.js";
import type {
  OpenClawBootstrapper,
  OpenClawInstallInfo,
  OpenClawInstallOptions,
} from "../openclaw/bootstrap.js";
import { SOVEREIGN_PINNED_OPENCLAW_VERSION } from "../openclaw/bootstrap.js";
import type { ExecInput, ExecResult } from "../system/exec.js";
import type { ImapTester } from "../system/imap.js";
import type { BundledMatrixProvisioner, BundledMatrixProvisionResult } from "../system/matrix.js";
import type { HostPreflightChecker } from "../system/preflight.js";
import { RealInstallerService } from "./real-service.js";
import type { RuntimeConfig } from "./real-service-shared.js";

const priorBotRepoDir = process.env.SOVEREIGN_BOTS_REPO_DIR;
const priorBotRepoUrl = process.env.SOVEREIGN_BOTS_REPO_URL;
const priorBotRepoRef = process.env.SOVEREIGN_BOTS_REPO_REF;

let testBotRepoDir = "";

const managedAgentAccessTokenDir = (paths: SovereignPaths): string =>
  join(dirname(paths.configPath), "matrix-agent-access-tokens");

const managedAgentAccessTokenPath = (paths: SovereignPaths, agentId: string): string =>
  join(managedAgentAccessTokenDir(paths), `matrix-agent-${agentId}-access-token`);

const buildInstallRequest = (): InstallRequest => ({
  mode: "bundled_matrix",
  openclaw: {
    manageInstallation: true,
    installMethod: "install_sh",
    version: "pinned-by-sovereign",
    skipIfCompatibleInstalled: true,
    forceReinstall: false,
    runOnboard: false,
  },
  openrouter: {
    model: "qwen/qwen3.5-9b",
    apiKey: "sk-or-test",
  },
  imap: {
    host: "imap.example.org",
    port: 993,
    tls: true,
    username: "operator@example.org",
    secretRef: "file:/tmp/imap-secret",
    mailbox: "INBOX",
  },
  matrix: {
    homeserverDomain: "matrix.example.org",
    publicBaseUrl: "https://matrix.example.org",
    federationEnabled: false,
    tlsMode: "local-dev",
    alertRoomName: "Sovereign Alerts",
  },
  operator: {
    username: "operator",
  },
  bots: {
    config: {
      "mail-sentinel": {
        pollInterval: "30m",
        lookbackWindow: "1h",
        e2eeAlertRoom: false,
      },
    },
    instances: [],
  },
  advanced: {
    nonInteractive: true,
  },
});

const maybeHandleInstalledLobsterExec = (input: {
  command: string;
  args?: string[];
}): ExecResult | null => {
  const serialized = [input.command, ...(input.args ?? [])].join(" ");
  if (serialized === "lobster commands.list | json") {
    return {
      command: serialized,
      exitCode: 0,
      stdout: JSON.stringify(["commands.list", "clawd.invoke", "llm_task.invoke"]),
      stderr: "",
    };
  }
  if (serialized === "npm list -g @clawdbot/lobster --json --depth=0") {
    return {
      command: serialized,
      exitCode: 0,
      stdout: JSON.stringify({
        dependencies: {
          "@clawdbot/lobster": {
            version: "2026.1.24",
          },
        },
      }),
      stderr: "",
    };
  }
  if (serialized === "npm install -g @clawdbot/lobster@2026.1.24") {
    return {
      command: serialized,
      exitCode: 0,
      stdout: "installed lobster",
      stderr: "",
    };
  }
  return null;
};

const writeBotRepoFixture = async (rootDir: string): Promise<void> => {
  const writeBotPackage = async (input: {
    id: string;
    displayName: string;
    description: string;
    defaultInstall: boolean;
    helloMessage?: string;
    matrixMode: "dedicated-account" | "service-account";
    matrixRouting?: {
      defaultAccount?: boolean;
      dm?: {
        enabled?: boolean;
      };
      alertRoom?: {
        autoReply?: boolean;
        requireMention?: boolean;
      };
    };
    configDefaults?: Record<string, string | boolean | number>;
    toolTemplates?: unknown[];
    toolInstances?: unknown[];
    openclaw?: Record<string, unknown>;
    requiredToolTemplates?: Array<{ id: string; version: string }>;
    optionalToolTemplates?: Array<{ id: string; version: string }>;
    agentTemplateModel?: string;
    extraWorkspaceFiles?: Array<{ path: string; source: string; content: string; mode?: string }>;
  }): Promise<void> => {
    const packageDir = join(rootDir, "bots", input.id);
    await mkdir(join(packageDir, "workspace", "skills", `${input.id}-core`), { recursive: true });
    await writeFile(join(packageDir, "workspace", "README.md"), `# ${input.displayName}\n`, "utf8");
    await writeFile(
      join(packageDir, "workspace", "AGENTS.md"),
      `# ${input.id}\nOperator: {{MATRIX_OPERATOR_USER_ID}}\n`,
      "utf8",
    );
    await writeFile(join(packageDir, "workspace", "TOOLS.md"), "{{TOOL_SECTION}}\n", "utf8");
    await writeFile(
      join(packageDir, "workspace", "skills", `${input.id}-core`, "SKILL.md"),
      `# ${input.displayName}\n`,
      "utf8",
    );
    for (const file of input.extraWorkspaceFiles ?? []) {
      await mkdir(dirname(join(packageDir, file.source)), { recursive: true });
      await writeFile(join(packageDir, file.source), file.content, "utf8");
    }
    await writeFile(
      join(packageDir, "sovereign-bot.json"),
      `${JSON.stringify(
        {
          kind: "sovereign-bot-package",
          manifestVersion: 2,
          id: input.id,
          version: "2.0.0",
          displayName: input.displayName,
          description: input.description,
          defaultInstall: input.defaultInstall,
          ...(input.helloMessage === undefined ? {} : { helloMessage: input.helloMessage }),
          matrixIdentity: {
            mode: input.matrixMode,
            localpartPrefix: input.id,
          },
          ...(input.matrixRouting === undefined ? {} : { matrixRouting: input.matrixRouting }),
          configDefaults: input.configDefaults ?? {},
          toolTemplates: input.toolTemplates ?? [],
          toolInstances: input.toolInstances ?? [],
          hostResources: [
            {
              id: "workspace-readme",
              kind: "managedFile",
              spec: {
                path: { join: [{ from: "agent.workspace" }, "/README.md"] },
                source: "workspace/README.md",
                writePolicy: "always",
              },
            },
            {
              id: "workspace-agents",
              kind: "managedFile",
              spec: {
                path: { join: [{ from: "agent.workspace" }, "/AGENTS.md"] },
                source: "workspace/AGENTS.md",
                writePolicy: "always",
              },
            },
            {
              id: "workspace-tools",
              kind: "managedFile",
              spec: {
                path: { join: [{ from: "agent.workspace" }, "/TOOLS.md"] },
                source: "workspace/TOOLS.md",
                writePolicy: "always",
              },
            },
            {
              id: "workspace-skill",
              kind: "managedFile",
              spec: {
                path: { join: [{ from: "agent.workspace" }, `/skills/${input.id}-core/SKILL.md`] },
                source: `workspace/skills/${input.id}-core/SKILL.md`,
                writePolicy: "always",
              },
            },
            ...(input.extraWorkspaceFiles ?? []).map((file) => ({
              id: `workspace-${file.path.replaceAll(/[/.]/g, "-")}`,
              kind: "managedFile",
              spec: {
                path: { join: [{ from: "agent.workspace" }, `/${file.path}`] },
                source: file.source,
                writePolicy:
                  file.path.startsWith("config/") ||
                  (file.path.startsWith("data/") && !file.path.toLowerCase().endsWith("readme.md"))
                    ? "ifMissing"
                    : "always",
                ...(file.mode === undefined ? {} : { mode: file.mode }),
              },
            })),
            ...(() => {
              const cron = (input.openclaw as { cron?: Record<string, unknown> } | undefined)?.cron;
              if (cron === undefined) {
                return [];
              }
              return [
                {
                  id: "managed-openclaw-cron",
                  kind: "openclawCron",
                  spec: {
                    id: typeof cron.id === "string" ? cron.id : `${input.id}-cron`,
                    agentId: input.id,
                    every:
                      typeof cron.defaultEvery === "string"
                        ? cron.defaultEvery
                        : typeof cron.every === "string"
                          ? cron.every
                          : "5m",
                    session: cron.session === "isolated" ? "isolated" : "isolated",
                    message: typeof cron.message === "string" ? cron.message : "hello",
                    ...(cron.announce === false
                      ? {}
                      : { announceRoomId: { from: "matrix.alertRoomId" } }),
                    desiredState: "present",
                  },
                },
              ];
            })(),
          ],
          agentTemplate: {
            id: input.id,
            version: "2.0.0",
            description: input.description,
            ...(input.agentTemplateModel === undefined ? {} : { model: input.agentTemplateModel }),
            matrix: {
              localpartPrefix: input.id,
            },
            requiredToolTemplates: input.requiredToolTemplates ?? [],
            optionalToolTemplates: input.optionalToolTemplates ?? [],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  };

  await writeBotPackage({
    id: "bitcoin-skill-match",
    displayName: "Bitcoin Skill Match",
    description:
      "Matrix-based community matchmaker that stores local skill profiles and trusted matches.",
    defaultInstall: false,
    helloMessage:
      "Hello from Bitcoin Skill Match. I can capture profiles and suggest trusted matches for your local Bitcoin community.",
    matrixMode: "dedicated-account",
    matrixRouting: {
      defaultAccount: true,
      dm: {
        enabled: true,
      },
      alertRoom: {
        autoReply: true,
        requireMention: false,
      },
    },
    configDefaults: {
      statePath: "data/community-state.json",
      statePolicyPath: "data/community-state.policy.json",
      stateAuditPath: "data/community-state.audit.jsonl",
    },
    toolTemplates: [
      {
        kind: "sovereign-tool-template",
        id: "guarded-json-state",
        version: "1.0.0",
        description: "Guarded JSON state access for self-owned records with auditable mutations.",
        capabilities: ["json-state.read", "json-state.self-upsert", "json-state.self-delete"],
        requiredSecretRefs: [],
        requiredConfigKeys: ["statePath", "policyPath"],
        allowedCommands: [],
        openclawPlugins: ["guarded-json-state"],
        openclawToolNames: ["guarded_json_state"],
      },
    ],
    toolInstances: [
      {
        id: "bitcoin-skill-match-state",
        templateRef: "guarded-json-state@1.0.0",
        config: {
          statePath: {
            from: "bots.config.bitcoin-skill-match.statePath",
          },
          policyPath: {
            from: "bots.config.bitcoin-skill-match.statePolicyPath",
          },
          auditPath: {
            from: "bots.config.bitcoin-skill-match.stateAuditPath",
          },
        },
        secretRefs: {},
      },
    ],
    requiredToolTemplates: [
      {
        id: "guarded-json-state",
        version: "1.0.0",
      },
    ],
  });

  await writeBotPackage({
    id: "mail-sentinel",
    displayName: "Mail Sentinel",
    description:
      "Local-first inbox sentinel that detects important mail, alerts Matrix, and adapts from feedback.",
    defaultInstall: true,
    helloMessage:
      "Hello from Mail Sentinel. I watch incoming mail, alert only on important signals, and learn from your feedback.",
    matrixMode: "dedicated-account",
    matrixRouting: {
      dm: {
        enabled: true,
      },
      alertRoom: {
        autoReply: true,
        requireMention: false,
      },
    },
    configDefaults: {
      agentId: "mail-sentinel",
      imapInstanceId: "mail-sentinel-imap",
      pollInterval: "5m",
      lookbackWindow: "15m",
      defaultReminderDelay: "4h",
      e2eeAlertRoom: false,
      model: "qwen/qwen-2.5-32b-instruct",
      statePath: "data/mail-sentinel-state.json",
      rulesPath: "config/default-rules.json",
    },
    toolTemplates: [
      {
        kind: "sovereign-tool-template",
        id: "mail-sentinel-tool",
        version: "1.0.0",
        description:
          "Local-first mail watcher for IMAP scoring, Matrix alerts, and feedback-driven tuning.",
        capabilities: ["mail-sentinel.scan", "mail-sentinel.feedback", "mail-sentinel.alerts.read"],
        requiredSecretRefs: [],
        requiredConfigKeys: ["agentId", "imapInstanceId", "statePath", "rulesPath"],
        openclawBundledPlugins: ["lobster", "llm-task"],
        openclawToolNames: ["lobster", "llm-task"],
        allowedCommands: [
          "<agent-workspace>/bin/mail-sentinel.js scan --instance <tool-instance-id> --json",
          "<agent-workspace>/bin/mail-sentinel.js list-alerts --instance <tool-instance-id> --view today --json",
          "<agent-workspace>/bin/mail-sentinel.js list-alerts --instance <tool-instance-id> --view recent --json",
          "<agent-workspace>/bin/mail-sentinel.js feedback --instance <tool-instance-id> --latest --action important --json",
          "<agent-workspace>/bin/mail-sentinel.js feedback --instance <tool-instance-id> --alert-id <alert-id> --action important --json",
          "<agent-workspace>/bin/mail-sentinel.js feedback --instance <tool-instance-id> --alert-id <alert-id> --action remind-later --delay <duration> --json",
        ],
      },
    ],
    toolInstances: [
      {
        id: "mail-sentinel-imap",
        templateRef: "imap-readonly@1.0.0",
        enabledWhen: {
          path: "imap.status",
          equals: "configured",
        },
        config: {
          host: {
            from: "imap.host",
          },
          port: {
            from: "imap.port",
            stringify: true,
          },
          tls: {
            from: "imap.tls",
            stringify: true,
          },
          username: {
            from: "imap.username",
          },
          mailbox: {
            from: "imap.mailbox",
          },
        },
        secretRefs: {
          password: {
            from: "imap.secretRef",
          },
        },
      },
      {
        id: "mail-sentinel-core",
        templateRef: "mail-sentinel-tool@1.0.0",
        config: {
          agentId: {
            from: "bots.config.mail-sentinel.agentId",
          },
          imapInstanceId: {
            from: "bots.config.mail-sentinel.imapInstanceId",
          },
          statePath: {
            from: "bots.config.mail-sentinel.statePath",
          },
          rulesPath: {
            from: "bots.config.mail-sentinel.rulesPath",
          },
          lookbackWindow: {
            from: "bots.config.mail-sentinel.lookbackWindow",
          },
          defaultReminderDelay: {
            from: "bots.config.mail-sentinel.defaultReminderDelay",
          },
        },
        secretRefs: {},
      },
    ],
    openclaw: {
      cron: {
        id: "mail-sentinel-poll",
        everyConfigKey: "pollInterval",
        defaultEvery: "30m",
        session: "isolated",
        announce: false,
        message:
          "Run the Mail Sentinel scan command from TOOLS.md for the configured instance. Do not summarize the inbox manually. Do not add extra commentary beyond the tool result.",
      },
    },
    requiredToolTemplates: [
      {
        id: "mail-sentinel-tool",
        version: "1.0.0",
      },
      {
        id: "imap-readonly",
        version: "1.0.0",
      },
    ],
    optionalToolTemplates: [],
    agentTemplateModel: "qwen/qwen-2.5-32b-instruct",
    extraWorkspaceFiles: [
      {
        path: "bin/mail-sentinel.js",
        source: "workspace/bin/mail-sentinel.js",
        content: "#!/usr/bin/env node\n",
        mode: "755",
      },
      {
        path: "config/default-rules.json",
        source: "workspace/config/default-rules.json",
        content: "{}\n",
      },
      {
        path: "config/user-policy.json",
        source: "workspace/config/user-policy.json",
        content:
          '{\n  "version": 1,\n  "senderPolicies": [],\n  "domainPolicies": [],\n  "categoryPolicies": [],\n  "contentPolicies": [],\n  "timePolicies": [],\n  "mutePolicies": []\n}\n',
      },
      {
        path: "data/README.md",
        source: "workspace/data/README.md",
        content: "Mail Sentinel data.\n",
      },
    ],
  });

  await writeBotPackage({
    id: "node-operator",
    displayName: "Node Operator",
    description: "Conversational operator that manages Sovereign Node and managed agents.",
    defaultInstall: false,
    helloMessage: "Hello from Node Operator. Ask me for Sovereign Node and system status.",
    matrixMode: "dedicated-account",
    matrixRouting: {
      dm: {
        enabled: true,
      },
      alertRoom: {
        autoReply: false,
        requireMention: true,
      },
    },
    toolInstances: [
      {
        id: "node-operator-cli",
        templateRef: "node-cli-ops@1.0.0",
        config: {},
        secretRefs: {},
      },
    ],
    requiredToolTemplates: [
      {
        id: "node-cli-ops",
        version: "1.0.0",
      },
    ],
    optionalToolTemplates: [
      {
        id: "imap-readonly",
        version: "1.0.0",
      },
    ],
  });
};

const buildTestLoadedBotPackage = (input: {
  id: string;
  displayName: string;
  description: string;
  matrixMode: "dedicated-account" | "service-account";
  model?: string;
  helloMessage?: string;
  matrixRouting?: {
    defaultAccount?: boolean;
    dm?: {
      enabled?: boolean;
    };
    alertRoom?: {
      autoReply?: boolean;
      requireMention?: boolean;
    };
  };
}): LoadedBotPackage => ({
  manifest: {
    kind: "sovereign-bot-package",
    manifestVersion: 2,
    id: input.id,
    version: "2.0.0",
    displayName: input.displayName,
    description: input.description,
    defaultInstall: false,
    ...(input.helloMessage === undefined ? {} : { helloMessage: input.helloMessage }),
    matrixIdentity: {
      mode: input.matrixMode,
      localpartPrefix: input.id,
    },
    ...(input.matrixRouting === undefined ? {} : { matrixRouting: input.matrixRouting }),
    configDefaults: {},
    toolTemplates: [],
    toolInstances: [],
    hostResources: [],
    agentTemplate: {
      id: input.id,
      version: "2.0.0",
      description: input.description,
      ...(input.model === undefined ? {} : { model: input.model }),
      matrix: {
        localpartPrefix: input.id,
      },
      requiredToolTemplates: [],
      optionalToolTemplates: [],
    },
  },
  template: {
    kind: "sovereign-agent-template",
    id: input.id,
    version: "2.0.0",
    description: input.description,
    ...(input.model === undefined ? {} : { model: input.model }),
    matrix: {
      localpartPrefix: input.id,
    },
    requiredToolTemplates: [],
    optionalToolTemplates: [],
    signature: {
      algorithm: "ed25519",
      keyId: "repo:sovereign-ai-bots",
      value: "filesystem-trust",
    },
  },
  toolTemplates: [],
  templateRef: `${input.id}@1.0.0`,
  keyId: "repo:sovereign-ai-bots",
  manifestSha256: `test-sha-${input.id}`,
  rootDir: join("/tmp", "sovereign-bot-tests", input.id),
});

beforeAll(async () => {
  testBotRepoDir = await mkdtemp(join(tmpdir(), "sovereign-node-bot-repo-test-"));
  await writeBotRepoFixture(testBotRepoDir);
  process.env.SOVEREIGN_BOTS_REPO_DIR = testBotRepoDir;
  delete process.env.SOVEREIGN_BOTS_REPO_URL;
  delete process.env.SOVEREIGN_BOTS_REPO_REF;
});

afterAll(async () => {
  await rm(testBotRepoDir, { recursive: true, force: true });
  if (priorBotRepoDir === undefined) {
    delete process.env.SOVEREIGN_BOTS_REPO_DIR;
  } else {
    process.env.SOVEREIGN_BOTS_REPO_DIR = priorBotRepoDir;
  }
  if (priorBotRepoUrl === undefined) {
    delete process.env.SOVEREIGN_BOTS_REPO_URL;
  } else {
    process.env.SOVEREIGN_BOTS_REPO_URL = priorBotRepoUrl;
  }
  if (priorBotRepoRef === undefined) {
    delete process.env.SOVEREIGN_BOTS_REPO_REF;
  } else {
    process.env.SOVEREIGN_BOTS_REPO_REF = priorBotRepoRef;
  }
});

const writeRuntimeArtifacts = async (paths: SovereignPaths): Promise<void> => {
  const runtimeConfigPath = join(paths.openclawServiceHome, ".openclaw", "openclaw.json5");
  const runtimeProfilePath = join(
    paths.openclawServiceHome,
    "profiles",
    "sovereign-runtime-profile.json5",
  );
  const gatewayEnvPath = join(paths.openclawServiceHome, "gateway.env");
  const matrixOperatorTokenPath = join(paths.secretsDir, "matrix-operator-access-token");
  const matrixBotTokenPath = join(paths.secretsDir, "matrix-bot-access-token");
  const matrixOperatorPasswordPath = join(paths.secretsDir, "matrix-operator.password");
  const projectDir = join(paths.stateDir, "bundled-matrix", "matrix-example-org");
  const onboardingStatePath = join(projectDir, "onboarding", "state.json");

  await mkdir(dirname(paths.configPath), { recursive: true });
  await mkdir(paths.secretsDir, { recursive: true });
  await mkdir(dirname(runtimeConfigPath), { recursive: true });
  await mkdir(dirname(runtimeProfilePath), { recursive: true });
  await mkdir(join(paths.stateDir, "mail-sentinel"), { recursive: true });
  await mkdir(dirname(onboardingStatePath), { recursive: true });

  await writeFile(matrixOperatorPasswordPath, "operator-password\n", "utf8");
  await writeFile(matrixOperatorTokenPath, "operator-token\n", "utf8");
  await writeFile(matrixBotTokenPath, "bot-token\n", "utf8");
  await writeFile(
    paths.configPath,
    `${JSON.stringify(
      {
        contractVersion: "1.0.0",
        mode: "bundled_matrix",
        openclaw: {
          managedInstallation: true,
          installMethod: "install_sh",
          requestedVersion: "0.2.0",
          serviceHome: paths.openclawServiceHome,
          openclawHome: join(paths.openclawServiceHome, ".openclaw"),
          runtimeConfigPath,
          runtimeProfilePath,
          gatewayEnvPath,
        },
        openrouter: {
          model: "qwen/qwen3.5-9b",
          apiKeySecretRef: "env:OPENROUTER_API_KEY",
        },
        openclawProfile: {
          plugins: {
            allow: ["matrix"],
          },
          agents: [
            {
              id: "mail-sentinel",
              workspace: join(paths.stateDir, "mail-sentinel", "workspace"),
            },
          ],
          cron: {
            id: "mail-sentinel-poll",
            every: "5m",
          },
        },
        imap: {
          host: "imap.example.org",
          mailbox: "INBOX",
          secretRef: "file:/tmp/imap-secret",
        },
        matrix: {
          accessMode: "direct",
          homeserverDomain: "matrix.example.org",
          publicBaseUrl: "https://matrix.example.org",
          adminBaseUrl: "http://127.0.0.1:8008",
          federationEnabled: false,
          projectDir,
          onboardingStatePath,
          operator: {
            localpart: "operator",
            userId: "@operator:matrix.example.org",
            passwordSecretRef: `file:${matrixOperatorPasswordPath}`,
            accessTokenSecretRef: `file:${matrixOperatorTokenPath}`,
          },
          bot: {
            localpart: "mail-sentinel",
            userId: "@mail-sentinel:matrix.example.org",
            accessTokenSecretRef: `file:${matrixBotTokenPath}`,
          },
          alertRoom: {
            roomId: "!alerts:matrix.example.org",
            roomName: "Sovereign Alerts",
          },
        },
        bots: {
          config: {
            "mail-sentinel": {
              pollInterval: "30m",
              lookbackWindow: "1h",
              e2eeAlertRoom: false,
            },
          },
          instances: [],
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(runtimeConfigPath, '{\n  "source": "test"\n}\n', "utf8");
  await writeFile(runtimeProfilePath, '{\n  "source": "test"\n}\n', "utf8");
  await writeFile(
    gatewayEnvPath,
    [
      `HOME=${paths.openclawServiceHome}`,
      `OPENCLAW_HOME=${paths.openclawServiceHome}`,
      `OPENCLAW_CONFIG=${runtimeConfigPath}`,
      `OPENCLAW_CONFIG_PATH=${runtimeConfigPath}`,
      `SOVEREIGN_NODE_CONFIG=${paths.configPath}`,
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(paths.stateDir, "mail-sentinel", "registration.json"),
    `${JSON.stringify(
      {
        agentId: "mail-sentinel",
        cronJobId: "mail-sentinel-poll",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
};

const writeDedicatedBotRuntimeArtifacts = async (paths: SovereignPaths): Promise<void> => {
  await writeRuntimeArtifacts(paths);

  const bitcoinWorkspace = join(paths.stateDir, "bitcoin-skill-match", "workspace");
  const nodeOperatorWorkspace = join(paths.stateDir, "node-operator", "workspace");
  const bitcoinTokenPath = managedAgentAccessTokenPath(paths, "bitcoin-skill-match");
  const bitcoinPasswordPath = join(paths.secretsDir, "matrix-agent-bitcoin-skill-match-password");
  const nodeOperatorTokenPath = managedAgentAccessTokenPath(paths, "node-operator");
  const nodeOperatorPasswordPath = join(paths.secretsDir, "matrix-agent-node-operator-password");

  await mkdir(bitcoinWorkspace, { recursive: true });
  await mkdir(nodeOperatorWorkspace, { recursive: true });
  await mkdir(managedAgentAccessTokenDir(paths), { recursive: true });
  await writeFile(bitcoinTokenPath, "bitcoin-skill-match-token\n", "utf8");
  await writeFile(bitcoinPasswordPath, "bitcoin-skill-match-password\n", "utf8");
  await writeFile(nodeOperatorTokenPath, "node-operator-token\n", "utf8");
  await writeFile(nodeOperatorPasswordPath, "node-operator-password\n", "utf8");

  const raw = await readFile(paths.configPath, "utf8");
  const parsed = JSON.parse(raw) as {
    openclawProfile?: {
      agents?: Array<Record<string, unknown>>;
      crons?: Array<Record<string, unknown>>;
    };
    matrix?: {
      bot?: Record<string, unknown>;
    };
  };

  parsed.openclawProfile = {
    ...(parsed.openclawProfile ?? {}),
    agents: [
      {
        id: "bitcoin-skill-match",
        workspace: bitcoinWorkspace,
        templateRef: "bitcoin-skill-match@2.0.0",
        botId: "bitcoin-skill-match",
        matrix: {
          localpart: "bitcoin-skill-match",
          userId: "@bitcoin-skill-match:matrix.example.org",
          passwordSecretRef: `file:${bitcoinPasswordPath}`,
          accessTokenSecretRef: `file:${bitcoinTokenPath}`,
        },
      },
      {
        id: "node-operator",
        workspace: nodeOperatorWorkspace,
        templateRef: "node-operator@2.0.0",
        botId: "node-operator",
        toolInstanceIds: ["node-operator-cli"],
        default: true,
        matrix: {
          localpart: "node-operator",
          userId: "@node-operator:matrix.example.org",
          passwordSecretRef: `file:${nodeOperatorPasswordPath}`,
          accessTokenSecretRef: `file:${nodeOperatorTokenPath}`,
        },
      },
    ],
    crons: [],
  };
  parsed.matrix = {
    ...(parsed.matrix ?? {}),
    bot: {
      localpart: "bitcoin-skill-match",
      userId: "@bitcoin-skill-match:matrix.example.org",
      passwordSecretRef: `file:${bitcoinPasswordPath}`,
      accessTokenSecretRef: `file:${bitcoinTokenPath}`,
    },
  };

  await writeFile(paths.configPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
};

const writeLegacyCorePinnedMailSentinelTemplate = async (paths: SovereignPaths): Promise<void> => {
  const raw = await readFile(paths.configPath, "utf8");
  const parsed = JSON.parse(raw) as {
    openclawProfile?: {
      agents?: Array<Record<string, unknown>>;
      crons?: Array<Record<string, unknown>>;
    };
    templates?: {
      installed?: Array<Record<string, unknown>>;
    };
  };

  parsed.openclawProfile = {
    ...(parsed.openclawProfile ?? {}),
    agents: [
      {
        id: "mail-sentinel",
        workspace: join(paths.stateDir, "mail-sentinel", "workspace"),
        templateRef: "mail-sentinel@2.0.0",
        botId: "mail-sentinel",
        matrix: {
          localpart: "mail-sentinel",
          userId: "@mail-sentinel:matrix.example.org",
          passwordSecretRef: "file:/tmp/mail-sentinel.password",
        },
      },
    ],
    crons: [
      {
        id: "mail-sentinel-poll",
        every: "5m",
        agentId: "mail-sentinel",
        botId: "mail-sentinel",
      },
    ],
  };
  parsed.templates = {
    installed: [
      {
        kind: "agent",
        id: "mail-sentinel",
        version: "1.0.0",
        description: "Legacy Mail Sentinel template",
        trusted: true,
        pinned: true,
        keyId: "sovereign-core-ed25519-2026-01",
        manifestSha256: "legacy-core-mail-sentinel-pin",
        installedAt: "2026-03-01T00:00:00.000Z",
        source: "core",
      },
    ],
  };

  await writeFile(paths.configPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
};

const writeNoCronManagedAgentRuntime = async (paths: SovereignPaths): Promise<void> => {
  const raw = await readFile(paths.configPath, "utf8");
  const parsed = JSON.parse(raw) as {
    openclawProfile?: {
      agents?: Array<Record<string, unknown>>;
      crons?: Array<Record<string, unknown>>;
    };
    matrix?: {
      bot?: Record<string, unknown>;
    };
  };

  parsed.openclawProfile = {
    ...(parsed.openclawProfile ?? {}),
    agents: [
      {
        id: "node-operator",
        workspace: join(paths.stateDir, "node-operator", "workspace"),
        templateRef: "node-operator@2.0.0",
        botId: "node-operator",
        matrix: {
          localpart: "node-operator",
          userId: "@node-operator:matrix.example.org",
          passwordSecretRef: "file:/tmp/node-operator.password",
        },
      },
    ],
    crons: [],
  };

  parsed.matrix = {
    ...(parsed.matrix ?? {}),
    bot: {
      localpart: "node-operator",
      userId: "@node-operator:matrix.example.org",
      accessTokenSecretRef: "file:/tmp/node-operator-access-token",
    },
  };

  await mkdir(join(paths.stateDir, "node-operator"), { recursive: true });
  await writeFile(
    join(paths.stateDir, "node-operator", "registration.json"),
    `${JSON.stringify(
      {
        agentId: "node-operator",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(paths.configPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
};

const buildManagedAgentMatrixProvisionResponse = (
  url: string,
  init?: RequestInit,
): Response | null => {
  if (url.includes("/_synapse/admin/v2/users/")) {
    const encoded = url.split("/_synapse/admin/v2/users/")[1] ?? "";
    const decoded = decodeURIComponent(encoded);
    return new Response(JSON.stringify({ name: decoded }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.endsWith("/_matrix/client/v3/login")) {
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as { identifier?: { user?: string } })
        : {};
    const localpart = body.identifier?.user ?? "unknown";
    return new Response(
      JSON.stringify({
        user_id: `@${localpart}:matrix.example.org`,
        access_token: `${localpart}-token`,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
  if (url.includes("/_matrix/client/v3/rooms/") && url.endsWith("/invite")) {
    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.includes("/_matrix/client/v3/rooms/") && url.endsWith("/join")) {
    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
};

describe("RealInstallerService", () => {
  it("generates an immutable relay slug during enrollment instead of honoring caller-provided slugs", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };

    let capturedRequestedSlug = "";
    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => null,
        ensureInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "pinned-by-sovereign",
          installMethod: "install_sh",
        }),
      },
      openclawGatewayServiceManager: {
        install: async () => {},
        start: async () => {},
        restart: async () => {},
      },
      managedAgentRegistrar: {
        register: async () => ({
          agentId: "mail-sentinel",
          cronJobId: "mail-sentinel-poll",
          workspaceDir: "/tmp/ws",
          agentCommand: "openclaw agents add mail-sentinel",
          cronCommand: "openclaw cron add --name mail-sentinel-poll",
        }),
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async (req) => ({
          ok: true,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "ok",
        }),
      },
      matrixProvisioner: {
        provision: async (req) => ({
          projectDir: "/tmp/fake-matrix",
          composeFilePath: "/tmp/fake-matrix/compose.yaml",
          accessMode: "relay",
          homeserverDomain: req.matrix.homeserverDomain,
          publicBaseUrl: req.matrix.publicBaseUrl,
          adminBaseUrl: "http://127.0.0.1:8008",
          federationEnabled: false,
          tlsMode: "auto",
        }),
        bootstrapAccounts: async () => ({
          operator: {
            localpart: "operator",
            userId: "@operator:pilot-node.relay.sovereign-ai-node.com",
            passwordSecretRef: "file:/tmp/operator.password",
            accessToken: "operator-token",
          },
          bot: {
            localpart: "mail-sentinel",
            userId: "@mail-sentinel:pilot-node.relay.sovereign-ai-node.com",
            passwordSecretRef: "file:/tmp/mail-sentinel.password",
            accessToken: "bot-token",
          },
        }),
        bootstrapRoom: async () => ({
          roomId: "!alerts:pilot-node.relay.sovereign-ai-node.com",
          roomName: "Sovereign Alerts",
        }),
        test: async (req) => ({
          ok: true,
          homeserverUrl: req.publicBaseUrl,
          checks: [],
        }),
      },
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { requestedSlug?: unknown };
        capturedRequestedSlug = typeof body.requestedSlug === "string" ? body.requestedSlug : "";
        return new Response(
          JSON.stringify({
            result: {
              assignedHostname: "pilot-node.relay.sovereign-ai-node.com",
              publicBaseUrl: "https://pilot-node.relay.sovereign-ai-node.com",
              tunnel: {
                serverAddr: "relay.sovereign-ai-node.com",
                serverPort: 7000,
                token: "relay-token",
                proxyName: "relay-pilot-node",
              },
            },
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          },
        );
      },
    });

    try {
      const req = buildInstallRequest() as InstallRequest & {
        relay: { controlUrl: string; enrollmentToken: string; requestedSlug: string };
      };
      req.connectivity = { mode: "relay" };
      req.relay = {
        controlUrl: "https://relay.sovereign-ai-node.com",
        enrollmentToken: "relay-enrollment-token",
        requestedSlug: "user-picked-name",
      };
      req.imap = undefined;
      req.matrix.homeserverDomain = "relay-pending.invalid";
      req.matrix.publicBaseUrl = "https://relay-pending.invalid";
      req.matrix.federationEnabled = false;
      req.matrix.tlsMode = "auto";

      const enrollment = await (
        service as unknown as {
          resolveRelayEnrollment: (
            value: InstallRequest,
            installationId: string,
          ) => Promise<{
            hostname: string;
            publicBaseUrl: string;
          }>;
        }
      ).resolveRelayEnrollment(req, "inst_test_custom_relay");

      expect(capturedRequestedSlug).toMatch(/^[a-z0-9-]{1,63}$/);
      expect(capturedRequestedSlug).not.toBe("user-picked-name");
      expect(enrollment.hostname).toBe("pilot-node.relay.sovereign-ai-node.com");
      expect(enrollment.publicBaseUrl).toBe("https://pilot-node.relay.sovereign-ai-node.com");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("uses public enrollment for the default managed relay when no token is provided", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };

    let capturedUrl = "";
    let capturedInstallationId = "";
    let capturedEnrollmentToken = "";
    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => null,
        ensureInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "pinned-by-sovereign",
          installMethod: "install_sh",
        }),
      },
      openclawGatewayServiceManager: {
        install: async () => {},
        start: async () => {},
        restart: async () => {},
      },
      managedAgentRegistrar: {
        register: async () => ({
          agentId: "mail-sentinel",
          cronJobId: "mail-sentinel-poll",
          workspaceDir: "/tmp/ws",
          agentCommand: "openclaw agents add mail-sentinel",
          cronCommand: "openclaw cron add --name mail-sentinel-poll",
        }),
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async (req) => ({
          ok: true,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "ok",
        }),
      },
      matrixProvisioner: {
        provision: async (req) => ({
          projectDir: "/tmp/fake-matrix",
          composeFilePath: "/tmp/fake-matrix/compose.yaml",
          accessMode: "relay",
          homeserverDomain: req.matrix.homeserverDomain,
          publicBaseUrl: req.matrix.publicBaseUrl,
          adminBaseUrl: "http://127.0.0.1:8008",
          federationEnabled: false,
          tlsMode: "auto",
        }),
        bootstrapAccounts: async () => ({
          operator: {
            localpart: "operator",
            userId: "@operator:pilot-node.relay.sovereign-ai-node.com",
            passwordSecretRef: "file:/tmp/operator.password",
            accessToken: "operator-token",
          },
          bot: {
            localpart: "mail-sentinel",
            userId: "@mail-sentinel:pilot-node.relay.sovereign-ai-node.com",
            passwordSecretRef: "file:/tmp/mail-sentinel.password",
            accessToken: "bot-token",
          },
        }),
        bootstrapRoom: async () => ({
          roomId: "!alerts:pilot-node.relay.sovereign-ai-node.com",
          roomName: "Sovereign Alerts",
        }),
        test: async (req) => ({
          ok: true,
          homeserverUrl: req.publicBaseUrl,
          checks: [],
        }),
      },
      fetchImpl: async (input, init) => {
        capturedUrl = input;
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          installationId?: unknown;
          enrollmentToken?: unknown;
        };
        capturedInstallationId = typeof body.installationId === "string" ? body.installationId : "";
        capturedEnrollmentToken =
          typeof body.enrollmentToken === "string" ? body.enrollmentToken : "";
        return new Response(
          JSON.stringify({
            result: {
              assignedHostname: "pilot-node.relay.sovereign-ai-node.com",
              publicBaseUrl: "https://pilot-node.relay.sovereign-ai-node.com",
              tunnel: {
                serverAddr: "relay.sovereign-ai-node.com",
                serverPort: 7000,
                token: "relay-token",
                proxyName: "relay-pilot-node",
              },
            },
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          },
        );
      },
    });

    try {
      const req = buildInstallRequest() as InstallRequest & {
        relay: { controlUrl: string };
      };
      req.connectivity = { mode: "relay" };
      req.relay = {
        controlUrl: "https://relay.sovereign-ai-node.com",
      };
      req.imap = undefined;
      req.matrix.homeserverDomain = "relay-pending.invalid";
      req.matrix.publicBaseUrl = "https://relay-pending.invalid";
      req.matrix.federationEnabled = false;
      req.matrix.tlsMode = "auto";

      const enrollment = await (
        service as unknown as {
          resolveRelayEnrollment: (
            value: InstallRequest,
            installationId: string,
          ) => Promise<{
            hostname: string;
            publicBaseUrl: string;
          }>;
        }
      ).resolveRelayEnrollment(req, "inst_public_managed_relay");

      expect(capturedUrl).toBe("https://relay.sovereign-ai-node.com/api/v1/enroll-public");
      expect(capturedInstallationId).toBe("inst_public_managed_relay");
      expect(capturedEnrollmentToken).toBe("");
      expect(enrollment.hostname).toBe("pilot-node.relay.sovereign-ai-node.com");
      expect(enrollment.publicBaseUrl).toBe("https://pilot-node.relay.sovereign-ai-node.com");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("preserves requested federation when building the effective relay install request", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };

    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => null,
        ensureInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "pinned-by-sovereign",
          installMethod: "install_sh",
        }),
      },
      openclawGatewayServiceManager: {
        install: async () => {},
        start: async () => {},
        restart: async () => {},
      },
      managedAgentRegistrar: {
        register: async () => ({
          agentId: "mail-sentinel",
          cronJobId: "mail-sentinel-poll",
          workspaceDir: "/tmp/ws",
          agentCommand: "openclaw agents add mail-sentinel",
          cronCommand: "openclaw cron add --name mail-sentinel-poll",
        }),
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async (req) => ({
          ok: true,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "ok",
        }),
      },
      matrixProvisioner: {
        provision: async () => {
          throw new Error("not used");
        },
        bootstrapAccounts: async () => {
          throw new Error("not used");
        },
        bootstrapRoom: async () => {
          throw new Error("not used");
        },
        test: async () => ({
          ok: true,
          homeserverUrl: "https://matrix.example.org",
          checks: [],
        }),
      },
      fetchImpl: async () =>
        new Response("{}", { status: 404, headers: { "Content-Type": "application/json" } }),
    });

    try {
      const req = buildInstallRequest() as InstallRequest & {
        relay: { controlUrl: string; enrollmentToken: string };
      };
      req.connectivity = { mode: "relay" };
      req.relay = {
        controlUrl: "https://relay.sovereign-ai-node.com",
        enrollmentToken: "relay-enrollment-token",
      };
      req.matrix.homeserverDomain = "relay-pending.invalid";
      req.matrix.publicBaseUrl = "https://relay-pending.invalid";
      req.matrix.federationEnabled = true;
      req.matrix.tlsMode = "auto";

      const effectiveReq = await (
        service as unknown as {
          buildRelayProvisionRequest: (
            value: InstallRequest,
            enrollment: {
              controlUrl: string;
              hostname: string;
              publicBaseUrl: string;
              tunnel: {
                serverAddr: string;
                serverPort: number;
                token: string;
                proxyName: string;
                type: "http";
                localIp: string;
                localPort: number;
              };
            },
          ) => InstallRequest;
        }
      ).buildRelayProvisionRequest(req, {
        controlUrl: "https://relay.sovereign-ai-node.com",
        hostname: "pilot-node.relay.sovereign-ai-node.com",
        publicBaseUrl: "https://pilot-node.relay.sovereign-ai-node.com",
        tunnel: {
          serverAddr: "relay.sovereign-ai-node.com",
          serverPort: 7000,
          token: "relay-token",
          proxyName: "relay-pilot-node",
          type: "http",
          localIp: "127.0.0.1",
          localPort: 18080,
        },
      });

      expect(effectiveReq.connectivity?.mode).toBe("relay");
      expect(effectiveReq.matrix.homeserverDomain).toBe("pilot-node.relay.sovereign-ai-node.com");
      expect(effectiveReq.matrix.publicBaseUrl).toBe(
        "https://pilot-node.relay.sovereign-ai-node.com",
      );
      expect(effectiveReq.matrix.federationEnabled).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("persists install job snapshots and serves them via getInstallJob", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };
    const ensureInstalledCalls: OpenClawInstallOptions[] = [];
    let preflightCalls = 0;
    let imapTestCalls = 0;
    let matrixProvisionCalls = 0;
    const fakeBootstrapper: OpenClawBootstrapper = {
      detectInstalled: async () => null,
      ensureInstalled: async (opts): Promise<OpenClawInstallInfo> => {
        ensureInstalledCalls.push(opts);
        return {
          binaryPath: "/usr/local/bin/openclaw",
          version: opts.version,
          installMethod: "install_sh",
        };
      },
    };
    const fakePreflightChecker: HostPreflightChecker = {
      run: async () => {
        preflightCalls += 1;
        return {
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        };
      },
    };
    const fakeImapTester: ImapTester = {
      test: async (req) => {
        imapTestCalls += 1;
        return {
          ok: false,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "failed",
          mailbox: req.imap.mailbox ?? "INBOX",
          error: {
            code: "IMAP_AUTH_FAILED",
            message: "Fake IMAP auth failure for installer-service unit test",
            retryable: false,
          },
        };
      },
    };
    const fakeMatrixProvisioner: BundledMatrixProvisioner = {
      provision: async (): Promise<BundledMatrixProvisionResult> => {
        matrixProvisionCalls += 1;
        return {
          projectDir: "/tmp/fake-matrix",
          composeFilePath: "/tmp/fake-matrix/compose.yaml",
          accessMode: "direct",
          homeserverDomain: "matrix.example.org",
          publicBaseUrl: "https://matrix.example.org",
          adminBaseUrl: "http://127.0.0.1:8008",
          federationEnabled: false,
          tlsMode: "local-dev",
        };
      },
      bootstrapAccounts: async () => {
        throw new Error("unexpected bootstrapAccounts call");
      },
      bootstrapRoom: async () => {
        throw new Error("unexpected bootstrapRoom call");
      },
      test: async (req) => ({
        ok: false,
        homeserverUrl: req.publicBaseUrl,
        checks: [],
      }),
    };
    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: fakeBootstrapper,
      openclawGatewayServiceManager: {
        install: async () => {},
        start: async () => {},
        restart: async () => {},
      },
      managedAgentRegistrar: {
        register: async () => {
          throw new Error("unexpected mail-sentinel register call");
        },
      },
      preflightChecker: fakePreflightChecker,
      imapTester: fakeImapTester,
      matrixProvisioner: fakeMatrixProvisioner,
    });

    try {
      const started = await service.startInstall(buildInstallRequest());

      expect(started.job.state).toBe("failed");
      expect(started.job.steps[0]?.id).toBe("preflight");
      expect(started.job.steps[0]?.state).toBe("succeeded");
      expect(started.job.steps[1]?.id).toBe("openclaw_bootstrap_cli");
      expect(started.job.steps[1]?.state).toBe("succeeded");
      expect(started.job.steps[2]?.id).toBe("openclaw_bundled_plugin_tools");
      expect(started.job.steps[3]?.id).toBe("imap_validate");
      expect(started.job.steps[3]?.state).toBe("warned");
      expect(started.job.steps[3]?.error?.code).toBe("IMAP_TEST_FAILED");

      const stored = await service.getInstallJob(started.job.jobId);
      expect(stored.job.jobId).toBe(started.job.jobId);
      expect(stored.job.state).toBe("failed");

      const files = await readdir(paths.installJobsDir);
      expect(files.some((name) => name.includes(started.job.jobId))).toBe(true);
      expect(preflightCalls).toBe(1);
      expect(ensureInstalledCalls).toHaveLength(1);
      expect(imapTestCalls).toBe(1);
      expect(matrixProvisionCalls).toBe(1);
      expect(ensureInstalledCalls[0]).toMatchObject({
        version: SOVEREIGN_PINNED_OPENCLAW_VERSION,
        noOnboard: true,
        noPrompt: true,
        forceReinstall: false,
        skipIfCompatibleInstalled: true,
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("runs through bots_configure and fails at smoke_checks when matrix probe fails", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };

    let matrixProvisionCalls = 0;
    let matrixBootstrapAccountCalls = 0;
    let matrixBootstrapRoomCalls = 0;
    let gatewayInstallCalls = 0;
    let gatewayInstallForceArg: boolean | undefined;
    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
        }),
        ensureInstalled: async (opts) => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: opts.version,
          installMethod: "install_sh",
        }),
      },
      openclawGatewayServiceManager: {
        install: async (options) => {
          gatewayInstallCalls += 1;
          gatewayInstallForceArg = options?.force;
        },
        start: async () => {},
        restart: async () => {},
      },
      managedAgentRegistrar: {
        register: async () => ({
          agentId: "mail-sentinel",
          cronJobId: "mail-sentinel-poll",
          workspaceDir: join(paths.stateDir, "mail-sentinel", "workspace"),
          agentCommand: "openclaw agents upsert --id mail-sentinel",
          cronCommand: "openclaw cron add --name mail-sentinel-poll --every 5m",
        }),
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async (req) => ({
          ok: true,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "ok",
          mailbox: req.imap.mailbox ?? "INBOX",
          capabilities: ["IMAP4rev1"],
        }),
      },
      matrixProvisioner: {
        provision: async (req) => {
          matrixProvisionCalls += 1;
          return {
            projectDir: join(tempRoot, "matrix"),
            composeFilePath: join(tempRoot, "matrix", "compose.yaml"),
            accessMode: "direct",
            homeserverDomain: req.matrix.homeserverDomain,
            publicBaseUrl: req.matrix.publicBaseUrl,
            adminBaseUrl: "http://127.0.0.1:8008",
            federationEnabled: req.matrix.federationEnabled ?? false,
            tlsMode: "local-dev",
          };
        },
        bootstrapAccounts: async () => {
          matrixBootstrapAccountCalls += 1;
          return {
            operator: {
              localpart: "operator",
              userId: "@operator:matrix.example.org",
              passwordSecretRef: "file:/tmp/operator.password",
              accessToken: "operator-token",
            },
            bot: {
              localpart: "mail-sentinel",
              userId: "@mail-sentinel:matrix.example.org",
              passwordSecretRef: "file:/tmp/mail-sentinel.password",
              accessToken: "bot-token",
            },
          };
        },
        bootstrapRoom: async (req) => {
          matrixBootstrapRoomCalls += 1;
          return {
            roomId: "!alerts:matrix.example.org",
            roomName: req.matrix.alertRoomName ?? "Sovereign Alerts",
          };
        },
        test: async (req) => ({
          ok: false,
          homeserverUrl: req.publicBaseUrl,
          checks: [],
        }),
      },
    });

    try {
      const started = await service.startInstall(buildInstallRequest());

      expect(started.job.state).toBe("failed");
      expect(matrixProvisionCalls).toBe(1);
      expect(matrixBootstrapAccountCalls).toBe(1);
      expect(matrixBootstrapRoomCalls).toBe(1);
      expect(gatewayInstallCalls).toBe(1);
      expect(gatewayInstallForceArg).toBe(false);

      const stepStates = Object.fromEntries(started.job.steps.map((step) => [step.id, step.state]));
      expect(stepStates.preflight).toBe("succeeded");
      expect(stepStates.openclaw_bootstrap_cli).toBe("succeeded");
      expect(stepStates.imap_validate).toBe("succeeded");
      expect(stepStates.matrix_provision).toBe("succeeded");
      expect(stepStates.matrix_bootstrap_accounts).toBe("succeeded");
      expect(stepStates.matrix_bootstrap_room).toBe("succeeded");
      expect(stepStates.openclaw_gateway_service_install).toBe("succeeded");
      expect(stepStates.openclaw_configure).toBe("succeeded");
      expect(stepStates.bots_configure).toBe("succeeded");
      expect(stepStates.smoke_checks).toBe("failed");
      expect(stepStates.test_alert).toBe("pending");

      const stored = await service.getInstallJob(started.job.jobId);
      expect(stored.error?.code).toBe("SMOKE_CHECKS_FAILED");
      expect(stored.job.currentStepId).toBe("smoke_checks");

      const writtenConfigRaw = await readFile(paths.configPath, "utf8");
      const writtenConfig = JSON.parse(writtenConfigRaw) as {
        openclaw?: { requestedVersion?: string };
        matrix?: {
          alertRoom?: { roomId?: string };
          bot?: { accessTokenSecretRef?: string };
        };
      };
      expect(writtenConfig.openclaw?.requestedVersion).toBe(SOVEREIGN_PINNED_OPENCLAW_VERSION);
      expect(writtenConfig.matrix?.alertRoom?.roomId).toBe("!alerts:matrix.example.org");
      expect(writtenConfig.matrix?.bot?.accessTokenSecretRef?.startsWith("file:")).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("completes install flow through test_alert when smoke checks and alert delivery pass", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };

    let matrixTestCalls = 0;
    const matrixProbeUrls: string[] = [];
    const observedMatrixUrls: string[] = [];
    let sentMessageBody = "";
    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
        }),
        ensureInstalled: async (opts) => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: opts.version,
          installMethod: "install_sh",
        }),
      },
      openclawGatewayServiceManager: {
        install: async () => {},
        start: async () => {},
        restart: async () => {},
      },
      managedAgentRegistrar: {
        register: async () => ({
          agentId: "mail-sentinel",
          cronJobId: "mail-sentinel-poll",
          workspaceDir: join(paths.stateDir, "mail-sentinel", "workspace"),
          agentCommand: "openclaw agents upsert --id mail-sentinel",
          cronCommand: "openclaw cron add --name mail-sentinel-poll --every 5m",
        }),
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async (req) => ({
          ok: true,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "ok",
          mailbox: req.imap.mailbox ?? "INBOX",
          capabilities: ["IMAP4rev1"],
        }),
      },
      matrixProvisioner: {
        provision: async (req) => ({
          projectDir: join(tempRoot, "matrix"),
          composeFilePath: join(tempRoot, "matrix", "compose.yaml"),
          accessMode: "direct",
          homeserverDomain: req.matrix.homeserverDomain,
          publicBaseUrl: "http://matrix.example.org",
          adminBaseUrl: "http://127.0.0.1:8008",
          federationEnabled: req.matrix.federationEnabled ?? false,
          tlsMode: "local-dev",
        }),
        bootstrapAccounts: async () => ({
          operator: {
            localpart: "operator",
            userId: "@operator:matrix.example.org",
            passwordSecretRef: "file:/tmp/operator.password",
            accessToken: "operator-token",
          },
          bot: {
            localpart: "mail-sentinel",
            userId: "@mail-sentinel:matrix.example.org",
            passwordSecretRef: "file:/tmp/mail-sentinel.password",
            accessToken: "bot-token",
          },
        }),
        bootstrapRoom: async () => ({
          roomId: "!alerts:matrix.example.org",
          roomName: "Sovereign Alerts",
        }),
        test: async (req) => {
          matrixTestCalls += 1;
          matrixProbeUrls.push(req.publicBaseUrl);
          return {
            ok: true,
            homeserverUrl: req.publicBaseUrl,
            checks: [],
          };
        },
      },
      fetchImpl: async (url, init) => {
        const provisionResponse = buildManagedAgentMatrixProvisionResponse(url, init);
        if (provisionResponse !== null) {
          return provisionResponse;
        }
        if (!url.includes("/_matrix/client/v3/rooms/")) {
          return new Response("not found", { status: 404 });
        }
        observedMatrixUrls.push(url);
        sentMessageBody = typeof init?.body === "string" ? init.body : "";
        return new Response(JSON.stringify({ event_id: "$evt1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    try {
      const started = await service.startInstall(buildInstallRequest());

      expect(started.job.state).toBe("succeeded");
      expect(matrixTestCalls).toBe(1);

      const stepStates = Object.fromEntries(started.job.steps.map((step) => [step.id, step.state]));
      expect(stepStates.preflight).toBe("succeeded");
      expect(stepStates.openclaw_bootstrap_cli).toBe("succeeded");
      expect(stepStates.imap_validate).toBe("succeeded");
      expect(stepStates.matrix_provision).toBe("succeeded");
      expect(stepStates.matrix_bootstrap_accounts).toBe("succeeded");
      expect(stepStates.matrix_bootstrap_room).toBe("succeeded");
      expect(stepStates.openclaw_gateway_service_install).toBe("succeeded");
      expect(stepStates.openclaw_configure).toBe("succeeded");
      expect(stepStates.bots_configure).toBe("succeeded");
      expect(stepStates.smoke_checks).toBe("succeeded");
      expect(stepStates.test_alert).toBe("succeeded");
      expect(matrixProbeUrls).toEqual(["http://127.0.0.1:8008"]);
      expect(observedMatrixUrls).toHaveLength(2);
      expect(observedMatrixUrls.every((url) => url.startsWith("http://127.0.0.1:8008/"))).toBe(
        true,
      );
      expect(sentMessageBody).toContain("Hello from Mail Sentinel");

      const stored = await service.getInstallJob(started.job.jobId);
      expect(stored.job.state).toBe("succeeded");
      expect(stored.error).toBeUndefined();

      const registrationRaw = await readFile(
        join(paths.stateDir, "mail-sentinel", "registration.json"),
        "utf8",
      );
      const registration = JSON.parse(registrationRaw) as { agentId?: string };
      expect(registration.agentId).toBe("mail-sentinel");

      const runtimeConfigStat = await stat(paths.configPath);
      expect(runtimeConfigStat.mode & 0o777).toBe(0o644);

      const openclawConfigRaw = await readFile(
        join(paths.openclawServiceHome, ".openclaw", "openclaw.json5"),
        "utf8",
      );
      const openclawConfig = JSON.parse(openclawConfigRaw) as {
        generatedAt?: string;
        source?: string;
        profileRef?: string;
        matrix?: unknown;
        session?: {
          dmScope?: string;
        };
        cron?: { enabled?: boolean; jobs?: unknown };
        agents?: {
          list?: Array<{
            id?: string;
            workspace?: string;
            tools?: {
              allow?: string[];
              elevated?: {
                enabled?: boolean;
              };
              exec?: {
                host?: string;
                security?: string;
                ask?: string;
              };
            };
          }>;
          defaults?: { model?: string };
        };
        plugins?: {
          allow?: string[];
          entries?: Record<string, { enabled?: boolean; config?: unknown }>;
        };
        channels?: {
          matrix?: {
            enabled?: boolean;
            homeserver?: string;
            threadReplies?: string;
            userId?: string;
            defaultAccount?: string;
            groupAllowFrom?: string[];
            groups?: Record<string, { allow?: boolean; users?: string[] }>;
            accounts?: Record<
              string,
              {
                userId?: string;
                homeserver?: string;
                accessToken?: string;
                groupPolicy?: string;
                groupAllowFrom?: string[];
                dm?: { enabled?: boolean; policy?: string; allowFrom?: string[] };
                groups?: Record<string, { autoReply?: boolean; requireMention?: boolean }>;
              }
            >;
          };
        };
      };
      expect(openclawConfig.generatedAt).toBeUndefined();
      expect(openclawConfig.source).toBeUndefined();
      expect(openclawConfig.profileRef).toBeUndefined();
      expect(openclawConfig.matrix).toBeUndefined();
      expect(openclawConfig.session?.dmScope).toBe("per-channel-peer");
      expect(openclawConfig.cron?.enabled).toBe(true);
      expect(openclawConfig.cron?.jobs).toBeUndefined();
      expect(openclawConfig.plugins?.allow).toEqual(
        expect.arrayContaining(["matrix", "lobster", "llm-task"]),
      );
      expect(openclawConfig.plugins?.entries?.matrix?.enabled).toBe(true);
      expect(openclawConfig.plugins?.entries?.matrix?.config).toBeUndefined();
      expect(openclawConfig.plugins?.entries?.lobster?.enabled).toBe(true);
      expect(openclawConfig.plugins?.entries?.["llm-task"]?.enabled).toBe(true);
      expect(openclawConfig.channels?.matrix?.enabled).toBe(true);
      expect(openclawConfig.channels?.matrix?.homeserver).toBe("http://127.0.0.1:8008");
      expect(openclawConfig.channels?.matrix?.threadReplies).toBe("always");
      expect(openclawConfig.channels?.matrix?.userId).toBeUndefined();
      expect(openclawConfig.channels?.matrix?.groupAllowFrom).toEqual([
        "@operator:matrix.example.org",
      ]);
      expect(openclawConfig.channels?.matrix?.groups?.["!alerts:matrix.example.org"]).toEqual(
        expect.objectContaining({
          allow: true,
          users: ["@operator:matrix.example.org"],
        }),
      );
      expect(openclawConfig.channels?.matrix?.groups?.["*"]).toEqual(
        expect.objectContaining({
          allow: true,
          users: ["@operator:matrix.example.org"],
        }),
      );
      expect(openclawConfig.channels?.matrix?.defaultAccount).toBe("mail-sentinel");
      expect(Object.keys(openclawConfig.channels?.matrix?.accounts ?? {}).sort()).toEqual([
        "mail-sentinel",
      ]);
      expect(openclawConfig.channels?.matrix?.accounts?.["mail-sentinel"]?.userId).toBe(
        "@mail-sentinel:matrix.example.org",
      );
      expect(openclawConfig.channels?.matrix?.accounts?.["mail-sentinel"]?.dm).toEqual({
        enabled: true,
        policy: "allowlist",
        allowFrom: ["@operator:matrix.example.org"],
      });
      expect(openclawConfig.channels?.matrix?.accounts?.["mail-sentinel"]?.groupPolicy).toBe(
        "allowlist",
      );
      expect(openclawConfig.channels?.matrix?.accounts?.["mail-sentinel"]?.groupAllowFrom).toEqual([
        "@operator:matrix.example.org",
      ]);
      expect(
        openclawConfig.channels?.matrix?.accounts?.["mail-sentinel"]?.groups?.[
          "!alerts:matrix.example.org"
        ],
      ).toEqual(
        expect.objectContaining({
          autoReply: true,
          requireMention: false,
        }),
      );
      expect(openclawConfig.channels?.matrix?.accounts?.["mail-sentinel"]?.groups?.["*"]).toEqual(
        expect.objectContaining({
          autoReply: true,
          requireMention: false,
        }),
      );
      expect(
        openclawConfig.agents?.list?.every((entry) => Object.hasOwn(entry, "matrix") === false),
      ).toBe(true);
      expect(openclawConfig.agents?.list).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "mail-sentinel",
            model: "openrouter/qwen/qwen-2.5-32b-instruct",
            tools: expect.objectContaining({
              allow: expect.arrayContaining(["exec", "session_status", "lobster", "llm-task"]),
              elevated: {
                enabled: true,
              },
              exec: {
                host: "gateway",
                security: "allowlist",
                ask: "off",
              },
            }),
          }),
        ]),
      );
      expect(openclawConfig.agents?.defaults?.model).toBe("openrouter/qwen/qwen3.5-9b");

      const runtimeConfigRaw = await readFile(paths.configPath, "utf8");
      const runtimeConfig = JSON.parse(runtimeConfigRaw) as {
        openclawProfile?: {
          session?: {
            dmScope?: string;
          };
        };
      };
      expect(runtimeConfig.openclawProfile?.session?.dmScope).toBe("per-channel-peer");

      const mailSentinelToolsRaw = await readFile(
        join(paths.stateDir, "mail-sentinel", "workspace", "TOOLS.md"),
        "utf8",
      );
      expect(mailSentinelToolsRaw).toContain(
        "Use only the documented OpenClaw tools or CLI commands listed below.",
      );
      expect(mailSentinelToolsRaw).toContain(
        `${join(paths.stateDir, "mail-sentinel", "workspace", "bin", "mail-sentinel.js")} scan --instance mail-sentinel-core --json`,
      );
      expect(mailSentinelToolsRaw).toContain(
        `${join(paths.stateDir, "mail-sentinel", "workspace", "bin", "mail-sentinel.js")} list-alerts --instance mail-sentinel-core --view today --json`,
      );
      expect(mailSentinelToolsRaw).toContain("openclaw-tool: `lobster`");
      expect(mailSentinelToolsRaw).toContain("openclaw-tool: `llm-task`");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("renders bot-repo tool templates and per-bot model overrides for bitcoin-skill-match", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };

    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
        }),
        ensureInstalled: async (opts) => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: opts.version,
          installMethod: "install_sh",
        }),
      },
      openclawGatewayServiceManager: {
        install: async () => {},
        start: async () => {},
        restart: async () => {},
      },
      managedAgentRegistrar: {
        register: async (input) => ({
          agentId: input.agentId,
          workspaceDir: input.workspaceDir,
          agentCommand: `openclaw agents upsert --id ${input.agentId}`,
          ...(input.cron === undefined
            ? {}
            : {
                cronJobId: input.cron.id,
                cronCommand: `openclaw cron add --name ${input.cron.id}`,
              }),
        }),
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async (req) => ({
          ok: true,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "ok",
          mailbox: req.imap.mailbox ?? "INBOX",
          capabilities: ["IMAP4rev1"],
        }),
      },
      matrixProvisioner: {
        provision: async (req) => ({
          projectDir: join(tempRoot, "matrix"),
          composeFilePath: join(tempRoot, "matrix", "compose.yaml"),
          accessMode: "direct",
          homeserverDomain: req.matrix.homeserverDomain,
          publicBaseUrl: "http://matrix.example.org",
          adminBaseUrl: "http://127.0.0.1:8008",
          federationEnabled: req.matrix.federationEnabled ?? false,
          tlsMode: "local-dev",
        }),
        bootstrapAccounts: async () => ({
          operator: {
            localpart: "operator",
            userId: "@operator:matrix.example.org",
            passwordSecretRef: "file:/tmp/operator-password",
            accessToken: "operator-token",
          },
          bot: {
            localpart: "bitcoin-skill-match",
            userId: "@bitcoin-skill-match:matrix.example.org",
            passwordSecretRef: "file:/tmp/bitcoin-password",
            accessToken: "bitcoin-token",
          },
        }),
        bootstrapRoom: async () => ({
          roomId: "!alerts:matrix.example.org",
          roomName: "Sovereign Alerts",
        }),
        test: async (req) => ({
          ok: true,
          homeserverUrl: req.publicBaseUrl,
          checks: [],
        }),
      },
      fetchImpl: async (url, init) => {
        const provisionResponse = buildManagedAgentMatrixProvisionResponse(url, init);
        if (provisionResponse !== null) {
          return provisionResponse;
        }
        if (!url.includes("/_matrix/client/v3/rooms/")) {
          return new Response("not found", { status: 404 });
        }
        return new Response(JSON.stringify({ event_id: "$evt-bitcoin" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    try {
      const req = buildInstallRequest();
      req.bots = {
        selected: ["bitcoin-skill-match"],
        config: {
          "bitcoin-skill-match": {
            model: "openai/gpt-5-mini",
            statePath: "data/community-state.json",
            statePolicyPath: "data/community-state.policy.json",
            stateAuditPath: "data/community-state.audit.jsonl",
          },
        },
      };

      const started = await service.startInstall(req);
      expect(started.job.state).toBe("succeeded");

      const openclawConfigRaw = await readFile(
        join(paths.openclawServiceHome, ".openclaw", "openclaw.json5"),
        "utf8",
      );
      const openclawConfig = JSON.parse(openclawConfigRaw) as {
        plugins?: {
          allow?: string[];
          load?: {
            paths?: string[];
          };
          entries?: Record<string, { enabled?: boolean }>;
        };
        agents?: {
          list?: Array<{
            id?: string;
            model?: string;
            tools?: {
              allow?: string[];
            };
          }>;
        };
      };
      expect(openclawConfig.plugins?.allow).toEqual(
        expect.arrayContaining(["matrix", "guarded-json-state"]),
      );
      expect(openclawConfig.plugins?.load?.paths).toEqual(
        expect.arrayContaining([
          join(paths.openclawServiceHome, ".openclaw", "extensions", "guarded-json-state"),
        ]),
      );
      expect(openclawConfig.plugins?.entries?.["guarded-json-state"]?.enabled).toBe(true);
      expect(openclawConfig.agents?.list).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "bitcoin-skill-match",
            model: "openrouter/openai/gpt-5-mini",
            tools: expect.objectContaining({
              allow: expect.arrayContaining(["session_status", "guarded_json_state"]),
            }),
          }),
        ]),
      );
      const bitcoinAgent = openclawConfig.agents?.list?.find(
        (entry) => entry.id === "bitcoin-skill-match",
      );
      expect(bitcoinAgent?.tools?.allow).not.toEqual(
        expect.arrayContaining(["read", "write", "edit", "exec"]),
      );

      const runtimeConfigRaw = await readFile(paths.configPath, "utf8");
      const runtimeConfig = JSON.parse(runtimeConfigRaw) as {
        openclawProfile?: {
          agents?: Array<{ id?: string; model?: string }>;
        };
        templates?: {
          installed?: Array<{
            kind?: string;
            id?: string;
            version?: string;
            source?: string;
          }>;
        };
      };
      expect(runtimeConfig.openclawProfile?.agents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "bitcoin-skill-match",
            model: "openai/gpt-5-mini",
          }),
        ]),
      );
      expect(runtimeConfig.templates?.installed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "tool",
            id: "guarded-json-state",
            version: "1.0.0",
            source: "bot-repo",
          }),
        ]),
      );

      const toolsRaw = await readFile(
        join(paths.stateDir, "bitcoin-skill-match", "workspace", "TOOLS.md"),
        "utf8",
      );
      expect(toolsRaw).toContain("template: `guarded-json-state@1.0.0`");
      expect(toolsRaw).toContain("openclaw-tool: `guarded_json_state`");
      expect(toolsRaw).toContain(
        "resolves the current Matrix sender from the active OpenClaw session",
      );
      expect(toolsRaw).toContain("normalizes a single scalar into a one-item array");
      await expect(
        readFile(
          join(
            paths.openclawServiceHome,
            ".openclaw",
            "extensions",
            "guarded-json-state",
            "index.js",
          ),
          "utf8",
        ),
      ).resolves.toEqual(expect.stringContaining('const TOOL_NAME = "guarded_json_state"'));
      await expect(
        readFile(
          join(
            paths.openclawServiceHome,
            ".openclaw",
            "extensions",
            "guarded-json-state",
            "index.js",
          ),
          "utf8",
        ),
      ).resolves.toEqual(expect.stringContaining("api.registerTool(\n    (toolContext) => ({"));
      await expect(
        readFile(
          join(
            paths.openclawServiceHome,
            ".openclaw",
            "extensions",
            "guarded-json-state",
            "index.js",
          ),
          "utf8",
        ),
      ).resolves.toEqual(
        expect.stringContaining("resolveGuardedJsonStateToolContext(toolContext ?? {})"),
      );
      await expect(
        readFile(
          join(
            paths.openclawServiceHome,
            ".openclaw",
            "extensions",
            "guarded-json-state",
            "index.js",
          ),
          "utf8",
        ),
      ).resolves.not.toContain("\\`");
      await expect(
        readFile(
          join(
            paths.openclawServiceHome,
            ".openclaw",
            "extensions",
            "guarded-json-state",
            "index.js",
          ),
          "utf8",
        ),
      ).resolves.not.toContain("ctx.cwd");
      await expect(
        readFile(
          join(
            paths.openclawServiceHome,
            ".openclaw",
            "extensions",
            "guarded-json-state",
            "index.js",
          ),
          "utf8",
        ),
      ).resolves.not.toContain("sessionManager");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails install during bots_configure when the OpenClaw matrix plugin is broken", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };

    let pluginEnableCalls = 0;
    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
        }),
        ensureInstalled: async (opts) => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: opts.version,
          installMethod: "install_sh",
        }),
      },
      openclawGatewayServiceManager: {
        install: async () => {},
        start: async () => {},
        restart: async () => {},
      },
      managedAgentRegistrar: {
        register: async () => ({
          agentId: "mail-sentinel",
          cronJobId: "mail-sentinel-poll",
          workspaceDir: join(paths.stateDir, "mail-sentinel", "workspace"),
          agentCommand: "openclaw agents upsert --id mail-sentinel",
          cronCommand: "openclaw cron add --name mail-sentinel-poll --every 5m",
        }),
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async (req) => ({
          ok: true,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "ok",
          mailbox: req.imap.mailbox ?? "INBOX",
          capabilities: ["IMAP4rev1"],
        }),
      },
      matrixProvisioner: {
        provision: async (req) => ({
          projectDir: join(tempRoot, "matrix"),
          composeFilePath: join(tempRoot, "matrix", "compose.yaml"),
          accessMode: "direct",
          homeserverDomain: req.matrix.homeserverDomain,
          publicBaseUrl: req.matrix.publicBaseUrl,
          adminBaseUrl: "http://127.0.0.1:8008",
          federationEnabled: req.matrix.federationEnabled ?? false,
          tlsMode: "local-dev",
        }),
        bootstrapAccounts: async () => ({
          operator: {
            localpart: "operator",
            userId: "@operator:matrix.example.org",
            passwordSecretRef: "file:/tmp/operator.password",
            accessToken: "operator-token",
          },
          bot: {
            localpart: "mail-sentinel",
            userId: "@mail-sentinel:matrix.example.org",
            passwordSecretRef: "file:/tmp/mail-sentinel.password",
            accessToken: "bot-token",
          },
        }),
        bootstrapRoom: async () => ({
          roomId: "!alerts:matrix.example.org",
          roomName: "Sovereign Alerts",
        }),
        test: async (req) => ({
          ok: true,
          homeserverUrl: req.publicBaseUrl,
          checks: [],
        }),
      },
      execRunner: {
        run: async (input): Promise<ExecResult> => {
          const serialized = [input.command, ...(input.args ?? [])].join(" ");
          const lobsterResult = maybeHandleInstalledLobsterExec(input);
          if (lobsterResult !== null) {
            return lobsterResult;
          }
          if (serialized === "openclaw plugins enable matrix") {
            pluginEnableCalls += 1;
            return {
              command: serialized,
              exitCode: 1,
              stdout: "",
              stderr:
                "[plugins] matrix failed to load from /usr/lib/node_modules/openclaw/extensions/matrix/index.ts: Error: Cannot find module '/usr/lib/node_modules/openclaw/dist/plugin-sdk/index.js/keyed-async-queue'\nUnknown channel \"matrix\".",
            };
          }
          return {
            command: serialized,
            exitCode: 0,
            stdout: "ok",
            stderr: "",
          };
        },
      },
      fetchImpl: async (url) => {
        if (url.includes("/_matrix/client/v3/rooms/")) {
          return new Response(JSON.stringify({ event_id: "$evt1" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const started = await service.startInstall(buildInstallRequest());

      expect(pluginEnableCalls).toBe(1);
      expect(started.job.state).toBe("failed");

      const stepStates = Object.fromEntries(started.job.steps.map((step) => [step.id, step.state]));
      expect(stepStates.preflight).toBe("succeeded");
      expect(stepStates.openclaw_bootstrap_cli).toBe("succeeded");
      expect(stepStates.imap_validate).toBe("succeeded");
      expect(stepStates.matrix_provision).toBe("succeeded");
      expect(stepStates.matrix_bootstrap_accounts).toBe("succeeded");
      expect(stepStates.matrix_bootstrap_room).toBe("succeeded");
      expect(stepStates.openclaw_gateway_service_install).toBe("succeeded");
      expect(stepStates.openclaw_configure).toBe("succeeded");
      expect(stepStates.bots_configure).toBe("failed");
      expect(stepStates.smoke_checks).toBe("pending");

      const stored = await service.getInstallJob(started.job.jobId);
      expect(stored.error?.code).toBe("MANAGED_AGENT_REGISTER_FAILED");
      expect(stored.job.currentStepId).toBe("bots_configure");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("migrates legacy core-pinned bot templates during update installs", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };

    await writeRuntimeArtifacts(paths);
    await writeLegacyCorePinnedMailSentinelTemplate(paths);

    const observedMatrixUrls: string[] = [];
    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
        }),
        ensureInstalled: async (opts) => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: opts.version,
          installMethod: "install_sh",
        }),
      },
      openclawGatewayServiceManager: {
        install: async () => {},
        start: async () => {},
        restart: async () => {},
      },
      managedAgentRegistrar: {
        register: async () => ({
          agentId: "mail-sentinel",
          cronJobId: "mail-sentinel-poll",
          workspaceDir: join(paths.stateDir, "mail-sentinel", "workspace"),
          agentCommand: "openclaw agents upsert --id mail-sentinel",
          cronCommand: "openclaw cron add --name mail-sentinel-poll --every 5m",
        }),
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async (req) => ({
          ok: true,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "ok",
          mailbox: req.imap.mailbox ?? "INBOX",
          capabilities: ["IMAP4rev1"],
        }),
      },
      matrixProvisioner: {
        provision: async (req) => ({
          projectDir: join(tempRoot, "matrix"),
          composeFilePath: join(tempRoot, "matrix", "compose.yaml"),
          accessMode: "direct",
          homeserverDomain: req.matrix.homeserverDomain,
          publicBaseUrl: "http://matrix.example.org",
          adminBaseUrl: "http://127.0.0.1:8008",
          federationEnabled: req.matrix.federationEnabled ?? false,
          tlsMode: "local-dev",
        }),
        bootstrapAccounts: async () => ({
          operator: {
            localpart: "operator",
            userId: "@operator:matrix.example.org",
            passwordSecretRef: "file:/tmp/operator.password",
            accessToken: "operator-token",
          },
          bot: {
            localpart: "mail-sentinel",
            userId: "@mail-sentinel:matrix.example.org",
            passwordSecretRef: "file:/tmp/mail-sentinel.password",
            accessToken: "bot-token",
          },
        }),
        bootstrapRoom: async () => ({
          roomId: "!alerts:matrix.example.org",
          roomName: "Sovereign Alerts",
        }),
        test: async (req) => ({
          ok: true,
          homeserverUrl: req.publicBaseUrl,
          checks: [],
        }),
      },
      fetchImpl: async (url) => {
        const provisionResponse = buildManagedAgentMatrixProvisionResponse(url);
        if (provisionResponse !== null) {
          return provisionResponse;
        }
        observedMatrixUrls.push(url.toString());
        return new Response(JSON.stringify({ event_id: "$evt1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    try {
      const started = await service.startInstall(buildInstallRequest());

      expect(started.job.state).toBe("succeeded");

      const updatedConfigRaw = await readFile(paths.configPath, "utf8");
      const updatedConfig = JSON.parse(updatedConfigRaw) as {
        templates?: {
          installed?: Array<{
            id?: string;
            version?: string;
            keyId?: string;
            manifestSha256?: string;
            source?: string;
            installedAt?: string;
          }>;
        };
      };
      const installedMailSentinel = updatedConfig.templates?.installed?.find(
        (entry) => entry.id === "mail-sentinel" && entry.version === "2.0.0",
      );

      expect(installedMailSentinel?.source).toBe("bot-repo");
      expect(installedMailSentinel?.keyId).toBe("repo:sovereign-ai-bots");
      expect(installedMailSentinel?.manifestSha256).not.toBe("legacy-core-mail-sentinel-pin");
      expect(typeof installedMailSentinel?.installedAt).toBe("string");
      expect(observedMatrixUrls).not.toHaveLength(0);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("preserves mutable managed workspace files during update installs", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };

    await writeRuntimeArtifacts(paths);

    const workspaceDir = join(paths.stateDir, "mail-sentinel", "workspace");
    const userPolicyPath = join(workspaceDir, "config", "user-policy.json");
    const defaultRulesPath = join(workspaceDir, "config", "default-rules.json");
    const readmePath = join(workspaceDir, "README.md");
    const customUserPolicy = [
      "{",
      '  "version": 1,',
      '  "senderPolicies": [',
      "    {",
      '      "id": "custom-sender-policy",',
      '      "match": "alerts@example.org",',
      '      "minZone": "amber"',
      "    }",
      "  ],",
      '  "domainPolicies": [],',
      '  "categoryPolicies": [],',
      '  "contentPolicies": [],',
      '  "timePolicies": [],',
      '  "mutePolicies": []',
      "}",
      "",
    ].join("\n");
    const customDefaultRules = [
      "{",
      '  "version": 2,',
      '  "thresholds": {',
      '    "candidate": 3,',
      '    "alert": 4,',
      '    "category": 4',
      "  },",
      '  "zoneThresholds": {',
      '    "redMinConfidence": 75,',
      '    "amberMinConfidence": 40,',
      '    "redMinHeuristicScore": 4,',
      '    "amberMinHeuristicScore": 3',
      "  },",
      '  "rules": [',
      "    {",
      '      "id": "custom-important-sender",',
      '      "field": "from",',
      '      "pattern": "alerts@example\\\\.org",',
      '      "weight": 10,',
      '      "reason": "Local override"',
      "    }",
      "  ]",
      "}",
      "",
    ].join("\n");

    await mkdir(join(workspaceDir, "config"), { recursive: true });
    await writeFile(userPolicyPath, customUserPolicy, "utf8");
    await writeFile(defaultRulesPath, customDefaultRules, "utf8");
    await writeFile(readmePath, "custom readme\n", "utf8");

    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
        }),
        ensureInstalled: async (opts) => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: opts.version,
          installMethod: "install_sh",
        }),
      },
      openclawGatewayServiceManager: {
        install: async () => {},
        start: async () => {},
        restart: async () => {},
      },
      managedAgentRegistrar: {
        register: async () => ({
          agentId: "mail-sentinel",
          cronJobId: "mail-sentinel-poll",
          workspaceDir,
          agentCommand: "openclaw agents upsert --id mail-sentinel",
          cronCommand: "openclaw cron add --name mail-sentinel-poll --every 5m",
        }),
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async (req) => ({
          ok: true,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "ok",
          mailbox: req.imap.mailbox ?? "INBOX",
          capabilities: ["IMAP4rev1"],
        }),
      },
      matrixProvisioner: {
        provision: async (req) => ({
          projectDir: join(tempRoot, "matrix"),
          composeFilePath: join(tempRoot, "matrix", "compose.yaml"),
          accessMode: "direct",
          homeserverDomain: req.matrix.homeserverDomain,
          publicBaseUrl: "http://matrix.example.org",
          adminBaseUrl: "http://127.0.0.1:8008",
          federationEnabled: req.matrix.federationEnabled ?? false,
          tlsMode: "local-dev",
        }),
        bootstrapAccounts: async () => ({
          operator: {
            localpart: "operator",
            userId: "@operator:matrix.example.org",
            passwordSecretRef: "file:/tmp/operator.password",
            accessToken: "operator-token",
          },
          bot: {
            localpart: "mail-sentinel",
            userId: "@mail-sentinel:matrix.example.org",
            passwordSecretRef: "file:/tmp/mail-sentinel.password",
            accessToken: "bot-token",
          },
        }),
        bootstrapRoom: async () => ({
          roomId: "!alerts:matrix.example.org",
          roomName: "Sovereign Alerts",
        }),
        test: async (req) => ({
          ok: true,
          homeserverUrl: req.publicBaseUrl,
          checks: [],
        }),
      },
      fetchImpl: async (url) => {
        const provisionResponse = buildManagedAgentMatrixProvisionResponse(url);
        if (provisionResponse !== null) {
          return provisionResponse;
        }
        return new Response(JSON.stringify({ event_id: "$evt1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    try {
      const started = await service.startInstall(buildInstallRequest());

      expect(started.job.state).toBe("succeeded");
      await expect(readFile(userPolicyPath, "utf8")).resolves.toBe(customUserPolicy);
      await expect(readFile(defaultRulesPath, "utf8")).resolves.toBe(customDefaultRules);
      await expect(readFile(readmePath, "utf8")).resolves.toBe("# Mail Sentinel\n");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("continues install when gateway user systemd bus is unavailable", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };

    let gatewayInstallCalls = 0;
    let gatewayRestartCalls = 0;
    let registrarCalls = 0;
    let sentMessageBody = "";

    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
        }),
        ensureInstalled: async (opts) => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: opts.version,
          installMethod: "install_sh",
        }),
      },
      openclawGatewayServiceManager: {
        install: async () => {
          gatewayInstallCalls += 1;
          throw {
            code: "OPENCLAW_GATEWAY_INSTALL_FAILED",
            message: "OpenClaw gateway command exited with non-zero status",
            retryable: true,
            details: {
              command: "openclaw gateway install",
              stderr:
                "Gateway service check failed: Error: systemctl --user unavailable: Failed to connect to bus: No medium found",
            },
          };
        },
        start: async () => {},
        restart: async () => {
          gatewayRestartCalls += 1;
        },
      },
      managedAgentRegistrar: {
        register: async () => {
          registrarCalls += 1;
          throw {
            code: "MAIL_SENTINEL_REGISTER_FAILED",
            message: "OpenClaw mail-sentinel-cron registration commands failed",
            retryable: true,
            details: {
              failures: [
                {
                  command:
                    "openclaw cron add --name mail-sentinel-poll --every 5m --session isolated --message hello",
                  exitCode: 1,
                  stderr:
                    "Error: gateway closed (1006 abnormal closure (no close frame)): no close reason\nGateway target: ws://127.0.0.1:18789",
                  stdout: "",
                },
              ],
            },
          };
        },
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async (req) => ({
          ok: true,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "ok",
          mailbox: req.imap.mailbox ?? "INBOX",
          capabilities: ["IMAP4rev1"],
        }),
      },
      matrixProvisioner: {
        provision: async (req) => ({
          projectDir: join(tempRoot, "matrix"),
          composeFilePath: join(tempRoot, "matrix", "compose.yaml"),
          accessMode: "direct",
          homeserverDomain: req.matrix.homeserverDomain,
          publicBaseUrl: req.matrix.publicBaseUrl,
          adminBaseUrl: "http://127.0.0.1:8008",
          federationEnabled: req.matrix.federationEnabled ?? false,
          tlsMode: "local-dev",
        }),
        bootstrapAccounts: async () => ({
          operator: {
            localpart: "operator",
            userId: "@operator:matrix.example.org",
            passwordSecretRef: "file:/tmp/operator.password",
            accessToken: "operator-token",
          },
          bot: {
            localpart: "mail-sentinel",
            userId: "@mail-sentinel:matrix.example.org",
            passwordSecretRef: "file:/tmp/mail-sentinel.password",
            accessToken: "bot-token",
          },
        }),
        bootstrapRoom: async () => ({
          roomId: "!alerts:matrix.example.org",
          roomName: "Sovereign Alerts",
        }),
        test: async (req) => ({
          ok: true,
          homeserverUrl: req.publicBaseUrl,
          checks: [],
        }),
      },
      fetchImpl: async (url, init) => {
        const provisionResponse = buildManagedAgentMatrixProvisionResponse(url, init);
        if (provisionResponse !== null) {
          return provisionResponse;
        }
        if (url.includes("/joined_members")) {
          return new Response(JSON.stringify({ joined: {} }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.includes("/send/m.room.message/")) {
          sentMessageBody = typeof init?.body === "string" ? init.body : "";
          return new Response(JSON.stringify({ event_id: "$evt1" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        return new Response("not found", { status: 404 });
      },
    });

    try {
      const started = await service.startInstall(buildInstallRequest());
      expect(started.job.state).toBe("succeeded");
      expect(gatewayInstallCalls).toBe(1);
      expect(gatewayRestartCalls).toBe(0);
      expect(registrarCalls).toBe(1);

      const stepStates = Object.fromEntries(started.job.steps.map((step) => [step.id, step.state]));
      expect(stepStates.openclaw_gateway_service_install).toBe("succeeded");
      expect(stepStates.openclaw_configure).toBe("succeeded");
      expect(stepStates.bots_configure).toBe("succeeded");
      expect(stepStates.smoke_checks).toBe("succeeded");
      expect(stepStates.test_alert).toBe("succeeded");
      expect(sentMessageBody).toContain("Hello from Mail Sentinel");

      const registrationRaw = await readFile(
        join(paths.stateDir, "mail-sentinel", "registration.json"),
        "utf8",
      );
      const registration = JSON.parse(registrationRaw) as {
        deferred?: boolean;
        cronJobId?: string;
      };
      expect(registration.deferred).toBe(true);
      expect(registration.cronJobId).toBe("mail-sentinel-poll");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("starts system-level gateway fallback when user services are unavailable", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const priorGatewayUnitPath = process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH;
    const priorServiceUser = process.env.SOVEREIGN_NODE_SERVICE_USER;
    const priorServiceGroup = process.env.SOVEREIGN_NODE_SERVICE_GROUP;
    const gatewayUnitPath = join(tempRoot, "systemd", "sovereign-openclaw-gateway.service");
    process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH = gatewayUnitPath;
    process.env.SOVEREIGN_NODE_SERVICE_USER = "sovereign-node";
    process.env.SOVEREIGN_NODE_SERVICE_GROUP = "sovereign-node";
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };

    let gatewayInstallCalls = 0;
    let gatewayRestartCalls = 0;
    let registrarCalls = 0;
    const commandCalls: string[] = [];
    const execCalls: ExecInput[] = [];
    let sentMessageBody = "";

    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
        }),
        ensureInstalled: async (opts) => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: opts.version,
          installMethod: "install_sh",
        }),
      },
      openclawGatewayServiceManager: {
        install: async () => {
          gatewayInstallCalls += 1;
          throw {
            code: "OPENCLAW_GATEWAY_INSTALL_FAILED",
            message: "OpenClaw gateway command exited with non-zero status",
            retryable: true,
            details: {
              command: "openclaw gateway install",
              stderr:
                "Gateway service check failed: Error: systemctl --user unavailable: Failed to connect to bus: No medium found",
            },
          };
        },
        start: async () => {},
        restart: async () => {
          gatewayRestartCalls += 1;
        },
      },
      managedAgentRegistrar: {
        register: async () => {
          registrarCalls += 1;
          return {
            agentId: "mail-sentinel",
            cronJobId: "mail-sentinel-poll",
            workspaceDir: join(paths.stateDir, "mail-sentinel", "workspace"),
            agentCommand: "openclaw agents add mail-sentinel --workspace /tmp/ws",
            cronCommand: "openclaw cron add --name mail-sentinel-poll --every 5m",
          };
        },
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async (req) => ({
          ok: true,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "ok",
          mailbox: req.imap.mailbox ?? "INBOX",
          capabilities: ["IMAP4rev1"],
        }),
      },
      matrixProvisioner: {
        provision: async (req) => ({
          projectDir: join(tempRoot, "matrix"),
          composeFilePath: join(tempRoot, "matrix", "compose.yaml"),
          accessMode: "direct",
          homeserverDomain: req.matrix.homeserverDomain,
          publicBaseUrl: req.matrix.publicBaseUrl,
          adminBaseUrl: "http://127.0.0.1:8008",
          federationEnabled: req.matrix.federationEnabled ?? false,
          tlsMode: "local-dev",
        }),
        bootstrapAccounts: async () => ({
          operator: {
            localpart: "operator",
            userId: "@operator:matrix.example.org",
            passwordSecretRef: "file:/tmp/operator.password",
            accessToken: "operator-token",
          },
          bot: {
            localpart: "mail-sentinel",
            userId: "@mail-sentinel:matrix.example.org",
            passwordSecretRef: "file:/tmp/mail-sentinel.password",
            accessToken: "bot-token",
          },
        }),
        bootstrapRoom: async () => ({
          roomId: "!alerts:matrix.example.org",
          roomName: "Sovereign Alerts",
        }),
        test: async (req) => ({
          ok: true,
          homeserverUrl: req.publicBaseUrl,
          checks: [],
        }),
      },
      execRunner: {
        run: async (input): Promise<ExecResult> => {
          execCalls.push(input);
          const serialized = [input.command, ...(input.args ?? [])].join(" ");
          commandCalls.push(serialized);
          const lobsterResult = maybeHandleInstalledLobsterExec(input);
          if (lobsterResult !== null) {
            return lobsterResult;
          }

          if (serialized.startsWith("systemctl ")) {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "active",
              stderr: "",
            };
          }
          if (serialized === "openclaw health") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "ok",
              stderr: "",
            };
          }
          if (serialized === "openclaw gateway status") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "Service: systemd (disabled)\nState: failed",
              stderr: "",
            };
          }
          if (serialized === "openclaw agents list") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "mail-sentinel\nnode-operator",
              stderr: "",
            };
          }
          if (serialized === "openclaw cron list") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "mail-sentinel-poll",
              stderr: "",
            };
          }
          if (serialized === "openclaw plugins enable matrix") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "enabled",
              stderr: "",
            };
          }
          if (serialized.startsWith("openclaw agents ")) {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "ok",
              stderr: "",
            };
          }
          if (serialized.startsWith("openclaw approvals allowlist add --agent ")) {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "ok",
              stderr: "",
            };
          }
          return {
            command: serialized,
            exitCode: 1,
            stdout: "",
            stderr: "unexpected command",
          };
        },
      },
      fetchImpl: async (url, init) => {
        const provisionResponse = buildManagedAgentMatrixProvisionResponse(url, init);
        if (provisionResponse !== null) {
          return provisionResponse;
        }
        if (url.includes("/joined_members")) {
          return new Response(JSON.stringify({ joined: {} }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.includes("/send/m.room.message/")) {
          sentMessageBody = typeof init?.body === "string" ? init.body : "";
          return new Response(JSON.stringify({ event_id: "$evt1" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        return new Response("not found", { status: 404 });
      },
    });

    try {
      const started = await service.startInstall(buildInstallRequest());
      expect(started.job.state).toBe("succeeded");
      expect(gatewayInstallCalls).toBe(1);
      expect(gatewayRestartCalls).toBe(0);
      expect(registrarCalls).toBe(1);
      expect(commandCalls.some((command) => command === "systemctl daemon-reload")).toBe(true);
      expect(commandCalls.some((command) => command.includes("enable --now"))).toBe(true);
      expect(commandCalls.some((command) => command.includes("is-active"))).toBe(true);
      expect(
        commandCalls.includes(
          "openclaw approvals allowlist add --agent mail-sentinel /usr/local/bin/sovereign-tool",
        ),
      ).toBe(true);

      const stepStates = Object.fromEntries(started.job.steps.map((step) => [step.id, step.state]));
      expect(stepStates.openclaw_gateway_service_install).toBe("succeeded");
      expect(stepStates.openclaw_configure).toBe("succeeded");
      expect(stepStates.bots_configure).toBe("succeeded");
      expect(stepStates.smoke_checks).toBe("succeeded");
      expect(stepStates.test_alert).toBe("succeeded");
      expect(sentMessageBody).toContain("Hello from Mail Sentinel");

      const unitRaw = await readFile(gatewayUnitPath, "utf8");
      expect(unitRaw).toContain("User=sovereign-node");
      expect(unitRaw).toContain("Group=sovereign-node");
      expect(unitRaw).toContain(`Environment=TMPDIR=${join(paths.openclawServiceHome, "tmp")}`);
      expect(unitRaw).toContain(`Environment=TMP=${join(paths.openclawServiceHome, "tmp")}`);
      expect(unitRaw).toContain(`Environment=TEMP=${join(paths.openclawServiceHome, "tmp")}`);

      const matrixEnableCall = execCalls.find((call) => {
        const args = call.args ?? [];
        return (
          (call.command === "openclaw" &&
            args[0] === "plugins" &&
            args[1] === "enable" &&
            args[2] === "matrix") ||
          (call.command === "sudo" &&
            args.includes("openclaw") &&
            args.includes("plugins") &&
            args.includes("enable") &&
            args.includes("matrix"))
        );
      });
      expect(matrixEnableCall?.options).toMatchObject({
        env: {
          TMPDIR: join(paths.openclawServiceHome, "tmp"),
          TMP: join(paths.openclawServiceHome, "tmp"),
          TEMP: join(paths.openclawServiceHome, "tmp"),
        },
      });

      const registrationRaw = await readFile(
        join(paths.stateDir, "mail-sentinel", "registration.json"),
        "utf8",
      );
      const registration = JSON.parse(registrationRaw) as {
        deferred?: boolean;
      };
      expect(registration.deferred).not.toBe(true);
    } finally {
      if (priorGatewayUnitPath === undefined) {
        delete process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH;
      } else {
        process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH = priorGatewayUnitPath;
      }
      if (priorServiceUser === undefined) {
        delete process.env.SOVEREIGN_NODE_SERVICE_USER;
      } else {
        process.env.SOVEREIGN_NODE_SERVICE_USER = priorServiceUser;
      }
      if (priorServiceGroup === undefined) {
        delete process.env.SOVEREIGN_NODE_SERVICE_GROUP;
      } else {
        process.env.SOVEREIGN_NODE_SERVICE_GROUP = priorServiceGroup;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("falls back to the system gateway when post-config refresh leaves the gateway stopped", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const priorGatewayUnitPath = process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH;
    const gatewayUnitPath = join(tempRoot, "systemd", "sovereign-openclaw-gateway.service");
    process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH = gatewayUnitPath;
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };

    let gatewayInstallCalls = 0;
    let gatewayRestartCalls = 0;
    let gatewayStartCalls = 0;
    let registrarCalls = 0;
    let systemGatewayStarted = false;
    const commandCalls: string[] = [];
    let sentMessageBody = "";

    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
        }),
        ensureInstalled: async (opts) => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: opts.version,
          installMethod: "install_sh",
        }),
      },
      openclawGatewayServiceManager: {
        install: async () => {
          gatewayInstallCalls += 1;
        },
        start: async () => {
          gatewayStartCalls += 1;
        },
        restart: async () => {
          gatewayRestartCalls += 1;
          throw new Error("gateway restart returned before the service was healthy");
        },
      },
      managedAgentRegistrar: {
        register: async () => {
          registrarCalls += 1;
          return {
            agentId: "mail-sentinel",
            cronJobId: "mail-sentinel-poll",
            workspaceDir: join(paths.stateDir, "mail-sentinel", "workspace"),
            agentCommand: "openclaw agents add mail-sentinel --workspace /tmp/ws",
            cronCommand: "openclaw cron add --name mail-sentinel-poll --every 5m",
          };
        },
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async (req) => ({
          ok: true,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "ok",
          mailbox: req.imap.mailbox ?? "INBOX",
          capabilities: ["IMAP4rev1"],
        }),
      },
      matrixProvisioner: {
        provision: async (req) => ({
          projectDir: join(tempRoot, "matrix"),
          composeFilePath: join(tempRoot, "matrix", "compose.yaml"),
          accessMode: "direct",
          homeserverDomain: req.matrix.homeserverDomain,
          publicBaseUrl: req.matrix.publicBaseUrl,
          adminBaseUrl: "http://127.0.0.1:8008",
          federationEnabled: req.matrix.federationEnabled ?? false,
          tlsMode: "local-dev",
        }),
        bootstrapAccounts: async () => ({
          operator: {
            localpart: "operator",
            userId: "@operator:matrix.example.org",
            passwordSecretRef: "file:/tmp/operator.password",
            accessToken: "operator-token",
          },
          bot: {
            localpart: "mail-sentinel",
            userId: "@mail-sentinel:matrix.example.org",
            passwordSecretRef: "file:/tmp/mail-sentinel.password",
            accessToken: "bot-token",
          },
        }),
        bootstrapRoom: async () => ({
          roomId: "!alerts:matrix.example.org",
          roomName: "Sovereign Alerts",
        }),
        test: async (req) => ({
          ok: true,
          homeserverUrl: req.publicBaseUrl,
          checks: [],
        }),
      },
      execRunner: {
        run: async (input): Promise<ExecResult> => {
          const serialized = [input.command, ...(input.args ?? [])].join(" ");
          commandCalls.push(serialized);
          const lobsterResult = maybeHandleInstalledLobsterExec(input);
          if (lobsterResult !== null) {
            return lobsterResult;
          }

          if (serialized.startsWith("systemctl ")) {
            if (!serialized.endsWith("daemon-reload")) {
              systemGatewayStarted = true;
            }
            if (serialized === "systemctl is-active sovereign-openclaw-gateway.service") {
              return {
                command: serialized,
                exitCode: 3,
                stdout: "activating",
                stderr: "",
              };
            }
            return {
              command: serialized,
              exitCode: 0,
              stdout: "active",
              stderr: "",
            };
          }
          if (serialized === "openclaw health") {
            return systemGatewayStarted
              ? {
                  command: serialized,
                  exitCode: 0,
                  stdout: "ok",
                  stderr: "",
                }
              : {
                  command: serialized,
                  exitCode: 1,
                  stdout: "",
                  stderr: "Error: gateway closed (1006 abnormal closure (no close frame))",
                };
          }
          if (serialized === "openclaw gateway status") {
            return systemGatewayStarted
              ? {
                  command: serialized,
                  exitCode: 0,
                  stdout: "Service: systemd\nState: running",
                  stderr: "",
                }
              : {
                  command: serialized,
                  exitCode: 3,
                  stdout: "inactive",
                  stderr: "",
                };
          }
          if (serialized === "openclaw agents list") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "mail-sentinel\nnode-operator",
              stderr: "",
            };
          }
          if (serialized === "openclaw cron list") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "mail-sentinel-poll",
              stderr: "",
            };
          }
          if (serialized === "openclaw plugins enable matrix") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "enabled",
              stderr: "",
            };
          }
          if (serialized.startsWith("openclaw agents ")) {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "ok",
              stderr: "",
            };
          }
          if (serialized.startsWith("openclaw approvals allowlist add --agent ")) {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "ok",
              stderr: "",
            };
          }
          return {
            command: serialized,
            exitCode: 1,
            stdout: "",
            stderr: "unexpected command",
          };
        },
      },
      fetchImpl: async (url, init) => {
        const provisionResponse = buildManagedAgentMatrixProvisionResponse(url, init);
        if (provisionResponse !== null) {
          return provisionResponse;
        }
        if (url.includes("/joined_members")) {
          return new Response(JSON.stringify({ joined: {} }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.includes("/send/m.room.message/")) {
          sentMessageBody = typeof init?.body === "string" ? init.body : "";
          return new Response(JSON.stringify({ event_id: "$evt1" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        return new Response("not found", { status: 404 });
      },
    });

    try {
      const started = await service.startInstall(buildInstallRequest());
      expect(started.job.state).toBe("succeeded");
      expect(gatewayInstallCalls).toBe(1);
      expect(gatewayRestartCalls).toBe(1);
      expect(gatewayStartCalls).toBe(2);
      expect(registrarCalls).toBe(1);
      expect(systemGatewayStarted).toBe(true);

      const stepStates = Object.fromEntries(started.job.steps.map((step) => [step.id, step.state]));
      expect(stepStates.openclaw_configure).toBe("succeeded");
      expect(stepStates.bots_configure).toBe("succeeded");
      expect(stepStates.smoke_checks).toBe("succeeded");
      expect(sentMessageBody).toContain("Hello from Mail Sentinel");
    } finally {
      if (priorGatewayUnitPath === undefined) {
        delete process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH;
      } else {
        process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH = priorGatewayUnitPath;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("accepts a healthy gateway when gateway status still reports inactive after runtime configure", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };

    let gatewayRestartCalls = 0;
    let gatewayStartCalls = 0;
    const commandCalls: string[] = [];

    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => null,
        ensureInstalled: async () => {
          throw new Error("not used");
        },
      },
      openclawGatewayServiceManager: {
        install: async () => {
          throw new Error("not used");
        },
        start: async () => {
          gatewayStartCalls += 1;
        },
        restart: async () => {
          gatewayRestartCalls += 1;
        },
      },
      managedAgentRegistrar: {
        register: async () => {
          throw new Error("not used");
        },
      },
      preflightChecker: {
        run: async () => {
          throw new Error("not used");
        },
      },
      imapTester: {
        test: async () => {
          throw new Error("not used");
        },
      },
      matrixProvisioner: {
        provision: async () => {
          throw new Error("not used");
        },
        bootstrapAccounts: async () => {
          throw new Error("not used");
        },
        bootstrapRoom: async () => {
          throw new Error("not used");
        },
        test: async () => ({
          ok: true,
          homeserverUrl: "https://matrix.example.org",
          checks: [],
        }),
      },
      execRunner: {
        run: async ({ command, args }): Promise<ExecResult> => {
          const handled = maybeHandleInstalledLobsterExec(
            args === undefined ? { command } : { command, args },
          );
          if (handled !== null) {
            return handled;
          }
          const serialized = [command, ...(args ?? [])].join(" ");
          commandCalls.push(serialized);
          const lobsterResult = maybeHandleInstalledLobsterExec(
            args === undefined ? { command } : { command, args },
          );
          if (lobsterResult !== null) {
            return lobsterResult;
          }

          if (serialized === "systemctl is-active sovereign-openclaw-gateway.service") {
            return {
              command: serialized,
              exitCode: 4,
              stdout: "",
              stderr: "Unit sovereign-openclaw-gateway.service could not be found.",
            };
          }
          if (serialized === "openclaw gateway status") {
            return {
              command: serialized,
              exitCode: 3,
              stdout: "inactive",
              stderr: "",
            };
          }
          if (serialized === "openclaw health") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "ok",
              stderr: "",
            };
          }

          return {
            command: serialized,
            exitCode: 1,
            stdout: "",
            stderr: "unexpected command",
          };
        },
      },
    });

    const runtimeConfig = {
      openclaw: {
        managedInstallation: true,
        installMethod: "install_sh",
        requestedVersion: "0.2.0",
        openclawHome: join(paths.openclawServiceHome, ".openclaw"),
        runtimeConfigPath: join(paths.openclawServiceHome, ".openclaw", "openclaw.json5"),
        runtimeProfilePath: join(paths.openclawServiceHome, "profiles", "runtime.json5"),
        gatewayEnvPath: join(paths.openclawServiceHome, "gateway.env"),
      },
    } as RuntimeConfig;

    try {
      await (
        service as unknown as {
          refreshGatewayAfterRuntimeConfig(config: RuntimeConfig): Promise<void>;
        }
      ).refreshGatewayAfterRuntimeConfig(runtimeConfig);

      expect(gatewayRestartCalls).toBe(1);
      expect(gatewayStartCalls).toBe(0);
      expect(commandCalls).toContain("openclaw gateway status");
      expect(commandCalls).toContain("openclaw health");
      expect(commandCalls).not.toContain("systemctl daemon-reload");
      expect(commandCalls.some((command) => command.includes("enable --now"))).toBe(false);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("waits through activating systemd state when starting the system gateway fallback", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const priorGatewayUnitPath = process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH;
    const gatewayUnitPath = join(tempRoot, "systemd", "sovereign-openclaw-gateway.service");
    process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH = gatewayUnitPath;

    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };

    const commandCalls: string[] = [];

    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => null,
        ensureInstalled: async () => {
          throw new Error("not used");
        },
      },
      openclawGatewayServiceManager: {
        install: async () => {
          throw new Error("not used");
        },
        start: async () => {
          throw new Error("not used");
        },
        restart: async () => {
          throw new Error("not used");
        },
      },
      managedAgentRegistrar: {
        register: async () => {
          throw new Error("not used");
        },
      },
      preflightChecker: {
        run: async () => {
          throw new Error("not used");
        },
      },
      imapTester: {
        test: async () => {
          throw new Error("not used");
        },
      },
      matrixProvisioner: {
        provision: async () => {
          throw new Error("not used");
        },
        bootstrapAccounts: async () => {
          throw new Error("not used");
        },
        bootstrapRoom: async () => {
          throw new Error("not used");
        },
        test: async () => ({
          ok: true,
          homeserverUrl: "https://matrix.example.org",
          checks: [],
        }),
      },
      execRunner: {
        run: async ({ command, args }): Promise<ExecResult> => {
          const serialized = [command, ...(args ?? [])].join(" ");
          commandCalls.push(serialized);
          const lobsterResult = maybeHandleInstalledLobsterExec(
            args === undefined ? { command } : { command, args },
          );
          if (lobsterResult !== null) {
            return lobsterResult;
          }

          if (serialized === "systemctl is-active sovereign-openclaw-gateway.service") {
            return {
              command: serialized,
              exitCode: 3,
              stdout: "activating",
              stderr: "",
            };
          }
          if (serialized.startsWith("systemctl ")) {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "ok",
              stderr: "",
            };
          }
          if (serialized === "openclaw health") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "ok",
              stderr: "",
            };
          }

          return {
            command: serialized,
            exitCode: 1,
            stdout: "",
            stderr: "unexpected command",
          };
        },
      },
    });

    const runtimeConfig = {
      openclaw: {
        managedInstallation: true,
        installMethod: "install_sh",
        requestedVersion: "0.2.0",
        openclawHome: join(paths.openclawServiceHome, ".openclaw"),
        runtimeConfigPath: join(paths.openclawServiceHome, ".openclaw", "openclaw.json5"),
        runtimeProfilePath: join(paths.openclawServiceHome, "profiles", "runtime.json5"),
        gatewayEnvPath: join(paths.openclawServiceHome, "gateway.env"),
        serviceUser: "sovereign-node",
        serviceGroup: "sovereign-node",
      },
      matrix: {
        adminBaseUrl: "http://127.0.0.1:8008",
      },
    } as RuntimeConfig;

    try {
      const started = await (
        service as unknown as {
          ensureSystemGatewayServiceFallback(config: RuntimeConfig): Promise<boolean>;
        }
      ).ensureSystemGatewayServiceFallback(runtimeConfig);

      expect(started).toBe(true);
      expect(commandCalls).toContain("systemctl daemon-reload");
      expect(commandCalls).toContain("systemctl enable --now sovereign-openclaw-gateway.service");
      expect(commandCalls).toContain("systemctl restart sovereign-openclaw-gateway.service");
      expect(commandCalls).toContain("systemctl is-active sovereign-openclaw-gateway.service");
      const unitRaw = await readFile(gatewayUnitPath, "utf8");
      expect(unitRaw).toContain("After=network-online.target docker.service");
      expect(unitRaw).toContain("Requires=docker.service");
      expect(unitRaw).toContain("ExecStartPre=/usr/bin/env sh -lc");
      expect(unitRaw).toContain("/_matrix/client/versions");
      expect(unitRaw).toContain("User=sovereign-node");
      expect(unitRaw).toContain("Group=sovereign-node");
      expect(unitRaw).toContain("Environment=PATH=");
    } finally {
      if (priorGatewayUnitPath === undefined) {
        delete process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH;
      } else {
        process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH = priorGatewayUnitPath;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("skips Docker and Matrix readiness gating when the gateway targets a remote homeserver", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const priorGatewayUnitPath = process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH;
    const gatewayUnitPath = join(tempRoot, "systemd", "sovereign-openclaw-gateway.service");
    process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH = gatewayUnitPath;

    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };

    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => null,
        ensureInstalled: async () => {
          throw new Error("not used");
        },
      },
      openclawGatewayServiceManager: {
        install: async () => {
          throw new Error("not used");
        },
        start: async () => {
          throw new Error("not used");
        },
        restart: async () => {
          throw new Error("not used");
        },
      },
      managedAgentRegistrar: {
        register: async () => {
          throw new Error("not used");
        },
      },
      preflightChecker: {
        run: async () => {
          throw new Error("not used");
        },
      },
      imapTester: {
        test: async () => {
          throw new Error("not used");
        },
      },
      matrixProvisioner: {
        provision: async () => {
          throw new Error("not used");
        },
        bootstrapAccounts: async () => {
          throw new Error("not used");
        },
        bootstrapRoom: async () => {
          throw new Error("not used");
        },
        test: async () => ({
          ok: true,
          homeserverUrl: "https://matrix.example.org",
          checks: [],
        }),
      },
      execRunner: {
        run: async ({ command, args }): Promise<ExecResult> => {
          const serialized = [command, ...(args ?? [])].join(" ");
          const lobsterResult = maybeHandleInstalledLobsterExec(
            args === undefined ? { command } : { command, args },
          );
          if (lobsterResult !== null) {
            return lobsterResult;
          }
          if (serialized.startsWith("systemctl ")) {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "ok",
              stderr: "",
            };
          }
          if (serialized === "openclaw health") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "ok",
              stderr: "",
            };
          }

          return {
            command: serialized,
            exitCode: 1,
            stdout: "",
            stderr: "unexpected command",
          };
        },
      },
    });

    const runtimeConfig = {
      openclaw: {
        managedInstallation: true,
        installMethod: "install_sh",
        requestedVersion: "0.2.0",
        openclawHome: join(paths.openclawServiceHome, ".openclaw"),
        runtimeConfigPath: join(paths.openclawServiceHome, ".openclaw", "openclaw.json5"),
        runtimeProfilePath: join(paths.openclawServiceHome, "profiles", "runtime.json5"),
        gatewayEnvPath: join(paths.openclawServiceHome, "gateway.env"),
        serviceUser: "sovereign-node",
        serviceGroup: "sovereign-node",
      },
      matrix: {
        adminBaseUrl: "https://matrix.example.org",
      },
    } as RuntimeConfig;

    try {
      const started = await (
        service as unknown as {
          ensureSystemGatewayServiceFallback(config: RuntimeConfig): Promise<boolean>;
        }
      ).ensureSystemGatewayServiceFallback(runtimeConfig);

      expect(started).toBe(true);
      const unitRaw = await readFile(gatewayUnitPath, "utf8");
      expect(unitRaw).toContain("After=network-online.target");
      expect(unitRaw).not.toContain("docker.service");
      expect(unitRaw).not.toContain("ExecStartPre=");
    } finally {
      if (priorGatewayUnitPath === undefined) {
        delete process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH;
      } else {
        process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH = priorGatewayUnitPath;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("warns instead of failing smoke checks when gateway is running but health probe returns non-empty error", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const priorGatewayUnitPath = process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH;
    const priorServiceUser = process.env.SOVEREIGN_NODE_SERVICE_USER;
    const priorServiceGroup = process.env.SOVEREIGN_NODE_SERVICE_GROUP;
    const gatewayUnitPath = join(tempRoot, "systemd", "sovereign-openclaw-gateway.service");
    process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH = gatewayUnitPath;
    process.env.SOVEREIGN_NODE_SERVICE_USER = "sovereign-node";
    process.env.SOVEREIGN_NODE_SERVICE_GROUP = "sovereign-node";
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "var", "backups"),
    };

    let sentMessageBody = "";
    let healthProbeCalls = 0;

    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
        }),
        ensureInstalled: async (opts) => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: opts.version,
          installMethod: "install_sh",
        }),
      },
      openclawGatewayServiceManager: {
        install: async () => {
          throw {
            code: "OPENCLAW_GATEWAY_INSTALL_FAILED",
            message: "OpenClaw gateway command exited with non-zero status",
            retryable: true,
            details: {
              command: "openclaw gateway install",
              stderr:
                "Gateway service check failed: Error: systemctl --user unavailable: Failed to connect to bus: No medium found",
            },
          };
        },
        start: async () => {},
        restart: async () => {},
      },
      managedAgentRegistrar: {
        register: async () => ({
          agentId: "mail-sentinel",
          cronJobId: "mail-sentinel-poll",
          workspaceDir: join(paths.stateDir, "mail-sentinel", "workspace"),
          agentCommand: "openclaw agents add mail-sentinel --workspace /tmp/ws",
          cronCommand: "openclaw cron add --name mail-sentinel-poll --every 5m",
        }),
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async (req) => ({
          ok: true,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "ok",
          mailbox: req.imap.mailbox ?? "INBOX",
          capabilities: ["IMAP4rev1"],
        }),
      },
      matrixProvisioner: {
        provision: async (req) => ({
          projectDir: join(tempRoot, "matrix"),
          composeFilePath: join(tempRoot, "matrix", "compose.yaml"),
          accessMode: "direct",
          homeserverDomain: req.matrix.homeserverDomain,
          publicBaseUrl: req.matrix.publicBaseUrl,
          adminBaseUrl: "http://127.0.0.1:8008",
          federationEnabled: req.matrix.federationEnabled ?? false,
          tlsMode: "local-dev",
        }),
        bootstrapAccounts: async () => ({
          operator: {
            localpart: "operator",
            userId: "@operator:matrix.example.org",
            passwordSecretRef: "file:/tmp/operator.password",
            accessToken: "operator-token",
          },
          bot: {
            localpart: "mail-sentinel",
            userId: "@mail-sentinel:matrix.example.org",
            passwordSecretRef: "file:/tmp/mail-sentinel.password",
            accessToken: "bot-token",
          },
        }),
        bootstrapRoom: async () => ({
          roomId: "!alerts:matrix.example.org",
          roomName: "Sovereign Alerts",
        }),
        test: async (req) => ({
          ok: true,
          homeserverUrl: req.publicBaseUrl,
          checks: [],
        }),
      },
      execRunner: {
        run: async (input): Promise<ExecResult> => {
          const serialized = [input.command, ...(input.args ?? [])].join(" ");
          const lobsterResult = maybeHandleInstalledLobsterExec(input);
          if (lobsterResult !== null) {
            return lobsterResult;
          }

          if (serialized.startsWith("systemctl is-active")) {
            return { command: serialized, exitCode: 0, stdout: "active\n", stderr: "" };
          }
          if (serialized.startsWith("systemctl ")) {
            return { command: serialized, exitCode: 0, stdout: "active", stderr: "" };
          }
          if (serialized === "openclaw health") {
            healthProbeCalls += 1;
            if (healthProbeCalls === 1) {
              return { command: serialized, exitCode: 0, stdout: "ok", stderr: "" };
            }
            return {
              command: serialized,
              exitCode: 1,
              stdout:
                "[openclaw] Failed to start CLI: Error: gateway closed (1006 abnormal closure (no close frame)): no close reason\nGateway target: ws://127.0.0.1:18789",
              stderr: "",
            };
          }
          if (serialized === "openclaw gateway status") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "Service: systemd (disabled)\nState: failed",
              stderr: "",
            };
          }
          if (serialized === "openclaw agents list") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "mail-sentinel\nnode-operator",
              stderr: "",
            };
          }
          if (serialized === "openclaw cron list") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "mail-sentinel-poll",
              stderr: "",
            };
          }
          if (serialized === "openclaw plugins enable matrix") {
            return { command: serialized, exitCode: 0, stdout: "enabled", stderr: "" };
          }
          if (serialized.startsWith("openclaw agents ")) {
            return { command: serialized, exitCode: 0, stdout: "ok", stderr: "" };
          }
          if (serialized.startsWith("openclaw approvals allowlist add --agent ")) {
            return { command: serialized, exitCode: 0, stdout: "ok", stderr: "" };
          }
          return { command: serialized, exitCode: 1, stdout: "", stderr: "unexpected command" };
        },
      },
      fetchImpl: async (url, init) => {
        const provisionResponse = buildManagedAgentMatrixProvisionResponse(url, init);
        if (provisionResponse !== null) {
          return provisionResponse;
        }
        if (url.includes("/joined_members")) {
          return new Response(JSON.stringify({ joined: {} }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.includes("/send/m.room.message/")) {
          sentMessageBody = typeof init?.body === "string" ? init.body : "";
          return new Response(JSON.stringify({ event_id: "$evt1" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const started = await service.startInstall(buildInstallRequest());
      expect(started.job.state).toBe("succeeded");

      const stepStates = Object.fromEntries(started.job.steps.map((step) => [step.id, step.state]));
      expect(stepStates.smoke_checks).toBe("succeeded");
      expect(stepStates.test_alert).toBe("succeeded");
      expect(sentMessageBody).toContain("Hello from Mail Sentinel");
      expect(healthProbeCalls).toBeGreaterThanOrEqual(2);
    } finally {
      if (priorGatewayUnitPath === undefined) {
        delete process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH;
      } else {
        process.env.SOVEREIGN_NODE_GATEWAY_SYSTEMD_UNIT_PATH = priorGatewayUnitPath;
      }
      if (priorServiceUser === undefined) {
        delete process.env.SOVEREIGN_NODE_SERVICE_USER;
      } else {
        process.env.SOVEREIGN_NODE_SERVICE_USER = priorServiceUser;
      }
      if (priorServiceGroup === undefined) {
        delete process.env.SOVEREIGN_NODE_SERVICE_GROUP;
      } else {
        process.env.SOVEREIGN_NODE_SERVICE_GROUP = priorServiceGroup;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("binds the shared default Matrix account to the matching managed agent", async () => {
    const botPackage = buildTestLoadedBotPackage({
      id: "bitcoin-skill-match",
      displayName: "Bitcoin Skill Match",
      description: "Matrix-based community matchmaker for a local Bitcoin community.",
      matrixMode: "service-account",
      matrixRouting: {
        defaultAccount: true,
      },
    });
    const paths: SovereignPaths = {
      configPath: "/tmp/sovereign-node.json5",
      secretsDir: "/tmp/sovereign-secrets",
      stateDir: "/tmp/sovereign-state",
      logsDir: "/tmp/sovereign-logs",
      installJobsDir: "/tmp/sovereign-install-jobs",
      openclawServiceHome: "/tmp/sovereign-openclaw-home",
      provenancePath: "/tmp/sovereign-install-provenance.json",
      backupsDir: "/tmp/sovereign-backups",
    };

    const commandCalls: string[] = [];
    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
        }),
        ensureInstalled: async (opts) => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: opts.version,
          installMethod: "install_sh",
        }),
      },
      openclawGatewayServiceManager: {
        install: async () => {},
        start: async () => {},
        restart: async () => {},
      },
      botCatalog: {
        listPackages: async () => [botPackage],
        getPackage: async (id) => {
          if (id !== "bitcoin-skill-match") {
            throw new Error(`unexpected bot package lookup: ${id}`);
          }
          return botPackage;
        },
        getDefaultSelectedIds: async () => [],
        findPackageByTemplateRef: async (ref) =>
          ref === botPackage.templateRef ? botPackage : null,
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async (req) => ({
          ok: true,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "ok",
          mailbox: req.imap.mailbox ?? "INBOX",
          capabilities: ["IMAP4rev1"],
        }),
      },
      matrixProvisioner: {
        provision: async () => {
          throw new Error("not used");
        },
        bootstrapAccounts: async () => {
          throw new Error("not used");
        },
        bootstrapRoom: async () => {
          throw new Error("not used");
        },
        test: async () => ({
          ok: true,
          homeserverUrl: "https://matrix.example.org",
          checks: [],
        }),
      },
      execRunner: {
        run: async ({ command, args }) => {
          const serialized = [command, ...(args ?? [])].join(" ");
          commandCalls.push(serialized);
          return {
            command: serialized,
            exitCode: 0,
            stdout: "ok",
            stderr: "",
          };
        },
      },
    });

    const runtimeConfig: RuntimeConfig = {
      openrouter: {
        model: "qwen/qwen3.5-9b",
        apiKeySecretRef: "env:OPENROUTER_API_KEY",
      },
      openclaw: {
        managedInstallation: true,
        installMethod: "install_sh",
        requestedVersion: "0.2.0",
        openclawHome: "/tmp/sovereign-openclaw-home/.openclaw",
        runtimeConfigPath: "/tmp/sovereign-openclaw-home/.openclaw/openclaw.json5",
        runtimeProfilePath: "/tmp/sovereign-openclaw-home/profiles/runtime.json5",
        gatewayEnvPath: "/tmp/sovereign-openclaw-home/gateway.env",
      },
      openclawProfile: {
        plugins: {
          allow: ["matrix"],
        },
        agents: [
          {
            id: "bitcoin-skill-match",
            templateRef: botPackage.templateRef,
            workspace: "/tmp/bitcoin-skill-match",
            matrix: {
              localpart: "bitcoin-skill-match",
              userId: "@bitcoin-skill-match:matrix.example.org",
              accessTokenSecretRef: "file:/tmp/bitcoin-skill-match.token",
            },
          },
          {
            id: "node-operator",
            workspace: "/tmp/node-operator",
            matrix: {
              localpart: "node-operator",
              userId: "@node-operator:matrix.example.org",
              accessTokenSecretRef: "file:/tmp/node-operator.token",
            },
          },
        ],
        crons: [],
      },
      imap: {
        status: "configured",
        host: "imap.example.org",
        port: 993,
        tls: true,
        username: "operator@example.org",
        mailbox: "INBOX",
        secretRef: "file:/tmp/imap-secret",
      },
      bots: {
        config: {},
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
          localpart: "bitcoin-skill-match",
          userId: "@bitcoin-skill-match:matrix.example.org",
          accessTokenSecretRef: "file:/tmp/bitcoin-skill-match.token",
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
        instances: [],
      },
    };

    const bindingsInvoker = service as unknown as {
      ensureManagedAgentOpenClawBindings(config: RuntimeConfig): Promise<void>;
    };

    await bindingsInvoker.ensureManagedAgentOpenClawBindings(runtimeConfig);

    expect(commandCalls.includes("openclaw plugins enable matrix")).toBe(true);
    expect(
      commandCalls.includes(
        "openclaw agents bind --agent bitcoin-skill-match --bind matrix:bitcoin-skill-match",
      ),
    ).toBe(false);
    expect(
      commandCalls.includes("openclaw agents bind --agent bitcoin-skill-match --bind matrix"),
    ).toBe(true);
    expect(
      commandCalls.includes(
        "openclaw agents bind --agent node-operator --bind matrix:node-operator",
      ),
    ).toBe(true);
    expect(
      commandCalls.includes("openclaw agents bind --agent node-operator --bind matrix:default"),
    ).toBe(false);
    expect(
      commandCalls.includes(
        "openclaw agents bind --agent bitcoin-skill-match --bind matrix:default",
      ),
    ).toBe(false);
  });

  it("resolves configured runtime ownership from the service identity when running as root", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-ownership-test-"));
    const getuidMock =
      typeof process.getuid === "function"
        ? vi
            .spyOn(process as typeof process & { getuid: () => number }, "getuid")
            .mockImplementation(() => 0)
        : null;
    const commandCalls: string[] = [];
    const service = new RealInstallerService(
      createLogger(),
      {
        configPath: "/tmp/sovereign-node.json5",
        secretsDir: "/tmp/sovereign-secrets",
        stateDir: "/tmp/sovereign-state",
        logsDir: "/tmp/sovereign-logs",
        installJobsDir: "/tmp/sovereign-install-jobs",
        openclawServiceHome: "/tmp/sovereign-openclaw-home",
        provenancePath: "/tmp/sovereign-install-provenance.json",
        backupsDir: "/tmp/sovereign-backups",
      },
      {
        openclawBootstrapper: {
          detectInstalled: async () => null,
          ensureInstalled: async () => {
            throw new Error("not used");
          },
        },
        openclawGatewayServiceManager: {
          install: async () => {
            throw new Error("not used");
          },
          start: async () => {
            throw new Error("not used");
          },
          restart: async () => {
            throw new Error("not used");
          },
        },
        managedAgentRegistrar: {
          register: async () => {
            throw new Error("not used");
          },
        },
        preflightChecker: {
          run: async () => {
            throw new Error("not used");
          },
        },
        imapTester: {
          test: async () => {
            throw new Error("not used");
          },
        },
        matrixProvisioner: {
          provision: async () => {
            throw new Error("not used");
          },
          bootstrapAccounts: async () => {
            throw new Error("not used");
          },
          bootstrapRoom: async () => {
            throw new Error("not used");
          },
          test: async () => ({
            ok: true,
            homeserverUrl: "https://matrix.example.org",
            checks: [],
          }),
        },
        execRunner: {
          run: async ({ command, args }): Promise<ExecResult> => {
            const serialized = [command, ...(args ?? [])].join(" ");
            commandCalls.push(serialized);
            if (serialized === "getent passwd runner") {
              return {
                command: serialized,
                exitCode: 0,
                stdout: "runner:x:1001:1001::/home/runner:/bin/bash\n",
                stderr: "",
              };
            }
            return {
              command: serialized,
              exitCode: 1,
              stdout: "",
              stderr: "unexpected command",
            };
          },
        },
      },
    );

    const runtimeConfig = {
      openclaw: {
        serviceUser: "runner",
        serviceGroup: "runner",
      },
    } as RuntimeConfig;

    try {
      const ownership = await (
        service as unknown as {
          resolveConfiguredRuntimeOwnership(
            config: RuntimeConfig,
          ): Promise<{ uid: number; gid: number } | null>;
        }
      ).resolveConfiguredRuntimeOwnership(runtimeConfig);

      expect(ownership).toEqual({ uid: 1001, gid: 1001 });
      expect(commandCalls).toEqual(["getent passwd runner"]);

      const tempFile = join(tempRoot, "ownership-seed-test");
      await writeFile(tempFile, "test", "utf8");
      await (
        service as unknown as {
          applyConfiguredRuntimeOwnership(path: string, config: RuntimeConfig): Promise<void>;
        }
      ).applyConfiguredRuntimeOwnership(tempFile, runtimeConfig);

      const cachedOwnership = (
        service as unknown as {
          resolvedRuntimeOwnership: { uid: number; gid: number } | null | undefined;
        }
      ).resolvedRuntimeOwnership;
      expect(cachedOwnership).toEqual({ uid: 1001, gid: 1001 });
    } finally {
      getuidMock?.mockRestore();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("stores managed agent access tokens under a shared node-owned directory", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-agent-token-test-"));
    const getuidMock =
      typeof process.getuid === "function"
        ? vi
            .spyOn(process as typeof process & { getuid: () => number }, "getuid")
            .mockImplementation(() => 0)
        : null;
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };
    await mkdir(dirname(paths.configPath), { recursive: true });
    await mkdir(paths.secretsDir, { recursive: true });
    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => null,
        ensureInstalled: async () => {
          throw new Error("not used");
        },
      },
      openclawGatewayServiceManager: {
        install: async () => {
          throw new Error("not used");
        },
        start: async () => {
          throw new Error("not used");
        },
        restart: async () => {
          throw new Error("not used");
        },
      },
      managedAgentRegistrar: {
        register: async () => {
          throw new Error("not used");
        },
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async () => ({
          ok: true,
          host: "imap.example.org",
          port: 993,
          tls: true,
          auth: "ok",
          mailbox: "INBOX",
        }),
      },
      matrixProvisioner: {
        provision: async () => {
          throw new Error("not used");
        },
        bootstrapAccounts: async () => {
          throw new Error("not used");
        },
        bootstrapRoom: async () => {
          throw new Error("not used");
        },
        test: async () => ({
          ok: true,
          homeserverUrl: "https://matrix.example.org",
          checks: [],
        }),
      },
      execRunner: {
        run: async ({ command, args }): Promise<ExecResult> => {
          const serialized = [command, ...(args ?? [])].join(" ");
          if (serialized === "getent passwd runner") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "runner:x:1001:1001::/home/runner:/bin/bash\n",
              stderr: "",
            };
          }
          if (serialized === "getent group gateway-bots") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "gateway-bots:x:1002:\n",
              stderr: "",
            };
          }
          return {
            command: serialized,
            exitCode: 1,
            stdout: "",
            stderr: "unexpected command",
          };
        },
      },
    });
    const runtimeConfig = {
      openclaw: {
        serviceUser: "runner",
        serviceGroup: "gateway-bots",
      },
    } as RuntimeConfig;

    try {
      const ownership = await (
        service as unknown as {
          resolveManagedAgentAccessTokenOwnership(
            config: RuntimeConfig,
          ): Promise<{ uid: number; gid: number } | null>;
        }
      ).resolveManagedAgentAccessTokenOwnership(runtimeConfig);

      expect(ownership).toEqual({
        uid: (await stat(dirname(paths.configPath))).uid,
        gid: 1002,
      });

      const secretRef = await (
        service as unknown as {
          writeManagedAgentAccessTokenFile(
            config: RuntimeConfig,
            fileName: string,
            value: string,
          ): Promise<string>;
        }
      ).writeManagedAgentAccessTokenFile(
        runtimeConfig,
        "matrix-agent-mail-sentinel-access-token",
        "shared-token",
      );

      const tokenPath = managedAgentAccessTokenPath(paths, "mail-sentinel");
      expect(secretRef).toBe(`file:${tokenPath}`);
      expect(await readFile(tokenPath, "utf8")).toBe("shared-token\n");
      expect((await stat(tokenPath)).mode & 0o777).toBe(0o640);
      expect((await stat(managedAgentAccessTokenDir(paths))).mode & 0o7777).toBe(0o2750);
    } finally {
      getuidMock?.mockRestore();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("stores managed secrets under the configured service identity in root installs", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-managed-secret-test-"));
    const getuidMock =
      typeof process.getuid === "function"
        ? vi
            .spyOn(process as typeof process & { getuid: () => number }, "getuid")
            .mockImplementation(() => 0)
        : null;
    const priorSudoUser = process.env.SUDO_USER;
    const priorServiceUser = process.env.SOVEREIGN_NODE_SERVICE_USER;
    const priorServiceGroup = process.env.SOVEREIGN_NODE_SERVICE_GROUP;
    process.env.SUDO_USER = "runner";
    delete process.env.SOVEREIGN_NODE_SERVICE_USER;
    delete process.env.SOVEREIGN_NODE_SERVICE_GROUP;

    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };

    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => null,
        ensureInstalled: async () => {
          throw new Error("not used");
        },
      },
      openclawGatewayServiceManager: {
        install: async () => {
          throw new Error("not used");
        },
        start: async () => {
          throw new Error("not used");
        },
        restart: async () => {
          throw new Error("not used");
        },
      },
      managedAgentRegistrar: {
        register: async () => {
          throw new Error("not used");
        },
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async () => ({
          ok: true,
          host: "imap.example.org",
          port: 993,
          tls: true,
          auth: "ok",
          mailbox: "INBOX",
        }),
      },
      matrixProvisioner: {
        provision: async () => {
          throw new Error("not used");
        },
        bootstrapAccounts: async () => {
          throw new Error("not used");
        },
        bootstrapRoom: async () => {
          throw new Error("not used");
        },
        test: async () => ({
          ok: true,
          homeserverUrl: "https://matrix.example.org",
          checks: [],
        }),
      },
      execRunner: {
        run: async ({ command, args }): Promise<ExecResult> => {
          const serialized = [command, ...(args ?? [])].join(" ");
          if (serialized === "getent passwd runner") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "runner:x:1001:1001::/home/runner:/bin/bash\n",
              stderr: "",
            };
          }
          return {
            command: serialized,
            exitCode: 1,
            stdout: "",
            stderr: "unexpected command",
          };
        },
      },
    });

    try {
      const secretRef = await (
        service as unknown as {
          writeManagedSecretFile(fileName: string, value: string): Promise<string>;
        }
      ).writeManagedSecretFile("matrix-agent-mail-sentinel-access-token", "token-value");

      expect(secretRef).toBe(
        `file:${join(paths.secretsDir, "matrix-agent-mail-sentinel-access-token")}`,
      );
      expect(
        await readFile(join(paths.secretsDir, "matrix-agent-mail-sentinel-access-token"), "utf8"),
      ).toBe("token-value\n");
      expect((await stat(paths.secretsDir)).mode & 0o777).toBe(0o700);

      const cachedOwnership = (
        service as unknown as {
          resolvedRuntimeOwnership: { uid: number; gid: number } | null | undefined;
        }
      ).resolvedRuntimeOwnership;
      expect(cachedOwnership).toEqual({ uid: 1001, gid: 1001 });

      const runtimeOwnership = await (
        service as unknown as {
          resolveRuntimeOwnership(): Promise<{ uid: number; gid: number } | null>;
        }
      ).resolveRuntimeOwnership();
      expect(runtimeOwnership).toEqual({ uid: 1001, gid: 1001 });
    } finally {
      getuidMock?.mockRestore();
      if (priorSudoUser === undefined) {
        delete process.env.SUDO_USER;
      } else {
        process.env.SUDO_USER = priorSudoUser;
      }
      if (priorServiceUser === undefined) {
        delete process.env.SOVEREIGN_NODE_SERVICE_USER;
      } else {
        process.env.SOVEREIGN_NODE_SERVICE_USER = priorServiceUser;
      }
      if (priorServiceGroup === undefined) {
        delete process.env.SOVEREIGN_NODE_SERVICE_GROUP;
      } else {
        process.env.SOVEREIGN_NODE_SERVICE_GROUP = priorServiceGroup;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("defaults the managed service identity to the invoking sudo user in root installs", () => {
    const getuidMock =
      typeof process.getuid === "function"
        ? vi
            .spyOn(process as typeof process & { getuid: () => number }, "getuid")
            .mockImplementation(() => 0)
        : null;
    const priorSudoUser = process.env.SUDO_USER;
    const priorServiceUser = process.env.SOVEREIGN_NODE_SERVICE_USER;
    const priorServiceGroup = process.env.SOVEREIGN_NODE_SERVICE_GROUP;
    process.env.SUDO_USER = "runner";
    delete process.env.SOVEREIGN_NODE_SERVICE_USER;
    delete process.env.SOVEREIGN_NODE_SERVICE_GROUP;

    const service = new RealInstallerService(
      createLogger(),
      {
        configPath: "/tmp/sovereign-node.json5",
        secretsDir: "/tmp/sovereign-secrets",
        stateDir: "/tmp/sovereign-state",
        logsDir: "/tmp/sovereign-logs",
        installJobsDir: "/tmp/sovereign-install-jobs",
        openclawServiceHome: "/tmp/sovereign-openclaw-home",
        provenancePath: "/tmp/sovereign-install-provenance.json",
        backupsDir: "/tmp/sovereign-backups",
      },
      {
        openclawBootstrapper: {
          detectInstalled: async () => null,
          ensureInstalled: async () => {
            throw new Error("not used");
          },
        },
        openclawGatewayServiceManager: {
          install: async () => {
            throw new Error("not used");
          },
          start: async () => {
            throw new Error("not used");
          },
          restart: async () => {
            throw new Error("not used");
          },
        },
        managedAgentRegistrar: {
          register: async () => {
            throw new Error("not used");
          },
        },
        preflightChecker: {
          run: async () => ({
            ok: true,
            mode: "bundled_matrix",
            overall: "pass",
            checks: [],
            recommendedActions: [],
          }),
        },
        imapTester: {
          test: async () => {
            throw new Error("not used");
          },
        },
        matrixProvisioner: {
          provision: async () => {
            throw new Error("not used");
          },
          bootstrapAccounts: async () => {
            throw new Error("not used");
          },
          bootstrapRoom: async () => {
            throw new Error("not used");
          },
          test: async () => ({
            ok: true,
            homeserverUrl: "https://matrix.example.org",
            checks: [],
          }),
        },
      },
    );

    try {
      const internals = service as unknown as {
        getConfiguredServiceIdentity(config?: RuntimeConfig): {
          user: string;
          group: string;
        };
        shouldPreferSystemGatewayService(config?: RuntimeConfig): boolean;
      };

      expect(internals.getConfiguredServiceIdentity()).toEqual({
        user: "runner",
        group: "runner",
      });
      expect(internals.shouldPreferSystemGatewayService()).toBe(true);
    } finally {
      if (priorSudoUser === undefined) {
        delete process.env.SUDO_USER;
      } else {
        process.env.SUDO_USER = priorSudoUser;
      }
      if (priorServiceUser === undefined) {
        delete process.env.SOVEREIGN_NODE_SERVICE_USER;
      } else {
        process.env.SOVEREIGN_NODE_SERVICE_USER = priorServiceUser;
      }
      if (priorServiceGroup === undefined) {
        delete process.env.SOVEREIGN_NODE_SERVICE_GROUP;
      } else {
        process.env.SOVEREIGN_NODE_SERVICE_GROUP = priorServiceGroup;
      }
      getuidMock?.mockRestore();
    }
  });

  it("builds status from runtime config and OpenClaw probes", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };
    await writeRuntimeArtifacts(paths);

    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
        }),
        ensureInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
          installMethod: "install_sh",
        }),
      },
      openclawGatewayServiceManager: {
        install: async () => {},
        start: async () => {},
        restart: async () => {},
      },
      managedAgentRegistrar: {
        register: async () => ({
          agentId: "mail-sentinel",
          cronJobId: "mail-sentinel-poll",
          workspaceDir: join(paths.stateDir, "mail-sentinel", "workspace"),
          agentCommand: "openclaw agents upsert",
          cronCommand: "openclaw cron add",
        }),
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async (req) => ({
          ok: true,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "ok",
          mailbox: req.imap.mailbox ?? "INBOX",
        }),
      },
      matrixProvisioner: {
        provision: async () => {
          throw new Error("not used");
        },
        bootstrapAccounts: async () => {
          throw new Error("not used");
        },
        bootstrapRoom: async () => {
          throw new Error("not used");
        },
        test: async () => ({
          ok: true,
          homeserverUrl: "https://matrix.example.org",
          checks: [],
        }),
      },
      execRunner: {
        run: async ({ command, args }) => {
          const serialized = [command, ...(args ?? [])].join(" ");
          if (serialized === "openclaw gateway status") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "running",
              stderr: "",
            };
          }
          if (serialized === "openclaw health") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "ok",
              stderr: "",
            };
          }
          if (serialized === "openclaw agents list") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "mail-sentinel\nnode-operator",
              stderr: "",
            };
          }
          if (serialized === "openclaw cron list") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "mail-sentinel-poll",
              stderr: "",
            };
          }
          return {
            command: serialized,
            exitCode: 1,
            stdout: "",
            stderr: "unexpected command",
          };
        },
      },
      fetchImpl: async (url) => {
        if (!url.includes("/joined_members")) {
          return new Response("not found", { status: 404 });
        }
        return new Response(JSON.stringify({ joined: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    try {
      const status = await service.getStatus();
      expect(status.mode).toBe("bundled_matrix");
      expect(status.openclaw.cliInstalled).toBe(true);
      expect(status.openclaw.serviceInstalled).toBe(true);
      expect(status.openclaw.serviceState).toBe("running");
      expect(status.openclaw.agentPresent).toBe(true);
      expect(status.openclaw.cronPresent).toBe(true);
      expect(status.matrix.roomReachable).toBe(true);
      expect(status.services.some((entry) => entry.kind === "openclaw")).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("repairs stale Matrix tokens during status and rewrites the OpenClaw runtime", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "var", "backups"),
    };
    const priorOpenrouterApiKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    let gatewayRestarts = 0;
    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
        }),
        ensureInstalled: async (opts) => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: opts.version,
          installMethod: "install_sh",
        }),
      },
      openclawGatewayServiceManager: {
        install: async () => {},
        start: async () => {},
        restart: async () => {
          gatewayRestarts += 1;
        },
      },
      managedAgentRegistrar: {
        register: async (input) => ({
          agentId: input.agentId,
          workspaceDir: input.workspaceDir,
          agentCommand: `openclaw agents upsert --id ${input.agentId}`,
          ...(input.cron === undefined ? {} : { cronJobId: input.cron.id }),
          ...(input.cron === undefined
            ? {}
            : { cronCommand: `openclaw cron add --name ${input.cron.id}` }),
        }),
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async (req) => ({
          ok: true,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "ok",
          mailbox: req.imap.mailbox ?? "INBOX",
        }),
      },
      matrixProvisioner: {
        provision: async (req) => ({
          projectDir: join(tempRoot, "matrix"),
          composeFilePath: join(tempRoot, "matrix", "compose.yaml"),
          accessMode: "direct",
          homeserverDomain: req.matrix.homeserverDomain,
          publicBaseUrl: req.matrix.publicBaseUrl,
          adminBaseUrl: "http://127.0.0.1:8008",
          federationEnabled: req.matrix.federationEnabled ?? false,
          tlsMode: "local-dev",
        }),
        bootstrapAccounts: async () => {
          const operatorPasswordPath = join(paths.secretsDir, "matrix-operator.password");
          const botPasswordPath = join(paths.secretsDir, "matrix-mail-sentinel.password");
          await mkdir(paths.secretsDir, { recursive: true });
          await writeFile(operatorPasswordPath, "operator-password\n", "utf8");
          await writeFile(botPasswordPath, "mail-sentinel-password\n", "utf8");
          return {
            operator: {
              localpart: "operator",
              userId: "@operator:matrix.example.org",
              passwordSecretRef: `file:${operatorPasswordPath}`,
              accessToken: "operator-token",
            },
            bot: {
              localpart: "mail-sentinel",
              userId: "@mail-sentinel:matrix.example.org",
              passwordSecretRef: `file:${botPasswordPath}`,
              accessToken: "mail-sentinel-bootstrap-token",
            },
          };
        },
        bootstrapRoom: async () => ({
          roomId: "!alerts:matrix.example.org",
          roomName: "Sovereign Alerts",
        }),
        test: async (req) => ({
          ok: true,
          homeserverUrl: req.publicBaseUrl,
          checks: [],
        }),
      },
      execRunner: {
        run: async (input): Promise<ExecResult> => {
          const lobster = maybeHandleInstalledLobsterExec(input);
          if (lobster !== null) {
            return lobster;
          }
          const serialized = [input.command, ...(input.args ?? [])].join(" ");
          if (serialized === "openclaw health") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "ok",
              stderr: "",
            };
          }
          if (serialized === "openclaw gateway status") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "Service: systemd\nState: running",
              stderr: "",
            };
          }
          if (serialized === "openclaw agents list") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "mail-sentinel",
              stderr: "",
            };
          }
          if (serialized === "openclaw cron list") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "mail-sentinel-poll",
              stderr: "",
            };
          }
          if (serialized.startsWith("openclaw ")) {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "ok",
              stderr: "",
            };
          }
          return {
            command: serialized,
            exitCode: 1,
            stdout: "",
            stderr: "unexpected command",
          };
        },
      },
      fetchImpl: async (url, init) => {
        const provisionResponse = buildManagedAgentMatrixProvisionResponse(url, init);
        if (provisionResponse !== null) {
          return provisionResponse;
        }
        const authorization = new Headers(init?.headers).get("Authorization") ?? "";
        const token = authorization.replace(/^Bearer\s+/u, "");
        const validTokens = new Set(["mail-sentinel-bootstrap-token", "mail-sentinel-token"]);
        if (url.endsWith("/_matrix/client/v3/account/whoami")) {
          return new Response(JSON.stringify({ user_id: "@mail-sentinel:matrix.example.org" }), {
            status: validTokens.has(token) ? 200 : 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.includes("/joined_members")) {
          return new Response(JSON.stringify({ joined: {} }), {
            status: validTokens.has(token) ? 200 : 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.includes("/send/m.room.message/")) {
          return new Response(JSON.stringify({ event_id: "$evt1" }), {
            status: validTokens.has(token) ? 200 : 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const req = buildInstallRequest();
      req.openrouter = {
        model: "qwen/qwen3.5-9b",
        secretRef: "env:OPENROUTER_API_KEY",
      };
      req.bots = {
        selected: ["mail-sentinel"],
      };

      const started = await service.startInstall(req);
      expect(started.job.state).toBe("succeeded");

      const runtimeConfigRaw = await readFile(paths.configPath, "utf8");
      const runtimeConfig = JSON.parse(runtimeConfigRaw) as {
        matrix?: {
          bot?: {
            accessTokenSecretRef?: string;
          };
        };
        openclawProfile?: {
          agents?: Array<{
            id?: string;
            matrix?: {
              accessTokenSecretRef?: string;
            };
          }>;
        };
      };
      const botTokenPath =
        runtimeConfig.matrix?.bot?.accessTokenSecretRef?.startsWith("file:") === true
          ? runtimeConfig.matrix.bot.accessTokenSecretRef.slice("file:".length)
          : "";
      const agentTokenPath =
        runtimeConfig.openclawProfile?.agents
          ?.find((agent) => agent.id === "mail-sentinel")
          ?.matrix?.accessTokenSecretRef?.startsWith("file:") === true
          ? (runtimeConfig.openclawProfile.agents
              .find((agent) => agent.id === "mail-sentinel")
              ?.matrix?.accessTokenSecretRef?.slice("file:".length) ?? "")
          : "";
      const openclawConfigPath = join(paths.openclawServiceHome, ".openclaw", "openclaw.json5");
      const initialOpenClawConfig = await readFile(openclawConfigPath, "utf8");
      expect(botTokenPath.length).toBeGreaterThan(0);
      expect(agentTokenPath.length).toBeGreaterThan(0);
      expect(botTokenPath).toBe(managedAgentAccessTokenPath(paths, "mail-sentinel"));
      expect(agentTokenPath).toBe(managedAgentAccessTokenPath(paths, "mail-sentinel"));
      expect(botTokenPath.startsWith(`${paths.secretsDir}/`)).toBe(false);
      expect((await stat(botTokenPath)).mode & 0o777).toBe(0o640);
      expect((await stat(managedAgentAccessTokenDir(paths))).mode & 0o7777).toBe(0o2750);
      expect(initialOpenClawConfig).toContain("mail-sentinel-token");
      const restartCountBeforeRepair = gatewayRestarts;

      await writeFile(botTokenPath, "stale-primary-token\n", "utf8");
      await writeFile(agentTokenPath, "stale-agent-token\n", "utf8");
      await writeFile(
        openclawConfigPath,
        initialOpenClawConfig.replaceAll("mail-sentinel-token", "stale-agent-token"),
        "utf8",
      );
      delete process.env.OPENROUTER_API_KEY;

      const status = await service.getStatus();

      expect(status.matrix.roomReachable).toBe(true);
      expect((await readFile(botTokenPath, "utf8")).trim()).toBe("mail-sentinel-token");
      expect((await readFile(agentTokenPath, "utf8")).trim()).toBe("mail-sentinel-token");
      expect(await readFile(openclawConfigPath, "utf8")).toBe(initialOpenClawConfig);
      expect(gatewayRestarts).toBe(restartCountBeforeRepair + 1);
    } finally {
      if (priorOpenrouterApiKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = priorOpenrouterApiKey;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("migrates legacy mail-sentinel request data into bot instances", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };
    await writeRuntimeArtifacts(paths);
    const requestPath = join(dirname(paths.configPath), "install-request.json");
    await writeFile(requestPath, `${JSON.stringify(buildInstallRequest(), null, 2)}\n`, "utf8");

    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => null,
        ensureInstalled: async () => {
          throw new Error("not used");
        },
      },
      openclawGatewayServiceManager: {
        install: async () => {},
        start: async () => {},
        restart: async () => {},
      },
      managedAgentRegistrar: {
        register: async () => {
          throw new Error("not used");
        },
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async () => ({
          ok: true,
          host: "imap.example.org",
          port: 993,
          tls: true,
          auth: "ok",
          mailbox: "INBOX",
        }),
      },
      matrixProvisioner: {
        provision: async () => {
          throw new Error("not used");
        },
        bootstrapAccounts: async () => {
          throw new Error("not used");
        },
        bootstrapRoom: async () => {
          throw new Error("not used");
        },
        test: async () => ({
          ok: true,
          homeserverUrl: "https://matrix.example.org",
          checks: [],
        }),
      },
    });

    try {
      const result = await service.migrateLegacyMailSentinel({
        allowedUsers: ["operator"],
      });

      expect(result.changed).toBe(true);
      expect(result.requestFile).toBe(requestPath);
      expect(result.instance.id).toBe("mail-sentinel");
      expect(result.instance.allowedUsers).toEqual(["@operator:matrix.example.org"]);

      const raw = await readFile(requestPath, "utf8");
      const request = JSON.parse(raw) as {
        bots?: {
          selected?: string[];
          instances?: Array<{
            id?: string;
            packageId?: string;
            workspace?: string;
            config?: Record<string, unknown>;
            secretRefs?: Record<string, unknown>;
            matrix?: {
              localpart?: string;
              alertRoom?: { roomId?: string; roomName?: string };
              allowedUsers?: string[];
            };
          }>;
        };
      };
      expect(request.bots?.selected).toContain("mail-sentinel");
      expect(request.bots?.instances).toEqual([
        {
          id: "mail-sentinel",
          packageId: "mail-sentinel",
          workspace: join(paths.stateDir, "mail-sentinel", "workspace"),
          config: {
            pollInterval: "30m",
            lookbackWindow: "1h",
            e2eeAlertRoom: false,
            imapConfigured: true,
            imapHost: "imap.example.org",
            imapPort: 993,
            imapTls: true,
            imapUsername: "pending",
            imapMailbox: "INBOX",
          },
          secretRefs: {
            imapPassword: "file:/tmp/imap-secret",
          },
          matrix: {
            localpart: "mail-sentinel",
            alertRoom: {
              roomId: "!alerts:matrix.example.org",
              roomName: "Sovereign Alerts",
            },
            allowedUsers: ["@operator:matrix.example.org"],
          },
        },
      ]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("treats disabled systemd host resources as healthy when they match desired state", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };
    await writeRuntimeArtifacts(paths);

    const raw = await readFile(paths.configPath, "utf8");
    const parsed = JSON.parse(raw) as {
      hostResources?: {
        planPath?: string;
        resources?: Array<Record<string, unknown>>;
        botStatus?: Array<Record<string, unknown>>;
      };
    };
    parsed.hostResources = {
      planPath: join(dirname(paths.configPath), "host-resources.json"),
      resources: [
        {
          id: "scan-service",
          botId: "mail-sentinel",
          kind: "systemdService",
          name: "sovereign-mail-sentinel-scan.service",
          content: "[Unit]\nDescription=test\n",
          desiredState: {
            enabled: false,
            active: false,
          },
          checks: [],
        },
      ],
      botStatus: [],
    };
    await writeFile(paths.configPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");

    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
        }),
        ensureInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
          installMethod: "install_sh",
        }),
      },
      openclawGatewayServiceManager: {
        install: async () => {},
        start: async () => {},
        restart: async () => {},
      },
      managedAgentRegistrar: {
        register: async () => ({
          agentId: "mail-sentinel",
          workspaceDir: join(paths.stateDir, "mail-sentinel", "workspace"),
          agentCommand: "openclaw agents upsert",
        }),
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async (req) => ({
          ok: true,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "ok",
          mailbox: req.imap.mailbox ?? "INBOX",
        }),
      },
      matrixProvisioner: {
        provision: async () => {
          throw new Error("not used");
        },
        bootstrapAccounts: async () => {
          throw new Error("not used");
        },
        bootstrapRoom: async () => {
          throw new Error("not used");
        },
        test: async () => ({
          ok: true,
          homeserverUrl: "https://matrix.example.org",
          checks: [],
        }),
      },
      execRunner: {
        run: async ({ command, args }) => {
          const serialized = [command, ...(args ?? [])].join(" ");
          if (serialized === "openclaw gateway status") {
            return { command: serialized, exitCode: 0, stdout: "running", stderr: "" };
          }
          if (serialized === "openclaw health") {
            return { command: serialized, exitCode: 0, stdout: "ok", stderr: "" };
          }
          if (serialized === "openclaw agents list") {
            return { command: serialized, exitCode: 0, stdout: "mail-sentinel", stderr: "" };
          }
          if (serialized === "openclaw cron list") {
            return { command: serialized, exitCode: 0, stdout: "", stderr: "" };
          }
          if (serialized === "systemctl is-enabled sovereign-mail-sentinel-scan.service") {
            return { command: serialized, exitCode: 1, stdout: "disabled", stderr: "" };
          }
          if (serialized === "systemctl is-active sovereign-mail-sentinel-scan.service") {
            return { command: serialized, exitCode: 3, stdout: "inactive", stderr: "" };
          }
          return {
            command: serialized,
            exitCode: 1,
            stdout: "",
            stderr: "unexpected command",
          };
        },
      },
      fetchImpl: async () =>
        new Response(JSON.stringify({ joined: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    try {
      const status = await service.getStatus();
      expect(status.bots["mail-sentinel"]?.health).toBe("healthy");
      expect(status.hostResources.find((entry) => entry.id === "scan-service")?.health).toBe(
        "healthy",
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("treats OpenClaw agent and cron probes as satisfied when none are configured", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };
    await writeRuntimeArtifacts(paths);

    const configRaw = await readFile(paths.configPath, "utf8");
    const parsed = JSON.parse(configRaw) as {
      openclawProfile?: {
        agents?: Array<Record<string, unknown>>;
        crons?: Array<Record<string, unknown>>;
      };
    };
    parsed.openclawProfile = {
      ...(parsed.openclawProfile ?? {}),
      agents: [],
      crons: [],
    };
    await writeFile(paths.configPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");

    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
        }),
        ensureInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
          installMethod: "install_sh",
        }),
      },
      openclawGatewayServiceManager: {
        install: async () => {},
        start: async () => {},
        restart: async () => {},
      },
      managedAgentRegistrar: {
        register: async () => ({
          agentId: "mail-sentinel",
          cronJobId: "mail-sentinel-poll",
          workspaceDir: join(paths.stateDir, "mail-sentinel", "workspace"),
          agentCommand: "openclaw agents upsert",
          cronCommand: "openclaw cron add",
        }),
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async (req) => ({
          ok: true,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "ok",
          mailbox: req.imap.mailbox ?? "INBOX",
        }),
      },
      matrixProvisioner: {
        provision: async () => {
          throw new Error("not used");
        },
        bootstrapAccounts: async () => {
          throw new Error("not used");
        },
        bootstrapRoom: async () => {
          throw new Error("not used");
        },
        test: async () => ({
          ok: true,
          homeserverUrl: "https://matrix.example.org",
          checks: [],
        }),
      },
      execRunner: {
        run: async ({ command, args }) => {
          const serialized = [command, ...(args ?? [])].join(" ");
          if (serialized === "openclaw gateway status") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "running",
              stderr: "",
            };
          }
          if (serialized === "openclaw health") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "ok",
              stderr: "",
            };
          }
          if (serialized === "openclaw agents list" || serialized === "openclaw cron list") {
            throw new Error("unexpected probe command");
          }
          return {
            command: serialized,
            exitCode: 1,
            stdout: "",
            stderr: "unexpected command",
          };
        },
      },
      fetchImpl: async (url) => {
        if (!url.includes("/joined_members")) {
          return new Response("not found", { status: 404 });
        }
        return new Response(JSON.stringify({ joined: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    try {
      const status = await service.getStatus();
      expect(status.openclaw.health).toBe("healthy");
      expect(status.openclaw.agentPresent).toBe(true);
      expect(status.openclaw.cronPresent).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("reports OpenClaw as stopped when gateway status is inactive", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };
    await writeRuntimeArtifacts(paths);

    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
        }),
        ensureInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
          installMethod: "install_sh",
        }),
      },
      openclawGatewayServiceManager: {
        install: async () => {},
        start: async () => {},
        restart: async () => {},
      },
      managedAgentRegistrar: {
        register: async () => ({
          agentId: "mail-sentinel",
          cronJobId: "mail-sentinel-poll",
          workspaceDir: join(paths.stateDir, "mail-sentinel", "workspace"),
          agentCommand: "openclaw agents upsert",
          cronCommand: "openclaw cron add",
        }),
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async (req) => ({
          ok: true,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "ok",
          mailbox: req.imap.mailbox ?? "INBOX",
        }),
      },
      matrixProvisioner: {
        provision: async () => {
          throw new Error("not used");
        },
        bootstrapAccounts: async () => {
          throw new Error("not used");
        },
        bootstrapRoom: async () => {
          throw new Error("not used");
        },
        test: async () => ({
          ok: true,
          homeserverUrl: "https://matrix.example.org",
          checks: [],
        }),
      },
      execRunner: {
        run: async ({ command, args }) => {
          const serialized = [command, ...(args ?? [])].join(" ");
          if (serialized === "openclaw gateway status") {
            return {
              command: serialized,
              exitCode: 3,
              stdout: "inactive",
              stderr: "",
            };
          }
          if (serialized === "openclaw health") {
            return {
              command: serialized,
              exitCode: 1,
              stdout: "",
              stderr: "health check failed",
            };
          }
          if (serialized === "openclaw agents list") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "mail-sentinel\nnode-operator",
              stderr: "",
            };
          }
          if (serialized === "openclaw cron list") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "mail-sentinel-poll",
              stderr: "",
            };
          }
          return {
            command: serialized,
            exitCode: 1,
            stdout: "",
            stderr: "unexpected command",
          };
        },
      },
      fetchImpl: async (url) => {
        if (!url.includes("/joined_members")) {
          return new Response("not found", { status: 404 });
        }
        return new Response(JSON.stringify({ joined: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    try {
      const status = await service.getStatus();
      expect(status.openclaw.serviceState).toBe("stopped");
      expect(status.services.find((entry) => entry.name === "openclaw-gateway")?.state).toBe(
        "stopped",
      );
      expect(status.openclaw.health).toBe("degraded");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("returns degraded OpenClaw status when quick probes time out", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };
    await writeRuntimeArtifacts(paths);

    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
        }),
        ensureInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
          installMethod: "install_sh",
        }),
      },
      openclawGatewayServiceManager: {
        install: async () => {},
        start: async () => {},
        restart: async () => {},
      },
      managedAgentRegistrar: {
        register: async () => ({
          agentId: "mail-sentinel",
          cronJobId: "mail-sentinel-poll",
          workspaceDir: join(paths.stateDir, "mail-sentinel", "workspace"),
          agentCommand: "openclaw agents upsert",
          cronCommand: "openclaw cron add",
        }),
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async (req) => ({
          ok: true,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "ok",
          mailbox: req.imap.mailbox ?? "INBOX",
        }),
      },
      matrixProvisioner: {
        provision: async () => {
          throw new Error("not used");
        },
        bootstrapAccounts: async () => {
          throw new Error("not used");
        },
        bootstrapRoom: async () => {
          throw new Error("not used");
        },
        test: async () => ({
          ok: true,
          homeserverUrl: "https://matrix.example.org",
          checks: [],
        }),
      },
      execRunner: {
        run: async (input): Promise<ExecResult> => {
          const serialized = [input.command, ...(input.args ?? [])].join(" ");
          if (serialized.startsWith("systemctl is-active")) {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "active",
              stderr: "",
            };
          }
          if (serialized === "openclaw health") {
            throw new Error("Command timed out after 5000 milliseconds");
          }
          if (
            serialized === "openclaw agents list" ||
            serialized === "openclaw agents list --json" ||
            serialized === "openclaw cron list" ||
            serialized === "openclaw cron list --json"
          ) {
            throw new Error("Command timed out after 5000 milliseconds");
          }
          return {
            command: serialized,
            exitCode: 0,
            stdout: "",
            stderr: "",
          };
        },
      },
    });

    try {
      const status = await service.getStatus();

      expect(status.openclaw.health).toBe("degraded");
      expect(status.openclaw.agentPresent).toBe(true);
      expect(status.openclaw.cronPresent).toBe(true);
      expect(status.services.find((entry) => entry.name === "openclaw-gateway")?.state).toBe(
        "running",
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("treats cron presence as satisfied when no managed crons are configured", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };
    await writeRuntimeArtifacts(paths);
    await writeNoCronManagedAgentRuntime(paths);

    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
        }),
        ensureInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
          installMethod: "install_sh",
        }),
      },
      openclawGatewayServiceManager: {
        install: async () => {},
        start: async () => {},
        restart: async () => {},
      },
      managedAgentRegistrar: {
        register: async () => ({
          agentId: "mail-sentinel",
          cronJobId: "mail-sentinel-poll",
          workspaceDir: join(paths.stateDir, "mail-sentinel", "workspace"),
          agentCommand: "openclaw agents upsert",
          cronCommand: "openclaw cron add",
        }),
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async (req) => ({
          ok: true,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "ok",
          mailbox: req.imap.mailbox ?? "INBOX",
        }),
      },
      matrixProvisioner: {
        provision: async () => {
          throw new Error("not used");
        },
        bootstrapAccounts: async () => {
          throw new Error("not used");
        },
        bootstrapRoom: async () => {
          throw new Error("not used");
        },
        test: async () => ({
          ok: true,
          homeserverUrl: "https://matrix.example.org",
          checks: [],
        }),
      },
      execRunner: {
        run: async (input): Promise<ExecResult> => {
          const serialized = [input.command, ...(input.args ?? [])].join(" ");
          if (serialized.startsWith("systemctl is-active")) {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "active",
              stderr: "",
            };
          }
          if (serialized === "openclaw health") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "ok",
              stderr: "",
            };
          }
          if (serialized === "openclaw agents list") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "node-operator",
              stderr: "",
            };
          }
          if (serialized === "openclaw cron list") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "",
              stderr: "",
            };
          }
          return {
            command: serialized,
            exitCode: 0,
            stdout: "",
            stderr: "",
          };
        },
      },
    });

    try {
      const status = await service.getStatus();
      expect(status.openclaw.agentPresent).toBe(true);
      expect(status.openclaw.cronPresent).toBe(true);
      expect(status.openclaw.health).toBe("healthy");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("falls back to JSON list output when plain OpenClaw list output omits the full id", async () => {
    const paths: SovereignPaths = {
      configPath: "/tmp/sovereign-node.json5",
      secretsDir: "/tmp/sovereign-secrets",
      stateDir: "/tmp/sovereign-state",
      logsDir: "/tmp/sovereign-logs",
      installJobsDir: "/tmp/sovereign-install-jobs",
      openclawServiceHome: "/tmp/sovereign-openclaw-home",
      provenancePath: "/tmp/sovereign-install-provenance.json",
      backupsDir: "/tmp/sovereign-backups",
    };

    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "2026.3.13",
        }),
        ensureInstalled: async (opts) => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: opts.version,
          installMethod: "install_sh",
        }),
      },
      openclawGatewayServiceManager: {
        install: async () => {},
        start: async () => {},
        restart: async () => {},
      },
      managedAgentRegistrar: {
        register: async () => {
          throw new Error("not used");
        },
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async () => ({
          ok: true,
          host: "imap.example.org",
          port: 993,
          tls: true,
          auth: "ok",
          mailbox: "INBOX",
          capabilities: ["IMAP4rev1"],
        }),
      },
      matrixProvisioner: {
        provision: async () => {
          throw new Error("not used");
        },
        bootstrapAccounts: async () => {
          throw new Error("not used");
        },
        bootstrapRoom: async () => {
          throw new Error("not used");
        },
        test: async () => ({
          ok: true,
          homeserverUrl: "https://matrix.example.org",
          checks: [],
        }),
      },
      execRunner: {
        run: async ({ command, args }) => {
          const serialized = [command, ...(args ?? [])].join(" ");
          if (serialized === "openclaw agents list") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "Agents:\n- mail-se...",
              stderr: "",
            };
          }
          if (serialized === "openclaw agents list --json") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: JSON.stringify([{ id: "mail-sentinel" }]),
              stderr: "",
            };
          }
          throw new Error(`unexpected command: ${serialized}`);
        },
      },
    });

    const inspect = service as unknown as {
      inspectOpenClawListContains(
        baseArgs: string[],
        expectedId: string,
      ): Promise<{
        present: boolean;
        verified: boolean;
      }>;
    };

    await expect(
      inspect.inspectOpenClawListContains(["agents", "list"], "mail-sentinel"),
    ).resolves.toEqual({
      present: true,
      verified: true,
    });
  });

  it("issues a one-time Matrix onboarding code and writes hashed onboarding state", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };
    await writeRuntimeArtifacts(paths);

    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => null,
        ensureInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
          installMethod: "install_sh",
        }),
      },
      openclawGatewayServiceManager: {
        install: async () => {},
        start: async () => {},
        restart: async () => {},
      },
      managedAgentRegistrar: {
        register: async () => ({
          agentId: "mail-sentinel",
          cronJobId: "mail-sentinel-poll",
          workspaceDir: join(paths.stateDir, "mail-sentinel", "workspace"),
          agentCommand: "openclaw agents upsert",
          cronCommand: "openclaw cron add",
        }),
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async (req) => ({
          ok: true,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "ok",
          mailbox: req.imap.mailbox ?? "INBOX",
        }),
      },
      matrixProvisioner: {
        provision: async () => {
          throw new Error("not used");
        },
        bootstrapAccounts: async () => {
          throw new Error("not used");
        },
        bootstrapRoom: async () => {
          throw new Error("not used");
        },
        test: async () => ({
          ok: true,
          homeserverUrl: "https://matrix.example.org",
          checks: [],
        }),
      },
    });

    try {
      const issued = await service.issueMatrixOnboardingCode();
      expect(issued.code).toMatch(/^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){2}$/);
      expect(issued.username).toBe("@operator:matrix.example.org");
      expect(issued.onboardingUrl).toBe("https://matrix.example.org/onboard");
      expect(issued.onboardingLink).toBe(`https://matrix.example.org/onboard#code=${issued.code}`);

      const onboardingStateRaw = await readFile(
        join(paths.stateDir, "bundled-matrix", "matrix-example-org", "onboarding", "state.json"),
        "utf8",
      );
      const onboardingState = JSON.parse(onboardingStateRaw) as {
        codeHash?: string;
        codeSalt?: string;
        username?: string;
        homeserverUrl?: string;
        passwordSecretRef?: string;
      };
      expect(onboardingState.codeHash).toBeTruthy();
      expect(onboardingState.codeSalt).toBeTruthy();
      expect(onboardingStateRaw).not.toContain(issued.code);
      expect(onboardingState.username).toBe("@operator:matrix.example.org");
      expect(onboardingState.homeserverUrl).toBe("https://matrix.example.org");
      expect(onboardingState.passwordSecretRef).toBe(
        `file:${join(paths.secretsDir, "matrix-operator.password")}`,
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("invites a local Matrix user with a shareable onboarding link", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };
    await writeRuntimeArtifacts(paths);
    const priorOpenrouterApiKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const fetchCalls: string[] = [];

    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => null,
        ensureInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
          installMethod: "install_sh",
        }),
      },
      openclawGatewayServiceManager: {
        install: async () => {},
        start: async () => {},
        restart: async () => {},
      },
      managedAgentRegistrar: {
        register: async () => ({
          agentId: "mail-sentinel",
          cronJobId: "mail-sentinel-poll",
          workspaceDir: join(paths.stateDir, "mail-sentinel", "workspace"),
          agentCommand: "openclaw agents upsert",
          cronCommand: "openclaw cron add",
        }),
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async (req) => ({
          ok: true,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "ok",
          mailbox: req.imap.mailbox ?? "INBOX",
        }),
      },
      matrixProvisioner: {
        provision: async () => {
          throw new Error("not used");
        },
        bootstrapAccounts: async () => {
          throw new Error("not used");
        },
        bootstrapRoom: async () => {
          throw new Error("not used");
        },
        test: async () => ({
          ok: true,
          homeserverUrl: "https://matrix.example.org",
          checks: [],
        }),
      },
      fetchImpl: async (input, init) => {
        const url = String(input);
        fetchCalls.push(url);
        if (url.includes("/_synapse/admin/v2/users/")) {
          return new Response(
            JSON.stringify({
              name: "@satoshi:matrix.example.org",
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        if (url.endsWith("/_matrix/client/v3/login")) {
          return new Response(
            JSON.stringify({
              user_id: "@satoshi:matrix.example.org",
              access_token: "satoshi-access-token",
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        if (url.endsWith("/invite") || url.endsWith("/join")) {
          return new Response("{}", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            method: init?.method ?? "GET",
            url,
          }),
          {
            status: 404,
            headers: { "Content-Type": "application/json" },
          },
        );
      },
    });

    try {
      const issued = await service.inviteMatrixUser({ username: "Satoshi" });
      expect(issued.username).toBe("@satoshi:matrix.example.org");
      expect(issued.onboardingUrl).toBe("https://matrix.example.org/onboard");
      expect(issued.onboardingLink).toBe(`https://matrix.example.org/onboard#code=${issued.code}`);

      const onboardingStateRaw = await readFile(
        join(paths.stateDir, "bundled-matrix", "matrix-example-org", "onboarding", "state.json"),
        "utf8",
      );
      const onboardingState = JSON.parse(onboardingStateRaw) as {
        username?: string;
        passwordSecretRef?: string;
      };
      expect(onboardingState.username).toBe("@satoshi:matrix.example.org");
      expect(onboardingState.passwordSecretRef).toBe(
        `file:${join(paths.secretsDir, "matrix-user-satoshi.password")}`,
      );
      expect(onboardingStateRaw).not.toContain(issued.code);
      expect(fetchCalls.some((url) => url.includes("/_synapse/admin/v2/users/"))).toBe(true);
      expect(fetchCalls.some((url) => url.endsWith("/_matrix/client/v3/login"))).toBe(true);
      expect(fetchCalls.some((url) => url.endsWith("/invite"))).toBe(true);
      expect(fetchCalls.some((url) => url.endsWith("/join"))).toBe(true);
    } finally {
      if (priorOpenrouterApiKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = priorOpenrouterApiKey;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("refreshes Matrix DM and room allowlists for all managed bots when inviting a local user", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };
    await writeDedicatedBotRuntimeArtifacts(paths);
    const priorOpenrouterApiKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    let gatewayRestartCalls = 0;

    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => null,
        ensureInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
          installMethod: "install_sh",
        }),
      },
      openclawGatewayServiceManager: {
        install: async () => {},
        start: async () => {},
        restart: async () => {
          gatewayRestartCalls += 1;
        },
      },
      managedAgentRegistrar: {
        register: async () => ({
          agentId: "mail-sentinel",
          cronJobId: "mail-sentinel-poll",
          workspaceDir: join(paths.stateDir, "mail-sentinel", "workspace"),
          agentCommand: "openclaw agents upsert",
          cronCommand: "openclaw cron add",
        }),
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async (req) => ({
          ok: true,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "ok",
          mailbox: req.imap.mailbox ?? "INBOX",
        }),
      },
      matrixProvisioner: {
        provision: async () => {
          throw new Error("not used");
        },
        bootstrapAccounts: async () => {
          throw new Error("not used");
        },
        bootstrapRoom: async () => {
          throw new Error("not used");
        },
        test: async () => ({
          ok: true,
          homeserverUrl: "https://matrix.example.org",
          checks: [],
        }),
      },
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (url.includes("/_synapse/admin/v2/users/")) {
          return new Response(
            JSON.stringify({
              name: "@satoshi:matrix.example.org",
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        if (url.endsWith("/_matrix/client/v3/login")) {
          return new Response(
            JSON.stringify({
              user_id: "@satoshi:matrix.example.org",
              access_token: "satoshi-access-token",
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        if (url.endsWith("/invite") || url.endsWith("/join")) {
          return new Response("{}", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            method: init?.method ?? "GET",
            url,
          }),
          {
            status: 404,
            headers: { "Content-Type": "application/json" },
          },
        );
      },
    });

    try {
      const issued = await service.inviteMatrixUser({ username: "satoshi" });
      expect(issued.username).toBe("@satoshi:matrix.example.org");
      expect(gatewayRestartCalls).toBe(1);

      const openclawConfigRaw = await readFile(
        join(paths.openclawServiceHome, ".openclaw", "openclaw.json5"),
        "utf8",
      );
      const openclawConfig = JSON.parse(openclawConfigRaw) as {
        bindings?: Array<{
          agentId?: string;
          match?: {
            channel?: string;
            accountId?: string;
          };
        }>;
        channels?: {
          matrix?: {
            defaultAccount?: string;
            dm?: { allowFrom?: string[] };
            groupAllowFrom?: string[];
            groups?: Record<string, { users?: string[] }>;
            accounts?: Record<
              string,
              {
                dm?: { allowFrom?: string[] };
                groupAllowFrom?: string[];
                groups?: Record<string, { users?: string[] }>;
              }
            >;
          };
        };
      };

      expect(openclawConfig.channels?.matrix?.defaultAccount).toBe("bitcoin-skill-match");
      expect(openclawConfig.bindings).toEqual([
        {
          agentId: "bitcoin-skill-match",
          match: {
            channel: "matrix",
            accountId: "bitcoin-skill-match",
          },
        },
        {
          agentId: "bitcoin-skill-match",
          match: {
            channel: "matrix",
          },
        },
        {
          agentId: "node-operator",
          match: {
            channel: "matrix",
            accountId: "node-operator",
          },
        },
      ]);
      expect(openclawConfig.channels?.matrix?.dm?.allowFrom).toEqual([
        "@operator:matrix.example.org",
        "@satoshi:matrix.example.org",
      ]);
      expect(openclawConfig.channels?.matrix?.groupAllowFrom).toEqual([
        "@operator:matrix.example.org",
        "@satoshi:matrix.example.org",
      ]);
      expect(
        openclawConfig.channels?.matrix?.groups?.["!alerts:matrix.example.org"]?.users,
      ).toEqual(["@operator:matrix.example.org", "@satoshi:matrix.example.org"]);
      expect(openclawConfig.channels?.matrix?.groups?.["*"]?.users).toEqual([
        "@operator:matrix.example.org",
        "@satoshi:matrix.example.org",
      ]);
      expect(
        openclawConfig.channels?.matrix?.accounts?.["bitcoin-skill-match"]?.dm?.allowFrom,
      ).toEqual(["@operator:matrix.example.org", "@satoshi:matrix.example.org"]);
      expect(
        openclawConfig.channels?.matrix?.accounts?.["bitcoin-skill-match"]?.groupAllowFrom,
      ).toEqual(["@operator:matrix.example.org", "@satoshi:matrix.example.org"]);
      expect(
        openclawConfig.channels?.matrix?.accounts?.["bitcoin-skill-match"]?.groups?.[
          "!alerts:matrix.example.org"
        ]?.users,
      ).toEqual(["@operator:matrix.example.org", "@satoshi:matrix.example.org"]);
      expect(
        openclawConfig.channels?.matrix?.accounts?.["bitcoin-skill-match"]?.groups?.["*"]?.users,
      ).toEqual(["@operator:matrix.example.org", "@satoshi:matrix.example.org"]);
      expect(openclawConfig.channels?.matrix?.accounts?.["node-operator"]?.dm?.allowFrom).toEqual([
        "@operator:matrix.example.org",
        "@satoshi:matrix.example.org",
      ]);
      expect(openclawConfig.channels?.matrix?.accounts?.["node-operator"]?.groupAllowFrom).toEqual([
        "@operator:matrix.example.org",
        "@satoshi:matrix.example.org",
      ]);
      expect(
        openclawConfig.channels?.matrix?.accounts?.["node-operator"]?.groups?.[
          "!alerts:matrix.example.org"
        ]?.users,
      ).toEqual(["@operator:matrix.example.org", "@satoshi:matrix.example.org"]);
      expect(
        openclawConfig.channels?.matrix?.accounts?.["node-operator"]?.groups?.["*"]?.users,
      ).toEqual(["@operator:matrix.example.org", "@satoshi:matrix.example.org"]);
    } finally {
      if (priorOpenrouterApiKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = priorOpenrouterApiKey;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("deactivates a local Matrix user, removes the managed invite secret, and refreshes bot allowlists", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };
    await writeDedicatedBotRuntimeArtifacts(paths);
    await writeFile(join(paths.secretsDir, "matrix-user-satoshi.password"), "secret\n", "utf8");
    const priorOpenrouterApiKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const fetchCalls: string[] = [];
    let gatewayRestartCalls = 0;

    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => null,
        ensureInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
          installMethod: "install_sh",
        }),
      },
      openclawGatewayServiceManager: {
        install: async () => {},
        start: async () => {},
        restart: async () => {
          gatewayRestartCalls += 1;
        },
      },
      managedAgentRegistrar: {
        register: async () => ({
          agentId: "mail-sentinel",
          cronJobId: "mail-sentinel-poll",
          workspaceDir: join(paths.stateDir, "mail-sentinel", "workspace"),
          agentCommand: "openclaw agents upsert",
          cronCommand: "openclaw cron add",
        }),
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async (req) => ({
          ok: true,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "ok",
          mailbox: req.imap.mailbox ?? "INBOX",
        }),
      },
      matrixProvisioner: {
        provision: async () => {
          throw new Error("not used");
        },
        bootstrapAccounts: async () => {
          throw new Error("not used");
        },
        bootstrapRoom: async () => {
          throw new Error("not used");
        },
        test: async () => ({
          ok: true,
          homeserverUrl: "https://matrix.example.org",
          checks: [],
        }),
      },
      fetchImpl: async (input) => {
        const url = String(input);
        fetchCalls.push(url);
        if (url.includes("/_synapse/admin/v1/deactivate/")) {
          return new Response(JSON.stringify({ id_server_unbind_result: "no-support" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const removed = await service.removeMatrixUser({ username: "@satoshi:matrix.example.org" });
      expect(removed).toEqual({
        localpart: "satoshi",
        userId: "@satoshi:matrix.example.org",
        removed: true,
      });
      expect(gatewayRestartCalls).toBe(1);
      await expect(
        stat(join(paths.secretsDir, "matrix-user-satoshi.password")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(fetchCalls.some((url) => url.includes("/_synapse/admin/v1/deactivate/"))).toBe(true);

      const openclawConfigRaw = await readFile(
        join(paths.openclawServiceHome, ".openclaw", "openclaw.json5"),
        "utf8",
      );
      const openclawConfig = JSON.parse(openclawConfigRaw) as {
        channels?: {
          matrix?: {
            dm?: { allowFrom?: string[] };
            groupAllowFrom?: string[];
            groups?: Record<string, { users?: string[] }>;
            accounts?: Record<
              string,
              {
                dm?: { allowFrom?: string[] };
                groupAllowFrom?: string[];
                groups?: Record<string, { users?: string[] }>;
              }
            >;
          };
        };
      };

      expect(openclawConfig.channels?.matrix?.dm?.allowFrom).toEqual([
        "@operator:matrix.example.org",
      ]);
      expect(openclawConfig.channels?.matrix?.groupAllowFrom).toEqual([
        "@operator:matrix.example.org",
      ]);
      expect(
        openclawConfig.channels?.matrix?.groups?.["!alerts:matrix.example.org"]?.users,
      ).toEqual(["@operator:matrix.example.org"]);
      expect(openclawConfig.channels?.matrix?.groups?.["*"]?.users).toEqual([
        "@operator:matrix.example.org",
      ]);
      expect(
        openclawConfig.channels?.matrix?.accounts?.["bitcoin-skill-match"]?.dm?.allowFrom,
      ).toEqual(["@operator:matrix.example.org"]);
      expect(
        openclawConfig.channels?.matrix?.accounts?.["bitcoin-skill-match"]?.groupAllowFrom,
      ).toEqual(["@operator:matrix.example.org"]);
      expect(
        openclawConfig.channels?.matrix?.accounts?.["bitcoin-skill-match"]?.groups?.[
          "!alerts:matrix.example.org"
        ]?.users,
      ).toEqual(["@operator:matrix.example.org"]);
      expect(
        openclawConfig.channels?.matrix?.accounts?.["bitcoin-skill-match"]?.groups?.["*"]?.users,
      ).toEqual(["@operator:matrix.example.org"]);
      expect(openclawConfig.channels?.matrix?.accounts?.["node-operator"]?.dm?.allowFrom).toEqual([
        "@operator:matrix.example.org",
      ]);
      expect(openclawConfig.channels?.matrix?.accounts?.["node-operator"]?.groupAllowFrom).toEqual([
        "@operator:matrix.example.org",
      ]);
      expect(
        openclawConfig.channels?.matrix?.accounts?.["node-operator"]?.groups?.[
          "!alerts:matrix.example.org"
        ]?.users,
      ).toEqual(["@operator:matrix.example.org"]);
      expect(
        openclawConfig.channels?.matrix?.accounts?.["node-operator"]?.groups?.["*"]?.users,
      ).toEqual(["@operator:matrix.example.org"]);
    } finally {
      if (priorOpenrouterApiKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = priorOpenrouterApiKey;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects Matrix onboarding code issuance for local-dev installs without HTTPS onboarding", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };
    await writeRuntimeArtifacts(paths);
    const rawConfig = await readFile(paths.configPath, "utf8");
    const parsedConfig = JSON.parse(rawConfig) as {
      matrix?: {
        publicBaseUrl?: string;
      };
    };
    if (parsedConfig.matrix) {
      parsedConfig.matrix.publicBaseUrl = "http://127.0.0.1:8008";
    }
    await writeFile(paths.configPath, `${JSON.stringify(parsedConfig, null, 2)}\n`, "utf8");

    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => null,
        ensureInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
          installMethod: "install_sh",
        }),
      },
      openclawGatewayServiceManager: {
        install: async () => {},
        start: async () => {},
        restart: async () => {},
      },
      managedAgentRegistrar: {
        register: async () => ({
          agentId: "mail-sentinel",
          cronJobId: "mail-sentinel-poll",
          workspaceDir: join(paths.stateDir, "mail-sentinel", "workspace"),
          agentCommand: "openclaw agents upsert",
          cronCommand: "openclaw cron add",
        }),
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async (req) => ({
          ok: true,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "ok",
          mailbox: req.imap.mailbox ?? "INBOX",
        }),
      },
      matrixProvisioner: {
        provision: async () => {
          throw new Error("not used");
        },
        bootstrapAccounts: async () => {
          throw new Error("not used");
        },
        bootstrapRoom: async () => {
          throw new Error("not used");
        },
        test: async () => ({
          ok: true,
          homeserverUrl: "http://127.0.0.1:8008",
          checks: [],
        }),
      },
    });

    try {
      await expect(service.issueMatrixOnboardingCode()).rejects.toMatchObject({
        code: "MATRIX_ONBOARDING_UNAVAILABLE",
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("reconfigures OpenRouter settings and syncs the saved install request", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };
    await writeRuntimeArtifacts(paths);

    const requestPath = join(dirname(paths.configPath), "install-request.json");
    await writeFile(requestPath, `${JSON.stringify(buildInstallRequest(), null, 2)}\n`, "utf8");

    let gatewayRestartCalls = 0;
    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
        }),
        ensureInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
          installMethod: "install_sh",
        }),
      },
      openclawGatewayServiceManager: {
        install: async () => {},
        start: async () => {},
        restart: async () => {
          gatewayRestartCalls += 1;
        },
      },
      managedAgentRegistrar: {
        register: async () => ({
          agentId: "mail-sentinel",
          cronJobId: "mail-sentinel-poll",
          workspaceDir: join(paths.stateDir, "mail-sentinel", "workspace"),
          agentCommand: "openclaw agents add",
          cronCommand: "openclaw cron add",
        }),
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async (req) => ({
          ok: true,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "ok",
          mailbox: req.imap.mailbox ?? "INBOX",
        }),
      },
      matrixProvisioner: {
        provision: async () => {
          throw new Error("not used");
        },
        bootstrapAccounts: async () => {
          throw new Error("not used");
        },
        bootstrapRoom: async () => {
          throw new Error("not used");
        },
        test: async () => ({
          ok: true,
          homeserverUrl: "https://matrix.example.org",
          checks: [],
        }),
      },
    });

    try {
      const result = await service.reconfigureOpenrouter({
        openrouter: {
          model: "openai/gpt-5",
          apiKey: "sk-or-updated",
        },
      });

      expect(result.target).toBe("openrouter");
      expect(result.changed).toEqual(
        expect.arrayContaining([
          "openrouter.model",
          "openrouter.apiKeySecretRef",
          "request.openrouter.model",
          "request.openrouter.secretRef",
        ]),
      );
      expect(result.restartRequiredServices).toEqual(["openclaw-gateway"]);
      expect(gatewayRestartCalls).toBe(1);

      const updatedConfigRaw = await readFile(paths.configPath, "utf8");
      const updatedConfig = JSON.parse(updatedConfigRaw) as {
        openrouter?: { model?: string; apiKeySecretRef?: string };
      };
      const expectedSecretRef = `file:${join(paths.secretsDir, "openrouter-api-key")}`;
      expect(updatedConfig.openrouter?.model).toBe("openai/gpt-5");
      expect(updatedConfig.openrouter?.apiKeySecretRef).toBe(expectedSecretRef);

      const secretRaw = await readFile(join(paths.secretsDir, "openrouter-api-key"), "utf8");
      expect(secretRaw).toBe("sk-or-updated\n");

      const openclawConfigRaw = await readFile(
        join(paths.openclawServiceHome, ".openclaw", "openclaw.json5"),
        "utf8",
      );
      const openclawConfig = JSON.parse(openclawConfigRaw) as {
        agents?: { defaults?: { model?: string } };
      };
      expect(openclawConfig.agents?.defaults?.model).toBe("openrouter/openai/gpt-5");

      const gatewayEnvRaw = await readFile(join(paths.openclawServiceHome, "gateway.env"), "utf8");
      expect(gatewayEnvRaw).toContain(`HOME=${paths.openclawServiceHome}`);
      expect(gatewayEnvRaw).toContain(`OPENCLAW_HOME=${paths.openclawServiceHome}`);
      expect(gatewayEnvRaw).toContain("OPENROUTER_API_KEY=sk-or-updated");
      expect(gatewayEnvRaw).toContain(`TMPDIR=${join(paths.openclawServiceHome, "tmp")}`);
      expect(gatewayEnvRaw).toContain(`TMP=${join(paths.openclawServiceHome, "tmp")}`);
      expect(gatewayEnvRaw).toContain(`TEMP=${join(paths.openclawServiceHome, "tmp")}`);

      const updatedRequestRaw = await readFile(requestPath, "utf8");
      const updatedRequest = JSON.parse(updatedRequestRaw) as {
        openrouter?: { model?: string; secretRef?: string; apiKey?: string };
      };
      expect(updatedRequest.openrouter?.model).toBe("openai/gpt-5");
      expect(updatedRequest.openrouter?.secretRef).toBe(expectedSecretRef);
      expect(updatedRequest.openrouter?.apiKey).toBeUndefined();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("provisions Matrix identity for created managed agents and exposes matrixUserId", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };
    await writeRuntimeArtifacts(paths);
    const priorOpenrouterApiKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    let gatewayRestartCalls = 0;
    const fetchCalls: string[] = [];
    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
        }),
        ensureInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
          installMethod: "install_sh",
        }),
      },
      openclawGatewayServiceManager: {
        install: async () => {},
        start: async () => {},
        restart: async () => {
          gatewayRestartCalls += 1;
        },
      },
      managedAgentRegistrar: {
        register: async () => ({
          agentId: "mail-sentinel",
          cronJobId: "mail-sentinel-poll",
          workspaceDir: join(paths.stateDir, "mail-sentinel", "workspace"),
          agentCommand: "openclaw agents upsert",
          cronCommand: "openclaw cron add",
        }),
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async (req) => ({
          ok: true,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "ok",
          mailbox: req.imap.mailbox ?? "INBOX",
        }),
      },
      matrixProvisioner: {
        provision: async () => {
          throw new Error("not used");
        },
        bootstrapAccounts: async () => {
          throw new Error("not used");
        },
        bootstrapRoom: async () => {
          throw new Error("not used");
        },
        test: async () => ({
          ok: true,
          homeserverUrl: "https://matrix.example.org",
          checks: [],
        }),
      },
      fetchImpl: async (url, init) => {
        fetchCalls.push(url);
        if (url.includes("/_synapse/admin/v2/users/")) {
          const encoded = url.split("/_synapse/admin/v2/users/")[1] ?? "";
          const decoded = decodeURIComponent(encoded);
          return new Response(JSON.stringify({ name: decoded }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.endsWith("/_matrix/client/v3/login")) {
          const body =
            typeof init?.body === "string"
              ? (JSON.parse(init.body) as { identifier?: { user?: string } })
              : {};
          const localpart = body.identifier?.user ?? "unknown";
          return new Response(
            JSON.stringify({
              user_id: `@${localpart}:matrix.example.org`,
              access_token: `${localpart}-token`,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        if (url.includes("/_matrix/client/v3/rooms/") && url.endsWith("/invite")) {
          return new Response("{}", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.includes("/_matrix/client/v3/rooms/") && url.endsWith("/join")) {
          return new Response("{}", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const created = await service.createManagedAgent({ id: "ops-helper" });
      expect(created.changed).toBe(true);
      expect(created.restartRequiredServices).toEqual(["openclaw-gateway"]);
      expect(created.agent.id).toBe("ops-helper");
      expect(created.agent.workspace).toBe(join(paths.stateDir, "ops-helper", "workspace"));
      expect(created.agent.matrixUserId).toBe("@ops-helper:matrix.example.org");
      expect(
        (await stat(join(paths.stateDir, "ops-helper", "workspace", ".openclaw"))).isDirectory(),
      ).toBe(true);
      expect(gatewayRestartCalls).toBe(1);

      const listed = await service.listManagedAgents();
      const listedAgent = listed.agents.find((agent) => agent.id === "ops-helper");
      expect(listedAgent?.matrixUserId).toBe("@ops-helper:matrix.example.org");

      const configRaw = await readFile(paths.configPath, "utf8");
      const config = JSON.parse(configRaw) as {
        openclawProfile?: {
          agents?: Array<{
            id?: string;
            matrix?: { userId?: string; localpart?: string };
          }>;
        };
      };
      const persisted = config.openclawProfile?.agents?.find((agent) => agent.id === "ops-helper");
      expect(persisted?.matrix?.localpart).toBe("ops-helper");
      expect(persisted?.matrix?.userId).toBe("@ops-helper:matrix.example.org");

      const updated = await service.updateManagedAgent({ id: "ops-helper" });
      expect(updated.changed).toBe(false);
      expect(updated.restartRequiredServices).toEqual([]);
      expect(gatewayRestartCalls).toBe(1);

      const removed = await service.deleteManagedAgent({ id: "ops-helper" });
      expect(removed.deleted).toBe(true);
      expect(removed.restartRequiredServices).toEqual(["openclaw-gateway"]);
      expect(gatewayRestartCalls).toBe(2);

      const listedAfterDelete = await service.listManagedAgents();
      expect(listedAfterDelete.agents.some((agent) => agent.id === "ops-helper")).toBe(false);

      expect(fetchCalls.some((url) => url.includes("/_synapse/admin/v2/users/"))).toBe(true);
      expect(fetchCalls.some((url) => url.endsWith("/_matrix/client/v3/login"))).toBe(true);
      expect(fetchCalls.some((url) => url.endsWith("/invite"))).toBe(true);
      expect(fetchCalls.some((url) => url.endsWith("/join"))).toBe(true);
    } finally {
      if (priorOpenrouterApiKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = priorOpenrouterApiKey;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("lists available bot packages and instantiates node-operator from the bot repo", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };
    await writeRuntimeArtifacts(paths);
    const priorOpenrouterApiKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    let gatewayRestartCalls = 0;
    const fetchCalls: string[] = [];
    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
        }),
        ensureInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
          installMethod: "install_sh",
        }),
      },
      openclawGatewayServiceManager: {
        install: async () => {},
        start: async () => {},
        restart: async () => {
          gatewayRestartCalls += 1;
        },
      },
      managedAgentRegistrar: {
        register: async () => ({
          agentId: "mail-sentinel",
          cronJobId: "mail-sentinel-poll",
          workspaceDir: join(paths.stateDir, "mail-sentinel", "workspace"),
          agentCommand: "openclaw agents upsert",
          cronCommand: "openclaw cron add",
        }),
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async (req) => ({
          ok: true,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "ok",
          mailbox: req.imap.mailbox ?? "INBOX",
        }),
      },
      matrixProvisioner: {
        provision: async () => {
          throw new Error("not used");
        },
        bootstrapAccounts: async () => {
          throw new Error("not used");
        },
        bootstrapRoom: async () => {
          throw new Error("not used");
        },
        test: async () => ({
          ok: true,
          homeserverUrl: "https://matrix.example.org",
          checks: [],
        }),
      },
      fetchImpl: async (url, init) => {
        fetchCalls.push(url);
        if (url.includes("/_synapse/admin/v2/users/")) {
          const encoded = url.split("/_synapse/admin/v2/users/")[1] ?? "";
          const decoded = decodeURIComponent(encoded);
          return new Response(JSON.stringify({ name: decoded }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.endsWith("/_matrix/client/v3/login")) {
          const body =
            typeof init?.body === "string"
              ? (JSON.parse(init.body) as { identifier?: { user?: string } })
              : {};
          const localpart = body.identifier?.user ?? "unknown";
          return new Response(
            JSON.stringify({
              user_id: `@${localpart}:matrix.example.org`,
              access_token: `${localpart}-token`,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        if (url.includes("/_matrix/client/v3/rooms/") && url.endsWith("/invite")) {
          return new Response("{}", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.includes("/_matrix/client/v3/rooms/") && url.endsWith("/join")) {
          return new Response("{}", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const listed = await service.listSovereignBots();
      const listedNodeOperator = listed.bots.find((bot) => bot.id === "node-operator");
      expect(listedNodeOperator).toMatchObject({
        id: "node-operator",
        defaultInstall: false,
        instantiated: false,
      });

      const instantiated = await service.instantiateSovereignBot({ id: "node-operator" });
      expect(instantiated.changed).toBe(true);
      expect(instantiated.restartRequiredServices).toEqual(["openclaw-gateway"]);
      expect(instantiated.bot.id).toBe("node-operator");
      expect(instantiated.bot.instantiated).toBe(true);
      expect(instantiated.agent.id).toBe("node-operator");
      expect(instantiated.agent.workspace).toBe(join(paths.stateDir, "node-operator", "workspace"));
      expect(instantiated.agent.matrixUserId).toBe("@node-operator:matrix.example.org");
      expect(instantiated.agent.toolInstanceIds).toEqual(["node-operator-cli"]);
      expect(
        (await stat(join(paths.stateDir, "node-operator", "workspace", ".openclaw"))).isDirectory(),
      ).toBe(true);
      const toolsDoc = await readFile(
        join(paths.stateDir, "node-operator", "workspace", "TOOLS.md"),
        "utf8",
      );
      expect(toolsDoc).toContain(
        "sovereign-node users invite <username> --ttl-minutes <minutes> --json",
      );
      expect(toolsDoc).toContain("sovereign-node users remove <username> --json");
      const agentsDoc = await readFile(
        join(paths.stateDir, "node-operator", "workspace", "AGENTS.md"),
        "utf8",
      );
      expect(agentsDoc).toContain("Operator: @operator:matrix.example.org");
      expect(gatewayRestartCalls).toBe(1);

      const configRaw = await readFile(paths.configPath, "utf8");
      const config = JSON.parse(configRaw) as {
        templates?: {
          installed?: Array<{ id?: string; source?: string }>;
        };
        openclawProfile?: {
          agents?: Array<{ id?: string; botId?: string }>;
        };
        sovereignTools?: {
          instances?: Array<{ id?: string; templateRef?: string }>;
        };
      };
      expect(
        config.templates?.installed?.some(
          (entry) => entry.id === "node-operator" && entry.source === "bot-repo",
        ),
      ).toBe(true);
      expect(
        config.openclawProfile?.agents?.some(
          (entry) => entry.id === "node-operator" && entry.botId === "node-operator",
        ),
      ).toBe(true);
      expect(config.sovereignTools?.instances).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "node-operator-cli",
            templateRef: "node-cli-ops@1.0.0",
          }),
        ]),
      );
      const toolsMd = await readFile(
        join(paths.stateDir, "node-operator", "workspace", "TOOLS.md"),
        "utf8",
      );
      expect(toolsMd).toContain("sovereign-node users invite <username> --json");
      expect(toolsMd).toContain("sovereign-node users remove <username> --json");
      expect(toolsMd).toContain("sovereign-node onboarding issue --ttl-minutes <minutes> --json");

      expect(fetchCalls.some((url) => url.includes("/_synapse/admin/v2/users/"))).toBe(true);
      expect(fetchCalls.some((url) => url.endsWith("/_matrix/client/v3/login"))).toBe(true);
      expect(fetchCalls.some((url) => url.endsWith("/invite"))).toBe(true);
      expect(fetchCalls.some((url) => url.endsWith("/join"))).toBe(true);
    } finally {
      if (priorOpenrouterApiKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = priorOpenrouterApiKey;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("deduplicates shared service-account Matrix bindings for managed repo bots", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };
    const botPackage = buildTestLoadedBotPackage({
      id: "bitcoin-skill-match",
      displayName: "Bitcoin Skill Match",
      description: "Matrix-based community matchmaker for a local Bitcoin community.",
      matrixMode: "service-account",
      helloMessage: "Hello from Bitcoin Skill Match.",
    });
    const priorOpenrouterApiKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    const commandCalls: string[] = [];
    let sentMessageBody = "";
    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
        }),
        ensureInstalled: async (opts) => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: opts.version,
          installMethod: "install_sh",
        }),
      },
      openclawGatewayServiceManager: {
        install: async () => {},
        start: async () => {},
        restart: async () => {},
      },
      managedAgentRegistrar: {
        register: async () => ({
          agentId: "bitcoin-skill-match",
          workspaceDir: join(paths.stateDir, "bitcoin-skill-match", "workspace"),
          agentCommand: "openclaw agents upsert --id bitcoin-skill-match",
        }),
      },
      botCatalog: {
        listPackages: async () => [botPackage],
        getPackage: async (id) => {
          if (id !== "bitcoin-skill-match") {
            throw new Error(`unexpected bot package lookup: ${id}`);
          }
          return botPackage;
        },
        getDefaultSelectedIds: async () => [],
        findPackageByTemplateRef: async (ref) =>
          ref === botPackage.templateRef ? botPackage : null,
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async (req) => ({
          ok: true,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "ok",
          mailbox: req.imap.mailbox ?? "INBOX",
        }),
      },
      matrixProvisioner: {
        provision: async (req) => ({
          projectDir: join(tempRoot, "matrix"),
          composeFilePath: join(tempRoot, "matrix", "compose.yaml"),
          accessMode: "direct",
          homeserverDomain: req.matrix.homeserverDomain,
          publicBaseUrl: req.matrix.publicBaseUrl,
          adminBaseUrl: "http://127.0.0.1:8008",
          federationEnabled: req.matrix.federationEnabled ?? false,
          tlsMode: "local-dev",
        }),
        bootstrapAccounts: async () => ({
          operator: {
            localpart: "operator",
            userId: "@operator:matrix.example.org",
            passwordSecretRef: "file:/tmp/operator.password",
            accessToken: "operator-token",
          },
          bot: {
            localpart: "bitcoin-skill-match",
            userId: "@bitcoin-skill-match:matrix.example.org",
            passwordSecretRef: "file:/tmp/bitcoin-skill-match.password",
            accessToken: "bot-token",
          },
        }),
        bootstrapRoom: async () => ({
          roomId: "!alerts:matrix.example.org",
          roomName: "Sovereign Alerts",
        }),
        test: async (req) => ({
          ok: true,
          homeserverUrl: req.publicBaseUrl,
          checks: [],
        }),
      },
      execRunner: {
        run: async (input): Promise<ExecResult> => {
          const serialized = [input.command, ...(input.args ?? [])].join(" ");
          commandCalls.push(serialized);

          if (serialized === "openclaw health") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "ok",
              stderr: "",
            };
          }
          if (serialized === "openclaw gateway status") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "Service: systemd\nState: running",
              stderr: "",
            };
          }
          if (serialized === "openclaw agents list") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "bitcoin-skill-match",
              stderr: "",
            };
          }
          if (serialized === "openclaw cron list") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "",
              stderr: "",
            };
          }
          if (serialized === "openclaw plugins enable matrix") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "enabled",
              stderr: "",
            };
          }
          if (serialized.startsWith("openclaw agents ")) {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "ok",
              stderr: "",
            };
          }
          return {
            command: serialized,
            exitCode: 1,
            stdout: "",
            stderr: "unexpected command",
          };
        },
      },
      fetchImpl: async (url, init) => {
        if (url.includes("/joined_members")) {
          return new Response(JSON.stringify({ joined: {} }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.includes("/send/m.room.message/")) {
          sentMessageBody = typeof init?.body === "string" ? init.body : "";
          return new Response(JSON.stringify({ event_id: "$evt1" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const req = buildInstallRequest();
      req.bots = {
        selected: ["bitcoin-skill-match"],
      };

      const started = await service.startInstall(req);
      expect(started.job.state).toBe("succeeded");

      const openclawConfigRaw = await readFile(
        join(paths.openclawServiceHome, ".openclaw", "openclaw.json5"),
        "utf8",
      );
      const openclawConfig = JSON.parse(openclawConfigRaw) as {
        channels?: {
          matrix?: {
            accounts?: Record<string, { userId?: string }>;
          };
        };
      };
      expect(Object.keys(openclawConfig.channels?.matrix?.accounts ?? {}).sort()).toEqual([
        "default",
      ]);
      expect(openclawConfig.channels?.matrix?.accounts?.default?.userId).toBe(
        "@bitcoin-skill-match:matrix.example.org",
      );
      expect(commandCalls).toContain(
        "openclaw agents bind --agent bitcoin-skill-match --bind matrix",
      );
      expect(commandCalls).not.toContain(
        "openclaw agents bind --agent bitcoin-skill-match --bind matrix:bitcoin-skill-match",
      );
      expect(commandCalls).not.toContain(
        "openclaw agents bind --agent bitcoin-skill-match --bind matrix:default",
      );
      expect(
        (
          await stat(join(paths.stateDir, "bitcoin-skill-match", "workspace", ".openclaw"))
        ).isDirectory(),
      ).toBe(true);
      const freshSessionsDir = join(
        paths.openclawServiceHome,
        ".openclaw",
        ".openclaw",
        "agents",
        "bitcoin-skill-match",
        "sessions",
      );
      expect((await stat(freshSessionsDir)).isDirectory()).toBe(true);
      const freshSessionsEntries = await readdir(dirname(freshSessionsDir));
      expect(freshSessionsEntries).toContain("sessions");
      expect(freshSessionsEntries.some((e) => e.startsWith("sessions.reset."))).toBe(false);
      expect(sentMessageBody).toContain("Hello from Bitcoin Skill Match");
    } finally {
      if (priorOpenrouterApiKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = priorOpenrouterApiKey;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("uses a dedicated repo bot as the primary Matrix account and narrows room auto-replies per bot", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };
    const priorOpenrouterApiKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    let bootstrapBotLocalpart = "";
    const commandCalls: string[] = [];
    const sentBodies: string[] = [];
    const joinedMemberAuthorizations: string[] = [];
    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
        }),
        ensureInstalled: async (opts) => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: opts.version,
          installMethod: "install_sh",
        }),
      },
      openclawGatewayServiceManager: {
        install: async () => {},
        start: async () => {},
        restart: async () => {},
      },
      managedAgentRegistrar: {
        register: async (input) => ({
          agentId: input.agentId,
          workspaceDir: input.workspaceDir,
          agentCommand: `openclaw agents upsert --id ${input.agentId}`,
          ...(input.cron === undefined ? {} : { cronJobId: input.cron.id }),
          ...(input.cron === undefined
            ? {}
            : { cronCommand: `openclaw cron add --name ${input.cron.id}` }),
        }),
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async (req) => ({
          ok: true,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "ok",
          mailbox: req.imap.mailbox ?? "INBOX",
        }),
      },
      matrixProvisioner: {
        provision: async (req) => ({
          projectDir: join(tempRoot, "matrix"),
          composeFilePath: join(tempRoot, "matrix", "compose.yaml"),
          accessMode: "direct",
          homeserverDomain: req.matrix.homeserverDomain,
          publicBaseUrl: req.matrix.publicBaseUrl,
          adminBaseUrl: "http://127.0.0.1:8008",
          federationEnabled: req.matrix.federationEnabled ?? false,
          tlsMode: "local-dev",
        }),
        bootstrapAccounts: async (_req, _provision, options) => {
          bootstrapBotLocalpart = options?.botLocalpart ?? "service-bot";
          return {
            operator: {
              localpart: "operator",
              userId: "@operator:matrix.example.org",
              passwordSecretRef: "file:/tmp/operator.password",
              accessToken: "operator-token",
            },
            bot: {
              localpart: bootstrapBotLocalpart,
              userId: `@${bootstrapBotLocalpart}:matrix.example.org`,
              passwordSecretRef: `file:/tmp/${bootstrapBotLocalpart}.password`,
              accessToken: `${bootstrapBotLocalpart}-bootstrap-token`,
            },
          };
        },
        bootstrapRoom: async () => ({
          roomId: "!alerts:matrix.example.org",
          roomName: "Sovereign Alerts",
        }),
        test: async (req) => ({
          ok: true,
          homeserverUrl: req.publicBaseUrl,
          checks: [],
        }),
      },
      execRunner: {
        run: async (input): Promise<ExecResult> => {
          const serialized = [input.command, ...(input.args ?? [])].join(" ");
          commandCalls.push(serialized);

          if (serialized === "openclaw health") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "ok",
              stderr: "",
            };
          }
          if (serialized === "openclaw gateway status") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "Service: systemd\nState: running",
              stderr: "",
            };
          }
          if (serialized === "openclaw agents list") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "bitcoin-skill-match\nnode-operator",
              stderr: "",
            };
          }
          if (serialized === "openclaw cron list") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "",
              stderr: "",
            };
          }
          if (serialized.startsWith("openclaw ")) {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "ok",
              stderr: "",
            };
          }
          return {
            command: serialized,
            exitCode: 1,
            stdout: "",
            stderr: "unexpected command",
          };
        },
      },
      fetchImpl: async (url, init) => {
        const provisionResponse = buildManagedAgentMatrixProvisionResponse(url, init);
        if (provisionResponse !== null) {
          return provisionResponse;
        }
        if (url.includes("/joined_members")) {
          const authorization = new Headers(init?.headers).get("Authorization") ?? "";
          joinedMemberAuthorizations.push(authorization);
          return new Response(JSON.stringify({ joined: {} }), {
            status: authorization === "Bearer bitcoin-skill-match-token" ? 200 : 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.includes("/send/m.room.message/")) {
          sentBodies.push(typeof init?.body === "string" ? init.body : "");
          return new Response(JSON.stringify({ event_id: "$evt1" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const req = buildInstallRequest();
      req.bots = {
        selected: ["bitcoin-skill-match", "node-operator"],
      };
      const nodeOperatorSessionsDir = join(
        paths.openclawServiceHome,
        ".openclaw",
        ".openclaw",
        "agents",
        "node-operator",
        "sessions",
      );
      await mkdir(nodeOperatorSessionsDir, { recursive: true });
      await writeFile(
        join(nodeOperatorSessionsDir, "legacy-session.jsonl"),
        '{"legacy":true}\n',
        "utf8",
      );

      const started = await service.startInstall(req);
      expect(started.job.state).toBe("succeeded");
      expect(bootstrapBotLocalpart).toBe("bitcoin-skill-match");

      const configRaw = await readFile(paths.configPath, "utf8");
      expect(configRaw).not.toContain("@service-bot:");
      const config = JSON.parse(configRaw) as {
        matrix?: {
          bot?: {
            localpart?: string;
            userId?: string;
            passwordSecretRef?: string;
            accessTokenSecretRef?: string;
          };
        };
      };
      expect(config.matrix?.bot?.localpart).toBe("bitcoin-skill-match");
      expect(config.matrix?.bot?.userId).toBe("@bitcoin-skill-match:matrix.example.org");
      expect(config.matrix?.bot?.passwordSecretRef).toBe(
        `file:${join(paths.secretsDir, "matrix-agent-bitcoin-skill-match-password")}`,
      );
      expect(config.matrix?.bot?.accessTokenSecretRef).toBe(
        `file:${managedAgentAccessTokenPath(paths, "bitcoin-skill-match")}`,
      );
      expect(commandCalls).toContain(
        "openclaw agents bind --agent bitcoin-skill-match --bind matrix:bitcoin-skill-match",
      );
      expect(commandCalls).toContain(
        "openclaw agents bind --agent bitcoin-skill-match --bind matrix",
      );
      expect(commandCalls).toContain(
        "openclaw agents bind --agent node-operator --bind matrix:node-operator",
      );
      expect(commandCalls).not.toContain(
        "openclaw agents bind --agent node-operator --bind matrix",
      );
      expect(joinedMemberAuthorizations).toContain("Bearer bitcoin-skill-match-token");
      expect(joinedMemberAuthorizations).not.toContain(
        "Bearer bitcoin-skill-match-bootstrap-token",
      );

      const openclawConfigRaw = await readFile(
        join(paths.openclawServiceHome, ".openclaw", "openclaw.json5"),
        "utf8",
      );
      expect(openclawConfigRaw).not.toContain("@service-bot:");
      const openclawConfig = JSON.parse(openclawConfigRaw) as {
        agents?: {
          list?: Array<{ id?: string; default?: boolean }>;
        };
        bindings?: Array<{
          agentId?: string;
          match?: {
            channel?: string;
            accountId?: string;
          };
        }>;
        channels?: {
          matrix?: {
            threadReplies?: string;
            userId?: string;
            defaultAccount?: string;
            accounts?: Record<
              string,
              {
                userId?: string;
                groupPolicy?: string;
                groupAllowFrom?: string[];
                dm?: { enabled?: boolean; policy?: string; allowFrom?: string[] };
                groups?: Record<string, { autoReply?: boolean; requireMention?: boolean }>;
              }
            >;
          };
        };
      };
      expect(openclawConfig.channels?.matrix?.userId).toBeUndefined();
      expect(openclawConfig.channels?.matrix?.threadReplies).toBe("always");
      expect(openclawConfig.channels?.matrix?.defaultAccount).toBe("bitcoin-skill-match");
      expect(openclawConfig.bindings).toEqual([
        {
          agentId: "bitcoin-skill-match",
          match: {
            channel: "matrix",
            accountId: "bitcoin-skill-match",
          },
        },
        {
          agentId: "bitcoin-skill-match",
          match: {
            channel: "matrix",
          },
        },
        {
          agentId: "node-operator",
          match: {
            channel: "matrix",
            accountId: "node-operator",
          },
        },
      ]);
      expect(openclawConfig.agents?.list).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "node-operator",
            default: true,
          }),
        ]),
      );
      expect(
        openclawConfig.agents?.list?.find((entry) => entry.id === "bitcoin-skill-match")?.default,
      ).not.toBe(true);
      expect(Object.keys(openclawConfig.channels?.matrix?.accounts ?? {}).sort()).toEqual([
        "bitcoin-skill-match",
        "node-operator",
      ]);
      expect(openclawConfig.channels?.matrix?.accounts?.["bitcoin-skill-match"]).toEqual(
        expect.objectContaining({
          userId: "@bitcoin-skill-match:matrix.example.org",
          dm: {
            enabled: true,
            policy: "allowlist",
            allowFrom: ["@operator:matrix.example.org"],
          },
          groupPolicy: "allowlist",
          groupAllowFrom: ["@operator:matrix.example.org"],
        }),
      );
      expect(
        openclawConfig.channels?.matrix?.accounts?.["bitcoin-skill-match"]?.groups?.[
          "!alerts:matrix.example.org"
        ],
      ).toEqual(
        expect.objectContaining({
          autoReply: true,
          requireMention: false,
        }),
      );
      expect(
        openclawConfig.channels?.matrix?.accounts?.["bitcoin-skill-match"]?.groups?.["*"],
      ).toEqual(
        expect.objectContaining({
          autoReply: true,
          requireMention: false,
        }),
      );
      expect(openclawConfig.channels?.matrix?.accounts?.["node-operator"]).toEqual(
        expect.objectContaining({
          userId: "@node-operator:matrix.example.org",
          dm: {
            enabled: true,
            policy: "allowlist",
            allowFrom: ["@operator:matrix.example.org"],
          },
          groupPolicy: "allowlist",
          groupAllowFrom: ["@operator:matrix.example.org"],
        }),
      );
      expect(
        openclawConfig.channels?.matrix?.accounts?.["node-operator"]?.groups?.[
          "!alerts:matrix.example.org"
        ],
      ).toEqual(
        expect.objectContaining({
          autoReply: false,
          requireMention: true,
        }),
      );
      expect(openclawConfig.channels?.matrix?.accounts?.["node-operator"]?.groups?.["*"]).toEqual(
        expect.objectContaining({
          autoReply: false,
          requireMention: true,
        }),
      );
      expect((await stat(nodeOperatorSessionsDir)).isDirectory()).toBe(true);
      const nodeOperatorSessionsEntries = await readdir(dirname(nodeOperatorSessionsDir));
      expect(nodeOperatorSessionsEntries).toContain("sessions");
      const archivedNodeOperatorSessionsEntry = nodeOperatorSessionsEntries.find((entry) =>
        entry.startsWith("sessions.reset."),
      );
      expect(archivedNodeOperatorSessionsEntry).toBeDefined();
      expect(
        (
          await stat(
            join(dirname(nodeOperatorSessionsDir), archivedNodeOperatorSessionsEntry ?? "missing"),
          )
        ).isDirectory(),
      ).toBe(true);
      expect(
        await readFile(
          join(
            dirname(nodeOperatorSessionsDir),
            archivedNodeOperatorSessionsEntry ?? "missing",
            "legacy-session.jsonl",
          ),
          "utf8",
        ),
      ).toContain('"legacy":true');
      const bsmSessionsDir = join(
        paths.openclawServiceHome,
        ".openclaw",
        ".openclaw",
        "agents",
        "bitcoin-skill-match",
        "sessions",
      );
      expect((await stat(bsmSessionsDir)).isDirectory()).toBe(true);
      const bsmSessionsEntries = await readdir(dirname(bsmSessionsDir));
      expect(bsmSessionsEntries).toContain("sessions");
      expect(bsmSessionsEntries.some((e) => e.startsWith("sessions.reset."))).toBe(false);
      expect(sentBodies.some((body) => body.includes("Hello from Bitcoin Skill Match"))).toBe(true);
      expect(sentBodies.some((body) => body.includes("Hello from Node Operator"))).toBe(true);
    } finally {
      if (priorOpenrouterApiKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = priorOpenrouterApiKey;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("reports doctor failures when gateway health and registration checks fail", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };
    await writeRuntimeArtifacts(paths);

    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
        }),
        ensureInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
          installMethod: "install_sh",
        }),
      },
      openclawGatewayServiceManager: {
        install: async () => {},
        start: async () => {},
        restart: async () => {},
      },
      managedAgentRegistrar: {
        register: async () => ({
          agentId: "mail-sentinel",
          cronJobId: "mail-sentinel-poll",
          workspaceDir: join(paths.stateDir, "mail-sentinel", "workspace"),
          agentCommand: "openclaw agents upsert",
          cronCommand: "openclaw cron add",
        }),
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async (req) => ({
          ok: true,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "ok",
          mailbox: req.imap.mailbox ?? "INBOX",
        }),
      },
      matrixProvisioner: {
        provision: async () => {
          throw new Error("not used");
        },
        bootstrapAccounts: async () => {
          throw new Error("not used");
        },
        bootstrapRoom: async () => {
          throw new Error("not used");
        },
        test: async () => ({
          ok: false,
          homeserverUrl: "https://matrix.example.org",
          checks: [],
        }),
      },
      execRunner: {
        run: async ({ command, args }) => {
          const serialized = [command, ...(args ?? [])].join(" ");
          if (serialized === "openclaw gateway status") {
            return {
              command: serialized,
              exitCode: 3,
              stdout: "inactive",
              stderr: "",
            };
          }
          if (serialized === "openclaw health") {
            return {
              command: serialized,
              exitCode: 1,
              stdout: "",
              stderr: "health check failed",
            };
          }
          if (serialized === "openclaw agents list") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "other-agent",
              stderr: "",
            };
          }
          if (serialized === "openclaw cron list") {
            return {
              command: serialized,
              exitCode: 0,
              stdout: "other-cron",
              stderr: "",
            };
          }
          return {
            command: serialized,
            exitCode: 1,
            stdout: "",
            stderr: "unexpected command",
          };
        },
      },
      fetchImpl: async () => new Response("not found", { status: 404 }),
    });

    try {
      const report = await service.getDoctorReport();
      expect(report.overall).toBe("fail");
      expect(report.checks.find((entry) => entry.id === "gateway-service-health")?.status).toBe(
        "fail",
      );
      expect(report.checks.find((entry) => entry.id === "managed-bot-registration")?.status).toBe(
        "fail",
      );
      expect(
        report.suggestedCommands.some((entry) => entry.includes("openclaw gateway restart")),
      ).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("treats running gateway with failed health probe as warn, not fail", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };
    await writeRuntimeArtifacts(paths);

    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
        }),
        ensureInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
          installMethod: "install_sh",
        }),
      },
      openclawGatewayServiceManager: {
        install: async () => {},
        start: async () => {},
        restart: async () => {},
      },
      managedAgentRegistrar: {
        register: async () => ({
          agentId: "mail-sentinel",
          cronJobId: "mail-sentinel-poll",
          workspaceDir: join(paths.stateDir, "mail-sentinel", "workspace"),
          agentCommand: "openclaw agents upsert",
          cronCommand: "openclaw cron add",
        }),
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async (req) => ({
          ok: true,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "ok",
          mailbox: req.imap.mailbox ?? "INBOX",
        }),
      },
      matrixProvisioner: {
        provision: async () => {
          throw new Error("not used");
        },
        bootstrapAccounts: async () => {
          throw new Error("not used");
        },
        bootstrapRoom: async () => {
          throw new Error("not used");
        },
        test: async () => ({
          ok: true,
          homeserverUrl: "https://matrix.example.org",
          checks: [],
        }),
      },
      execRunner: {
        run: async ({ command, args }) => {
          const serialized = [command, ...(args ?? [])].join(" ");
          if (serialized.startsWith("systemctl is-active")) {
            return { command: serialized, exitCode: 0, stdout: "active\n", stderr: "" };
          }
          if (serialized === "openclaw gateway status") {
            return { command: serialized, exitCode: 0, stdout: "running", stderr: "" };
          }
          if (serialized === "openclaw health") {
            return { command: serialized, exitCode: 1, stdout: "", stderr: "" };
          }
          if (serialized.startsWith("openclaw agents list")) {
            return { command: serialized, exitCode: 0, stdout: "mail-sentinel", stderr: "" };
          }
          if (serialized.startsWith("openclaw cron list")) {
            return { command: serialized, exitCode: 0, stdout: "mail-sentinel-poll", stderr: "" };
          }
          return { command: serialized, exitCode: 0, stdout: "", stderr: "" };
        },
      },
      fetchImpl: async () => new Response(JSON.stringify({ joined: {} }), { status: 200 }),
    });

    try {
      const report = await service.getDoctorReport();
      expect(report.checks.find((entry) => entry.id === "gateway-service-health")?.status).toBe(
        "warn",
      );
      expect(report.overall).not.toBe("fail");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps room reply routing open in OpenClaw config when federation is enabled", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "var", "backups"),
    };
    await writeDedicatedBotRuntimeArtifacts(paths);

    // Set federationEnabled: true in the runtime config
    const raw = await readFile(paths.configPath, "utf8");
    const parsed = JSON.parse(raw) as { matrix?: { federationEnabled?: boolean } };
    parsed.matrix = { ...parsed.matrix, federationEnabled: true };
    await writeFile(paths.configPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");

    const seededGatewayAuth = {
      mode: "token",
      token: "existing-gateway-token",
    } as const;
    await writeFile(
      join(paths.openclawServiceHome, ".openclaw", "openclaw.json5"),
      `${JSON.stringify(
        {
          meta: {
            lastTouchedVersion: "2026.3.13",
          },
          gateway: {
            bind: "loopback",
            auth: seededGatewayAuth,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const priorOpenrouterApiKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => null,
        ensureInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
          installMethod: "install_sh",
        }),
      },
      openclawGatewayServiceManager: {
        install: async () => {},
        start: async () => {},
        restart: async () => {},
      },
      managedAgentRegistrar: {
        register: async () => ({
          agentId: "mail-sentinel",
          cronJobId: "mail-sentinel-poll",
          workspaceDir: join(paths.stateDir, "mail-sentinel", "workspace"),
          agentCommand: "openclaw agents upsert",
          cronCommand: "openclaw cron add",
        }),
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async (req) => ({
          ok: true,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "ok",
          mailbox: req.imap.mailbox ?? "INBOX",
        }),
      },
      matrixProvisioner: {
        provision: async () => {
          throw new Error("not used");
        },
        bootstrapAccounts: async () => {
          throw new Error("not used");
        },
        bootstrapRoom: async () => {
          throw new Error("not used");
        },
        test: async () => ({
          ok: true,
          homeserverUrl: "https://matrix.example.org",
          checks: [],
        }),
      },
      fetchImpl: async (input, init) => {
        const url = String(input);
        return (
          buildManagedAgentMatrixProvisionResponse(url, init) ??
          new Response("{}", { status: 404, headers: { "Content-Type": "application/json" } })
        );
      },
    });

    try {
      // Trigger an invite which regenerates the OpenClaw config with the current federationEnabled=true
      const issued = await service.inviteMatrixUser({ username: "satoshi" });
      expect(issued.username).toBe("@satoshi:matrix.example.org");

      const openclawConfigRaw = await readFile(
        join(paths.openclawServiceHome, ".openclaw", "openclaw.json5"),
        "utf8",
      );
      const openclawConfig = JSON.parse(openclawConfigRaw) as {
        meta?: {
          lastTouchedVersion?: string;
        };
        gateway?: {
          auth?: {
            mode?: string;
            token?: string;
          };
        };
        channels?: {
          matrix?: {
            dm?: { policy?: string; allowFrom?: string[] };
            groupPolicy?: string;
            groupAllowFrom?: string[];
            groups?: Record<
              string,
              {
                users?: string[];
                autoReply?: boolean;
                requireMention?: boolean;
              }
            >;
            accounts?: Record<
              string,
              {
                dm?: { enabled?: boolean; policy?: string; allowFrom?: string[] };
                groupPolicy?: string;
                groupAllowFrom?: string[];
                groups?: Record<
                  string,
                  {
                    users?: string[];
                    autoReply?: boolean;
                    requireMention?: boolean;
                  }
                >;
              }
            >;
          };
        };
      };

      expect(openclawConfig.meta?.lastTouchedVersion).toBe("2026.3.13");
      expect(openclawConfig.gateway?.auth).toEqual(seededGatewayAuth);
      expect(openclawConfig.channels?.matrix?.dm?.policy).toBe("open");
      expect(openclawConfig.channels?.matrix?.groupPolicy).toBe("open");
      expect(openclawConfig.channels?.matrix?.groupAllowFrom).toBeUndefined();
      expect(
        openclawConfig.channels?.matrix?.groups?.["!alerts:matrix.example.org"]?.autoReply,
      ).toBe(true);
      expect(
        openclawConfig.channels?.matrix?.groups?.["!alerts:matrix.example.org"]?.requireMention,
      ).toBe(false);

      const btcAccount = openclawConfig.channels?.matrix?.accounts?.["bitcoin-skill-match"];
      expect(btcAccount?.dm?.enabled).toBe(true);
      expect(btcAccount?.dm?.policy).toBe("open");
      expect(btcAccount?.dm?.allowFrom).toBeUndefined();
      expect(btcAccount?.groupPolicy).toBe("open");
      expect(btcAccount?.groupAllowFrom).toBeUndefined();
      expect(btcAccount?.groups?.["!alerts:matrix.example.org"]?.autoReply).toBe(true);
      expect(btcAccount?.groups?.["!alerts:matrix.example.org"]?.requireMention).toBe(false);

      const opAccount = openclawConfig.channels?.matrix?.accounts?.["node-operator"];
      expect(opAccount?.dm?.enabled).toBe(true);
      expect(opAccount?.dm?.policy).toBe("open");
      expect(opAccount?.dm?.allowFrom).toBeUndefined();
      expect(opAccount?.groupPolicy).toBe("open");
      expect(opAccount?.groupAllowFrom).toBeUndefined();
      expect(opAccount?.groups?.["!alerts:matrix.example.org"]?.autoReply).toBe(false);
      expect(opAccount?.groups?.["!alerts:matrix.example.org"]?.requireMention).toBe(true);
    } finally {
      if (priorOpenrouterApiKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = priorOpenrouterApiKey;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("reconfigures matrix federation from disabled to enabled", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "var", "backups"),
    };
    await writeDedicatedBotRuntimeArtifacts(paths);

    // Write a matching install request so updateInstallRequestFederation can update it
    const installRequestPath = join(dirname(paths.configPath), "install-request.json");
    await writeFile(
      installRequestPath,
      JSON.stringify({
        mode: "bundled_matrix",
        openrouter: { model: "qwen/qwen3.5-9b", secretRef: "env:OPENROUTER_API_KEY" },
        matrix: {
          homeserverDomain: "matrix.example.org",
          publicBaseUrl: "https://matrix.example.org",
          federationEnabled: false,
        },
        operator: { username: "operator" },
      }),
      "utf8",
    );

    const priorOpenrouterApiKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    let gatewayRestartCalls = 0;

    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => null,
        ensureInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
          installMethod: "install_sh",
        }),
      },
      openclawGatewayServiceManager: {
        install: async () => {},
        start: async () => {},
        restart: async () => {
          gatewayRestartCalls += 1;
        },
      },
      managedAgentRegistrar: {
        register: async () => ({
          agentId: "mail-sentinel",
          cronJobId: "mail-sentinel-poll",
          workspaceDir: join(paths.stateDir, "mail-sentinel", "workspace"),
          agentCommand: "openclaw agents upsert",
          cronCommand: "openclaw cron add",
        }),
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async (req) => ({
          ok: true,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "ok",
          mailbox: req.imap.mailbox ?? "INBOX",
        }),
      },
      matrixProvisioner: {
        provision: async () => {
          throw new Error("not used");
        },
        bootstrapAccounts: async () => {
          throw new Error("not used");
        },
        bootstrapRoom: async () => {
          throw new Error("not used");
        },
        test: async () => ({
          ok: true,
          homeserverUrl: "https://matrix.example.org",
          checks: [],
        }),
      },
      fetchImpl: async () =>
        new Response("{}", { status: 404, headers: { "Content-Type": "application/json" } }),
    });

    try {
      const result = await service.reconfigureMatrix({
        matrix: { federationEnabled: true },
      });
      expect(result.changed).toContain("matrix.federationEnabled");
      expect(gatewayRestartCalls).toBe(1);

      // Runtime config should reflect the change
      const configRaw = await readFile(paths.configPath, "utf8");
      const config = JSON.parse(configRaw) as { matrix?: { federationEnabled?: boolean } };
      expect(config.matrix?.federationEnabled).toBe(true);

      // OpenClaw config should keep room routing open without allowlists
      const openclawRaw = await readFile(
        join(paths.openclawServiceHome, ".openclaw", "openclaw.json5"),
        "utf8",
      );
      const openclawConfig = JSON.parse(openclawRaw) as {
        channels?: {
          matrix?: {
            dm?: { policy?: string; allowFrom?: string[] };
            groupPolicy?: string;
            groups?: Record<string, { autoReply?: boolean; requireMention?: boolean }>;
          };
        };
      };
      expect(openclawConfig.channels?.matrix?.dm?.policy).toBe("open");
      expect(openclawConfig.channels?.matrix?.dm?.allowFrom).toBeUndefined();
      expect(openclawConfig.channels?.matrix?.groupPolicy).toBe("open");
      expect(
        openclawConfig.channels?.matrix?.groups?.["!alerts:matrix.example.org"]?.autoReply,
      ).toBe(true);
      expect(
        openclawConfig.channels?.matrix?.groups?.["!alerts:matrix.example.org"]?.requireMention,
      ).toBe(false);
    } finally {
      if (priorOpenrouterApiKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = priorOpenrouterApiKey;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("enables federation in relay mode", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "var", "backups"),
    };
    await writeDedicatedBotRuntimeArtifacts(paths);

    // Set access mode to relay
    const raw = await readFile(paths.configPath, "utf8");
    const parsed = JSON.parse(raw) as { matrix?: { accessMode?: string } };
    parsed.matrix = { ...parsed.matrix, accessMode: "relay" };
    await writeFile(paths.configPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");

    const priorOpenrouterApiKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    let federationUpdateArgs: Record<string, unknown> | null = null;

    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => null,
        ensureInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
          installMethod: "install_sh",
        }),
      },
      openclawGatewayServiceManager: {
        install: async () => {},
        start: async () => {},
        restart: async () => {},
      },
      managedAgentRegistrar: {
        register: async () => ({
          agentId: "mail-sentinel",
          cronJobId: "mail-sentinel-poll",
          workspaceDir: join(paths.stateDir, "mail-sentinel", "workspace"),
          agentCommand: "openclaw agents upsert",
          cronCommand: "openclaw cron add",
        }),
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async (req) => ({
          ok: true,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "ok",
          mailbox: req.imap.mailbox ?? "INBOX",
        }),
      },
      matrixProvisioner: {
        provision: async () => {
          throw new Error("not used");
        },
        updateFederationConfig: async (params) => {
          federationUpdateArgs = params as Record<string, unknown>;
        },
        bootstrapAccounts: async () => {
          throw new Error("not used");
        },
        bootstrapRoom: async () => {
          throw new Error("not used");
        },
        test: async () => ({
          ok: true,
          homeserverUrl: "https://matrix.example.org",
          checks: [],
        }),
      },
      fetchImpl: async () =>
        new Response("{}", { status: 404, headers: { "Content-Type": "application/json" } }),
    });

    try {
      const result = await service.reconfigureMatrix({
        matrix: { federationEnabled: true },
      });

      expect(result.changed).toContain("matrix.federationEnabled");
      expect(federationUpdateArgs).toMatchObject({
        federationEnabled: true,
        accessMode: "relay",
        homeserverDomain: "matrix.example.org",
        publicBaseUrl: "https://matrix.example.org",
      });

      const configRaw = await readFile(paths.configPath, "utf8");
      const config = JSON.parse(configRaw) as { matrix?: { federationEnabled?: boolean } };
      expect(config.matrix?.federationEnabled).toBe(true);
    } finally {
      if (priorOpenrouterApiKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = priorOpenrouterApiKey;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("writes compiled systemd units to disk when content differs", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const systemdDir = join(tempRoot, "etc", "systemd", "system");
    await mkdir(systemdDir, { recursive: true });

    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };
    await writeRuntimeArtifacts(paths);

    const serviceContent =
      "[Unit]\nDescription=Sovereign Mail Sentinel Scan\n\n[Service]\nType=oneshot\nUser=sovereign-ai-node\n\n[Install]\n";
    const timerContent =
      "[Unit]\nDescription=Sovereign Mail Sentinel Scan Timer\n\n[Timer]\nOnUnitActiveSec=30min\n\n[Install]\nWantedBy=timers.target\n";

    const raw = await readFile(paths.configPath, "utf8");
    const parsed = JSON.parse(raw) as {
      hostResources?: {
        planPath?: string;
        resources?: Array<Record<string, unknown>>;
        botStatus?: Array<Record<string, unknown>>;
      };
    };
    parsed.hostResources = {
      planPath: join(dirname(paths.configPath), "host-resources.json"),
      resources: [
        {
          id: "scan-service",
          botId: "mail-sentinel",
          kind: "systemdService",
          name: "sovereign-mail-sentinel-scan.service",
          content: serviceContent,
          desiredState: { enabled: false, active: false },
          checks: [],
        },
        {
          id: "scan-timer",
          botId: "mail-sentinel",
          kind: "systemdTimer",
          name: "sovereign-mail-sentinel-scan.timer",
          content: timerContent,
          desiredState: { enabled: true, active: true },
          checks: [],
        },
      ],
      botStatus: [],
    };
    await writeFile(paths.configPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");

    // Write an outdated unit to verify it gets overwritten
    await writeFile(
      join(systemdDir, "sovereign-mail-sentinel-scan.service"),
      "[Unit]\nDescription=Old\n\n[Service]\nType=oneshot\nUser=sovereign-node\n\n[Install]\n",
      "utf8",
    );

    const execCommands: string[] = [];
    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
        }),
        ensureInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
          installMethod: "install_sh",
        }),
      },
      openclawGatewayServiceManager: {
        install: async () => {},
        start: async () => {},
        restart: async () => {},
      },
      managedAgentRegistrar: {
        register: async () => ({
          agentId: "mail-sentinel",
          workspaceDir: join(paths.stateDir, "mail-sentinel", "workspace"),
          agentCommand: "openclaw agents upsert",
        }),
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async (req) => ({
          ok: true,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "ok",
          mailbox: req.imap.mailbox ?? "INBOX",
        }),
      },
      matrixProvisioner: {
        provision: async () => {
          throw new Error("not used");
        },
        bootstrapAccounts: async () => {
          throw new Error("not used");
        },
        bootstrapRoom: async () => {
          throw new Error("not used");
        },
        test: async () => ({
          ok: true,
          homeserverUrl: "https://matrix.example.org",
          checks: [],
        }),
      },
      execRunner: {
        run: async ({ command, args }) => {
          const serialized = [command, ...(args ?? [])].join(" ");
          execCommands.push(serialized);
          return { command: serialized, exitCode: 0, stdout: "", stderr: "" };
        },
      },
      fetchImpl: async () =>
        new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
    });

    const getuidMock =
      typeof process.getuid === "function"
        ? vi
            .spyOn(process as typeof process & { getuid: () => number }, "getuid")
            .mockImplementation(() => 0)
        : null;
    process.env.SOVEREIGN_NODE_SYSTEMD_UNIT_DIR = systemdDir;
    try {
      const configRaw = await readFile(paths.configPath, "utf8");
      const runtimeConfig = JSON.parse(configRaw) as RuntimeConfig;
      runtimeConfig.hostResources = parsed.hostResources as NonNullable<
        RuntimeConfig["hostResources"]
      >;
      await (
        service as unknown as {
          applyCompiledSystemdResources(config: RuntimeConfig): Promise<void>;
        }
      ).applyCompiledSystemdResources(runtimeConfig);

      // Verify the service unit was overwritten with new content
      const writtenService = await readFile(
        join(systemdDir, "sovereign-mail-sentinel-scan.service"),
        "utf8",
      );
      expect(writtenService).toBe(serviceContent);

      // Verify the timer unit was created
      const writtenTimer = await readFile(
        join(systemdDir, "sovereign-mail-sentinel-scan.timer"),
        "utf8",
      );
      expect(writtenTimer).toBe(timerContent);

      // Verify systemctl daemon-reload was called
      expect(execCommands).toContain("systemctl daemon-reload");

      // Verify enable and restart were called for the timer (desiredState.enabled + active)
      expect(execCommands).toContain("systemctl enable sovereign-mail-sentinel-scan.timer");
      expect(execCommands).toContain("systemctl restart sovereign-mail-sentinel-scan.timer");

      // The service has desiredState enabled=false, active=false, so no enable/restart
      expect(execCommands).not.toContain("systemctl enable sovereign-mail-sentinel-scan.service");
      expect(execCommands).not.toContain("systemctl restart sovereign-mail-sentinel-scan.service");
    } finally {
      getuidMock?.mockRestore();
      delete process.env.SOVEREIGN_NODE_SYSTEMD_UNIT_DIR;
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("skips writing systemd units when content is unchanged", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-installer-test-"));
    const systemdDir = join(tempRoot, "etc", "systemd", "system");
    await mkdir(systemdDir, { recursive: true });

    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "var", "lib"),
      logsDir: join(tempRoot, "var", "log"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };
    await writeRuntimeArtifacts(paths);

    const serviceContent =
      "[Unit]\nDescription=Sovereign Mail Sentinel Scan\n\n[Service]\nType=oneshot\nUser=sovereign-ai-node\n\n[Install]\n";

    const raw = await readFile(paths.configPath, "utf8");
    const parsed = JSON.parse(raw) as {
      hostResources?: {
        planPath?: string;
        resources?: Array<Record<string, unknown>>;
        botStatus?: Array<Record<string, unknown>>;
      };
    };
    parsed.hostResources = {
      planPath: join(dirname(paths.configPath), "host-resources.json"),
      resources: [
        {
          id: "scan-service",
          botId: "mail-sentinel",
          kind: "systemdService",
          name: "sovereign-mail-sentinel-scan.service",
          content: serviceContent,
          desiredState: { enabled: false, active: false },
          checks: [],
        },
      ],
      botStatus: [],
    };
    await writeFile(paths.configPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");

    // Write the exact same content so nothing should change
    await writeFile(
      join(systemdDir, "sovereign-mail-sentinel-scan.service"),
      serviceContent,
      "utf8",
    );

    const execCommands: string[] = [];
    const service = new RealInstallerService(createLogger(), paths, {
      openclawBootstrapper: {
        detectInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
        }),
        ensureInstalled: async () => ({
          binaryPath: "/usr/local/bin/openclaw",
          version: "0.2.0",
          installMethod: "install_sh",
        }),
      },
      openclawGatewayServiceManager: {
        install: async () => {},
        start: async () => {},
        restart: async () => {},
      },
      managedAgentRegistrar: {
        register: async () => ({
          agentId: "mail-sentinel",
          workspaceDir: join(paths.stateDir, "mail-sentinel", "workspace"),
          agentCommand: "openclaw agents upsert",
        }),
      },
      preflightChecker: {
        run: async () => ({
          mode: "bundled_matrix",
          overall: "pass",
          checks: [],
          recommendedActions: [],
        }),
      },
      imapTester: {
        test: async (req) => ({
          ok: true,
          host: req.imap.host,
          port: req.imap.port,
          tls: req.imap.tls,
          auth: "ok",
          mailbox: req.imap.mailbox ?? "INBOX",
        }),
      },
      matrixProvisioner: {
        provision: async () => {
          throw new Error("not used");
        },
        bootstrapAccounts: async () => {
          throw new Error("not used");
        },
        bootstrapRoom: async () => {
          throw new Error("not used");
        },
        test: async () => ({
          ok: true,
          homeserverUrl: "https://matrix.example.org",
          checks: [],
        }),
      },
      execRunner: {
        run: async ({ command, args }) => {
          const serialized = [command, ...(args ?? [])].join(" ");
          execCommands.push(serialized);
          return { command: serialized, exitCode: 0, stdout: "", stderr: "" };
        },
      },
      fetchImpl: async () =>
        new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
    });

    const getuidMock2 =
      typeof process.getuid === "function"
        ? vi
            .spyOn(process as typeof process & { getuid: () => number }, "getuid")
            .mockImplementation(() => 0)
        : null;
    process.env.SOVEREIGN_NODE_SYSTEMD_UNIT_DIR = systemdDir;
    try {
      const configRaw = await readFile(paths.configPath, "utf8");
      const runtimeConfig = JSON.parse(configRaw) as RuntimeConfig;
      runtimeConfig.hostResources = parsed.hostResources as NonNullable<
        RuntimeConfig["hostResources"]
      >;
      await (
        service as unknown as {
          applyCompiledSystemdResources(config: RuntimeConfig): Promise<void>;
        }
      ).applyCompiledSystemdResources(runtimeConfig);

      // Content is identical, so no daemon-reload should be called
      expect(execCommands).not.toContain("systemctl daemon-reload");
    } finally {
      getuidMock2?.mockRestore();
      delete process.env.SOVEREIGN_NODE_SYSTEMD_UNIT_DIR;
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
