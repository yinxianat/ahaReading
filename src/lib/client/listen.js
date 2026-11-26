/**
 * Browser helpers for Aha Listening: option labels and time formatting.
 */
export { LEVELS as LISTEN_LEVELS, STYLES as LISTEN_STYLES, PART_MINUTE_CHOICES } from "@/lib/listen-options.js";

/** 125 → "2:05"; 3725 → "1:02:05". */
export function formatClock(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** About-minutes label: 290 → "about 5 min". */
export function aboutMinutes(seconds) {
  return `about ${Math.max(1, Math.round((seconds || 0) / 60))} min`;
}

/** The spoken cue at the start of a part. */
export function partIntro(part, total) {
  const minutes = Math.max(1, Math.round((part.durationSec || 0) / 60));
  return `Part ${part.order + 1} of ${total}: ${part.title}. About ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}
