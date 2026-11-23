"use client";
/**
 * Modal confirm dialog: focus moves in (to `initialFocusRef` or the first
 * control), is trapped, Esc closes, focus returns to the trigger.
 */
import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { focusables, trapTab } from "./focus.js";

/**
 * @param {{open:boolean, onClose:() => void, title:string, description?:any, children?:any, actions?:any, initialFocusRef?:{current:HTMLElement|null}}} props
 */
export default function Dialog({ open, onClose, title, description, children, actions, initialFocusRef }) {
  const titleId = useId();
  const descId = useId();
  const panel = useRef(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;
    const trigger = document.activeElement;
    const target = initialFocusRef?.current || (panel.current && focusables(panel.current)[0]);
    target?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
      } else trapTab(e, panel.current);
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      if (trigger && typeof trigger.focus === "function") trigger.focus();
    };
  }, [open, initialFocusRef]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-black/40 anim-fade" onClick={() => onCloseRef.current()} aria-hidden="true" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        className="anim-pop relative m-0 w-full max-w-[440px] rounded-t-lg bg-surface p-5 shadow-2 sm:m-4 sm:rounded-lg safe-bottom"
      >
        <h2 id={titleId} className="text-[20px] font-semibold leading-tight break-anywhere">
          {title}
        </h2>
        {description ? (
          <div id={descId} className="mt-2 text-muted">
            {description}
          </div>
        ) : null}
        {children ? <div className="mt-4">{children}</div> : null}
        {actions ? <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">{actions}</div> : null}
      </div>
    </div>,
    document.body
  );
}
