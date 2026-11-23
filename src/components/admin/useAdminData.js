"use client";
/**
 * Shared pieces of the admin tabs: the data hook (loading / error /
 * updatedAt / refresh), the per-section failure check and layout helpers.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client/api.js";
import { ErrorState } from "@/components/ui/Misc.js";

/**
 * An overview section that failed on the server arrives as
 * `{error:"unavailable", message}` instead of its data (lib/admin.js `guarded`).
 * @param {unknown} part
 * @returns {boolean}
 */
export const failed = (part) => !part || (typeof part === "object" && !Array.isArray(part) && typeof part.error === "string");

/** Fetch an admin endpoint; tracks loading/error/updatedAt and supports refresh. */
export function useAdminData(path, { refreshMs = 0 } = {}) {
  const [state, setState] = useState({ status: "loading", data: null, error: null, updatedAt: 0 });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    api(path, { signal: controller.signal, timeoutMs: 30000 })
      .then((data) => setState({ status: "ready", data, error: null, updatedAt: Date.now() }))
      .catch((error) => {
        if (error.code !== "aborted") setState((s) => ({ ...s, status: "error", error }));
      });
    return () => controller.abort();
  }, [path, tick]);
  useEffect(() => {
    if (!refreshMs) return undefined;
    const id = setInterval(() => document.visibilityState === "visible" && setTick((t) => t + 1), refreshMs);
    return () => clearInterval(id);
  }, [refreshMs]);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, refresh };
}

export function Section({ title, children, id }) {
  return (
    <section className="mt-6" id={id} aria-labelledby={id ? `${id}-h` : undefined}>
      <h2 id={id ? `${id}-h` : undefined} className="mb-3 text-[18px] font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

export function PartError({ onRetry }) {
  return <ErrorState title="This section could not be loaded." body="Refresh to retry." onRetry={onRetry} />;
}
