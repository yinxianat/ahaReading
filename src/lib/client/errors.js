/**
 * Error code → user copy and recovery, the single source of error wording
 * (UX-SPEC 5). Components decide which buttons to render from `recovery`.
 */

const GENERIC = "Something went wrong on our side. Please try again.";

/**
 * @typedef {object} ErrorView
 * @property {"info"|"warning"|"danger"|"neutral"} tone
 * @property {string} message
 * @property {string} [sub]
 * @property {number|null} retryAfter seconds to wait before "Try again" enables
 * @property {boolean} waitForOnline "Try again" enables on the `online` event
 * @property {"retry"|"pick_text"|"paste_instead"|"later"|"none"} recovery
 *   "later" = waiting is the only fix (daily quota): no Try again button, the
 *   caller's extra actions (Open Notebook, Show English…) are the way out.
 * @property {"s"|"mmss"|"hm"} [countdownFormat]
 */

/** Client timeout for explain/translate: above the server's 25s chain deadline (TEAM-BRIEF round 2 #3). */
export const AI_CLIENT_TIMEOUT_MS = 35000;

/**
 * @param {{code?:string, message?:string, retryAfter?:number|null}} err an ApiError
 * @param {"explain"|"translate"|"save"|"login"|"code"|"articles"|"import"|"upload"|"form"|"load"|"settings"|"review"} context
 * @returns {ErrorView}
 */
