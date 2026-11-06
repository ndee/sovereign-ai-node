import type { OpenRouterPrivacyConfig } from "../openclaw/openrouter-routing.js";

/**
 * Whether OpenRouter can serve a model under the node's routing restrictions.
 *
 * A model is servable when at least one of its OpenRouter endpoints survives
 * the restrictions the node sends with every request: the provider allow-list
 * (`only`) and, when zero data retention is on, OpenRouter's ZDR endpoint
 * list. Without such an endpoint every request for the model fails with
 * "No allowed providers are available for the selected model".
 *
 * `dataCollection` is not evaluated: OpenRouter publishes no per-endpoint
 * data policy, and with `zdr` on (the strict default) the ZDR list is the
 * stricter filter. Endpoint health (status, uptime) is not evaluated either:
 * an outage is transient, a routing mismatch is not.
 *
 * Only public metadata is read; the API key is never sent. A lookup that
 * cannot be completed is reported as `unknown`, never as `unservable`, so
 * callers can tell "OpenRouter says no" from "could not ask".
 */

export const OPENROUTER_API_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_TIMEOUT_MS = 10_000;
// The ZDR list covers every model OpenRouter serves (about 1 MB).
const DEFAULT_ZDR_TIMEOUT_MS = 20_000;
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:~-]*(\/[A-Za-z0-9._:~-]+)+$/;

export type OpenrouterServability =
  | { model: string; status: "servable"; endpoints: string[] }
  | {
      model: string;
      status: "unservable";
      /** `unknown-model`: OpenRouter does not list the model at all. */
      reason: "unknown-model" | "no-allowed-endpoint";
      /** Every endpoint tag OpenRouter lists for the model. */
      endpoints: string[];
    }
  | { model: string; status: "unknown"; message: string };

export interface OpenrouterServabilityChecker {
  /** One verdict per entry of `models`, in order; `model` echoes the input. */
  check(
    models: readonly string[],
    privacy: OpenRouterPrivacyConfig,
  ): Promise<OpenrouterServability[]>;
}

