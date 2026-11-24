"use client";
/**
 * Notebook list (UX-SPEC 6.1): debounced search, tag chips, article filter,
 * cursor pagination with infinite scroll + a visible "Load more".
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "@/lib/client/api.js";
import { getPendingDeletes, getServerPendingDeletes, subscribePendingDeletes } from "@/lib/client/pending-deletes.js";
import TopBar from "@/components/app/TopBar.js";
import NotebookSwitch from "./NotebookSwitch.js";
import Button from "@/components/ui/Button.js";
import Icon from "@/components/ui/icons.js";
import Sheet from "@/components/ui/Sheet.js";
import { EmptyState, ErrorState, Skeleton, SavedCopyNote } from "@/components/ui/Misc.js";
import ErrorAlert from "@/components/ui/ErrorAlert.js";
import ConceptCard from "./ConceptCard.js";

const CHIP_LIMIT = 12;

function buildQuery({ search, tag, articleId, cursor }) {
  const params = new URLSearchParams();
  if (search) params.set("search", search);
  if (tag) params.set("tag", tag);
  if (articleId) params.set("articleId", articleId);
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}

function matchesLocally(c, search) {
  if (!search) return true;
  const q = search.toLowerCase();
  return [c.term, c.definition, c.definitionZh, c.userNotes, ...(c.tags || [])].some((v) => typeof v === "string" && v.toLowerCase().includes(q));
}

function TagChip({ label, count, active, onClick, ...rest }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={`inline-flex min-h-[44px] flex-none items-center gap-1 rounded-full border px-3 text-[14px] whitespace-nowrap ${
        active ? "border-accent bg-accent-soft font-semibold text-accent" : "border-border bg-surface text-text"
      }`}
      {...rest}
    >
      {active ? <Icon name="check" size={14} /> : null}
      {label}
      {count != null ? <span className="text-muted">· {count}</span> : null}
    </button>
  );
}

export default function Notebook({ initialSearch, initialTag, initialArticleId }) {
  const [input, setInput] = useState(initialSearch);
  const [search, setSearch] = useState(initialSearch);
  const [tag, setTag] = useState(initialTag);
  const [articleId, setArticleId] = useState(initialArticleId);
  const [state, setState] = useState({ status: "loading", concepts: [], tags: [], nextCursor: null, fromCache: false });
  const [more, setMore] = useState({ loading: false, error: null });
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(0);
  const [tagSheet, setTagSheet] = useState(false);
  const [articleSheet, setArticleSheet] = useState(false);
  const [articles, setArticles] = useState({ status: "idle", list: [] });
  const [articleTitle, setArticleTitle] = useState("");
  const sentinel = useRef(null);
  const loadingMore = useRef(false);
  const moreCtl = useRef(null);
  const currentQuery = useRef(null);
  const pendingDeletes = useSyncExternalStore(subscribePendingDeletes, getPendingDeletes, getServerPendingDeletes);

  useEffect(() => {
    const t = setTimeout(() => setSearch(input.trim()), 300);
    return () => clearTimeout(t);
  }, [input]);

  useEffect(() => {
    const qs = buildQuery({ search, tag, articleId });
    window.history.replaceState(window.history.state, "", qs ? `/notebook?${qs}` : "/notebook");
  }, [search, tag, articleId]);

  useEffect(() => {
    const controller = new AbortController();
    const query = buildQuery({ search, tag, articleId });
    // A page still loading for the previous filter must never be appended to
    // this one (ENG-6).
    currentQuery.current = query;
    moreCtl.current?.abort();
    moreCtl.current = null;
    loadingMore.current = false;
    queueMicrotask(() => setMore({ loading: false, error: null }));
    api(`/api/notebook?${query}`, { signal: controller.signal, timeoutMs: 20000 })
      .then((data) => {
        setNow(Date.now());
        const fromCache = Boolean(data?.__fromCache);
        let concepts = Array.isArray(data?.concepts) ? data.concepts : [];
        // Offline: the cached copy may be the unfiltered list; filter it here.
        if (fromCache) concepts = concepts.filter((c) => matchesLocally(c, search) && (!tag || (c.tags || []).includes(tag)) && (!articleId || c.articleId === articleId));
        setState({ status: "ready", concepts, tags: data?.tags || [], nextCursor: fromCache ? null : data?.nextCursor || null, fromCache });
        if (articleId && !articleTitle) {
          const withTitle = concepts.find((c) => c.articleId === articleId && c.articleTitle);
          if (withTitle) setArticleTitle(withTitle.articleTitle);
        }
      })
      .catch((err) => {
        if (err.code !== "aborted") setState({ status: "error", error: err, concepts: [], tags: [], nextCursor: null });
      });
    return () => controller.abort();
    // articleTitle is only a display nicety; refetching on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, tag, articleId, attempt]);

  const loadMore = useCallback(async () => {
    if (loadingMore.current || !state.nextCursor) return;
    const query = buildQuery({ search, tag, articleId });
    if (query !== currentQuery.current) return;
    const controller = new AbortController();
    moreCtl.current = controller;
    loadingMore.current = true;
    setMore({ loading: true, error: null });
    try {
      const data = await api(`/api/notebook?${buildQuery({ search, tag, articleId, cursor: state.nextCursor })}`, { signal: controller.signal, timeoutMs: 20000 });
      if (controller.signal.aborted || query !== currentQuery.current) return;
      setState((s) => {
        const seen = new Set(s.concepts.map((c) => c.id));
        return { ...s, concepts: [...s.concepts, ...(data?.concepts || []).filter((c) => !seen.has(c.id))], nextCursor: data?.nextCursor || null };
      });
      setMore({ loading: false, error: null });
    } catch (err) {
      if (err.code === "aborted" || controller.signal.aborted || query !== currentQuery.current) return;
      setMore({ loading: false, error: err });
    } finally {
      if (moreCtl.current === controller) {
        moreCtl.current = null;
        loadingMore.current = false;
      }
    }
  }, [state.nextCursor, search, tag, articleId]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !state.nextCursor || more.error) return undefined;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && loadMore(), { rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [state.nextCursor, loadMore, more.error]);

  const openArticles = () => {
    setArticleSheet(true);
    if (articles.status === "ready" || articles.status === "loading") return;
    setArticles({ status: "loading", list: [] });
    api("/api/articles", { timeoutMs: 15000 })
      .then((data) => setArticles({ status: "ready", list: data?.articles || [] }))
      .catch((error) => setArticles({ status: "error", list: [], error }));
  };

  const reload = () => {
    setState((s) => ({ ...s, status: "loading" }));
    setAttempt((a) => a + 1);
  };
  const clearFilters = () => {
    setInput("");
    setSearch("");
    setTag("");
    setArticleId("");
    setArticleTitle("");
  };

  const visible = state.concepts.filter((c) => !pendingDeletes.includes(c.id));
  const filtered = Boolean(search || tag || articleId);
  const tags = state.tags || [];
  const chipTags = tags.length > CHIP_LIMIT ? tags.slice(0, CHIP_LIMIT - 1) : tags;
  const countLabel = state.status === "ready" ? `${visible.length}${state.nextCursor ? "+" : ""} concept${visible.length === 1 && !state.nextCursor ? "" : "s"}` : "";

  return (
    <main id="main" className="app-main mx-auto max-w-[720px] px-4 md:px-6">
      <TopBar
        title="Notebook"
        sub={countLabel || " "}
        actions={
          <Button href="/notebook/new" variant="secondary" icon="plus">
            Add
          </Button>
        }
      />
      <NotebookSwitch current="concepts" />

      <div className="sticky top-0 z-20 -mx-4 bg-bg px-4 pt-1 pb-2 md:-mx-6 md:px-6">
        <div className="relative">
          <label htmlFor="nb-search" className="sr-only">
            Search terms and explanations
          </label>
          <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted">
            <Icon name="search" size={18} />
          </span>
          <input
            id="nb-search"
            type="search"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Search terms and explanations"
            maxLength={200}
            className="min-h-[44px] w-full rounded-sm border border-border bg-surface pr-11 pl-10 text-[16px] placeholder:text-muted focus:border-accent focus:outline-none"
          />
          {input ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setInput("")}
              className="absolute top-0 right-0 inline-flex h-11 w-11 items-center justify-center text-muted"
            >
              <Icon name="x" size={18} />
            </button>
          ) : null}
        </div>
      </div>

      {tags.length ? (
        <div className="scroll-x -mx-4 px-4 pb-2 md:-mx-6 md:px-6">
          <div role="radiogroup" aria-label="Filter by tag" className="flex gap-2">
            <TagChip label="All" active={!tag} onClick={() => setTag("")} />
            {chipTags.map((t) => (
              <TagChip key={t.tag} label={t.tag} count={t.count} active={tag === t.tag} onClick={() => setTag(tag === t.tag ? "" : t.tag)} />
            ))}
            {tags.length > CHIP_LIMIT ? <TagChip label="More…" active={false} role="button" aria-checked={undefined} onClick={() => setTagSheet(true)} /> : null}
          </div>
        </div>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {articleId ? (
          <span className="inline-flex max-w-full items-center rounded-full bg-accent-soft pl-3 text-[14px]">
            <span className="min-w-0 truncate">From: {articleTitle || "this article"}</span>
            <button type="button" aria-label="Clear article filter" className="inline-flex h-10 w-10 items-center justify-center" onClick={() => { setArticleId(""); setArticleTitle(""); }}>
              <Icon name="x" size={16} />
            </button>
          </span>
        ) : (
          <Button variant="secondary" onClick={openArticles}>
            All articles <Icon name="chevronDown" size={16} />
          </Button>
        )}
      </div>

      {state.fromCache ? <SavedCopyNote className="mb-3" /> : null}

      {state.status === "loading" ? (
        <div className="space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} variant="card" />
          ))}
        </div>
      ) : null}

      {state.status === "error" ? <ErrorState title="Couldn't load your Notebook." error={state.error} onRetry={reload} /> : null}

      {state.status === "ready" && visible.length === 0 && !filtered ? (
        <EmptyState icon="bookmark" title="Your Notebook is empty" body="Save an explanation while reading, or tap Add to write your own. They'll show up here." action={{ label: "Start reading", href: "/read" }} />
      ) : null}
      {state.status === "ready" && visible.length === 0 && filtered ? (
        <EmptyState
          icon="search"
          title={search ? `No concepts match “${search}”.` : "No concepts match these filters."}
          action={{ label: "Clear filters", onClick: clearFilters }}
        />
      ) : null}

      {state.status === "ready" && visible.length > 0 ? (
        <>
          <ul className="space-y-3">
            {visible.map((c) => (
              <ConceptCard key={c.id} concept={c} now={now} />
            ))}
          </ul>
          <div ref={sentinel} />
          {more.error ? (
            // A 400 here is a stale cursor: retrying it can't work, reloading the list can (E7).
            <ErrorAlert
              className="mt-4"
              error={more.error}
              context="load"
              onRetry={more.error.code === "invalid_input" ? reload : loadMore}
              extraActions={more.error.code === "invalid_input" ? [] : [{ label: "Reload list", onClick: reload }]}
              compact
            />
          ) : null}
          {state.nextCursor && !more.error ? (
            <div className="mt-4 flex justify-center">
              <Button variant="secondary" onClick={loadMore} loading={more.loading} loadingLabel="Loading…">
                Load more
              </Button>
            </div>
          ) : null}
        </>
      ) : null}

      <Sheet open={tagSheet} onClose={() => setTagSheet(false)} title="All tags" snapPoints={[0.6, 0.92]}>
        <div role="radiogroup" aria-label="Filter by tag" className="flex flex-wrap gap-2 pt-2">
          <TagChip label="All" active={!tag} onClick={() => { setTag(""); setTagSheet(false); }} />
          {tags.map((t) => (
            <TagChip key={t.tag} label={t.tag} count={t.count} active={tag === t.tag} onClick={() => { setTag(t.tag); setTagSheet(false); }} />
          ))}
        </div>
      </Sheet>

      <Sheet open={articleSheet} onClose={() => setArticleSheet(false)} title="Filter by article" snapPoints={[0.6, 0.92]}>
        {articles.status === "loading" ? <Skeleton lines={4} height={20} /> : null}
        {articles.status === "error" ? (
          <ErrorAlert error={articles.error} context="load" onRetry={() => { setArticles({ status: "idle", list: [] }); openArticles(); }} compact />
        ) : null}
        {articles.status === "ready" && articles.list.length === 0 ? <p className="py-4 text-muted">No articles yet.</p> : null}
        <ul className="divide-y divide-border">
          {articles.list.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                className="flex min-h-[52px] w-full items-center text-left break-anywhere"
                onClick={() => {
                  setArticleId(a.id);
                  setArticleTitle(a.title || "Untitled");
                  setArticleSheet(false);
                }}
              >
                {a.title || "Untitled"}
              </button>
            </li>
          ))}
        </ul>
      </Sheet>
    </main>
  );
}
