import type { KeyObject } from "node:crypto";
import { createHash, createPublicKey, verify } from "node:crypto";

export type TemplateSignature = {
  algorithm: "ed25519";
  keyId: string;
  value: string;
};

export type ToolTemplateManifest = {
  kind: "sovereign-tool-template";
  id: string;
  version: string;
  description: string;
  capabilities: string[];
  requiredSecretRefs: string[];
  requiredConfigKeys: string[];
  allowedCommands: string[];
  openclawPlugins?: string[];
  openclawBundledPlugins?: string[];
  openclawToolNames?: string[];
  signature: TemplateSignature;
};

export type ToolTemplateDefinition = Omit<ToolTemplateManifest, "signature">;

export type AgentTemplateManifest = {
  kind: "sovereign-agent-template";
  id: string;
  version: string;
  description: string;
  model?: string;
  matrix: {
    localpartPrefix: string;
  };
  requiredToolTemplates: Array<{
    id: string;
    version: string;
  }>;
  optionalToolTemplates: Array<{
    id: string;
    version: string;
  }>;
  signature: TemplateSignature;
};

export type SovereignTemplateManifest = ToolTemplateManifest | AgentTemplateManifest;

export type TrustedTemplateKey = {
  keyId: string;
  publicKeyPem: string;
};

type VerifiedManifest = {
  manifestSha256: string;
  trusted: boolean;
  keyId: string;
};

const CORE_KEY_ID = "sovereign-core-ed25519-2026-01";
const CORE_PUBLIC_KEY_PEM = [
  "-----BEGIN PUBLIC KEY-----",
  "MCowBQYDK2VwAyEAm97Y7Eyidm9mmk+vre8+PTJWtUSfJI6n3DlWJ3x4bek=",
  "-----END PUBLIC KEY-----",
].join("\n");
const CORE_KEY_ID_2026_03 = "sovereign-core-ed25519-2026-03";
const CORE_PUBLIC_KEY_PEM_2026_03 = [
  "-----BEGIN PUBLIC KEY-----",
  "MCowBQYDK2VwAyEA1NjeN4Uzn3Eh1cuWIZv4zxfO+WQU2HyRMasiwO4/DGE=",
  "-----END PUBLIC KEY-----",
].join("\n");
export const CORE_TRUSTED_TEMPLATE_KEYS: TrustedTemplateKey[] = [
  {
    keyId: CORE_KEY_ID,
    publicKeyPem: CORE_PUBLIC_KEY_PEM,
  },
  {
    keyId: CORE_KEY_ID_2026_03,
    publicKeyPem: CORE_PUBLIC_KEY_PEM_2026_03,
  },
];

export const CORE_TEMPLATE_MANIFESTS: ToolTemplateManifest[] = [
  {
    kind: "sovereign-tool-template",
    id: "node-cli-ops",
    version: "1.0.0",
    description: "Least-privilege sovereign-node operational CLI tools for operator-style agents.",
    capabilities: ["node.status.read", "node.doctor.read", "node.agents.manage", "node.alert.send"],
    requiredSecretRefs: [],
    requiredConfigKeys: [],
    allowedCommands: [
      "sovereign-node status --json",
      "sovereign-node doctor --json",
      "sovereign-node agents list --json",
      "sovereign-node agents create <id> --workspace <dir> --json",
      "sovereign-node agents update <id> --workspace <dir> --json",
      "sovereign-node agents delete <id> --json",
      "sovereign-node test-alert --json",
    ],
    signature: {
      algorithm: "ed25519",
      keyId: CORE_KEY_ID,
      value:
        "mcnSHp56qDnOQ0t1+yuZr3t60KpNX1GcDUAEwO0EDPatVkQz88bRtornPGM3jkXI8lOpYxx/Bro0poXs2ODOBw==",
    },
  },
  {
    kind: "sovereign-tool-template",
    id: "imap-readonly",
    version: "1.0.0",
    description: "Read-only IMAP tooling template for message fetch/search style agents.",
    capabilities: ["imap.read-mail", "imap.search-mail", "imap.fetch-headers"],
    requiredSecretRefs: ["password"],
    requiredConfigKeys: ["host", "port", "tls", "username", "mailbox"],
    allowedCommands: [
      "sovereign-tool imap-read-mail --instance <tool-instance-id> --message-id <id>",
      "sovereign-tool imap-search-mail --instance <tool-instance-id> --query <query>",
    ],
    signature: {
      algorithm: "ed25519",
      keyId: CORE_KEY_ID,
      value:
        "iC9gCncfVhI6ZCknRjuGy93IWVIntGuLktSNdpGaNfO+flWST34eosIQT4F/fYWtnJEI7KHSzAXOJzJHj1S+DA==",
    },
  },
];

export const parseTemplateRef = (ref: string): { id: string; version: string } => {
  const normalized = ref.trim();
  const match = /^([a-z0-9][a-z0-9._-]{1,62})@([0-9]+\.[0-9]+\.[0-9]+)$/.exec(normalized);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new Error("Template ref must match <id>@<semver> (example: example-template@1.0.0)");
  }
  return {
    id: match[1],
    version: match[2],
  };
};

export const formatTemplateRef = (id: string, version: string): string => `${id}@${version}`;

const stableSerializeWithoutSignature = (value: unknown): string => {
  const serialize = (input: unknown): string => {
    if (Array.isArray(input)) {
      return `[${input.map((entry) => serialize(entry)).join(",")}]`;
    }
    if (input !== null && typeof input === "object") {
      const record = input as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((key) => key !== "signature")
        .sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(record[key])}`).join(",")}}`;
    }
    return JSON.stringify(input);
  };
  return serialize(value);
};

const trustedKeyById = (trustedKeys: TrustedTemplateKey[]): Map<string, KeyObject> => {
  const map = new Map<string, KeyObject>();
  for (const key of trustedKeys) {
    map.set(key.keyId, createPublicKey(key.publicKeyPem));
  }
  return map;
};

export const verifySignedTemplateManifest = (
  manifest: SovereignTemplateManifest,
  trustedKeys: TrustedTemplateKey[],
): VerifiedManifest => {
  const payload = stableSerializeWithoutSignature(manifest);
  const payloadBuffer = Buffer.from(payload, "utf8");
  const signature = Buffer.from(manifest.signature.value, "base64");
  const keys = trustedKeyById(trustedKeys);
  const trustedKey = keys.get(manifest.signature.keyId);
  const digest = createHash("sha256").update(payloadBuffer).digest("hex");
  if (trustedKey === undefined) {
    throw new Error(
      `Template ${formatTemplateRef(manifest.id, manifest.version)} is signed by unknown key '${manifest.signature.keyId}'`,
    );
  }
  const verified = verify(null, payloadBuffer, trustedKey, signature);
  if (!verified) {
    throw new Error(
      `Template signature verification failed for ${formatTemplateRef(manifest.id, manifest.version)}`,
    );
  }
  return {
    manifestSha256: digest,
    trusted: true,
    keyId: manifest.signature.keyId,
  };
};

export const findCoreTemplateManifest = (ref: string): SovereignTemplateManifest | undefined => {
  const parsed = parseTemplateRef(ref);
  return CORE_TEMPLATE_MANIFESTS.find(
    (entry) => entry.id === parsed.id && entry.version === parsed.version,
  );
};
