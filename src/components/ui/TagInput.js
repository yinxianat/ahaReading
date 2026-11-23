"use client";
/**
 * Chip entry for tags: Enter / comma / blur adds; ✕ removes. Tags are
 * lowercased and trimmed, at most `max` of `maxLength` chars each.
 */
import { useId, useState } from "react";
import Icon from "./icons.js";

/** @param {string} raw */
export function normaliseTag(raw) {
  return String(raw || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * @param {{value:string[], onChange:(tags:string[]) => void, suggestions?:string[], max?:number, maxLength?:number, label?:string, disabled?:boolean}} props
 */
export default function TagInput({ value, onChange, suggestions = [], max = 10, maxLength = 50, label = "Tags", disabled = false }) {
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState("");
  const id = useId();

  const add = (raw) => {
    const parts = String(raw).split(",").map(normaliseTag).filter(Boolean);
    if (parts.length === 0) return;
    let next = [...value];
    for (const p of parts) {
      if (p.length > maxLength) {
        setNote(`Each tag can be up to ${maxLength} characters.`);
        continue;
      }
      if (next.includes(p)) continue;
      if (next.length >= max) {
        setNote(`Up to ${max} tags.`);
        break;
      }
      next = [...next, p];
    }
    onChange(next);
    setDraft("");
  };
  const remove = (tag) => {
    setNote("");
    onChange(value.filter((t) => t !== tag));
  };
  const unused = suggestions.filter((s) => !value.includes(s)).slice(0, 6);

  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-[14px] font-semibold">
        {label}
      </label>
      <div className="flex min-h-[44px] flex-wrap items-center gap-1.5 rounded-sm border border-border bg-surface px-2 py-1 focus-within:border-accent">
        {value.map((t) => (
          <span key={t} className="inline-flex max-w-full items-center rounded-full bg-accent-soft pl-3 text-[14px] text-text">
            <span className="min-w-0 truncate">{t}</span>
            <button
              type="button"
              aria-label={`Remove tag ${t}`}
              onClick={() => remove(t)}
              disabled={disabled}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full text-muted hover:text-text"
            >
              <Icon name="x" size={14} />
            </button>
          </span>
        ))}
        <input
          id={id}
          value={draft}
          disabled={disabled || value.length >= max}
          onChange={(e) => {
            const v = e.target.value;
            if (v.includes(",")) add(v);
            else setDraft(v);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add(draft);
            } else if (e.key === "Backspace" && !draft && value.length) {
              remove(value[value.length - 1]);
            }
          }}
          onBlur={() => draft && add(draft)}
          enterKeyHint="done"
          autoCapitalize="none"
          placeholder={value.length >= max ? "" : "Add tags (optional)"}
          maxLength={maxLength + 5}
          className="min-h-[36px] min-w-[8rem] flex-1 bg-transparent px-1 text-[16px] outline-none placeholder:text-muted"
        />
      </div>
      {note || value.length >= max ? <p className="mt-1 text-[14px] text-muted">{note || `Up to ${max} tags.`}</p> : null}
      {unused.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Suggested tags">
          {unused.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => add(s)}
              disabled={disabled || value.length >= max}
              className="min-h-[36px] rounded-full border border-border px-3 text-[14px] text-muted hover:border-accent hover:text-text"
            >
              + {s}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
