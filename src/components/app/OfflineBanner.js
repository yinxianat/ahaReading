"use client";
/**
 * Global offline banner and review-queue sync (UX-SPEC 5). Flushes the queue
 * on `online` and on focus, and reports the outcome in a toast.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useOnline } from "@/lib/client/hooks.js";
import { flushQueue } from "@/lib/client/offline-queue.js";
import { useToast } from "@/components/ui/Toast.js";
import Icon from "@/components/ui/icons.js";
import { useDue, useQueuedCount } from "./DueContext.js";

/** "2 reviews will sync…" / "1 review will sync…" */
export function queueLine(n) {
  return n === 1 ? "1 review will sync when you're back online." : `${n} reviews will sync when you're back online.`;
}

export default function OfflineBanner() {
  const online = useOnline();
  const queued = useQueuedCount();
  const { toast } = useToast();
  const { refresh } = useDue();
  const [backOnline, setBackOnline] = useState(false);
  const wasOffline = useRef(false);

  const flush = useCallback(async () => {
    if (!navigator.onLine) return;
    const { synced, skipped } = await flushQueue();
    if (synced > 0) toast({ message: synced === 1 ? "1 review synced." : `${synced} reviews synced.`, tone: "success" });
    if (skipped > 0) toast({ message: "One review couldn't be synced and was skipped." });
    if (synced || skipped) refresh();
  }, [toast, refresh]);

  useEffect(() => {
    if (!online) {
      wasOffline.current = true;
      return undefined;
    }
    let timer;
    if (wasOffline.current) {
      wasOffline.current = false;
      queueMicrotask(() => setBackOnline(true));
      timer = setTimeout(() => setBackOnline(false), 2000);
    }
    flush();
    return () => clearTimeout(timer);
  }, [online, flush]);

  useEffect(() => {
    const onFocus = () => flush();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [flush]);

  if (online && !backOnline) return null;
  return (
    <div
      role="status"
      className={`sticky top-0 z-30 flex min-h-9 items-center gap-2 px-4 py-1.5 text-[14px] ${online ? "bg-success-soft text-success" : "bg-warning-soft text-text"}`}
    >
      <Icon name={online ? "check" : "wifiOff"} size={18} className={online ? "" : "text-warning"} />
      <p className="min-w-0">
        {online ? (
          "Back online."
        ) : (
          <>
            You&apos;re offline. Notebook and Review still work.
            {queued > 0 ? <span className="block text-muted">{queueLine(queued)}</span> : null}
          </>
        )}
      </p>
    </div>
  );
}
