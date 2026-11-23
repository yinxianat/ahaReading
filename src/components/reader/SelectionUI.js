"use client";
/**
 * The two "I don't understand" entry points: a floating pill above the
 * selection for fine pointers, a bottom action bar for touch (the iOS
 * callout sits above the selection, so nothing may float there).
 */
import { createPortal } from "react-dom";
import Icon from "@/components/ui/icons.js";

const TOO_LONG = "Too long — select up to a sentence or two";

/**
 * @param {{snapshot:object, onActivate:() => void}} props
 */
export function SelectionPill({ snapshot, onActivate }) {
  if (!snapshot?.rect || typeof document === "undefined") return null;
  const { rect } = snapshot;
  const width = snapshot.tooLong ? 340 : 190;
  const vw = document.documentElement.clientWidth;
  const left = Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), vw - width - 8);
  const above = rect.top >= 64;
  const top = (above ? rect.top - 8 - 44 : rect.bottom + 8) + (snapshot.scrollY ?? window.scrollY);
  return createPortal(
    <div data-selection-ui="" className="anim-pop absolute z-40" style={{ top, left, width }}>
      <button
        type="button"
        onPointerDown={(e) => e.preventDefault()}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onActivate}
        disabled={snapshot.tooLong}
        title={snapshot.tooLong ? undefined : "⌥↵"}
        className="flex min-h-[44px] w-full items-center justify-center rounded-full bg-accent px-4 text-[15px] font-semibold text-accent-fg shadow-2 disabled:bg-surface-2 disabled:text-muted"
      >
        {snapshot.tooLong ? TOO_LONG : "I don't understand"}
      </button>
    </div>,
    document.body
  );
}

/**
 * @param {{snapshot:object, onActivate:() => void, onClear:() => void}} props
 */
export function SelectionActionBar({ snapshot, onActivate, onClear }) {
  if (!snapshot) return null;
  const text = snapshot.highlightedText;
  const preview = text.length > 40 ? `${text.slice(0, 39)}…` : text;
  return (
    <div
      data-selection-ui=""
      className="anim-slide-up fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface shadow-3"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="mx-auto flex h-16 max-w-[720px] items-center gap-2 px-2">
        <button
          type="button"
          aria-label="Clear selection"
          onClick={onClear}
          className="inline-flex h-11 w-11 flex-none items-center justify-center rounded-md text-muted"
        >
          <Icon name="x" size={20} />
        </button>
        <p className="min-w-0 flex-1 truncate text-[14px] text-muted">
          {snapshot.tooLong ? TOO_LONG : `“${preview}”`}
        </p>
        <button
          type="button"
          onClick={onActivate}
          disabled={snapshot.tooLong}
          className="min-h-[44px] flex-none rounded-full bg-accent px-4 text-[15px] font-semibold text-accent-fg disabled:opacity-50"
        >
          I don&apos;t understand
        </button>
      </div>
    </div>
  );
}
