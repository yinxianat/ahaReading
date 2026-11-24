"use client";
/**
 * Inline alert for an ApiError: copy from errors.js, live countdown for
 * rate_limited / ai_unavailable, and the recovery buttons the code calls for.
 */
import { useMemo } from "react";
import { describeError } from "@/lib/client/errors.js";
import Alert from "./Alert.js";
import Countdown, { RetryButton, formatSeconds } from "./Countdown.js";
import Button from "./Button.js";

function renderMessage(view, resetKey, plain) {
  const parts = view.message.split("{countdown}");
  if (parts.length === 1) return view.message;
  // The ticking text is aria-hidden (no per-second chatter), so screen readers
  // get the whole sentence once instead of "Try again in ." with a gap.
  return (
    <>
      <span aria-hidden="true">
        {parts[0]}
        <Countdown key={resetKey} seconds={view.retryAfter || 0} format={view.countdownFormat || "s"} />
        {parts[1]}
      </span>
      <span className="sr-only">{plain}</span>
    </>
  );
}

// The screen-reader sentence is read once, so it must not name a number of seconds that
// is stale a moment later; the Try again button says when it is ready. Hour-long waits
// (daily limits) stay specific: they don't go stale while being read.
function spokenWait(view) {
  const seconds = view.retryAfter || 0;
  if (view.countdownFormat === "hm") return formatSeconds(seconds, "hm");
  if (view.countdownFormat === "mmss") return "a moment";
  return seconds > 90 ? "a few minutes" : "a few seconds";
}

/**
 * One announcement per error: role="alert" makes screen readers read it when it appears
 * (a second copy through announce() was read twice).
 * @param {object} props
 * @param {any} props.error ApiError
 * @param {string} props.context errors.js context
 * @param {() => void} [props.onRetry]
 * @param {() => void} [props.onPickText] for content_refused / invalid selection
 * @param {() => void} [props.onPasteInstead] Import tab
 * @param {() => void} [props.onDismiss]
 * @param {Array<{label:string, onClick?:() => void, href?:string}>} [props.extraActions]
 * @param {boolean} [props.compact]
 */
export default function ErrorAlert({ error, context, onRetry, onPickText, onPasteInstead, onDismiss, extraActions = [], compact, className = "" }) {
  const view = useMemo(() => describeError(error, context), [error, context]);
  const plain = view.message.replace("{countdown}", spokenWait(view));

  return (
    <Alert tone={view.tone} compact={compact} onDismiss={onDismiss} className={className} role="alert">
      <p>{renderMessage(view, error, plain)}</p>
      {view.sub ? <p className="mt-1 text-muted text-[14px]">{view.sub}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {view.recovery === "pick_text" && onPickText ? (
          <Button variant="secondary" onClick={onPickText}>
            Pick different text
          </Button>
        ) : null}
        {onPasteInstead && (view.recovery === "paste_instead" || context === "import" || context === "upload") ? (
          <Button variant="secondary" onClick={onPasteInstead}>
            Paste text instead
          </Button>
        ) : null}
        {onRetry && view.recovery === "retry" ? (
          <RetryButton retryAfter={view.retryAfter} waitForOnline={view.waitForOnline} onRetry={onRetry} resetKey={error} format={view.countdownFormat || "s"} />
        ) : null}
        {onRetry && view.recovery === "none" && error?.code !== "not_found" && error?.code !== "forbidden" && context !== "translate" ? (
          <Button variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
        {extraActions.map((a) => (
          <Button key={a.label} variant="text" onClick={a.onClick} href={a.href}>
            {a.label}
          </Button>
        ))}
      </div>
    </Alert>
  );
}
