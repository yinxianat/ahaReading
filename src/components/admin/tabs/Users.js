"use client";
/**
 * Admin Users (UX-SPEC 8.4): searchable, sortable list with a detail sheet.
 */
import { useEffect, useMemo, useState } from "react";
import { formatDate, relativeTime } from "@/lib/client/relative-time.js";
import { ErrorState, Skeleton } from "@/components/ui/Misc.js";
import Sheet from "@/components/ui/Sheet.js";
import { DataTable } from "../parts.js";
import { useAdminData } from "../useAdminData.js";

export default function Users({ registerRefresh }) {
  const { status, data, error, refresh, updatedAt } = useAdminData("/api/admin/users");
  useEffect(() => registerRefresh(refresh, updatedAt), [registerRefresh, refresh, updatedAt]);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState({ key: "joinedAt", dir: "desc" });
  const [selected, setSelected] = useState(null);
  const rows = useMemo(() => {
    const list = (data?.users || []).filter((u) => !q || `${u.email} ${u.displayName || ""}`.toLowerCase().includes(q.toLowerCase()));
    const val = (u) => (u[sort.key] ? new Date(u[sort.key]).getTime() : 0);
    return [...list].sort((a, b) => (sort.dir === "asc" ? val(a) - val(b) : val(b) - val(a)));
  }, [data, q, sort]);
  if (status === "loading") return <Skeleton lines={6} height={20} />;
  if (status === "error" && !data) return <ErrorState title="Couldn't load users." error={error} onRetry={refresh} />;
  const onSort = (key) => setSort((s) => ({ key, dir: s.key === key && s.dir === "desc" ? "asc" : "desc" }));
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <label className="w-full max-w-[360px]">
          <span className="sr-only">Search users</span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search users" className="min-h-[44px] w-full rounded-sm border border-border bg-surface px-3 text-[16px]" />
        </label>
        <span className="text-[14px] text-muted">{data?.total ?? rows.length} total</span>
      </div>
      <DataTable
        emptyText="No users match."
        rows={rows}
        sort={sort}
        onSort={onSort}
        onRowClick={setSelected}
        columns={[
          { key: "email", label: "Email", render: (u) => <span className="break-anywhere">{u.email}</span> },
          { key: "displayName", label: "Name", render: (u) => u.displayName || "—" },
          { key: "joinedAt", label: "Joined", sortable: true, render: (u) => formatDate(u.joinedAt) },
          { key: "lastActiveAt", label: "Last active", sortable: true, render: (u) => (u.lastActiveAt ? relativeTime(u.lastActiveAt) : "—") },
          { key: "articles", label: "Articles" },
          { key: "concepts", label: "Concepts" },
          { key: "explanations", label: "Explanations" },
          { key: "onboarded", label: "Onboarded", render: (u) => (u.onboarded ? "✓" : "—") },
        ]}
      />
      <Sheet open={Boolean(selected)} onClose={() => setSelected(null)} title={selected?.email || "User"} snapPoints={[0.6, 0.92]}>
        {selected ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 pt-2 text-[15px]">
            {[
              ["Email", selected.email],
              ["Name", selected.displayName || "—"],
              ["Language", selected.locale],
              ["Help level", selected.helpLevel],
              ["Joined", formatDate(selected.joinedAt)],
              ["Last active", selected.lastActiveAt ? relativeTime(selected.lastActiveAt) : "—"],
              ["Articles", selected.articles],
              ["Concepts", selected.concepts],
              ["Explanations", selected.explanations],
              ["Reviews", selected.reviews],
              ["Onboarded", selected.onboarded ? "Yes" : "No"],
            ].map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted">{k}</dt>
                <dd className="break-anywhere">{v ?? "—"}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </Sheet>
    </div>
  );
}
