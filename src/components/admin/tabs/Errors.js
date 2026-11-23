"use client";
/**
 * Admin Errors (UX-SPEC 8.3): deduplicated log entries, resolve with undo.
 */
import { useEffect, useState } from "react";
import { api } from "@/lib/client/api.js";
import { formatDate, relativeTime } from "@/lib/client/relative-time.js";
import Button from "@/components/ui/Button.js";
import { Badge, EmptyState, ErrorState, Skeleton } from "@/components/ui/Misc.js";
import { useToast } from "@/components/ui/Toast.js";
import { useAdminData } from "../useAdminData.js";

const LEVEL_TONE = { CRITICAL: "danger", ERROR: "danger", WARN: "warning" };

export default function Errors({ registerRefresh }) {
  const [includeResolved, setIncludeResolved] = useState(false);
  const { status, data, error, refresh, updatedAt } = useAdminData(`/api/admin/logs?includeResolved=${includeResolved ? "true" : "false"}`);
  useEffect(() => registerRefresh(refresh, updatedAt), [registerRefresh, refresh, updatedAt]);
  const [hidden, setHidden] = useState(() => new Set());
  const [expanded, setExpanded] = useState(null);
  const [levelFilter, setLevelFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const { toast } = useToast();

  const resolve = (entry) => {
    let undone = false;
    setHidden((h) => new Set(h).add(entry.id));
    toast({
      message: "Marked resolved.",
      action: {
        label: "Undo",
        onClick: () => {
          undone = true;
          setHidden((h) => {
            const n = new Set(h);
            n.delete(entry.id);
            return n;
          });
        },
      },
      onExpire: () => {
        if (undone) return;
        api(`/api/admin/logs/${encodeURIComponent(entry.id)}/resolve`, { method: "POST", timeoutMs: 15000 })
          .then(() => refresh())
          .catch(() => {
            setHidden((h) => {
              const n = new Set(h);
              n.delete(entry.id);
              return n;
            });
            toast({ message: "Couldn't mark that resolved. Try again.", tone: "danger" });
          });
      },
    });
  };

  if (status === "loading") return <Skeleton lines={6} height={20} />;
  if (status === "error" && !data) return <ErrorState title="Couldn't load errors." error={error} onRetry={refresh} />;
  const entries = (data?.entries || []).filter((e) => (includeResolved || !hidden.has(e.id)) && (!levelFilter || e.level === levelFilter) && (!sourceFilter || e.source === sourceFilter));
  const sources = Array.from(new Set((data?.entries || []).map((e) => e.source))).sort();

  return (
    <div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="inline-flex min-h-[44px] items-center gap-2">
          <input type="checkbox" role="switch" className="h-5 w-5 accent-[var(--accent)]" checked={includeResolved} onChange={(e) => setIncludeResolved(e.target.checked)} />
          Show {data?.resolvedCount ?? 0} resolved
        </label>
        <label className="flex flex-col text-[13px] text-muted">
          Level
          <select value={levelFilter} onChange={(e) => setLevelFilter(e.target.value)} className="mt-1 min-h-[44px] rounded-sm border border-border bg-surface px-2 text-[16px] text-text">
            <option value="">All</option>
            <option value="CRITICAL">critical</option>
            <option value="ERROR">error</option>
            <option value="WARN">warn</option>
          </select>
        </label>
        <label className="flex flex-col text-[13px] text-muted">
          Source
          <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} className="mt-1 min-h-[44px] rounded-sm border border-border bg-surface px-2 text-[16px] text-text">
            <option value="">All</option>
            {sources.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>

      {entries.length === 0 ? (
        <EmptyState icon="check" tone="success" title="No open errors." />
      ) : (
        <ul className="mt-4 space-y-2">
          {entries.map((e) => (
            <li key={e.id} className={`rounded-md border border-border bg-surface p-3 ${e.resolved ? "opacity-60" : ""}`}>
              <div className="flex flex-wrap items-start gap-2">
                <Badge tone={LEVEL_TONE[e.level] || "neutral"}>{String(e.level).toLowerCase()}</Badge>
                <code className="text-[13px]">{e.source}</code>
                <span className="font-semibold tabular-nums">×{e.count}</span>
              </div>
              <button type="button" className="mt-1 block min-h-[36px] w-full text-left font-semibold break-anywhere" aria-expanded={expanded === e.id} onClick={() => setExpanded(expanded === e.id ? null : e.id)}>
                {e.message}
              </button>
              <p className="text-[13px] text-muted">
                First seen {formatDate(e.firstSeenAt)} · Last seen {relativeTime(e.lastSeenAt)}
                {e.resolved ? ` · Resolved ${relativeTime(e.resolvedAt)}` : ""}
              </p>
              {expanded === e.id ? <pre className="mt-2 max-h-64 overflow-auto rounded-sm bg-surface-2 p-2 text-[12px] break-anywhere whitespace-pre-wrap">{e.detail || "No detail."}</pre> : null}
              {!e.resolved ? (
                <Button variant="secondary" className="mt-2" onClick={() => resolve(e)}>
                  Resolve
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
