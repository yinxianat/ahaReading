"use client";
/**
 * Review due count for the nav badge: fetched on mount, when the tab becomes
 * visible, and whenever a page calls refresh(). Offline it subtracts queued
 * reviews from the last known count.
 */
import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore } from "react";
import { api } from "@/lib/client/api.js";
import { getQueue, subscribeQueue } from "@/lib/client/offline-queue.js";

const DueContext = createContext({ dueCount: 0, refresh: () => {}, queued: 0 });

/** @returns {{dueCount:number, refresh:() => void, queued:number}} */
export function useDue() {
  return useContext(DueContext);
}

const emptyQueue = () => 0;
/** @returns {number} reviews waiting to sync */
export function useQueuedCount() {
  return useSyncExternalStore(subscribeQueue, () => getQueue().length, emptyQueue);
}

export function DueProvider({ children }) {
  const [count, setCount] = useState(0);
  const queued = useQueuedCount();

  const refresh = useCallback(() => {
    // Count only (ENG-16); the full due list is fetched by Review and by the offline warm-up.
    api("/api/review?countOnly=1", { timeoutMs: 15000 })
      .then((data) => setCount(Number(data?.dueCount) || 0))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const onVisible = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  return <DueContext.Provider value={{ dueCount: Math.max(0, count - queued), refresh, queued }}>{children}</DueContext.Provider>;
}