/** The OpenRouter model id for an OpenClaw model ref (`openrouter/<author>/<slug>`). */
export const openrouterLookupModelId = (ref: string): string => {
  const trimmed = ref.trim();
  const withoutProvider = trimmed.replace(/^openrouter\//i, "");
  return withoutProvider.includes("/") ? withoutProvider : trimmed;
};

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

type Endpoint = { modelId: string; tag: string };

type Lookup<T> = { ok: true; value: T } | { ok: false; message: string };

export class HttpOpenrouterServabilityChecker implements OpenrouterServabilityChecker {
  constructor(
    private readonly options: {
      fetch?: FetchLike;
      baseUrl?: string;
      timeoutMs?: number;
      zdrTimeoutMs?: number;
    } = {},
  ) {}

  async check(
    models: readonly string[],
    privacy: OpenRouterPrivacyConfig,
  ): Promise<OpenrouterServability[]> {
    if (models.length === 0) {
      return [];
    }
    const zdr = privacy.zdr ? await this.lookupZdrEndpoints() : undefined;
    const only = privacy.only?.map((entry) => entry.toLowerCase());
    const byModelId = new Map<string, Promise<Lookup<Endpoint[] | null>>>();
    return await Promise.all(
      models.map(async (model): Promise<OpenrouterServability> => {
        const modelId = openrouterLookupModelId(model);
        if (!SAFE_MODEL_ID.test(modelId)) {
          return {
            model,
            status: "unknown",
            message: `Model id ${modelId} cannot be looked up on OpenRouter`,
          };
        }
        if (zdr !== undefined && !zdr.ok) {
          return { model, status: "unknown", message: zdr.message };
        }
        let pending = byModelId.get(modelId);
        if (pending === undefined) {
          pending = this.lookupModelEndpoints(modelId);
          byModelId.set(modelId, pending);
        }
        const endpoints = await pending;
        if (!endpoints.ok) {
          return { model, status: "unknown", message: endpoints.message };
        }
        if (endpoints.value === null) {
          return { model, status: "unservable", reason: "unknown-model", endpoints: [] };
        }
        const allowed = endpoints.value.filter(
          (endpoint) =>
            isAllowedProvider(endpoint.tag, only) &&
            (zdr === undefined || zdr.value.has(zdrKey(endpoint))),
        );
        return allowed.length > 0
          ? { model, status: "servable", endpoints: allowed.map((endpoint) => endpoint.tag) }
          : {
              model,
              status: "unservable",
              reason: "no-allowed-endpoint",
              endpoints: endpoints.value.map((endpoint) => endpoint.tag),
            };
      }),
    );
  }

  /** `null` value: OpenRouter does not know the model (HTTP 404). */
  private async lookupModelEndpoints(modelId: string): Promise<Lookup<Endpoint[] | null>> {
    const response = await this.getJson(
      `/models/${modelId}/endpoints`,
      "the model endpoint lookup",
      this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      true,
    );
    if (!response.ok) {
      return response;
    }
    if (response.value === null) {
      return { ok: true, value: null };
    }
    const data = isRecord(response.value) ? response.value.data : undefined;
    if (!isRecord(data) || !Array.isArray(data.endpoints)) {
      return unexpected("the model endpoint lookup");
    }
    return { ok: true, value: readEndpoints(data.endpoints) };
  }

  private async lookupZdrEndpoints(): Promise<Lookup<Set<string>>> {
    const subject = "the zero-data-retention endpoint lookup";
    const response = await this.getJson(
      "/endpoints/zdr",
      subject,
      this.options.zdrTimeoutMs ?? DEFAULT_ZDR_TIMEOUT_MS,
      false,
    );
    if (!response.ok) {
      return response;
    }
    const data = isRecord(response.value) ? response.value.data : undefined;
    if (!Array.isArray(data)) {
      return unexpected(subject);
    }
    return { ok: true, value: new Set(readEndpoints(data).map(zdrKey)) };
  }

  private async getJson(
    path: string,
    subject: string,
    timeoutMs: number,
    notFoundIsNull: boolean,
  ): Promise<Lookup<unknown>> {
    const fetchImpl = this.options.fetch ?? (globalThis.fetch as FetchLike);
    const baseUrl = this.options.baseUrl ?? OPENROUTER_API_BASE_URL;
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (notFoundIsNull && response.status === 404) {
        await response.body?.cancel().catch(() => {});
        return { ok: true, value: null };
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        return {
          ok: false,
          message: `OpenRouter responded with HTTP ${String(response.status)} to ${subject}`,
        };
      }
      try {
        return { ok: true, value: await response.json() };
      } catch {
        return unexpected(subject);
      }
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      return {
        ok: false,
        message: timedOut
          ? `Timed out contacting OpenRouter for ${subject}`
          : `Could not reach OpenRouter for ${subject}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const unexpected = (subject: string): { ok: false; message: string } => ({
  ok: false,
  message: `OpenRouter returned an unexpected answer to ${subject}`,
});

const readEndpoints = (entries: unknown[]): Endpoint[] =>
  entries.flatMap((entry) =>
    isRecord(entry) &&
    typeof entry.tag === "string" &&
    entry.tag.length > 0 &&
    typeof entry.model_id === "string"
      ? [{ modelId: entry.model_id, tag: entry.tag }]
      : [],
  );

const zdrKey = (endpoint: Endpoint): string => `${endpoint.modelId}\u0000${endpoint.tag}`;

// OpenRouter accepts a provider slug ("nebius") or an exact endpoint tag
// ("nebius/fp8") in `provider.only`; an endpoint tag is "<slug>[/<variant>]".
const isAllowedProvider = (tag: string, only: string[] | undefined): boolean => {
  if (only === undefined) {
    return true;
  }
  const normalized = tag.toLowerCase();
  const slug = normalized.split("/")[0];
  return only.some((entry) => entry === normalized || entry === slug);
};
