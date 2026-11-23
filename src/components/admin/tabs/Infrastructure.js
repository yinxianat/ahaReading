"use client";
/**
 * Admin Infrastructure (UX-SPEC 8.5): health, AI chain, email and config,
 * from /api/health and /api/admin/diagnostics (which carries
 * `infrastructure`, so the heavy overview call isn't needed here — ENG-8).
 */
import { useEffect, useMemo, useState } from "react";
import { Badge, Skeleton } from "@/components/ui/Misc.js";
import { PartError, useAdminData } from "../useAdminData.js";

function Check({ ok, label, fix, muted }) {
  return (
    <li className={`py-2 ${muted ? "opacity-60" : ""}`}>
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 break-anywhere">{label}</span>
        <span className={ok ? "text-success" : "text-danger"} aria-label={ok ? "OK" : "Problem"}>
          {ok ? "✓" : "✗"}
        </span>
      </div>
      {!ok && fix ? <p className="mt-1 rounded-sm bg-accent-soft px-2 py-1 text-[13px]"><strong>Fix:</strong> {fix}</p> : null}
    </li>
  );
}

function InfraCard({ title, children }) {
  return (
    <section className="rounded-md border border-border bg-surface p-4">
      <h3 className="mb-2 font-semibold">{title}</h3>
      {children}
    </section>
  );
}

// Which diagnostic finding carries the remediation for each config row.
const FINDING_FOR_VAR = {
  JWT_SECRET: "missing_jwt_secret",
  MAGIC_LINK_SECRET: "missing_magic_link_secret",
  BASE_URL: "base_url_problem",
  ADMIN_EMAILS: "no_admin_emails",
};
const SMTP_FINDINGS = ["smtp_credentials_incomplete", "smtp_recent_failure", "smtp_not_configured"];

export default function Infrastructure({ registerRefresh }) {
  const diagnostics = useAdminData("/api/admin/diagnostics");
  const [health, setHealth] = useState({ status: "loading" });
  const [healthTick, setHealthTick] = useState(0);
  const refreshAll = useMemo(() => {
    const refresh = diagnostics.refresh;
    return () => {
      refresh();
      setHealthTick((t) => t + 1);
    };
  }, [diagnostics.refresh]);
  useEffect(() => registerRefresh(refreshAll, diagnostics.updatedAt), [registerRefresh, refreshAll, diagnostics.updatedAt]);
  useEffect(() => {
    let cancelled = false;
    // /api/health answers 503 with a body when fatal; read it either way.
    fetch("/api/health", { cache: "no-store" })
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (!cancelled) setHealth({ status: "ready", httpStatus: r.status, body });
      })
      .catch(() => !cancelled && setHealth({ status: "error" }));
    return () => {
      cancelled = true;
    };
  }, [healthTick]);

  const findings = Array.isArray(diagnostics.data?.findings) ? diagnostics.data.findings : [];
  const fixFor = (...codes) => codes.map((c) => findings.find((f) => f.code === c)?.remediation).find(Boolean);
  const infra = diagnostics.data?.infrastructure || null;
  const checks = health.body?.checks && typeof health.body.checks === "object" ? health.body.checks : null;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <InfraCard title="Health">
        {health.status === "loading" ? <Skeleton lines={3} /> : null}
        {health.status === "error" ? <PartError onRetry={() => setHealthTick((t) => t + 1)} /> : null}
        {health.status === "ready" ? (
          <>
            <p className="mb-2">
              Overall: <Badge tone={health.httpStatus === 200 && health.body?.status !== "degraded" ? "success" : health.httpStatus === 200 ? "warning" : "danger"}>{health.body?.status || `HTTP ${health.httpStatus}`}</Badge>
            </p>
            {checks ? (
              <ul className="divide-y divide-border text-[14px]">
                {Object.entries(checks).map(([name, v]) => {
                  const st = Array.isArray(v) ? (v.length ? v.join(", ") : "none") : v && typeof v === "object" ? v.status : v;
                  const good = st === "ok" || st === true || (Array.isArray(v) && v.length > 0);
                  const warn = /degraded|not_configured|incomplete/.test(String(st));
                  return (
                    <li key={name} className="flex items-center justify-between gap-3 py-2">
                      <span>{name}</span>
                      <Badge tone={good ? "success" : warn ? "warning" : "danger"}>{String(st)}</Badge>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </>
        ) : null}
      </InfraCard>

      <InfraCard title="AI provider chain">
        {diagnostics.status === "loading" ? <Skeleton lines={3} /> : null}
        {diagnostics.status !== "loading" && !infra ? <PartError onRetry={diagnostics.refresh} /> : null}
        {infra ? (
          <ol className="divide-y divide-border text-[14px]">
            {(infra.aiChain || []).map((p) => (
              <li key={p.name} className={`py-2 ${p.configured ? "" : "opacity-60"}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">{p.name}</span>
                  <span className={p.configured ? "text-success" : "text-muted"}>{p.configured ? "configured ✓" : "Skipped — no API key"}</span>
                </div>
                <p className="text-muted break-anywhere">
                  {p.registered ? "registered" : "not registered"} · {p.defaultModel || "no default model"}
                </p>
              </li>
            ))}
          </ol>
        ) : null}
      </InfraCard>

      <InfraCard title="Email">
        {infra ? (
          <ul className="divide-y divide-border text-[14px]">
            <Check ok={infra.smtp?.state === "configured"} label={`SMTP: ${infra.smtp?.state ?? "unknown"}`} fix={fixFor(...SMTP_FINDINGS)} />
            {Object.entries(infra.smtp || {})
              .filter(([k]) => k !== "state")
              .map(([k, v]) => (
                <li key={k} className="flex justify-between gap-3 py-2">
                  <span className="text-muted">{k}</span>
                  <span className="break-anywhere">{v == null ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v)}</span>
                </li>
              ))}
          </ul>
        ) : diagnostics.status === "loading" ? (
          <Skeleton lines={3} />
        ) : (
          <PartError onRetry={diagnostics.refresh} />
        )}
      </InfraCard>

      <InfraCard title="Config">
        {infra ? (
          <ul className="divide-y divide-border text-[14px]">
            {(infra.environment || []).map((v) => (
              <Check
                key={v.name}
                ok={v.set || !v.required}
                muted={!v.required && !v.set}
                label={
                  <>
                    <code>{v.name}</code> <span className="text-muted">· {v.scope}{v.required ? " · required" : ""}{v.set ? " · set" : " · not set"}</span>
                  </>
                }
                fix={(FINDING_FOR_VAR[v.name] && fixFor(FINDING_FOR_VAR[v.name])) || `Set ${v.name} in the deployment environment.`}
              />
            ))}
          </ul>
        ) : diagnostics.status === "loading" ? (
          <Skeleton lines={3} />
        ) : (
          <PartError onRetry={diagnostics.refresh} />
        )}
      </InfraCard>
    </div>
  );
}
