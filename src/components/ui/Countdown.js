"use client";
/**
 * Live countdown text and the "Try again" button that waits for it.
 * Screen readers hear the start and the end only, never every second.
 */
import { useEffect, useRef } from "react";
import { useCountdown, useOnline } from "@/lib/client/hooks.js";
import { announce } from "./announce.js";
import Button from "./Button.js";

/**
 * @param {number} s seconds
 * @param {"s"|"mmss"|"hm"} [format] "hm" is for long waits (daily quota): "3h 12m", "4m", "45s"
 */
export function formatSeconds(s, format = "s") {
  if (format === "hm") {
    if (s < 60) return `${s}s`;
    const totalMinutes = Math.ceil(s / 60);
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    if (h === 0) return `${m}m`;
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  if (format === "mmss") {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, "0")}`;
  }
  return `${s}s`;
}

/**
 * @param {{seconds:number, format?:"s"|"mmss"|"hm", onDone?:() => void}} props
 */
export default function Countdown({ seconds, format = "s", onDone }) {
  const left = useCountdown(seconds);
  const done = useRef(false);
  useEffect(() => {
    if (left === 0 && seconds > 0 && !done.current) {
      done.current = true;
      announce("You can try again now");
      onDone?.();
    }
  }, [left, seconds, onDone]);
  return (
    <span aria-hidden="true" className="font-semibold tabular-nums">
      {formatSeconds(left, format)}
    </span>
  );
}

/**
 * Disabled with "Try again in Ns" until the wait is over, then enabled.
 * Never auto-fires. With `waitForOnline` it also waits for connectivity.
 * @param {{retryAfter?:number|null, onRetry:() => void, label?:string, waitForOnline?:boolean, resetKey?:any, variant?:string, fullWidth?:boolean}} props
 */
export function RetryButton({ retryAfter, onRetry, label = "Try again", waitForOnline = false, resetKey, variant = "secondary", fullWidth, format = "s" }) {
  const left = useCountdown(retryAfter || 0, resetKey);
  const online = useOnline();
  const blockedByNetwork = waitForOnline && !online;
  return (
    <Button variant={variant} onClick={onRetry} disabled={left > 0 || blockedByNetwork} fullWidth={fullWidth}>
      {left > 0 ? `${label} in ${formatSeconds(left, format)}` : label}
    </Button>
  );
}
