"use client";
/**
 * Mobile bottom sheet that becomes a right side panel (or centred dialog) at
 * ≥1024px. Bottom sheet: drag handle toggles snap heights, drag down past 30%
 * closes, Esc closes, focus is trapped while modal.
 */
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useIsDesktop } from "@/lib/client/hooks.js";
import { focusables, trapTab } from "./focus.js";
import { IconButton } from "./Button.js";

/**
 * @param {object} props
 * @param {boolean} props.open
 * @param {() => void} props.onClose
 * @param {number[]} [props.snapPoints] fractions of viewport height
 * @param {"side"|"dialog"} [props.desktop]
 * @param {boolean} [props.modal] trap focus + scrim on mobile
 * @param {boolean} [props.scrimCollapses] scrim tap collapses instead of closing
 * @param {string} props.title accessible name (and visible heading unless `header` given)
 * @param {any} [props.header] custom header content (replaces default title row)
 * @param {any} [props.footer] sticky footer
 * @param {number} [props.topOffset] px under a sticky top bar (side panel)
 * @param {boolean} [props.restoreFocus]
 * @param {number} [props.expandKey] change it to snap a bottom sheet to its tallest height
 */
export default function Sheet({
  open,
  onClose,
  snapPoints = [0.55, 0.92],
  desktop = "dialog",
  modal = true,
  scrimCollapses = false,
  title,
  header,
  footer,
  children,
  topOffset = 0,
  restoreFocus = true,
  expandKey = 0,
}) {
  const isDesktop = useIsDesktop();
  const [snap, setSnap] = useState(0);
  const [drag, setDrag] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef(null);
  const panel = useRef(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Adjust during render (not in an effect) so the sheet is already tall in
  // the same commit as whatever asked for it.
  const [seenExpandKey, setSeenExpandKey] = useState(expandKey);
  if (expandKey !== seenExpandKey) {
    setSeenExpandKey(expandKey);
    setSnap(snapPoints.length - 1);
  }

  const side = isDesktop && desktop === "side";
  const trapping = open && modal && !side;

  useEffect(() => {
    if (!open) return undefined;
    const trigger = document.activeElement;
    if (trapping && panel.current) {
      const first = focusables(panel.current)[0];
      (first || panel.current).focus();
    }
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
      } else if (trapping) trapTab(e, panel.current);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (restoreFocus && trigger && typeof trigger.focus === "function" && document.contains(trigger)) trigger.focus();
    };
  }, [open, trapping, restoreFocus]);

  if (!open || typeof document === "undefined") return null;

  const heading = header || (
    <div className="flex items-center justify-between gap-2 px-4 pt-1">
      <h2 id={titleId} className="min-w-0 text-[18px] font-semibold break-anywhere">
        {title}
      </h2>
      <IconButton icon="x" label="Close" onClick={() => onCloseRef.current()} />
    </div>
  );

  if (side) {
    return (
      <aside
        ref={panel}
        role="complementary"
        aria-label={title}
        className="fixed right-0 bottom-0 z-40 flex w-[420px] flex-col border-l border-border bg-surface anim-fade"
        style={{ top: topOffset }}
      >
        {heading}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">{children}</div>
        {footer ? <div className="border-t border-border bg-surface px-4 py-3">{footer}</div> : null}
      </aside>
    );
  }

  if (isDesktop) {
    return createPortal(
      <div className="fixed inset-0 z-[65] flex items-center justify-center">
        <div className="absolute inset-0 bg-black/40 anim-fade" aria-hidden="true" onClick={() => onCloseRef.current()} />
        <div
          ref={panel}
          role="dialog"
          aria-modal="true"
          aria-labelledby={header ? undefined : titleId}
          aria-label={header ? title : undefined}
          tabIndex={-1}
          className="anim-pop relative flex max-h-[85vh] w-full max-w-[520px] flex-col rounded-lg bg-surface py-3 shadow-2"
        >
          {heading}
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-2">{children}</div>
          {footer ? <div className="border-t border-border px-4 pt-3">{footer}</div> : null}
        </div>
      </div>,
      document.body
    );
  }

  const fraction = snapPoints[Math.min(snap, snapPoints.length - 1)];
  const onHandleDown = (e) => {
    dragStart.current = e.clientY;
    setDragging(true);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onHandleMove = (e) => {
    if (dragStart.current == null) return;
    setDrag(e.clientY - dragStart.current);
  };
  const onHandleUp = () => {
    if (dragStart.current == null) return;
    const dy = drag;
    dragStart.current = null;
    setDragging(false);
    setDrag(0);
    const vh = window.innerHeight;
    if (Math.abs(dy) < 6) {
      setSnap((s) => (s + 1) % snapPoints.length);
      return;
    }
    if (dy > vh * 0.3 || (snap === 0 && dy > vh * 0.15)) onCloseRef.current();
    else if (dy > 0 && snap > 0) setSnap(snap - 1);
    else if (dy < 0 && snap < snapPoints.length - 1) setSnap(snap + 1);
  };

  return createPortal(
    <div className="fixed inset-0 z-[65]" style={{ pointerEvents: modal ? "auto" : "none" }}>
      {modal ? (
        <div
          className="absolute inset-0 bg-black/20 anim-fade"
          aria-hidden="true"
          onClick={() => {
            if (scrimCollapses && snap > 0) setSnap(0);
            else if (!scrimCollapses) onCloseRef.current();
          }}
        />
      ) : null}
      <div
        ref={panel}
        role="dialog"
        aria-modal={modal ? "true" : undefined}
        aria-labelledby={header ? undefined : titleId}
        aria-label={header ? title : undefined}
        tabIndex={-1}
        className="anim-slide-up absolute inset-x-0 bottom-0 flex flex-col rounded-t-lg bg-surface shadow-3 dark:border-t dark:border-border"
        style={{
          height: `${fraction * 100}dvh`,
          transform: drag > 0 ? `translateY(${drag}px)` : undefined,
          transition: !dragging ? "height var(--dur-slow) var(--ease)" : "none",
          pointerEvents: "auto",
        }}
      >
        <button
          type="button"
          aria-label={snap === snapPoints.length - 1 ? "Collapse panel" : "Expand panel"}
          className="flex h-6 w-full flex-none touch-none items-center justify-center"
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onPointerCancel={onHandleUp}
        >
          <span className="h-1 w-9 rounded-full bg-border" />
        </button>
        {heading}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">{children}</div>
        {footer ? <div className="border-t border-border bg-surface px-4 pt-3 safe-bottom" style={{ paddingBottom: "max(12px, env(safe-area-inset-bottom))" }}>{footer}</div> : null}
        {!footer ? <div className="safe-bottom" /> : null}
      </div>
    </div>,
    document.body
  );
}