export function describeError(err, context = "load") {
  const code = err?.code || "server_error";
  const serverMessage = err?.message && err.message !== code ? err.message : "";
  const ai = context === "explain" || context === "translate";

  switch (code) {
    case "rate_limited": {
      const retryAfter = err?.retryAfter || 15;
      if (context === "code") {
        return { tone: "warning", message: "Too many attempts. Try again in {countdown}.", retryAfter, waitForOnline: false, recovery: "retry", countdownFormat: "mmss" };
      }
      if (context === "login") {
        return { tone: "warning", message: "Too many sign-in requests. Try again in {countdown}.", retryAfter, waitForOnline: false, recovery: "retry", countdownFormat: "mmss" };
      }
      if (context === "articles" || context === "import" || context === "upload") {
        return { tone: "warning", message: "You've added a lot of articles in a minute. Try again in {countdown}.", retryAfter, waitForOnline: false, recovery: "retry" };
      }
      return { tone: "warning", message: "You're going a bit fast. You can try again in {countdown}.", retryAfter, waitForOnline: false, recovery: "retry" };
    }
    case "daily_limit": {
      const retryAfter = err?.retryAfter || 3600;
      if (context === "translate") {
        return { tone: "warning", message: "You've used today's translations. 今日翻译次数已用完。 More in {countdown}.", sub: "The English explanation is still here.", retryAfter, waitForOnline: false, recovery: "later", countdownFormat: "hm" };
      }
      return {
        tone: "warning",
        message: "You've reached today's limit for explanations. More in {countdown}.",
        sub: "Your Notebook and Review still work.",
        retryAfter,
        waitForOnline: false,
        recovery: "later",
        countdownFormat: "hm",
      };
    }
    case "code_locked":
      return { tone: "danger", message: "Too many wrong codes. Send a new link to get a fresh code.", retryAfter: null, waitForOnline: false, recovery: "none" };
    case "code_invalid":
      return { tone: "danger", message: serverMessage || "That code isn't right. Check the email and try again.", retryAfter: null, waitForOnline: false, recovery: "none" };
    case "link_expired":
      if (context === "code") {
        return { tone: "danger", message: "This code has expired. Send a new link to get a fresh code.", retryAfter: null, waitForOnline: false, recovery: "none" };
      }
      return { tone: "danger", message: "This link has expired. Request a new one.", retryAfter: null, waitForOnline: false, recovery: "none" };
    case "link_used":
      if (context === "code") {
        return { tone: "danger", message: "This code was already used. Send a new link to sign in again.", retryAfter: null, waitForOnline: false, recovery: "none" };
      }
      return { tone: "danger", message: "This link was already used. Request a new one.", retryAfter: null, waitForOnline: false, recovery: "none" };
    case "link_invalid":
      if (context === "code") {
        return { tone: "danger", message: "That code doesn't match this email. Check both, or send a new link.", retryAfter: null, waitForOnline: false, recovery: "none" };
      }
      return { tone: "danger", message: "This link isn't valid. Request a new one.", retryAfter: null, waitForOnline: false, recovery: "none" };
    case "ai_unavailable":
      if (context === "translate") {
        return { tone: "warning", message: "Translation isn't available right now. 翻译暂时不可用。", retryAfter: err?.retryAfter || 30, waitForOnline: false, recovery: "retry" };
      }
      return {
        tone: "warning",
        message: "Our AI helper is temporarily unavailable. We'll be ready to try again in {countdown}.",
        sub: "Your Notebook and Review still work.",
        retryAfter: err?.retryAfter || 30,
        waitForOnline: false,
        recovery: "retry",
      };
    case "content_refused":
      if (context === "translate") {
        return { tone: "info", message: "We couldn't translate this explanation. You can still read it in English.", retryAfter: null, waitForOnline: false, recovery: "none" };
      }
      return { tone: "info", message: "We can't explain this passage. Try selecting a different part of the text.", retryAfter: null, waitForOnline: false, recovery: "pick_text" };
    case "explanation_failed":
      if (context === "translate") {
        return { tone: "danger", message: "Translation isn't available right now. 翻译暂时不可用。", retryAfter: null, waitForOnline: false, recovery: "retry" };
      }
      return { tone: "danger", message: "We had trouble writing a clear explanation. Trying again usually works.", retryAfter: null, waitForOnline: false, recovery: "retry" };
    case "timeout":
      if (context === "translate") {
        return { tone: "danger", message: "Translation took too long. 翻译超时。 Trying again usually works.", retryAfter: null, waitForOnline: false, recovery: "retry" };
      }
      return { tone: "danger", message: "That took too long. Trying again usually works.", retryAfter: null, waitForOnline: false, recovery: "retry" };
    case "offline":
      if (ai) {
        return { tone: "warning", message: "You're offline. Explanations need an internet connection.", retryAfter: null, waitForOnline: true, recovery: "retry" };
      }
      if (context === "code") {
        return { tone: "warning", message: "You're offline. Connect to the internet, then enter the code again.", retryAfter: null, waitForOnline: true, recovery: "retry" };
      }
      if (context === "login") {
        return { tone: "warning", message: "You're offline. Connect to the internet to get a sign-in link.", retryAfter: null, waitForOnline: true, recovery: "retry" };
      }
      if (context === "load") {
        return { tone: "warning", message: "You're offline, and there's no saved copy of this yet.", retryAfter: null, waitForOnline: true, recovery: "retry" };
      }
      return { tone: "warning", message: "You're offline. We'll be able to send this once you reconnect.", retryAfter: null, waitForOnline: true, recovery: "retry" };
    case "invalid_input":
      if (context === "explain") {
        return { tone: "danger", message: serverMessage || "That selection can't be explained. Select a shorter phrase.", retryAfter: null, waitForOnline: false, recovery: "pick_text" };
      }
      return { tone: "danger", message: serverMessage || "Check what you entered and try again.", retryAfter: null, waitForOnline: false, recovery: "none" };
    case "upload_in_progress":
      return { tone: "warning", message: "Another file is still uploading. Wait for it to finish, then try again.", retryAfter: err?.retryAfter || 5, waitForOnline: false, recovery: "retry" };
    case "server_busy":
      return { tone: "warning", message: "We're reading a lot of files right now. Try again in {countdown}.", retryAfter: err?.retryAfter || 10, waitForOnline: false, recovery: "retry" };
    case "upload_interrupted":
      return { tone: "warning", message: serverMessage || "The upload stopped before the whole file arrived. Check your connection and try again.", retryAfter: null, waitForOnline: false, recovery: "retry" };
    case "file_unsupported":
      return { tone: "danger", message: serverMessage || "We can read PDF and Word (.docx) files. For anything else, paste the text instead.", retryAfter: null, waitForOnline: false, recovery: "paste_instead" };
    case "file_too_large":
      return { tone: "danger", message: serverMessage || "That file is too large. Upload a smaller file, or paste the part you want to read.", retryAfter: null, waitForOnline: false, recovery: "paste_instead" };
    case "file_unreadable":
      return { tone: "danger", message: serverMessage || "We couldn't read the text in that file. Paste the text instead.", retryAfter: null, waitForOnline: false, recovery: "paste_instead" };
    case "url_blocked":
      return { tone: "danger", message: serverMessage || "That address can't be imported. Use a public http or https link.", retryAfter: null, waitForOnline: false, recovery: "paste_instead" };
    case "url_unreachable":
      return { tone: "danger", message: serverMessage || "We couldn't reach that page. Check the link, or paste the text instead.", retryAfter: null, waitForOnline: false, recovery: "retry" };
    case "url_not_readable":
      return { tone: "danger", message: serverMessage || "We couldn't find readable text on that page. It may need a login. Paste the text instead.", retryAfter: null, waitForOnline: false, recovery: "paste_instead" };
    case "not_found":
      if (context === "translate") {
        return { tone: "neutral", message: "This explanation expired. Ask again to translate it.", retryAfter: null, waitForOnline: false, recovery: "none" };
      }
      if (context === "explain") {
        return { tone: "danger", message: "This article isn't in your Library any more.", sub: "Go back to your Library and open it again.", retryAfter: null, waitForOnline: false, recovery: "none" };
      }
      if (context === "save") {
        return { tone: "danger", message: "This explanation expired before it was saved.", sub: "Ask for the explanation again, then save it.", retryAfter: null, waitForOnline: false, recovery: "none" };
      }
      return { tone: "danger", message: "We can't find that.", sub: "It may have been deleted.", retryAfter: null, waitForOnline: false, recovery: "none" };
    case "forbidden":
      return { tone: "danger", message: "You don't have access to that.", retryAfter: null, waitForOnline: false, recovery: "none" };
    case "unauthenticated":
      return { tone: "info", message: "Your session ended. Sign in again to pick up where you left off.", retryAfter: null, waitForOnline: false, recovery: "none" };
    case "aborted":
      return { tone: "neutral", message: "Cancelled.", retryAfter: null, waitForOnline: false, recovery: "retry" };
    default:
      if (context === "settings" && !(err?.status >= 400 && err?.status < 500 && serverMessage)) {
        return { tone: "danger", message: "Couldn't save that.", retryAfter: null, waitForOnline: false, recovery: "retry" };
      }
      if (ai && context === "translate") {
        return { tone: "danger", message: "Translation isn't available right now. 翻译暂时不可用。", retryAfter: null, waitForOnline: false, recovery: "retry" };
      }
      // 400-class codes we don't know yet still carry a message that names the fix.
      if (err?.status >= 400 && err?.status < 500 && serverMessage) {
        return { tone: "danger", message: serverMessage, retryAfter: null, waitForOnline: false, recovery: "retry" };
      }
      return { tone: "danger", message: GENERIC, retryAfter: null, waitForOnline: false, recovery: "retry" };
  }
}

export const GENERIC_ERROR = GENERIC;
