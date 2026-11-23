"use client";
/**
 * Client-side session gate for every signed-in page: /api/auth/me, then
 * redirect to /login?next=… on 401, or to onboarding when it isn't done.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { api } from "@/lib/client/api.js";
import { loginUrl } from "@/lib/client/next-path.js";
import { forgetSession, onboardingSkipped, rememberSignedInUser, warmOfflineCache } from "@/lib/client/local-data.js";
import { PageSpinner, ErrorState } from "@/components/ui/Misc.js";
import { UserContext, readCachedUser, writeCachedUser } from "./UserContext.js";

/**
 * @param {{children:any, requireOnboarded?:boolean}} props
 */
export default function AuthGuard({ children, requireOnboarded = true }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUserState] = useState(null);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);

  const setUser = useCallback((u) => {
    setUserState(u);
    writeCachedUser(u);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const here = () => window.location.pathname + window.location.search;
    api("/api/auth/me", { redirectOn401: false, timeoutMs: 15000 })
      .then(async (data) => {
        if (cancelled) return;
        const u = data?.user;
        if (!u) throw Object.assign(new Error("no user"), { code: "server_error" });
        // A different account on this device: drop the previous one's offline data first (SEC-3).
        await rememberSignedInUser(u.id);
        if (cancelled) return;
        writeCachedUser(u);
        setUserState(u);
        setOffline(false);
        setError(null);
        warmOfflineCache(u.id);
        if (requireOnboarded && !u.onboardedAt && !onboardingSkipped()) router.replace(`/onboarding?next=${encodeURIComponent(here())}`);
      })
      .catch(async (err) => {
        if (cancelled) return;
        if (err.code === "unauthenticated") {
          const hadSession = Boolean(readCachedUser());
          await forgetSession();
          if (cancelled) return;
          router.replace(loginUrl(here(), hadSession ? { reason: "expired" } : {}));
          return;
        }
        const cached = readCachedUser();
        if (cached && (err.code === "offline" || err.code === "timeout" || err.status >= 500)) {
          setUserState(cached);
          setOffline(true);
          return;
        }
        setError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, requireOnboarded, router]);

  const value = useMemo(() => ({ user, setUser, offline }), [user, setUser, offline]);

  if (error && !user) {
    return (
      <main id="main" className="mx-auto max-w-[520px] px-4 py-16">
        <ErrorState title="We couldn't load your account." error={error} onRetry={() => setAttempt((a) => a + 1)} secondary={{ label: "Go to sign in", href: loginUrl(pathname) }} />
      </main>
    );
  }
  if (!user || (requireOnboarded && !user.onboardedAt && !onboardingSkipped())) return <PageSpinner label="Loading…" />;
  return <UserContext.Provider value={value}>{children}</UserContext.Provider>;
}
