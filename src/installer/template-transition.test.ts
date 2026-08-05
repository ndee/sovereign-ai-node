import { describe, expect, it } from "vitest";

import type { SovereignBotPackageManifest } from "../bots/catalog.js";
import type { ToolTemplateDefinition } from "../templates/catalog.js";
import {
  diffBotPackageSurfaces,
  diffToolTemplateSurfaces,
  sanitizeSurfaceValue,
} from "./template-transition.js";

const toolTemplate = (overrides?: Partial<ToolTemplateDefinition>): ToolTemplateDefinition => ({
  kind: "sovereign-tool-template",
  id: "mail-sentinel-tool",
  version: "2.0.0",
  description: "Mail watcher",
  capabilities: ["mail-sentinel.scan", "mail-sentinel.version.read"],
  requiredSecretRefs: [],
  requiredConfigKeys: [],
  allowedCommands: ["<agent-workspace>/bin/mail-sentinel.js version --json"],
  openclawPlugins: [],
  openclawBundledPlugins: [],
  openclawToolNames: [],
  ...overrides,
});

describe("diffToolTemplateSurfaces", () => {
  it("reports the incident shape: status capability and command added", () => {
    const previous = toolTemplate();
    const next = toolTemplate({
      capabilities: [...previous.capabilities, "mail-sentinel.status.read"],
      allowedCommands: [
        ...previous.allowedCommands,
        "<agent-workspace>/bin/mail-sentinel.js status --instance <tool-instance-id> --json",
      ],
    });
    const diff = diffToolTemplateSurfaces({
      previous,
      next,
      previousKeyId: "repo:sovereign-ai-bots",
      nextKeyId: "repo:sovereign-ai-bots",
    });
    expect(diff.classifications).toEqual(
      expect.arrayContaining(["capability-added", "command-added"]),
    );
    expect(diff.capabilitiesAdded).toEqual(["mail-sentinel.status.read"]);
    expect(diff.commandsAdded).toEqual([
      "<agent-workspace>/bin/mail-sentinel.js status --instance <tool-instance-id> --json",
    ]);
    expect(diff.capabilitiesRemoved).toEqual([]);
    expect(diff.commandsRemoved).toEqual([]);
    expect(diff.previousAvailable).toBe(true);
  });

  it("reports removals", () => {
    const previous = toolTemplate();
    const next = toolTemplate({ capabilities: ["mail-sentinel.scan"], allowedCommands: [] });
    const diff = diffToolTemplateSurfaces({
      previous,
      next,
      previousKeyId: "k",
      nextKeyId: "k",
    });
    expect(diff.classifications).toEqual(
      expect.arrayContaining(["capability-removed", "command-removed"]),
    );
    expect(diff.capabilitiesRemoved).toEqual(["mail-sentinel.version.read"]);
  });

  it("classifies identical templates", () => {
    const diff = diffToolTemplateSurfaces({
      previous: toolTemplate(),
      next: toolTemplate(),
      previousKeyId: "k",
      nextKeyId: "k",
    });
    expect(diff.classifications).toEqual(["identical"]);
  });

  it("classifies non-surface changes as unknown-change instead of hiding them", () => {
    const diff = diffToolTemplateSurfaces({
      previous: toolTemplate(),
      next: toolTemplate({ description: "Different" }),
      previousKeyId: "k",
      nextKeyId: "k",
    });
    expect(diff.classifications).toEqual(["unknown-change"]);
  });

  it("classifies key changes and missing previous content", () => {
    const withKeyChange = diffToolTemplateSurfaces({
      previous: toolTemplate(),
      next: toolTemplate(),
      previousKeyId: "old-key",
      nextKeyId: "new-key",
    });
    expect(withKeyChange.classifications).toContain("template-key-changed");

    const withoutPrevious = diffToolTemplateSurfaces({
      previous: null,
      next: toolTemplate(),
      previousKeyId: "k",
      nextKeyId: "k",
    });
    expect(withoutPrevious.previousAvailable).toBe(false);
    expect(withoutPrevious.classifications).toEqual(["unknown-change"]);
  });

  it("sanitizes injected control characters and bounds entry length", () => {
    const hostile = `evil\u001b[31mcmd\r\nrm -rf${"x".repeat(400)}`;
    const previous = toolTemplate();
    const next = toolTemplate({ allowedCommands: [...previous.allowedCommands, hostile] });
    const diff = diffToolTemplateSurfaces({
      previous,
      next,
      previousKeyId: "k",
      nextKeyId: "k",
    });
    const rendered = diff.commandsAdded[0] ?? "";
    expect(rendered).not.toContain("\u001b");
    expect(rendered).not.toContain("\r");
    expect(rendered).not.toContain("\n");
    expect(rendered.length).toBeLessThanOrEqual(241);
    expect(sanitizeSurfaceValue("plain")).toBe("plain");
  });
});

const botManifest = (
  overrides?: Partial<SovereignBotPackageManifest>,
): SovereignBotPackageManifest =>
  ({
    kind: "sovereign-bot-package",
    manifestVersion: 2,
    id: "fixture-bot",
    version: "1.0.0",
    displayName: "Fixture",
    description: "Fixture bot",
    matrixIdentity: { mode: "dedicated-account", localpartPrefix: "fixture-bot" },
    configDefaults: {},
    toolTemplates: [],
    toolInstances: [],
    hostResources: [
      {
        id: "workspace-tools",
        kind: "managedFile",
        dependsOn: [],
        supersedes: [],
        spec: { path: "x", inlineContent: "doc", writePolicy: "always" },
        checks: [],
      },
    ],
    agentTemplate: {
      id: "fixture-bot",
      version: "1.0.0",
      description: "Fixture bot",
      matrix: { localpartPrefix: "fixture-bot" },
      requiredToolTemplates: [],
      optionalToolTemplates: [],
    },
    ...overrides,
  }) as SovereignBotPackageManifest;

describe("diffBotPackageSurfaces", () => {
  it("reports added, removed, changed resources and write-policy changes", () => {
    const previous = botManifest();
    const next = botManifest({
      hostResources: [
        {
          id: "workspace-tools",
          kind: "managedFile",
          dependsOn: [],
          supersedes: [],
          spec: { path: "x", inlineContent: "doc", writePolicy: "ifMissing" },
          checks: [],
        },
        {
          id: "workspace-extra",
          kind: "managedFile",
          dependsOn: [],
          supersedes: [],
          spec: { path: "y", inlineContent: "extra", writePolicy: "always" },
          checks: [],
        },
      ] as SovereignBotPackageManifest["hostResources"],
    });
    const diff = diffBotPackageSurfaces({
      previous,
      next,
      previousKeyId: "k",
      nextKeyId: "k",
    });
    expect(diff.classifications).toEqual(
      expect.arrayContaining(["resource-added", "resource-changed", "write-policy-changed"]),
    );
    expect(diff.resourcesAdded).toEqual(["workspace-extra"]);
    expect(diff.resourcesChanged).toEqual(["workspace-tools"]);

    const removal = diffBotPackageSurfaces({
      previous: next,
      next: previous,
      previousKeyId: "k",
      nextKeyId: "k",
    });
    expect(removal.resourcesRemoved).toEqual(["workspace-extra"]);
  });

  it("falls back to digest-only knowledge without previous content", () => {
    const diff = diffBotPackageSurfaces({
      previous: null,
      next: botManifest(),
      previousKeyId: "k",
      nextKeyId: "k",
    });
    expect(diff.previousAvailable).toBe(false);
  });
});
