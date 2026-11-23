"use client";
/**
 * 1 Simple · 2 Analogy · 3 Deep dive. Fetched levels are revisitable, and
 * every level below the highest one reached can be tapped (fetched on demand)
 * so "simpler" is always possible (PO-2). Unfetched deeper levels are reached
 * only through "Still confused".
 */
import { useRef } from "react";

export const LEVEL_NAMES = { 1: "Simple", 2: "Analogy", 3: "Deep dive" };

/**
 * @param {{level:number, fetchedLevels:number[], reachableBelow?:number, onSelect:(n:number) => void, disabled?:boolean}} props
 *   reachableBelow: levels lower than this are tappable even when not fetched yet
 *   disabled: offline — only already-fetched levels stay tappable
 */
export default function LevelStepper({ level, fetchedLevels, reachableBelow = 0, onSelect, disabled = false }) {
  const refs = useRef([]);
  const reachable = (n) => fetchedLevels.includes(n) || (!disabled && n < reachableBelow);
  const move = (e, i) => {
    const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    for (let n = i + dir; n >= 1 && n <= 3; n += dir) {
      if (reachable(n)) {
        onSelect(n);
        refs.current[n]?.focus();
        return;
      }
    }
  };
  return (
    <div role="radiogroup" aria-label={`Help level ${level} of 3, ${LEVEL_NAMES[level]}`} className="flex min-w-0 gap-1">
      {[1, 2, 3].map((n) => {
        const fetched = fetchedLevels.includes(n);
        const canGo = reachable(n);
        const current = n === level;
        return (
          <button
            key={n}
            ref={(el) => {
              refs.current[n] = el;
            }}
            type="button"
            role="radio"
            aria-checked={current}
            aria-label={`Level ${n}, ${LEVEL_NAMES[n]}`}
            disabled={!canGo && !current}
            tabIndex={current ? 0 : -1}
            onClick={() => (canGo || current) && onSelect(n)}
            onKeyDown={(e) => move(e, n)}
            // 36px visible, 44px hit area (PO-15): the pseudo-element extends the target.
            className={`relative min-h-[36px] min-w-0 rounded-sm px-2 text-[13px] whitespace-nowrap transition-colors before:absolute before:inset-x-0 before:-inset-y-1 before:content-[''] ${
              current ? "bg-accent-soft font-bold text-accent" : canGo ? `text-text hover:bg-surface-2 ${fetched ? "" : "underline decoration-dotted underline-offset-4"}` : "text-muted opacity-60"
            }`}
          >
            <span className="tabular-nums">{n}</span> {LEVEL_NAMES[n]}
          </button>
        );
      })}
    </div>
  );
}
