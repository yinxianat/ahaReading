"use client";
/**
 * Consumes a magic-link token by POST (never on GET — link scanners prefetch).
 * The token comes from the URL hash or the query; it is removed from the
 * address bar immediately so it doesn't linger in history (UX-SPEC 3.3).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client/api.js";
import { sanitizeNext, loginUrl } from "@/lib/client/next-path.js";
import { rememberSignedInUser } from "@/lib/client/local-data.js";
import { writeCachedUser } from "@/components/app/UserContext.js";
import Button from "@/components/ui/Button.js";
import { RetryButton } from "@/components/ui/Countdown.js";

function readToken() {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const query = new URLSearchParams(window.location.search);
  return hash.get("token") || query.get("token") || "";
}

function stripToken() {
  const url = new URL(window.location.href);
  url.searchParams.delete("token");
  url.hash = "";
  window.history.replaceState(null, "", url.pathname + url.search);
}

const COPY = {
  link_expired: {
    title: "This link has expired",
    body: "Sign-in links work for 15 minutes.",
  },
  link_used: {
    title: "This link was already used",
    body: "Each link works once. If you just signed in on another tab, you're already in.",
  },
  link_invalid: {
    title: "This link isn't valid",
    body: "It may have been cut off when copied. Request a fresh one.",
  },
};

/**
 * After a successful verify (link or code): wipe another user's offline data,
 * then go to `next` — through onboarding for a new account (QA-6).
 * The page's own `next` wins over the server's default; both are sanitised.
 * @param {{replace:(href:string) => void}} router
 * @param {{user?:{id?:string, onboardedAt?:string|null}, next?:string}} data verify response
 * @param {string} next from the page URL ("" when absent)
 */
export async function finishSignIn(router, data, next) {
  if (data?.user?.id) {
    await rememberSignedInUser(data.user.id);
    writeCachedUser(data.user);
  }
  const target = sanitizeNext(next || data?.next, "/read");
  if (!data?.user?.onboardedAt) router.replace(`/onboarding?next=${encodeURIComponent(target)}`);
  else router.replace(target);
}

export default function VerifyClient({ next }) {
  const router = useRouter();
  const [state, setState] = useState({ status: "pending" });
  const started = useRef(false);
  const token = useRef("");
  const inFlight = useRef(false);

  const verify = useCallback(async () => {
    if (inFlight.current) return;
    if (!token.current) {
      setState({ status: "error", code: "link_invalid" });
      return;
    }
    inFlight.current = true;
    setState({ status: "pending" });
    try {
      const body = next ? { token: token.current, next } : { token: token.current };
      const data = await api("/api/auth/verify", { method: "POST", body, timeoutMs: 20000, redirectOn401: false });
      setState({ status: "ok" });
      await finishSignIn(router, data, next);
    } catch (err) {
      setState({ status: "error", code: err.code, retryAfter: err.retryAfter, error: err });
    } finally {
      inFlight.current = false;
    }
  }, [next, router]);

  useEffect(() => {
    // StrictMode runs effects twice in dev; the token must be POSTed once.
    if (started.current) return;
    started.current = true;
    token.current = readToken();
    if (token.current) stripToken();
    verify();
  }, [verify]);

  const newLink = loginUrl(next || "/read");

  if (state.status === "pending" || state.status === "ok") {
    return (
      <div className="text-center" role="status">
        {state.status === "ok" ? (
          <h1 className="text-[24px] font-bold">You&apos;re in.</h1>
        ) : (
          <>
            <span className="spinner text-accent" style={{ width: 28, height: 28 }} aria-hidden="true" />
            <h1 className="mt-3 text-[24px] font-bold">Signing you in…</h1>
            <p className="mt-2 text-muted">This takes a second.</p>
            <div className="mt-5">
              <Button variant="secondary" onClick={verify}>
                Continue signing in
              </Button>
            </div>
          </>
        )}
      </div>
    );
  }

  const known = COPY[state.code];
  if (known) {
    return (
      <div>
        <h1 className="text-[24px] font-bold leading-tight">{known.title}</h1>
        <p className="mt-2 text-muted">{known.body}</p>
        <div className="mt-5 flex flex-col gap-2">
          <Button href={newLink} fullWidth>
            Send a new link
          </Button>
          {state.code === "link_used" ? (
            <Button href="/read" variant="text" fullWidth>
              Go to Library
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  if (state.code === "rate_limited") {
    return (
      <div>
        <h1 className="text-[24px] font-bold leading-tight">Too many attempts</h1>
        <p className="mt-2 text-muted">Wait a moment, then try again.</p>
        <div className="mt-5 flex flex-col gap-2">
          <RetryButton retryAfter={state.retryAfter || 30} onRetry={verify} variant="primary" fullWidth resetKey={state.error} />
          <Button href={newLink} variant="text" fullWidth>
            Send a new link
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-[24px] font-bold leading-tight">We couldn&apos;t sign you in just now.</h1>
      <p className="mt-2 text-muted">
        {state.code === "offline" ? "You're offline. Connect to the internet, then try again." : "Something went wrong on our side. Your link still works if it's under 15 minutes old."}
      </p>
      <div className="mt-5 flex flex-col gap-2">
        <RetryButton retryAfter={0} onRetry={verify} variant="primary" fullWidth waitForOnline={state.code === "offline"} />
        <Button href={newLink} variant="text" fullWidth>
          Send a new link
        </Button>
      </div>
    </div>
  );
}
