/**
 * OpenRouter privacy routing for the managed OpenClaw runtime.
 *
 * Every provider-backed call the node makes (including `llm-task` mail
 * classification) goes through OpenRouter, which by default may route a
 * request to any upstream provider, including ones that retain or train on
 * prompts. OpenRouter exposes per-request provider routing preferences in the
 * `provider` field of the request body; this module renders that block from
 * the node's `openrouter.privacy` config.
 *
 * OpenClaw (2026.3.x) reads `agents.defaults.models["<provider>/<model>"].params`
 * via `resolveExtraParams()` and, when `params.provider` is an object and the
 * provider is `openrouter`, injects it into `model.compat.openRouterRouting`
 * so pi-ai sets `provider` in the OpenAI-completions request body
 * (`extra-params.ts`, `createStreamFnWithExtraParams`).
 *
 * The strict profile below is the DEFAULT; operators must opt out explicitly.
 */

export type OpenRouterDataCollection = "deny" | "allow";

export type OpenRouterPrivacyConfig = {
  /** Restrict to endpoints that honour OpenRouter's zero-data-retention policy. */
  zdr: boolean;
  /** Exclude providers that may collect / train on prompts. */
  dataCollection: OpenRouterDataCollection;
  /** Allow OpenRouter to fall back to providers outside the preferred/filtered set. */
  allowFallbacks: boolean;
  /** Optional provider allowlist (OpenRouter provider slugs, e.g. "together"). */
  only?: string[];
};

export type OpenRouterPrivacyInput = Partial<{
  zdr: unknown;
  dataCollection: unknown;
  allowFallbacks: unknown;
  only: unknown;
}>;

/** OpenRouter `provider` routing block as sent in the request body. */
export type OpenRouterProviderRouting = {
  data_collection: OpenRouterDataCollection;
  zdr: boolean;
  allow_fallbacks: boolean;
  only?: string[];
};

export const DEFAULT_OPENROUTER_PRIVACY: Readonly<OpenRouterPrivacyConfig> = Object.freeze({
  zdr: true,
  dataCollection: "deny",
  allowFallbacks: false,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeOnly = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const deduped = Array.from(new Set(entries));
  return deduped.length === 0 ? undefined : deduped;
};

/**
 * Resolve an `openrouter.privacy` block (install request or persisted node
 * config) into a fully-populated config. Unknown / malformed values fall back
 * to the strict defaults, so a corrupted config never silently weakens
 * routing.
 */
export const resolveOpenRouterPrivacy = (input: unknown): OpenRouterPrivacyConfig => {
  const raw: OpenRouterPrivacyInput = isRecord(input) ? input : {};
  const only = normalizeOnly(raw.only);
  return {
    zdr: typeof raw.zdr === "boolean" ? raw.zdr : DEFAULT_OPENROUTER_PRIVACY.zdr,
    dataCollection:
      raw.dataCollection === "allow" || raw.dataCollection === "deny"
        ? raw.dataCollection
        : DEFAULT_OPENROUTER_PRIVACY.dataCollection,
    allowFallbacks:
      typeof raw.allowFallbacks === "boolean"
        ? raw.allowFallbacks
        : DEFAULT_OPENROUTER_PRIVACY.allowFallbacks,
    ...(only === undefined ? {} : { only }),
  };
};

/** Render the OpenRouter request-body `provider` block. */
export const buildOpenRouterProviderRouting = (
  privacy: OpenRouterPrivacyConfig,
): OpenRouterProviderRouting => ({
  data_collection: privacy.dataCollection,
  zdr: privacy.zdr,
  allow_fallbacks: privacy.allowFallbacks,
  ...(privacy.only === undefined ? {} : { only: [...privacy.only] }),
});

/**
 * Render the `agents.defaults.models` entry OpenClaw needs so the routing
 * block reaches every request for the configured OpenRouter model
 * (`agents.defaults.models["openrouter/<model>"].params.provider`).
 */
export const buildOpenClawOpenRouterModelParams = (
  model: string,
  privacy: OpenRouterPrivacyConfig,
): Record<string, { params: { provider: OpenRouterProviderRouting } }> => {
  const bareModel = model.replace(/^openrouter\//i, "");
  return {
    [`openrouter/${bareModel}`]: {
      params: {
        provider: buildOpenRouterProviderRouting(privacy),
      },
    },
  };
};
