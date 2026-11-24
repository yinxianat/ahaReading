"use client";
/**
 * Every bookmark in one place (/bookmarks): filter by kind, search quotes, notes and
 * article titles, and jump back to the spot (/read/<article>#bm-<bookmark id>; the
 * reader finds the block again by its quote, even after the article was edited). Grouped by
 * article, most recently bookmarked first.
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/client/api.js";
import { KIND_ICON, KIND_LABEL } from "@/lib/client/bookmarks.js";
import { relativeTime } from "@/lib/client/relative-time.js";
import TopBar from "@/components/app/TopBar.js";
import NotebookSwitch from "@/components/notebook/NotebookSwitch.js";
import BookmarkSheet from "@/components/reader/BookmarkSheet.js";
import Button from "@/components/ui/Button.js";
import { Segmented } from "@/components/ui/Tabs.js";
import { EmptyState, ErrorState, Skeleton, SavedCopyNote } from "@/components/ui/Misc.js";
import Icon from "@/components/ui/icons.js";
import { useToast } from "@/components/ui/Toast.js";

const FILTERS = ["all", "revisit", "important"];
// Short labels so three filters fit one row on a phone.
const FILTER_LABEL = { all: "All", revisit: "Re-visit", important: "Important" };

function groupByArticle(bookmarks) {
  const groups = new Map();
  for (const b of bookmarks) {
    if (!groups.has(b.articleId)) groups.set(b.articleId, { articleId: b.articleId, title: b.articleTitle || "Untitled", items: [] });
    groups.get(b.articleId).items.push(b);
  }
  return [...groups.values()];
}

export default function Bookmarks() {
  const { toast } = useToast();
  const [state, setState] = useState({ status: "loading", bookmarks: [], counts: { all: 0, revisit: 0, important: 0 } });
  const [attempt, setAttempt] = useState(0);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState(null);
  const [now, setNow] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    api("/api/bookmarks", { signal: controller.signal, timeoutMs: 15000 })
      .then((data) => {
        setNow(Date.now());
        setState({ status: "ready", bookmarks: data?.bookmarks || [], counts: data?.counts || { all: 0, revisit: 0, important: 0 }, fromCache: Boolean(data?.__fromCache) });
      })
      .catch((err) => {
        if (err.code !== "aborted") setState((s) => ({ ...s, status: "error", error: err }));
      });
    return () => controller.abort();
  }, [attempt]);

  const counts = useMemo(() => {
    const c = { all: state.bookmarks.length, revisit: 0, important: 0 };
    for (const b of state.bookmarks) c[b.kind] += 1;
    return c;
  }, [state.bookmarks]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return state.bookmarks.filter(
      (b) => (filter === "all" || b.kind === filter) && (!q || [b.quote, b.note, b.articleTitle].some((t) => t && t.toLowerCase().includes(q)))
    );
  }, [state.bookmarks, filter, query]);
  const groups = useMemo(() => groupByArticle(visible), [visible]);

  const save = async ({ kind, note }) => {
    const data = await api(`/api/bookmarks/${encodeURIComponent(editing.id)}`, { method: "PATCH", body: { kind, note }, timeoutMs: 15000 });
    setState((s) => ({ ...s, bookmarks: s.bookmarks.map((b) => (b.id === data.bookmark.id ? data.bookmark : b)) }));
    setEditing(null);
    toast({ message: "Bookmark updated.", tone: "success" });
  };
  const remove = async () => {
    try {
      await api(`/api/bookmarks/${encodeURIComponent(editing.id)}`, { method: "DELETE", timeoutMs: 15000 });
    } catch (err) {
      if (err.code !== "not_found") throw err;
    }
    setState((s) => ({ ...s, bookmarks: s.bookmarks.filter((b) => b.id !== editing.id) }));
    setEditing(null);
    toast({ message: "Bookmark deleted." });
  };

  return (
    <main id="main" className="app-main mx-auto max-w-[720px] px-4 md:px-6">
      <TopBar title="Bookmarks" sub={state.status === "ready" ? `${counts.all} saved spot${counts.all === 1 ? "" : "s"}` : " "} />
      <NotebookSwitch current="bookmarks" />

      {state.status === "loading" ? (
        <div className="mt-4 space-y-3">
          <Skeleton variant="card" />
          <Skeleton variant="card" />
        </div>
      ) : null}
      {state.status === "error" ? <ErrorState title="Couldn't load your bookmarks." error={state.error} onRetry={() => { setState((s) => ({ ...s, status: "loading" })); setAttempt((a) => a + 1); }} /> : null}

      {state.status === "ready" && counts.all === 0 ? (
        <EmptyState
          icon="bookmark"
          title="No bookmarks yet"
          body="While reading, select a passage and tap the bookmark button to re-visit it later or mark it as important. Your notes on them collect here."
          action={{ label: "Start reading", href: "/read" }}
        />
      ) : null}

      {state.status === "ready" && counts.all > 0 ? (
        <>
          {state.fromCache ? <SavedCopyNote className="mt-3" /> : null}
          <div className="mt-4 space-y-3">
            <Segmented
              ariaLabel="Show bookmarks"
              className="w-full"
              options={FILTERS.map((f) => ({ value: f, label: `${FILTER_LABEL[f]} (${counts[f]})` }))}
              value={filter}
              onChange={setFilter}
            />
            <div className="relative">
              <label htmlFor="bm-search" className="sr-only">
                Search bookmarks
              </label>
              <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted">
                <Icon name="search" size={18} />
              </span>
              <input
                id="bm-search"
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search passages, notes and articles"
                maxLength={200}
                className="min-h-[44px] w-full rounded-sm border border-border bg-surface pr-3 pl-10 text-[16px] placeholder:text-muted focus:border-accent focus:outline-none"
              />
            </div>
          </div>

          {groups.length === 0 ? (
            <p className="py-8 text-center text-muted">
              No bookmarks match.{" "}
              <button type="button" className="font-semibold text-accent" onClick={() => { setFilter("all"); setQuery(""); }}>
                Show all
              </button>
            </p>
          ) : (
            <div className="mt-6 space-y-8 pb-8">
              {groups.map((g) => (
                <section key={g.articleId} aria-labelledby={`bm-g-${g.articleId}`}>
                  <h2 id={`bm-g-${g.articleId}`} className="mb-2 text-[17px] font-semibold break-anywhere">
                    <Link href={`/read/${encodeURIComponent(g.articleId)}`} className="text-text">
                      {g.title}
                    </Link>
                  </h2>
                  <ul className="space-y-3">
                    {g.items.map((b) => (
                      <li key={b.id} className="rounded-md border border-border bg-surface p-3" data-testid="bookmark-item">
                        <div className="flex items-center justify-between gap-2">
                          <p className={`inline-flex items-center gap-1 text-[13px] font-semibold ${b.kind === "important" ? "text-warning" : "text-accent"}`}>
                            <Icon name={KIND_ICON[b.kind]} size={14} /> {KIND_LABEL[b.kind]}
                          </p>
                          <p className="text-[13px] text-muted">{now ? relativeTime(b.createdAt, now) : ""}</p>
                        </div>
                        <p className="mt-1.5 line-clamp-3 font-reading text-[16px] break-anywhere">“{b.quote}”</p>
                        {b.note ? <p className="mt-1.5 text-[15px] whitespace-pre-wrap break-anywhere">{b.note}</p> : null}
                        <div className="mt-2 flex flex-wrap gap-2">
                          <Button variant="secondary" href={`/read/${encodeURIComponent(b.articleId)}#bm-${encodeURIComponent(b.id)}`}>
                            Open
                          </Button>
                          <Button variant="text" icon="pencil" onClick={() => setEditing(b)} aria-label={`Edit bookmark “${b.quote.slice(0, 40)}”`}>
                            Edit
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </>
      ) : null}

      {editing ? (
        <BookmarkSheet key={editing.id} mode="edit" quote={editing.quote} initial={{ kind: editing.kind, note: editing.note }} onSave={save} onDelete={remove} onClose={() => setEditing(null)} />
      ) : null}
    </main>
  );
}
