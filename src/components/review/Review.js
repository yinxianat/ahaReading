"use client";
/**
 * Spaced review session (UX-SPEC 6.3). Ratings are optimistic: the next card
 * shows at once and the POST runs in the background; a network failure puts
 * the rating on the offline queue (synced by OfflineBanner).
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client/api.js";
import { enqueueReview, getQueue, newClientId } from "@/lib/client/offline-queue.js";
import { nextReviewPhrase } from "@/lib/client/relative-time.js";
import { useUser } from "@/components/app/UserContext.js";
import { useDue, useQueuedCount } from "@/components/app/DueContext.js";
import { queueLine } from "@/components/app/OfflineBanner.js";
import { useToast } from "@/components/ui/Toast.js";
import Button from "@/components/ui/Button.js";
import Icon from "@/components/ui/icons.js";
import { EmptyState, ErrorState, Skeleton, SavedCopyNote } from "@/components/ui/Misc.js";
import { Flashcard, RatingBar } from "./Flashcard.js";

/**
 * The one progress line (PO-13): "3-day streak · 12 reviewed today · 5 mastered".
 * Parts that are zero are left out; empty when there is nothing to say.
 * @param {{streakDays:number, reviewedToday:number, mastered?:number}|null} stats
 * @returns {string}
 */
export function statsLine(stats) {
  if (!stats) return "";
  const parts = [];
  if (stats.streakDays > 0) parts.push(`${stats.streakDays}-day streak`);
  if (stats.reviewedToday > 0) parts.push(`${stats.reviewedToday} reviewed today`);
  if (stats.mastered > 0) parts.push(`${stats.mastered} mastered`);
  return parts.join(" · ");
}

function validStats(s) {
  return s && Number.isInteger(s.streakDays) && Number.isInteger(s.reviewedToday) && Number.isInteger(s.mastered) ? s : null;
}

function earliestOf(a, b) {
  if (!a) return b;
  if (!b) return a;
  return new Date(a) < new Date(b) ? a : b;
}

