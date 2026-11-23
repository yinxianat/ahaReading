/**
 * AI provider failures come in kinds with opposite handling:
 *
 *   INFRASTRUCTURE — timeout, network, auth, quota, rate limit, 5xx, empty reply.
 *     The content was never fairly judged, so the next provider may succeed: fail over.
 *   REFUSAL — the provider evaluated the content and declined. Asking another provider
 *     is shopping for a yes, so the chain stops.
 *   INVALID_OUTPUT — the provider answered, but the answer failed our output checks.
 *     Treated as a quality failure for this request (502), not a provider outage.
 *
 * Classification belongs in each adapter, because only the adapter knows its API's
 * error shape. The chain reads nothing but `kind`.
 */
export const ErrorKind = Object.freeze({
  INFRASTRUCTURE: "INFRASTRUCTURE",
  REFUSAL: "REFUSAL",
  INVALID_OUTPUT: "INVALID_OUTPUT",
});

export class ProviderError extends Error {
  /**
   * @param {string} kind one of ErrorKind
   * @param {string} provider provider name ("anthropic", "openai", "google", "mock", "chain")
   * @param {unknown} [cause] original error or a summary Error
   */
  constructor(kind, provider, cause) {
    super(`${provider}: ${kind} — ${cause?.message || "unknown"}`);
    this.name = "ProviderError";
    this.kind = kind;
    this.provider = provider;
    this.cause = cause;
  }
}

// "Misconfigured or out of capacity" — always infrastructure whatever status carries it.
// Gemini reports an invalid key as HTTP 400 / API_KEY_INVALID / INVALID_ARGUMENT; treating
// that as a refusal would stop the chain on a typo'd key instead of failing over.
const CONFIG_OR_CAPACITY =
  /api[\s_-]?key|unauthenticated|unauthorized|permission[\s_-]?denied|forbidden|quota|billing|rate[\s_-]?limit|exceeded|insufficient|expired|credential|invalid[\s_-]?argument|overloaded/i;

/**
 * Classify a non-2xx provider HTTP response.
 * @param {number} status HTTP status code
 * @param {string|object} [body] raw or parsed response body
 * @param {{refusalOn400?: boolean}} [options] whether an unmatched 400 from THIS provider
 *   can mean "content declined on its merits" (false for providers that signal blocks on 200)
 * @returns {string} ErrorKind.INFRASTRUCTURE or ErrorKind.REFUSAL
 */
export function classifyHttp(status, body = "", { refusalOn400 = false } = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
  if (status >= 500 || [401, 403, 408, 409, 429].includes(status)) return ErrorKind.INFRASTRUCTURE;
  if (CONFIG_OR_CAPACITY.test(text)) return ErrorKind.INFRASTRUCTURE;
  if (status === 400 && refusalOn400) return ErrorKind.REFUSAL;
  return ErrorKind.INFRASTRUCTURE;
}

function msFromEnv(name, fallback) {
  const parsed = parseInt(process.env[name] || "", 10);
  if (!Number.isFinite(parsed) || parsed < 1000) return fallback;
  return Math.min(parsed, 120_000);
}

/**
 * Per-provider timeout, from AI_TIMEOUT_MS (clamped 1s..120s; blank/garbage → 12s).
 * Short enough that a hung first provider leaves time to fail over inside the chain deadline.
 * @returns {number}
 */
export function providerTimeoutMs() {
  return msFromEnv("AI_TIMEOUT_MS", 12_000);
}

/**
 * Whole-chain deadline, from AI_CHAIN_DEADLINE_MS (clamped 1s..120s; default 25s). The
 * client gives up at 35s, so the server must answer (success or 503) before that.
 * @returns {number}
 */
export function chainDeadlineMs() {
  return msFromEnv("AI_CHAIN_DEADLINE_MS", 25_000);
}

/** @returns {ProviderError} INFRASTRUCTURE "request timed out" */
export function timeoutError(provider) {
  return new ProviderError(ErrorKind.INFRASTRUCTURE, provider, new Error("request timed out"));
}

/**
 * Run a provider fetch and turn transport failures (DNS, reset, timeout) into
 * INFRASTRUCTURE errors so the chain can fail over. Uses the chain's `init.signal`
 * (which carries this attempt's share of the deadline), else the per-provider timeout.
 * @param {string} provider
 * @param {string} url
 * @param {RequestInit} init
 * @returns {Promise<Response>}
 */
export async function providerFetch(provider, url, init) {
  try {
    return await fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(providerTimeoutMs()) });
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") throw timeoutError(provider);
    throw new ProviderError(ErrorKind.INFRASTRUCTURE, provider, err);
  }
}

/**
 * Throw a classified ProviderError for a non-2xx response.
 * @param {string} provider
 * @param {Response} res
 * @param {{refusalOn400?: boolean}} [options]
 */
export async function throwHttpError(provider, res, options) {
  const body = await res.text().catch(() => "");
  const kind = classifyHttp(res.status, body, options);
  throw new ProviderError(kind, provider, new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`));
}
