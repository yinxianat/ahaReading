"use client";
/**
 * Single-slot toast (UX-SPEC 5 "Toast spec"): a new toast replaces the old
 * one, info 4s / undo 6s, timer pauses on hover or focus. `onExpire` runs when
 * a toast leaves without its action being used — that is how "delete with
 * undo" commits.
 *
 * Pausing is limited to a real mouse hover and keyboard focus (QA-7): touch
 * browsers emulate mouseenter under the last tap point and never send the
 * matching leave, which used to freeze the toast — and the pending delete —
 * forever. A pause also never lasts longer than MAX_PAUSE_MS.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import Icon from "./icons.js";
import { announce } from "./announce.js";

const MAX_PAUSE_MS = 20000;

function canHover() {
  try {
    return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  } catch {
    return false;
  }
}

const ToastContext = createContext({ toast: () => {}, dismiss: () => {} });

/** @returns {{toast:(t:{message:string, tone?:string, action?:{label:string,onClick:() => void}, duration?:number, onExpire?:() => void}) => void, dismiss:() => void}} */
export function useToast() {
  return useContext(ToastContext);
}

const TONE = {
  info: "",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
};

export function ToastProvider({ children }) {
  const [current, setCurrent] = useState(null);
  const timer = useRef(null);
  const remaining = useRef(0);
  const started = useRef(0);
  const active = useRef(null);
  const pauseCap = useRef(null);
  const paused = useRef(false);

  const finish = useCallback((usedAction) => {
    const t = active.current;
    if (!t) return;
    active.current = null;
    clearTimeout(timer.current);
    clearTimeout(pauseCap.current);
    if (!usedAction) {
      try {
        t.onExpire?.();
      } catch {
        // a failing commit must not break the next toast
      }
    }
    setCurrent((c) => (c && c.id === t.id ? null : c));
  }, []);

  const start = useCallback(
    (ms) => {
      clearTimeout(timer.current);
      clearTimeout(pauseCap.current);
      paused.current = false;
      remaining.current = ms;
      started.current = Date.now();
      timer.current = setTimeout(() => finish(false), ms);
    },
    [finish]
  );

  const toast = useCallback(
    (t) => {
      if (active.current) finish(false);
      const item = { id: Math.random().toString(36).slice(2), tone: "info", duration: t.action ? 6000 : 4000, ...t };
      active.current = item;
      setCurrent(item);
      announce(item.message);
      start(item.duration);
    },
    [finish, start]
  );

  const resume = useCallback(() => {
    if (active.current && paused.current) start(remaining.current);
  }, [start]);
  const pause = useCallback(() => {
    if (!active.current || paused.current) return;
    paused.current = true;
    clearTimeout(timer.current);
    clearTimeout(pauseCap.current);
    remaining.current = Math.max(800, remaining.current - (Date.now() - started.current));
    pauseCap.current = setTimeout(resume, MAX_PAUSE_MS);
  }, [resume]);
  const onPointerEnter = useCallback((e) => {
    if (e.pointerType === "mouse" && canHover()) pause();
  }, [pause]);
  const onPointerLeave = useCallback((e) => {
    if (e.pointerType === "mouse" && canHover()) resume();
  }, [resume]);
  const onFocus = useCallback((e) => {
    // Keyboard focus only; a tap focuses the button it lands on too.
    if (e.target instanceof Element && e.target.matches(":focus-visible")) pause();
  }, [pause]);

  useEffect(() => {
    // Commit a pending undo-able action if the tab is closed mid-toast.
    const onHide = () => finish(false);
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [finish]);

  const value = useMemo(() => ({ toast, dismiss: () => finish(false) }), [toast, finish]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 z-[60] flex justify-center px-4"
        style={{ bottom: "calc(var(--toast-offset, 72px) + env(safe-area-inset-bottom))" }}
      >
        {current ? (
          <div
            key={current.id}
            className="anim-toast pointer-events-auto flex w-full max-w-[420px] items-center gap-3 rounded-md bg-text px-4 py-2 text-bg shadow-2"
            onPointerEnter={onPointerEnter}
            onPointerLeave={onPointerLeave}
            onFocus={onFocus}
            onBlur={resume}
          >
            {current.tone !== "info" ? (
              <span className={TONE[current.tone]}>
                <Icon name={current.tone === "success" ? "check" : "alert"} size={18} />
              </span>
            ) : null}
            <p className="min-w-0 flex-1 py-2 text-[15px] break-anywhere">{current.message}</p>
            {current.action ? (
              <button
                type="button"
                className="min-h-[44px] rounded-md px-3 font-semibold text-accent-soft underline-offset-2 hover:underline"
                onClick={() => {
                  const fn = current.action.onClick;
                  finish(true);
                  fn();
                }}
              >
                {current.action.label}
              </button>
            ) : null}
            <button
              type="button"
              aria-label="Dismiss"
              className="inline-flex h-11 w-11 flex-none items-center justify-center rounded-md opacity-80 hover:opacity-100"
              onClick={() => finish(false)}
            >
              <Icon name="x" size={18} />
            </button>
          </div>
        ) : null}
      </div>
    </ToastContext.Provider>
  );
}
