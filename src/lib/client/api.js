/**
 * The one fetch wrapper every page uses. Parses the API error shape
 * `{error, message, retryAfter, field}` into an ApiError, maps a network
 * failure to code "offline", turns a 401 into a redirect to the sign-in page
 * (after letting open forms save their drafts), and supports cancellation.
 */
import { loginUrl } from "./next-path.js";
import { forgetSession } from "./local-data.js";

/** Error thrown by `api()`; `code` is the server's `error` field or a client code. */
export class ApiError extends Error {
  /**
   * @param {{code:string, message?:string, status?:number, retryAfter?:number|null, field?:string|null, data?:object}} init
   */
  constructor({ code, message, status = 0, retryAfter = null, field = null, data = null }) {
    super(message || code);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
    this.field = field;
    this.data = data;
  }
}

/** Fired on window just before a 401 redirect so drafts can be stashed. */
export const BEFORE_AUTH_REDIRECT = "aha:before-auth-redirect";

let redirecting = false;

function redirectToLogin() {
  if (typeof window === "undefined" || redirecting) return;
  redirecting = true;
  try {
    window.dispatchEvent(new Event(BEFORE_AUTH_REDIRECT));
  } catch {
    // a draft saver failing must not keep the user on a dead session
  }
  const here = window.location.pathname + window.location.search;
  // Cached API responses must not outlive the session (SEC-3); never let a
  // slow Cache API hold the user on a dead page.
  const go = () => window.location.replace(loginUrl(here, { reason: "expired" }));
  Promise.race([forgetSession(), new Promise((r) => setTimeout(r, 800))]).then(go, go);
}

function combineSignals(signals) {
  const live = signals.filter(Boolean);
  if (live.length <= 1) return live[0];
  if (typeof AbortSignal.any === "function") return AbortSignal.any(live);
  const controller = new AbortController();
  for (const s of live) {
    if (s.aborted) controller.abort(s.reason);
    else s.addEventListener("abort", () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}

function parseRetryAfter(body, response) {
  const fromBody = Number(body?.retryAfter);
  if (Number.isFinite(fromBody) && fromBody > 0) return Math.ceil(fromBody);
  const header = Number(response.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return Math.ceil(header);
  return null;
}

/**
 * @param {string} path same-origin API path, e.g. "/api/articles"
 * @param {{method?:string, body?:any, headers?:Object<string,string>, signal?:AbortSignal, timeoutMs?:number, redirectOn401?:boolean, keepalive?:boolean}} [options]
 *   `body` is sent as JSON, except a Blob/File, which is sent as-is with its own type (uploads).
 * @returns {Promise<any>} parsed JSON, or null for an empty body. Objects served
 *   from the service-worker cache carry a non-enumerable `__fromCache: true`.
 * @throws {ApiError} codes: server codes, plus "offline", "timeout", "aborted", "server_error"
 */
export async function api(path, { method = "GET", body, headers: extraHeaders, signal, timeoutMs = 0, redirectOn401 = true, keepalive } = {}) {
  const timeoutController = timeoutMs > 0 ? new AbortController() : null;
  const timer = timeoutController ? setTimeout(() => timeoutController.abort("timeout"), timeoutMs) : null;
  const isFile = typeof Blob !== "undefined" && body instanceof Blob;
  const headers = { Accept: "application/json", ...extraHeaders };
  if (isFile) headers["Content-Type"] = body.type || "application/octet-stream";
  else if (body !== undefined) headers["Content-Type"] = "application/json";

  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: isFile ? body : body !== undefined ? JSON.stringify(body) : undefined,
      signal: combineSignals([signal, timeoutController?.signal]),
      credentials: "same-origin",
      keepalive,
    });
  } catch (err) {
    if (timeoutController?.signal.aborted && !signal?.aborted) {
      throw new ApiError({ code: "timeout", message: "That took too long." });
    }
    if (signal?.aborted || err?.name === "AbortError") {
      throw new ApiError({ code: "aborted", message: "Cancelled." });
    }
    throw new ApiError({ code: "offline", message: "You're offline." });
  } finally {
    if (timer) clearTimeout(timer);
  }

  let data = null;
  const text = await response.text().catch(() => "");
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    if (response.status === 401 && redirectOn401) redirectToLogin();
    const fallbackCode =
      response.status === 401 ? "unauthenticated"
        : response.status === 403 ? "forbidden"
          : response.status === 404 ? "not_found"
            : response.status === 429 ? "rate_limited"
              : response.status >= 500 ? "server_error" : "invalid_input";
    throw new ApiError({
      code: typeof data?.error === "string" ? data.error : fallbackCode,
      message: typeof data?.message === "string" ? data.message : "",
      status: response.status,
      retryAfter: parseRetryAfter(data, response),
      field: typeof data?.field === "string" ? data.field : null,
      data,
    });
  }

  if (data && typeof data === "object" && response.headers.get("x-aha-from-cache") === "1") {
    Object.defineProperty(data, "__fromCache", { value: true, enumerable: false });
  }
  return data;
}

/**
 * Normalise anything thrown into an ApiError (render crashes, unexpected throws).
 * @param {unknown} err
 * @returns {ApiError}
 */
export function toApiError(err) {
  if (err instanceof ApiError) return err;
  return new ApiError({ code: "server_error", message: "" });
}
