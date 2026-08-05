import type { SovereignBotPackageManifest } from "../bots/catalog.js";
import type { ToolTemplateDefinition } from "../templates/catalog.js";

/**
 * Deterministic structural comparison between a previously pinned template
 * and the release-authorized target template.
 *
 * The manifest digest stays authoritative for the pin itself; this diff
 * exists for operator visibility, audit output, tests, and incident
 * diagnosis. It never executes anything, output strings are sanitized so a
 * hostile manifest cannot inject log/terminal control sequences, and every
 * list is length-bounded.
 */

export type TemplateChangeClassification =
  | "identical"
  | "capability-added"
  | "capability-removed"
  | "command-added"
  | "command-removed"
  | "resource-added"
  | "resource-removed"
  | "resource-changed"
  | "write-policy-changed"
  | "template-key-changed"
  | "unknown-change";

export type TemplateTransitionDiff = {
  classifications: TemplateChangeClassification[];
  capabilitiesAdded: string[];
  capabilitiesRemoved: string[];
  commandsAdded: string[];
  commandsRemoved: string[];
  resourcesAdded: string[];
  resourcesRemoved: string[];
  resourcesChanged: string[];
  /** True when the previous template content was unavailable, so only the
   * digest-level change is known and list diffs are empty. */
  previousAvailable: boolean;
};

const MAX_SURFACE_VALUE_LENGTH = 240;
const MAX_LIST_ENTRIES = 32;

/** Strip C0/C1 control characters (log/terminal injection) and bound length. */
export const sanitizeSurfaceValue = (value: string): string => {
  let sanitized = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    sanitized += code >= 0x20 && code !== 0x7f && (code < 0x80 || code > 0x9f) ? char : " ";
  }
  return sanitized.length > MAX_SURFACE_VALUE_LENGTH
    ? `${sanitized.slice(0, MAX_SURFACE_VALUE_LENGTH)}…`
    : sanitized;
};

const boundList = (values: string[]): string[] => {
  const sanitized = values.map(sanitizeSurfaceValue);
  if (sanitized.length <= MAX_LIST_ENTRIES) {
    return sanitized;
  }
  return [
    ...sanitized.slice(0, MAX_LIST_ENTRIES),
    `… ${sanitized.length - MAX_LIST_ENTRIES} more entries omitted`,
  ];
};

const added = (previous: readonly string[], next: readonly string[]): string[] =>
  next.filter((entry) => !previous.includes(entry));

const stableSerialize = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

/**
 * Diff two tool-template definitions (capabilities and allowed commands are
 * the authorization-relevant surfaces; everything else groups under
 * unknown-change so a novel manifest field can never change surfaces
 * invisibly).
 */
export const diffToolTemplateSurfaces = (input: {
  previous: ToolTemplateDefinition | null;
  next: ToolTemplateDefinition;
  previousKeyId: string;
  nextKeyId: string;
}): TemplateTransitionDiff => {
  const classifications = new Set<TemplateChangeClassification>();
  if (input.previousKeyId !== input.nextKeyId) {
    classifications.add("template-key-changed");
  }

  if (input.previous === null) {
    if (classifications.size === 0) {
      classifications.add("unknown-change");
    }
    return {
      classifications: Array.from(classifications),
      capabilitiesAdded: [],
      capabilitiesRemoved: [],
      commandsAdded: [],
      commandsRemoved: [],
      resourcesAdded: [],
      resourcesRemoved: [],
      resourcesChanged: [],
      previousAvailable: false,
    };
  }

  const capabilitiesAdded = added(input.previous.capabilities, input.next.capabilities);
  const capabilitiesRemoved = added(input.next.capabilities, input.previous.capabilities);
  const commandsAdded = added(input.previous.allowedCommands, input.next.allowedCommands);
  const commandsRemoved = added(input.next.allowedCommands, input.previous.allowedCommands);

  if (capabilitiesAdded.length > 0) classifications.add("capability-added");
  if (capabilitiesRemoved.length > 0) classifications.add("capability-removed");
  if (commandsAdded.length > 0) classifications.add("command-added");
  if (commandsRemoved.length > 0) classifications.add("command-removed");

  // Any other field difference (plugins, required config/secret keys,
  // description, version …) must still be visible as a change.
  const strip = (template: ToolTemplateDefinition) => {
    const { capabilities: _c, allowedCommands: _a, ...rest } = template;
    return rest;
  };
  if (
    classifications.size === 0 &&
    stableSerialize(strip(input.previous)) !== stableSerialize(strip(input.next))
  ) {
    classifications.add("unknown-change");
  }
  if (classifications.size === 0) {
    classifications.add(
      stableSerialize(input.previous) === stableSerialize(input.next)
        ? "identical"
        : "unknown-change",
    );
  }

  return {
    classifications: Array.from(classifications),
    capabilitiesAdded: boundList(capabilitiesAdded),
    capabilitiesRemoved: boundList(capabilitiesRemoved),
    commandsAdded: boundList(commandsAdded),
    commandsRemoved: boundList(commandsRemoved),
    resourcesAdded: [],
    resourcesRemoved: [],
    resourcesChanged: [],
    previousAvailable: true,
  };
};

