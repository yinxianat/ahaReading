"use client";
/**
 * Admin AI Calls (UX-SPEC 8.2): per-provider summary and recent attempts.
 */
import { useEffect, useState } from "react";
import { formatDateTime, relativeTime } from "@/lib/client/relative-time.js";
import Button from "@/components/ui/Button.js";
import { ErrorState, Skeleton } from "@/components/ui/Misc.js";
import { DataTable, StatusBadge } from "../parts.js";
import { useAdminData } from "../useAdminData.js";

export default function AiCalls({ registerRefresh }) {
  const { status, data, error, refresh, updatedAt } = useAdminData("/api/admin/ai-calls");
  useEffect(() => registerRefresh(refresh, updatedAt), [registerRefresh, refresh, updatedAt]);
  const [filter, setFilter] = useState({ status: "", provider: "", task: "" });
  const [expanded, setExpanded] = useState(null);
  const [limit, setLimit] = useState(50);
  if (status === "loading") return <Skeleton lines={6} height={20} />;
  if (status === "error" && !data) return <ErrorState title="Couldn't load AI calls." error={error} onRetry={refresh} />;
  const recent = data?.recent || [];
  const providers = Object.keys(data?.byProvider || {});
  const rows = recent.filter((r) => (!filter.status || r.status === filter.status) && (!filter.provider || r.provider === filter.provider) && (!filter.task || r.task === filter.task));
  const select = (key, label, options) => (
    <label className="flex min-w-0 flex-col text-[13px] text-muted">
      {label}
      <select
        value={filter[key]}
        onChange={(e) => setFilter((f) => ({ ...f, [key]: e.target.value }))}
        className="mt-1 min-h-[44px] rounded-sm border border-border bg-surface px-2 text-[16px] text-text"
      >
        <option value="">All</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {providers.length === 0 ? <p className="text-muted">No AI calls in the last 24 hours.</p> : null}
        {providers.map((p) => {
          const s = data.byProvider[p];
          return (
            <span key={p} className="rounded-full border border-border bg-surface px-3 py-1.5 text-[13px] break-anywhere">
              <strong>{p}</strong> · <span className="text-success">{s.ok || 0} ok</span> · <span className="text-danger">{s.infrastructure || 0} infra</span> ·{" "}
              <span className="text-warning">{s.refusal || 0} refusal</span> · {s.invalid_output || 0} invalid
            </span>
          );
        })}
      </div>
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {select("status", "Status", ["ok", "infrastructure", "refusal", "invalid_output"])}
        {select("provider", "Provider", providers)}
        {select("task", "Task", ["explain", "translate"])}
      </div>
      <p className="mt-2 text-[13px] text-muted">Summary covers the last 24 hours; the table shows the most recent attempts.</p>
      <div className="mt-3">
        <DataTable
          emptyText="No calls match these filters."
          rows={rows.slice(0, limit)}
          onRowClick={(r) => setExpanded(expanded?.id === r.id ? null : r)}
          columns={[
            { key: "createdAt", label: "Time", render: (r) => <span title={relativeTime(r.createdAt)}>{formatDateTime(r.createdAt)}</span> },
            { key: "task", label: "Task" },
            { key: "provider", label: "Provider" },
            { key: "model", label: "Model", render: (r) => <span className="break-anywhere">{r.model || "—"}</span> },
            { key: "status", label: "Status", render: (r) => <StatusBadge status={r.status} /> },
            { key: "tokens", label: "Tokens", render: (r) => r.tokens ?? "—" },
            { key: "latencyMs", label: "Latency ms", render: (r) => r.latencyMs ?? "—" },
          ]}
        />
      </div>
      {expanded ? (
        <div className="mt-3 rounded-md border border-border bg-surface p-3 text-[14px]">
          <p className="font-semibold">Call {expanded.id}</p>
          <pre className="mt-2 text-[13px] break-anywhere whitespace-pre-wrap">{expanded.detail || "No error detail."}</pre>
        </div>
      ) : null}
      {rows.length > limit ? (
        <div className="mt-3 flex justify-center">
          <Button variant="secondary" onClick={() => setLimit((l) => l + 50)}>
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}
