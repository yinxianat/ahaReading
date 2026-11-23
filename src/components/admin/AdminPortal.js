"use client";
/**
 * Operator portal shell (UX-SPEC 8): tab bar, refresh + updated time, 403
 * page. Each tab lives in ./tabs/ and degrades on its own instead of blanking
 * the page. Active tab lives in ?tab= (LESSONS 49j).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/client/api.js";
import { useUser } from "@/components/app/UserContext.js";
import Tabs from "@/components/ui/Tabs.js";
import Button from "@/components/ui/Button.js";
import { FullPageError } from "@/components/ui/Misc.js";
import Overview from "./tabs/Overview.js";
import AiCalls from "./tabs/AiCalls.js";
import Errors from "./tabs/Errors.js";
import Users from "./tabs/Users.js";
import Infrastructure from "./tabs/Infrastructure.js";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "ai-calls", label: "AI Calls" },
  { id: "errors", label: "Errors" },
  { id: "users", label: "Users" },
  { id: "infrastructure", label: "Infrastructure" },
];

export default function AdminPortal({ initialTab }) {
  const { user } = useUser();
  const [tab, setTab] = useState(initialTab);
  const [meta, setMeta] = useState({ refresh: null, updatedAt: 0 });
  const [forbidden, setForbidden] = useState(false);
  const metaRef = useRef(meta);

  const registerRefresh = useCallback((refresh, updatedAt) => {
    metaRef.current = { refresh, updatedAt };
    setMeta({ refresh, updatedAt });
  }, []);

  useEffect(() => {
    // Admin APIs answer 403 for non-admins; check once so the 403 page shows
    // even if /api/auth/me's isAdmin is stale.
    api("/api/admin/metrics", { timeoutMs: 15000 }).catch((err) => err.status === 403 && setForbidden(true));
  }, []);

  const go = (id) => {
    setTab(id);
    window.history.replaceState(window.history.state, "", `/admin?tab=${id}`);
  };

  if (forbidden || user?.isAdmin === false) {
    return (
      <main id="main">
        <FullPageError title="This area is for operators." body="Your account doesn't have admin access." primary={{ label: "Back to reading", href: "/read" }} icon="shield" />
      </main>
    );
  }

  return (
    <div className="min-h-dvh">
      <header className="border-b border-border bg-surface safe-top">
        <div className="mx-auto flex min-h-[56px] max-w-[1280px] flex-wrap items-center justify-between gap-2 px-4">
          <p className="font-bold">AhaReading · Admin</p>
          <Link href="/read" className="inline-flex min-h-[44px] items-center font-semibold">
            Back to app
          </Link>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-[1280px] px-4 pt-4 pb-16">
        <h1 className="sr-only">Admin portal</h1>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Tabs tabs={TABS} value={tab} onChange={go} ariaLabel="Admin sections" idPrefix="admin" className="min-w-0 flex-1" />
          <div className="flex items-center gap-2">
            {meta.updatedAt ? <span className="text-[13px] text-muted">Updated {new Date(meta.updatedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" })}</span> : null}
            <Button variant="secondary" icon="refresh" onClick={() => meta.refresh?.()}>
              Refresh
            </Button>
          </div>
        </div>
        <div role="tabpanel" id={`admin-panel-${tab}`} aria-labelledby={`admin-${tab}`} className="mt-5">
          {tab === "overview" ? <Overview go={go} registerRefresh={registerRefresh} /> : null}
          {tab === "ai-calls" ? <AiCalls registerRefresh={registerRefresh} /> : null}
          {tab === "errors" ? <Errors registerRefresh={registerRefresh} /> : null}
          {tab === "users" ? <Users registerRefresh={registerRefresh} /> : null}
          {tab === "infrastructure" ? <Infrastructure registerRefresh={registerRefresh} /> : null}
        </div>
      </main>
    </div>
  );
}
