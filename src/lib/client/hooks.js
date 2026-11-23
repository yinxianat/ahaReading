"use client";
/**
 * Small browser-state hooks shared across pages.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

function subscribeOnline(callback) {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

/** @returns {boolean} navigator.onLine, live; true during SSR */
export function useOnline() {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
}

/**
 * @param {string} query CSS media query
 * @param {boolean} [serverValue]
 * @returns {boolean}
 */
export function useMediaQuery(query, serverValue = false) {
  const subscribe = useCallback(
    (callback) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", callback);
      return () => mql.removeEventListener("change", callback);
    },
    [query]
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => serverValue);
}

/** @returns {boolean} ≥1024px — sidebar / side panel layout */
export function useIsDesktop() {
  return useMediaQuery("(min-width: 1024px)");
}

/** @returns {boolean} touch-first device */
export function useCoarsePointer() {
  return useMediaQuery("(pointer: coarse)");
}

/**
 * A string value persisted in localStorage (per-viewer conveniences only).
 * @param {string} key
 * @param {string} initial
 * @returns {[string, (v:string) => void]}
 */
export function useStoredState(key, initial) {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    let stored = null;
    try {
      stored = localStorage.getItem(key);
    } catch {
      stored = null;
    }
    // Read after mount so server and first client render agree.
    if (stored !== null) queueMicrotask(() => setValue(stored));
  }, [key]);
  const update = useCallback(
    (v) => {
      setValue(v);
      try {
        localStorage.setItem(key, v);
      } catch {
        // storage blocked: keep the in-memory value
      }
    },
    [key]
  );
  return [value, update];
}

/**
 * Seconds remaining until a deadline, ticking once per second.
 * @param {number|null} seconds start value; null = inactive
 * @param {any} [resetKey] change to restart from `seconds`
 * @returns {number} remaining whole seconds (0 when done or inactive)
 */
export function useCountdown(seconds, resetKey) {
  const [deadline, setDeadline] = useState(null);
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!seconds || seconds <= 0) {
      queueMicrotask(() => setDeadline(null));
      return undefined;
    }
    const end = Date.now() + seconds * 1000;
    queueMicrotask(() => {
      setDeadline(end);
      setNow(Date.now());
    });
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= end) clearInterval(id);
    }, 250);
    return () => clearInterval(id);
  }, [seconds, resetKey]);
  if (!deadline) return seconds > 0 ? seconds : 0;
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}
