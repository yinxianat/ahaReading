"use client";
/**
 * Operator UI pieces: health headline, stat cards, severity lanes, findings,
 * and a table that scrolls inside its own wrapper (never the page).
 */
import { useState } from "react";
import Icon from "@/components/ui/icons.js";
import { Badge } from "@/components/ui/Misc.js";

const SEV = {
  high: { label: "Act now", border: "border-l-danger", tone: "danger" },
  medium: { label: "Worth a look", border: "border-l-warning", tone: "warning" },
  low: { label: "Notes", border: "border-l-border", tone: "neutral" },
};

/** @param {{headline:any, findings:any[], onJump:() => void}} props */
export function HealthHeadline({ headline, findings, onJump }) {
  const counts = headline?.counts || { high: 0, medium: 0, low: 0 };
  const top = Array.isArray(findings) ? findings[0] : null;
  let border = "border-l-success";
  let title = "All systems normal";
  if (headline?.status === "unknown") {
    border = "border-l-warning";
    title = "Health findings could not be loaded";
  } else if (counts.high > 0) {
    border = "border-l-danger";
    title = `Act now — ${counts.high} high-severity finding${counts.high === 1 ? "" : "s"}`;
  } else if (counts.medium > 0) {
    border = "border-l-warning";
    title = `Worth a look — ${counts.medium} finding${counts.medium === 1 ? "" : "s"}`;
  }
  return (
    <button type="button" onClick={onJump} className={`w-full rounded-md border border-border border-l-4 ${border} bg-surface p-4 text-left shadow-1`}>
      <p className="text-[18px] font-semibold">{title}</p>
      {top && (counts.high || counts.medium) ? <p className="mt-1 text-muted break-anywhere">{top.title}</p> : null}
    </button>
  );
}

/** @param {{label:string, value:any, sub?:any, tone?:"danger"|null, onClick?:() => void}} props */
export function StatCard({ label, value, sub, tone, onClick }) {
  return (
    <button type="button" onClick={onClick} className="flex min-h-[96px] w-full min-w-0 flex-col rounded-md border border-border bg-surface p-3 text-left shadow-1 hover:border-accent/50">
      <span className="flex w-full items-center justify-between gap-2 text-[13px] text-muted">
        <span className="min-w-0 truncate">{label}</span>
        <Icon name="chevronRight" size={16} />
      </span>
      <span className={`mt-1 text-[24px] font-bold tabular-nums break-anywhere ${tone === "danger" ? "text-danger" : ""}`}>{value ?? "—"}</span>
      {sub ? <span className="text-[13px] text-muted break-anywhere">{sub}</span> : null}
    </button>
  );
}

/** @param {{finding:{title:string, detail:string, remediation?:string, code:string}}} props */
export function FindingRow({ finding }) {
  return (
    <li className="py-3">
      <p className="font-semibold break-anywhere">{finding.title || finding.code}</p>
      {finding.detail ? <p className="mt-0.5 text-[15px] text-muted break-anywhere">{finding.detail}</p> : null}
      <p className="mt-2 rounded-sm bg-accent-soft px-3 py-2 text-[14px] break-anywhere">
        <strong>Fix:</strong> {finding.remediation || "No remediation provided — report this finding as a bug."}
      </p>
    </li>
  );
}

/** @param {{severity:"high"|"medium"|"low", findings:any[], defaultOpen:boolean}} props */
export function SeverityLane({ severity, findings, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen);
  const meta = SEV[severity];
  return (
    <section className={`rounded-md border border-border border-l-4 ${meta.border} bg-surface`}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex min-h-[52px] w-full items-center justify-between px-4 text-left">
        <span className="flex items-center gap-2 font-semibold">
          {meta.label} <Badge tone={meta.tone}>{findings.length}</Badge>
        </span>
        <Icon name="chevronDown" size={18} className={open ? "rotate-180" : ""} />
      </button>
      {open ? (
        <div className="border-t border-border px-4">
          {findings.length === 0 ? <p className="py-3 text-muted">Nothing here.</p> : <ul className="divide-y divide-border">{findings.map((f, i) => <FindingRow key={`${f.code}-${i}`} finding={f} />)}</ul>}
        </div>
      ) : null}
    </section>
  );
}

/**
 * @param {{columns:Array<{key:string,label:string,render?:(row:any) => any, sortable?:boolean}>, rows:any[], onRowClick?:(row:any) => void, emptyText:string, sort?:{key:string,dir:string}, onSort?:(key:string) => void, rowKey?:(row:any) => string}} props
 */
export function DataTable({ columns, rows, onRowClick, emptyText, sort, onSort, rowKey = (r) => r.id }) {
  if (!rows.length) return <p className="py-6 text-center text-muted">{emptyText}</p>;
  return (
    <div className="scroll-x rounded-md border border-border bg-surface">
      <table className="w-full min-w-[640px] text-left text-[14px]">
        <thead className="bg-surface-2 text-[12px] tracking-[.02em] text-muted uppercase">
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className="px-3 py-2 font-semibold whitespace-nowrap" aria-sort={sort?.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}>
                {c.sortable && onSort ? (
                  <button type="button" className="inline-flex min-h-[36px] items-center gap-1 uppercase" onClick={() => onSort(c.key)}>
                    {c.label}
                    {sort?.key === c.key ? <span aria-hidden="true">{sort.dir === "asc" ? "▲" : "▼"}</span> : null}
                  </button>
                ) : (
                  c.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
            <tr
              key={rowKey(r)}
              className={onRowClick ? "cursor-pointer hover:bg-surface-2" : ""}
              onClick={onRowClick ? () => onRowClick(r) : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              onKeyDown={onRowClick ? (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onRowClick(r)) : undefined}
            >
              {columns.map((c) => (
                <td key={c.key} className="px-3 py-2 align-top">
                  {c.render ? c.render(r) : r[c.key] ?? "—"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const STATUS_TONE = { ok: "success", infrastructure: "danger", refusal: "warning", invalid_output: "warning" };
/** @param {{status:string}} props */
export function StatusBadge({ status }) {
  return <Badge tone={STATUS_TONE[status] || "neutral"}>{status}</Badge>;
}
