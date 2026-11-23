"use client";
/**
 * Admin Overview (UX-SPEC 8.1): one GET /api/admin/overview; every section
 * renders its own error when its part failed.
 */
import { useEffect } from "react";
import { ErrorState, Skeleton } from "@/components/ui/Misc.js";
import { HealthHeadline, SeverityLane, StatCard } from "../parts.js";
import { failed, PartError, Section, useAdminData } from "../useAdminData.js";

export default function Overview({ go, registerRefresh }) {
  const { status, data, error, refresh, updatedAt } = useAdminData("/api/admin/overview", { refreshMs: 60000 });
  useEffect(() => registerRefresh(refresh, updatedAt), [registerRefresh, refresh, updatedAt]);
  if (status === "loading") return <Skeleton lines={6} height={20} />;
  if (status === "error" && !data) return <ErrorState title="Couldn't load the overview." error={error} onRetry={refresh} />;
  const o = data || {};
  const findings = Array.isArray(o.findings) ? o.findings : [];
  const m = failed(o.metrics) ? null : o.metrics;
  const ai = failed(o.aiCalls) ? null : o.aiCalls;
  const logs = failed(o.logs) ? null : o.logs;
  const aiTotal = ai?.total ?? 0;
  const aiFailed = ai ? (ai.byStatus?.infrastructure || 0) + (ai.byStatus?.invalid_output || 0) + (ai.byStatus?.refusal || 0) : 0;
  const failRate = aiTotal ? (aiFailed / aiTotal) * 100 : 0;
  const openErrors = logs?.entries?.length ?? null;
  const critical = logs?.entries?.filter((e) => e.level === "CRITICAL").length ?? 0;

  return (
    <div>
      {failed(o.findings) ? <PartError onRetry={refresh} /> : <HealthHeadline headline={o.headline} findings={findings} onJump={() => document.getElementById("lanes")?.scrollIntoView({ behavior: "smooth" })} />}

      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Users" value={m?.users?.totalRegistered} sub={m ? `${m.users?.activeToday ?? 0} active today` : "unavailable"} onClick={() => go("users")} />
        <StatCard label="Explanations 24h" value={m?.explanations?.total} sub={m ? `${m.explanations?.cacheHitRate ?? "0%"} cached` : "unavailable"} onClick={() => go("ai-calls")} />
        <StatCard label="AI failure rate 24h" value={ai ? `${failRate.toFixed(1)}%` : null} sub={ai ? `${aiFailed} of ${aiTotal}` : "unavailable"} tone={failRate > 10 ? "danger" : null} onClick={() => go("ai-calls")} />
        <StatCard label="Open errors" value={openErrors} sub={logs ? `${critical} critical` : "unavailable"} onClick={() => go("errors")} />
        <StatCard label="Est. AI cost 24h" value={m?.costEstimate?.today ?? null} sub={m?.costEstimate?.projectedMonthly ? `${m.costEstimate.projectedMonthly}/mo projected` : "pricing unavailable"} onClick={() => go("ai-calls")} />
        <StatCard label="Due reviews" value={m?.concepts?.reviewsDueNow} sub={m ? `${m.concepts?.reviewsCompletedToday ?? 0} done today` : "unavailable"} onClick={() => go("users")} />
      </div>

      <Section title="Findings" id="lanes">
        {failed(o.findings) ? (
          <PartError onRetry={refresh} />
        ) : (
          <div className="space-y-3">
            <SeverityLane severity="high" findings={findings.filter((f) => f.severity === "high")} defaultOpen />
            <SeverityLane severity="medium" findings={findings.filter((f) => f.severity === "medium")} defaultOpen={false} />
            <SeverityLane severity="low" findings={findings.filter((f) => f.severity === "low")} defaultOpen={false} />
          </div>
        )}
      </Section>
    </div>
  );
}
