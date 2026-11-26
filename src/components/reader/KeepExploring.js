"use client";
/**
 * "Keep exploring" after a deep dive: three ways to continue the explanation on
 * screen. Each choice is a follow-up request (POST /api/explain with followUp +
 * basedOn); ExplainPanel owns the requests and which view is showing.
 */
import { useId } from "react";
import Icon from "@/components/ui/icons.js";

// Keys match FOLLOW_UPS in src/lib/ai/explain-prompt.js (the server rejects any other).
export const FOLLOW_UPS = [
  { key: "deeper", label: "Go deeper", hint: "How it works underneath, edge cases, an example", icon: "layers", loading: "Going deeper…" },
  { key: "big_picture", label: "See the bigger picture", hint: "Where it fits and why it matters", icon: "search", loading: "Zooming out…" },
  { key: "related", label: "Expand the topic", hint: "Related ideas to learn next", icon: "plus", loading: "Finding related topics…" },
];
export const FOLLOW_BY_KEY = Object.fromEntries(FOLLOW_UPS.map((f) => [f.key, f]));

/**
 * @param {{current: string|null, onPick: (key: string) => void, disabled?: boolean}} props
 *   current: the follow-up on screen (its button reads "… again"), or null on the deep dive
 */
export default function KeepExploring({ current, onPick, disabled = false }) {
  const id = useId();
  return (
    <section className="mt-6 border-t border-border pt-4" aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`} className="text-[15px] font-semibold">
        Keep exploring
      </h3>
      <p className="mt-0.5 text-[14px] text-muted">Pick where to go next with this idea.</p>
      <ul className="mt-3 grid gap-2">
        {FOLLOW_UPS.map((f) => {
          const here = current === f.key;
          return (
            <li key={f.key}>
              <button
                type="button"
                onClick={() => onPick(f.key)}
                disabled={disabled}
                aria-describedby={`${id}-${f.key}`}
                className="flex min-h-[56px] w-full items-center gap-3 rounded-md border border-border bg-surface px-3 py-2 text-left hover:border-accent disabled:opacity-50"
              >
                <span className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-full bg-accent-soft text-accent" aria-hidden="true">
                  <Icon name={f.icon} size={18} />
                </span>
                <span className="min-w-0">
                  <span className="block font-semibold break-words">{here ? `${f.label} again` : f.label}</span>
                  {/* The hint is the button's description, not part of its name. */}
                  <span id={`${id}-${f.key}`} aria-hidden="true" className="block text-[13px] text-muted">
                    {here ? "Continue from this answer" : f.hint}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
