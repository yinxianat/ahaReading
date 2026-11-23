import { ProviderError, ErrorKind } from "./errors.js";
import { jsonError } from "@/lib/http.js";

/**
 * Map a runChain failure to the API error contract (422 / 502 / 503), with a
 * recovery-naming message. Non-ProviderErrors are rethrown so withErrorHandling logs them.
 * @param {unknown} err
 * @param {"explain"|"translate"} task
 * @returns {Response}
 */
export function aiErrorResponse(err, task) {
  if (!(err instanceof ProviderError)) throw err;
  if (err.kind === ErrorKind.REFUSAL) {
    return jsonError(
      422,
      "content_refused",
      task === "translate"
        ? "We couldn't translate this explanation. You can still read it in English."
        : "We couldn't generate an explanation for this text. Try highlighting a different section."
    );
  }
  if (err.kind === ErrorKind.INVALID_OUTPUT) {
    return jsonError(
      502,
      task === "translate" ? "translation_failed" : "explanation_failed",
      task === "translate"
        ? "We had trouble producing a clear translation. Please try again."
        : "We had trouble generating a clear explanation. Please try again."
    );
  }
  return jsonError(
    503,
    "ai_unavailable",
    "Our AI service is temporarily unavailable. Please try again in 30 seconds.",
    { retryAfter: 30 },
    { "Retry-After": "30" }
  );
}
