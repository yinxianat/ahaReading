"use client";
/**
 * Owns the reader's pending selection snapshot (UX-SPEC 4.1–4.3). The
 * snapshot survives the native selection collapsing on touch devices (iOS
 * clears it when a button is tapped); on fine pointers a collapse clears it.
 */
import { useEffect, useRef, useState } from "react";
import { snapshotFromSelection } from "@/lib/client/selection.js";

/**
 * @param {{current:HTMLElement|null}} rootRef article body
 * @param {{coarse:boolean, enabled:boolean}} options
 * @returns {[object|null, (s:object|null) => void]}
 */
export function useArticleSelection(rootRef, { coarse, enabled }) {
  const [snapshot, setSnapshot] = useState(null);
  const timer = useRef(null);
  const anchorScroll = useRef(0);

  useEffect(() => {
    if (!enabled) return undefined;
    const onChange = () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        const snap = snapshotFromSelection(rootRef.current);
        if (snap) {
          anchorScroll.current = window.scrollY;
          setSnapshot({ ...snap, id: `${Date.now()}-${Math.random()}`, scrollY: window.scrollY });
        } else if (!coarse) {
          const sel = window.getSelection();
          if (!sel || sel.isCollapsed) setSnapshot((s) => (s && s.source === "select" ? null : s));
        }
      }, 120);
    };
    document.addEventListener("selectionchange", onChange);
    return () => {
      clearTimeout(timer.current);
      document.removeEventListener("selectionchange", onChange);
    };
  }, [rootRef, coarse, enabled]);

  useEffect(() => {
    if (!enabled) return undefined;
    // Touch: tapping anywhere outside the article and the action UI clears.
    const onDown = (e) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (rootRef.current?.contains(t) || t.closest("[data-selection-ui]")) return;
      setSnapshot(null);
    };
    const onScroll = () => {
      if (Math.abs(window.scrollY - anchorScroll.current) > 200) setSnapshot((s) => (s && !coarse ? null : s));
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("scroll", onScroll);
    };
  }, [rootRef, coarse, enabled]);

  return [snapshot, setSnapshot];
}
