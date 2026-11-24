"use client";
/**
 * Tablist with roving focus (arrow keys, Home/End) and a Segmented switch
 * built on radio semantics.
 */
import { useRef } from "react";

function rove(e, index, count, select) {
  let next = null;
  if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (index + 1) % count;
  else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (index - 1 + count) % count;
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = count - 1;
  if (next === null) return;
  e.preventDefault();
  select(next);
}

/**
 * `shortLabel` is shown instead of `label` on phone-width screens (the accessible name stays
 * `label`); with short labels the tabs share the width equally, so every tab is visible
 * without sideways scrolling.
 * @param {{tabs:Array<{id:string,label:string,shortLabel?:string,badge?:any}>, value:string, onChange:(id:string) => void, ariaLabel:string, idPrefix?:string}} props
 */
export default function Tabs({ tabs, value, onChange, ariaLabel, idPrefix = "tab", className = "" }) {
  const refs = useRef([]);
  const compact = tabs.some((t) => t.shortLabel);
  return (
    <div className={`scroll-x ${className}`}>
      <div role="tablist" aria-label={ariaLabel} className={`flex gap-1 border-b border-border ${compact ? "w-max min-w-full" : "min-w-max"}`}>
        {tabs.map((t, i) => {
          const selected = t.id === value;
          return (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${idPrefix}-${t.id}`}
              aria-selected={selected}
              aria-controls={`${idPrefix}-panel-${t.id}`}
              aria-label={t.shortLabel ? t.label : undefined}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(t.id)}
              onKeyDown={(e) =>
                rove(e, i, tabs.length, (n) => {
                  onChange(tabs[n].id);
                  refs.current[n]?.focus();
                })
              }
              className={`-mb-px inline-flex min-h-[44px] items-center gap-2 whitespace-nowrap border-b-2 px-3 font-semibold ${
                compact ? "flex-1 justify-center sm:flex-none sm:justify-start" : ""
              } ${
                selected ? "border-accent text-accent" : "border-transparent text-muted hover:text-text"
              }`}
            >
              {t.shortLabel ? (
                <>
                  <span className="sm:hidden">{t.shortLabel}</span>
                  <span className="hidden sm:inline">{t.label}</span>
                </>
              ) : (
                t.label
              )}
              {t.badge != null ? t.badge : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * @param {{options:Array<{value:any,label:any, ariaLabel?:string}>, value:any, onChange:(v:any) => void, ariaLabel:string, size?:"sm"|"md", disabled?:boolean}} props
 */
export function Segmented({ options, value, onChange, ariaLabel, size = "md", disabled = false, className = "" }) {
  const refs = useRef([]);
  const current = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={`inline-flex max-w-full rounded-md bg-surface-2 p-1 ${className}`}>
      {options.map((o, i) => {
        const checked = o.value === value;
        return (
          <button
            key={String(o.value)}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={o.ariaLabel}
            tabIndex={i === current ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) =>
              rove(e, i, options.length, (n) => {
                onChange(options[n].value);
                refs.current[n]?.focus();
              })
            }
            className={`relative min-w-0 flex-1 rounded-sm px-3 font-semibold whitespace-nowrap transition-colors disabled:opacity-50 ${
              size === "sm" ? "min-h-[36px] text-[14px] after:absolute after:-inset-y-1 after:inset-x-0" : "min-h-[40px] text-[15px]"
            } ${checked ? "bg-surface text-accent shadow-1" : "text-muted hover:text-text"}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
