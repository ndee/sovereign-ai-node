import type { ErrorDetail } from "../contracts/common.js";
import type { TestOpenrouterResult } from "../contracts/install.js";

/**
 * Lightweight OpenRouter API key validation.
 *
 * `GET /api/v1/auth/key` is OpenRouter's documented, side-effect-free way to
 * inspect the key the request was made with: it costs no credits, creates no
 * completion, and answers 401 for an unknown key. The key travels only in the
 * Authorization header of this one outbound request; it is never logged and
 * never echoed back — the result carries at most the free-form label
 * OpenRouter attached to the key.
 */

export const OPENROUTER_KEY_ENDPOINT = "https://openrouter.ai/api/v1/auth/key";
const DEFAULT_TIMEOUT_MS = 10_000;

export interface OpenrouterKeyValidator {
  validate(apiKey: string): Promise<TestOpenrouterResult>;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export class HttpOpenrouterKeyValidator implements OpenrouterKeyValidator {
  constructor(
    private readonly options: {
      fetch?: FetchLike;
      endpoint?: string;
      timeoutMs?: number;
    } = {},
  ) {}

  async validate(apiKey: string): Promise<TestOpenrouterResult> {
    const fetchImpl = this.options.fetch ?? (globalThis.fetch as FetchLike);
    const endpoint = this.options.endpoint ?? OPENROUTER_KEY_ENDPOINT;
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        return { ok: false, error: invalidKeyError() };
      }
      if (!response.ok) {
        return {
          ok: false,
          error: {
            code: "OPENROUTER_KEY_CHECK_FAILED",
            message: `OpenRouter responded with HTTP ${String(response.status)} while checking the key`,
            retryable: response.status >= 500 || response.status === 429,
            details: { status: response.status },
          },
        };
      }
      const label = await readLabel(response);
      return { ok: true, ...(label === undefined ? {} : { label }) };
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      return {
        ok: false,
        error: {
          code: aborted ? "OPENROUTER_KEY_CHECK_TIMEOUT" : "OPENROUTER_KEY_CHECK_FAILED",
          message: aborted
            ? "Timed out contacting OpenRouter to check the key"
            : `Could not reach OpenRouter to check the key: ${error instanceof Error ? error.message : String(error)}`,
          retryable: true,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

const invalidKeyError = (): ErrorDetail => ({
  code: "OPENROUTER_KEY_INVALID",
  message: "OpenRouter rejected the API key",
  retryable: false,
});

const readLabel = async (response: Response): Promise<string | undefined> => {
  try {
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) {
      return undefined;
    }
    const data = (body as { data?: unknown }).data;
    if (typeof data !== "object" || data === null) {
      return undefined;
    }
    const label = (data as { label?: unknown }).label;
    return typeof label === "string" && label.length > 0 ? label : undefined;
  } catch {
    return undefined;
  }
};