export default function Review({ conceptId }) {
  const { user } = useUser();
  const { refresh: refreshDue } = useDue();
  const queued = useQueuedCount();
  const { toast } = useToast();
  const [state, setState] = useState({ status: "loading" });
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [reviewed, setReviewed] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(0);
  const [earliestNext, setEarliestNext] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    const url = conceptId ? `/api/notebook/${encodeURIComponent(conceptId)}` : "/api/review";
    api(url, { signal: controller.signal, timeoutMs: 20000 })
      .then((data) => {
        setNow(Date.now());
        if (conceptId) {
          const c = data?.concept || data;
          setState({ status: "ready", cards: c ? [c] : [], dueCount: c ? 1 : 0, nextDueAt: null, single: true });
          return;
        }
        // Offline: drop cards already rated but not yet synced.
        const pendingIds = new Set(getQueue().map((q) => q.conceptId));
        const cards = (data?.due || []).filter((c) => !data?.__fromCache || !pendingIds.has(c.id));
        const fromCache = Boolean(data?.__fromCache);
        // A cached copy's numbers are stale, so no progress line offline.
        const stats = fromCache ? null : validStats(data?.stats);
        setState({ status: "ready", cards, dueCount: Number(data?.dueCount) || cards.length, nextDueAt: data?.nextDueAt || null, fromCache, stats });
      })
      .catch((err) => {
        if (err.code !== "aborted") setState({ status: "error", error: err });
      });
    return () => controller.abort();
  }, [conceptId, attempt]);

  const cards = state.cards || [];
  const card = cards[index];
  const done = state.status === "ready" && cards.length > 0 && index >= cards.length;

  const rate = useCallback(
    (quality) => {
      if (!card || !revealed) return;
      const review = { conceptId: card.id, quality, clientId: newClientId() };
      setIndex((i) => i + 1);
      setRevealed(false);
      setReviewed((n) => n + 1);
      api("/api/review", { method: "POST", body: review, timeoutMs: 15000 })
        .then((data) => {
          if (data?.nextReviewAt) setEarliestNext((prev) => (!prev || new Date(data.nextReviewAt) < new Date(prev) ? data.nextReviewAt : prev));
          refreshDue();
        })
        .catch((err) => {
          // Transient failures — including 429 — are queued and synced later (E8).
          if (err.code === "offline" || err.code === "timeout" || err.status >= 500 || err.status === 429) enqueueReview(review);
          else if (err.code === "review_conflict") {
            // Reviewed on another device at the same moment: the server kept that rating.
            toast({ message: "That card was just reviewed on another device, so this rating wasn't saved.", action: {
                label: "Reload reviews",
                onClick: () => {
                  setState({ status: "loading" });
                  setIndex(0);
                  setRevealed(false);
                  setAttempt((n) => n + 1);
                },
              },
            });
            refreshDue();
          } else if (err.code !== "unauthenticated") toast({ message: "One review couldn't be saved and was skipped." });
        });
    },
    [card, revealed, refreshDue, toast]
  );

  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      if (t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      if (e.metaKey || e.ctrlKey || e.altKey || !card) return;
      if (!revealed && (e.key === " " || e.key === "Enter")) {
        e.preventDefault();
        setRevealed(true);
      } else if (revealed && ["1", "2", "3"].includes(e.key)) {
        e.preventDefault();
        rate({ 1: 1, 2: 3, 3: 5 }[e.key]);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [card, revealed, rate]);

  const again = () => {
    setState({ status: "loading" });
    setIndex(0);
    setReviewed(0);
    setRevealed(false);
    setEarliestNext(null);
    setAttempt((a) => a + 1);
  };

  const total = cards.length;
  const position = Math.min(index + 1, total);
  // After a session: today now counts toward the streak. Mastered is left out
  // because this session's new intervals aren't known here.
  const doneStats = state.stats
    ? {
        streakDays: state.stats.streakDays + (state.stats.reviewedToday === 0 && reviewed > 0 ? 1 : 0),
        reviewedToday: state.stats.reviewedToday + reviewed,
      }
    : null;
  const emptyLine = statsLine(state.stats);

  return (
    <main id="main" className="app-main mx-auto max-w-[720px] px-4 md:px-6">
      <header className="pt-4 pb-2 safe-top">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="text-[28px] leading-tight font-bold">Review</h1>
          {state.status === "ready" && total > 0 && !done ? (
            <p className="text-muted tabular-nums" aria-label={`Card ${position} of ${total}`}>
              {position} of {total}
            </p>
          ) : null}
        </div>
        {state.status === "ready" && total > 0 ? (
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
            <div className="h-full bg-accent transition-[width] duration-[var(--dur)]" style={{ width: `${(Math.min(index, total) / total) * 100}%` }} />
          </div>
        ) : null}
        {queued > 0 ? <p className="mt-2 text-[14px] text-muted">{queueLine(queued)}</p> : null}
        {state.fromCache ? <SavedCopyNote className="mt-1" /> : null}
      </header>

      {state.status === "loading" ? <Skeleton variant="block" height={280} className="mx-auto mt-4 max-w-[560px] rounded-lg" /> : null}
      {state.status === "error" ? (
        state.error?.code === "not_found" ? (
          <EmptyState icon="layers" title="That concept isn't in your Notebook." body="It may have been deleted." action={{ label: "Back to Notebook", href: "/notebook" }} />
        ) : (
          <ErrorState title="Couldn't load your reviews." error={state.error} onRetry={again} />
        )
      ) : null}

      {state.status === "ready" && total === 0 ? (
        state.nextDueAt ? (
          <EmptyState
            icon="layers"
            title="Nothing due"
            body={`Next review ${nextReviewPhrase(state.nextDueAt, now)}.${emptyLine ? ` ${emptyLine}.` : ""}`}
            action={{ label: "Back to reading", href: "/read" }}
          />
        ) : (
          <EmptyState
            icon="layers"
            title="Nothing due"
            body={`Save concepts while reading and they'll appear here for review.${emptyLine ? ` ${emptyLine}.` : ""}`}
            action={{ label: "Start reading", href: "/read" }}
          />
        )
      ) : null}

      {done ? (
        <div className="flex flex-col items-center px-4 py-10 text-center" role="status">
          <span className="mb-3 inline-flex h-14 w-14 items-center justify-center rounded-full bg-success-soft text-success">
            <Icon name="check" size={28} />
          </span>
          <h2 className="text-[24px] font-bold">All done</h2>
          <p className="mt-1 text-muted">
            You reviewed {reviewed} concept{reviewed === 1 ? "" : "s"}.
          </p>
          {!state.single && (state.nextDueAt || earliestNext) ? (
            <p className="mt-1 text-muted">Next review {nextReviewPhrase(earliestOf(state.nextDueAt, earliestNext), now)}</p>
          ) : null}
          {!state.single && statsLine(doneStats) ? (
            <p className="mt-1 font-semibold" data-testid="review-stats">
              {statsLine(doneStats)}
            </p>
          ) : null}
          <div className="mt-5 flex flex-col gap-2 sm:flex-row">
            <Button href="/read">Back to reading</Button>
            {!state.single ? (
              <Button variant="secondary" onClick={again}>
                Review again
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {card ? (
        <div className="mx-auto mt-4 max-w-[560px]">
          <Flashcard key={card.id} concept={card} revealed={revealed} onReveal={() => setRevealed(true)} locale={user?.locale} />
          {!revealed ? <p className="mt-3 text-center text-[14px] text-muted">Tap to reveal · Space</p> : null}
        </div>
      ) : null}

      {card && revealed ? (
        <div
          className="fixed inset-x-0 z-20 border-t border-border bg-bg px-4 pt-3 pb-3 lg:static lg:mx-auto lg:mt-6 lg:max-w-[560px] lg:border-0 lg:p-0"
          style={{ bottom: "calc(var(--tabbar-h) + env(safe-area-inset-bottom))" }}
        >
          <div className="mx-auto max-w-[560px]">
            <RatingBar onRate={rate} />
          </div>
        </div>
      ) : null}
    </main>
  );
}
