"use client";
/**
 * Small panel anchored to a viewport rect; flips below when there is no
 * room above. Esc and outside clicks close it.
 */
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

/**
 * @param {{anchorRect:{top:number,left:number,bottom:number,width:number}|null, open:boolean, onClose:() => void, placement?:"top"|"bottom", label:string, width?:number}} props
 */
export default function Popover({ anchorRect, open, onClose, placement = "bottom", label, width = 320, children }) {
  const ref = useRef(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    if (!open) return undefined;
    const trigger = document.activeElement;
    ref.current?.focus();
    const onKey = (e) => e.key === "Escape" && onCloseRef.current();
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
      if (trigger && document.contains(trigger)) trigger.focus?.();
    };
  }, [open]);
  if (!open || !anchorRect || typeof document === "undefined") return null;
  const vw = window.innerWidth;
  const w = Math.min(width, vw - 16);
  const left = Math.min(Math.max(8, anchorRect.left + anchorRect.width / 2 - w / 2), vw - w - 8);
  const below = placement === "bottom" || anchorRect.top < 220;
  const style = below ? { top: anchorRect.bottom + 8, left, width: w } : { bottom: window.innerHeight - anchorRect.top + 8, left, width: w };
  return createPortal(
    <div ref={ref} role="dialog" aria-label={label} tabIndex={-1} className="anim-pop fixed z-[66] rounded-md border border-border bg-surface p-4 shadow-2" style={style}>
      {children}
    </div>,
    document.body
  );
}