type HostResourceLike = { id: string; kind: string; spec?: unknown; writePolicy?: unknown };

/** writePolicy may sit at the resource top level or inside spec, depending on
 * the manifest generation; check both so a policy flip is never missed. */
const resourceWritePolicy = (resource: HostResourceLike): unknown =>
  resource.writePolicy ??
  (typeof resource.spec === "object" && resource.spec !== null
    ? (resource.spec as Record<string, unknown>).writePolicy
    : undefined);

const hostResourceList = (manifest: SovereignBotPackageManifest | null): HostResourceLike[] => {
  if (manifest === null) {
    return [];
  }
  return (manifest.hostResources as unknown as HostResourceLike[]).filter(
    (entry): entry is HostResourceLike => typeof entry?.id === "string",
  );
};

/**
 * Diff a bot package's host-resource surface (the agent-template pin covers
 * the whole bot manifest, so managed resources are its relevant surface).
 */
export const diffBotPackageSurfaces = (input: {
  previous: SovereignBotPackageManifest | null;
  next: SovereignBotPackageManifest;
  previousKeyId: string;
  nextKeyId: string;
}): TemplateTransitionDiff => {
  const classifications = new Set<TemplateChangeClassification>();
  if (input.previousKeyId !== input.nextKeyId) {
    classifications.add("template-key-changed");
  }

  if (input.previous === null) {
    if (classifications.size === 0) {
      classifications.add("unknown-change");
    }
    return {
      classifications: Array.from(classifications),
      capabilitiesAdded: [],
      capabilitiesRemoved: [],
      commandsAdded: [],
      commandsRemoved: [],
      resourcesAdded: [],
      resourcesRemoved: [],
      resourcesChanged: [],
      previousAvailable: false,
    };
  }

  const previousById = new Map(hostResourceList(input.previous).map((r) => [r.id, r] as const));
  const nextById = new Map(hostResourceList(input.next).map((r) => [r.id, r] as const));

  const resourcesAdded: string[] = [];
  const resourcesRemoved: string[] = [];
  const resourcesChanged: string[] = [];
  let writePolicyChanged = false;

  for (const [id, next] of nextById) {
    const previous = previousById.get(id);
    if (previous === undefined) {
      resourcesAdded.push(id);
      continue;
    }
    if (stableSerialize(previous) !== stableSerialize(next)) {
      resourcesChanged.push(id);
      if (stableSerialize(resourceWritePolicy(previous)) !== stableSerialize(resourceWritePolicy(next))) {
        writePolicyChanged = true;
      }
    }
  }
  for (const id of previousById.keys()) {
    if (!nextById.has(id)) {
      resourcesRemoved.push(id);
    }
  }

  if (resourcesAdded.length > 0) classifications.add("resource-added");
  if (resourcesRemoved.length > 0) classifications.add("resource-removed");
  if (resourcesChanged.length > 0) classifications.add("resource-changed");
  if (writePolicyChanged) classifications.add("write-policy-changed");
  if (classifications.size === 0) {
    classifications.add(
      stableSerialize(input.previous) === stableSerialize(input.next)
        ? "identical"
        : "unknown-change",
    );
  }

  return {
    classifications: Array.from(classifications),
    capabilitiesAdded: [],
    capabilitiesRemoved: [],
    commandsAdded: [],
    commandsRemoved: [],
    resourcesAdded: boundList(resourcesAdded),
    resourcesRemoved: boundList(resourcesRemoved),
    resourcesChanged: boundList(resourcesChanged),
    previousAvailable: true,
  };
};
