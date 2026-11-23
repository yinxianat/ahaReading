"use client";
/**
 * Reader screen (UX-SPEC 3.6, 4): article, selection capture (desktop pill,
 * touch action bar, tap-a-sentence mode), explain panel, saved-concept marks.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/client/api.js";
import { sentenceSpans, offsetAtPoint, snapshotFromRange } from "@/lib/client/selection.js";
import { parseArticle } from "@/lib/client/article-blocks.js";
import { useCoarsePointer, useIsDesktop, useStoredState } from "@/lib/client/hooks.js";
import { formatDate, nextReviewPhrase } from "@/lib/client/relative-time.js";
import { useUser } from "@/components/app/UserContext.js";
import { useToast } from "@/components/ui/Toast.js";
import Button, { IconButton } from "@/components/ui/Button.js";
import { Segmented } from "@/components/ui/Tabs.js";
import { Skeleton, FullPageError, ErrorState, SavedCopyNote } from "@/components/ui/Misc.js";
import Popover from "@/components/ui/Popover.js";
import Sheet from "@/components/ui/Sheet.js";
import Icon from "@/components/ui/icons.js";
import Alert from "@/components/ui/Alert.js";
import ArticleBody from "./ArticleBody.js";
import { useArticleSelection } from "./useArticleSelection.js";
import { SelectionPill, SelectionActionBar } from "./SelectionUI.js";
import ExplainPanel from "./ExplainPanel.js";
import { plainPreview } from "@/components/notebook/ConceptCard.js";

const SIZES = { S: 16, M: 18, L: 20 };

function TopBar({ title, size, setSize, coarse, tapMode, setTapMode }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const [rect, setRect] = useState(null);
  return (
    <header className="sticky top-0 z-30 border-b border-border/60 backdrop-blur safe-top" style={{ background: "color-mix(in srgb, var(--bg) 85%, transparent)" }}>
      <div className="mx-auto flex h-[52px] max-w-[1120px] items-center gap-1 px-2">
        <Link href="/read" className="inline-flex min-h-[44px] flex-none items-center gap-0.5 rounded-md px-2 font-semibold no-underline">
          <Icon name="chevronLeft" size={20} />
          Library
        </Link>
        <p className="min-w-0 flex-1 truncate px-1 text-center text-[15px] font-semibold" aria-hidden="true">
          {title}
        </p>
        {coarse ? (
          <IconButton
            icon="pointer"
            label="Tap a sentence"
            pressed={tapMode}
            onClick={() => setTapMode(!tapMode)}
          />
        ) : null}
        <button
          ref={btnRef}
          type="button"
          aria-label="Text size"
          aria-expanded={open}
          onClick={() => {
            setRect(btnRef.current?.getBoundingClientRect() || null);
            setOpen((o) => !o);
          }}
          className="inline-flex h-11 min-w-11 items-center justify-center rounded-md px-2 font-reading text-[18px] font-semibold hover:bg-surface-2"
        >
          Aa
        </button>
        <Popover anchorRect={rect} open={open} onClose={() => setOpen(false)} label="Text size" width={240}>
          <p className="mb-2 text-[14px] font-semibold">Text size</p>
          <Segmented
            ariaLabel="Text size"
            className="w-full"
            options={[
              { value: "S", label: "S", ariaLabel: "Small" },
              { value: "M", label: "M", ariaLabel: "Medium" },
              { value: "L", label: "L", ariaLabel: "Large" },
            ]}
            value={size}
            onChange={setSize}
          />
        </Popover>
      </div>
    </header>
  );
}

function ConceptPreview({ preview, isDesktop, onClose, onExplainAgain, now }) {
  if (!preview) return null;
  const { concept } = preview;
  const def = plainPreview(concept.definition);
  const body = (
    <div>
      <p className="font-reading text-[18px] font-semibold break-anywhere">{concept.term}</p>
      <p className="mt-1 text-[15px] text-muted break-anywhere">{def.length > 200 ? `${def.slice(0, 200)}…` : def}</p>
      {concept.nextReviewAt ? <p className="mt-2 text-[14px] text-muted">Next review: {nextReviewPhrase(concept.nextReviewAt, now)}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button href={`/notebook/${concept.id}`} variant="secondary">
          Open in Notebook
        </Button>
        <Button variant="text" onClick={onExplainAgain}>
          Explain again
        </Button>
      </div>
    </div>
  );
  if (isDesktop) {
    return (
      <Popover anchorRect={preview.rect} open onClose={onClose} label={`Saved concept: ${concept.term}`} placement="bottom">
        {body}
      </Popover>
    );
  }
  return (
    <Sheet open onClose={onClose} title="Saved concept" snapPoints={[0.4, 0.7]}>
      {body}
    </Sheet>
  );
}

/**
 * Every saved concept from this article (for the marks), following the cursor
 * so articles with more than one page of concepts keep all their highlights
 * (ENG-11). Capped at 10 pages.
 */
async function loadConceptMarks(articleId, signal) {
  const concepts = [];
  let tags = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const qs = new URLSearchParams({ articleId, limit: "50" });
    if (cursor) qs.set("cursor", cursor);
    const data = await api(`/api/notebook?${qs}`, { signal, timeoutMs: 20000 });
    if (Array.isArray(data?.concepts)) concepts.push(...data.concepts);
    if (page === 0 && Array.isArray(data?.tags)) tags = data.tags;
    cursor = data?.__fromCache ? null : data?.nextCursor || null;
    if (!cursor) break;
  }
  return { concepts, tags };
}

export default function Reader({ id }) {
  const { user } = useUser();
  const { toast } = useToast();
  const coarse = useCoarsePointer();
  const isDesktop = useIsDesktop();
  const [article, setArticle] = useState({ status: "loading" });
  const [concepts, setConcepts] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [attempt, setAttempt] = useState(0);
  const [marksError, setMarksError] = useState(null);
  const [marksAttempt, setMarksAttempt] = useState(0);
  const [sizeKey, setSizeKey] = useStoredState("aha.readSize", "M");
  const [tapModeRaw, setTapModeRaw] = useStoredState("aha.tapMode", "0");
  const [coachSeen, setCoachSeen] = useStoredState("aha.coachReader", "0");
  const [active, setActive] = useState(null);
  const [tap, setTap] = useState(null);
  const [preview, setPreview] = useState(null);
  const [now, setNow] = useState(0);
  const bodyRef = useRef(null);
  const tapStart = useRef(null);
  const lastPending = useRef(null);
  const tapMode = coarse && tapModeRaw === "1";

  const [pending, setPending] = useArticleSelection(bodyRef, { coarse, enabled: article.status === "ready" });

  useEffect(() => {
    const controller = new AbortController();
    api(`/api/articles/${encodeURIComponent(id)}`, { signal: controller.signal, timeoutMs: 20000 })
      .then((data) => {
        setNow(Date.now());
        setArticle({ status: "ready", data: data?.article, fromCache: Boolean(data?.__fromCache) });
      })
      .catch((err) => {
        if (err.code !== "aborted") setArticle({ status: "error", error: err });
      });
    return () => controller.abort();
  }, [id, attempt]);

  useEffect(() => {
    const controller = new AbortController();
    loadConceptMarks(id, controller.signal)
      .then(({ concepts: list, tags }) => {
        setMarksError(null);
        setConcepts(list);
        setSuggestions(tags.map((t) => t.tag).filter(Boolean).slice(0, 6));
      })
      .catch((err) => {
        if (err.code !== "aborted") setMarksError(err);
      });
    return () => controller.abort();
  }, [id, attempt, marksAttempt]);

  useEffect(() => {
    // Toasts sit above the action bar here (no tab bar on this route).
    document.documentElement.style.setProperty("--toast-offset", "84px");
    return () => document.documentElement.style.removeProperty("--toast-offset");
  }, []);

  const blocks = useMemo(() => (article.status === "ready" ? parseArticle(article.data?.content) : []), [article]);
  const paragraphs = useMemo(() => blocks.map((b) => b.text), [blocks]);

  const openPanel = useCallback(
    (snap) => {
      if (!snap || snap.tooLong) return;
      lastPending.current = snap;
      setPreview(null);
      setPending(null);
      setTap(null);
      window.getSelection()?.removeAllRanges();
      setActive({ ...snap, key: `${Date.now()}` });
      if (!isDesktop) {
        // Keep the selected paragraph visible above the sheet.
        const p = bodyRef.current?.querySelector(`[data-p="${snap.paragraphIndexes[0]}"]`);
        if (p) {
          const top = p.getBoundingClientRect().top + window.scrollY - window.innerHeight * 0.08 - 52;
          window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
        }
      }
    },
    [isDesktop, setPending]
  );

  const closePanel = useCallback(
    ({ restore = false } = {}) => {
      setActive(null);
      if (restore && lastPending.current) setPending(lastPending.current);
    },
    [setPending]
  );

  const pickAgain = useCallback(() => {
    setActive(null);
    if (isDesktop) bodyRef.current?.focus?.();
    else toast({ message: "Select one word or term" });
  }, [isDesktop, toast]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.altKey && e.key === "Enter" && pending && !active) {
        e.preventDefault();
        openPanel(pending);
      } else if (e.key === "Escape" && !active) {
        setPending(null);
        setTap(null);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pending, active, openPanel, setPending]);

  const setTapMode = (on) => {
    setTapModeRaw(on ? "1" : "0");
    setTap(null);
    toast({ message: on ? "Tap mode on — tap any sentence to get help." : "Tap mode off." });
  };

  const onPointerDown = (e) => {
    if (!tapMode) return;
    tapStart.current = { x: e.clientX, y: e.clientY, t: Date.now() };
  };
  const onPointerUp = (e) => {
    if (!tapMode || !tapStart.current) return;
    const s = tapStart.current;
    tapStart.current = null;
    if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > 8 || Date.now() - s.t > 300) return;
    if (e.target instanceof Element && e.target.closest("mark.concept")) return;
    const p = e.target instanceof Element ? e.target.closest("[data-p]") : null;
    if (!p) return;
    const index = Number(p.dataset.p);
    const text = paragraphs[index] || "";
    const offset = offsetAtPoint(p, e.clientX, e.clientY);
    if (offset == null) return;
    const span = sentenceSpans(text, user?.locale === "zh" ? "zh" : "en").find(([a, b]) => offset >= a && offset < b);
    if (!span) return;
    const snap = snapshotFromRange(text, index, span[0], span[1], "tap");
    if (!snap) return;
    if (tap && tap.paragraphIndexes[0] === index && tap.ranges[index]?.[0] === snap.ranges[index][0]) {
      setTap(null);
      setPending(null);
      return;
    }
    const withId = { ...snap, id: `${Date.now()}` };
    setTap(withId);
    setPending(withId);
  };

  const onConceptOpen = useCallback(
    (concept, rect, index, start, end) => {
      setNow(Date.now());
      setPreview({ concept, rect, index, start, end });
    },
    []
  );

  const explainAgain = () => {
    if (!preview) return;
    const snap = snapshotFromRange(paragraphs[preview.index] || "", preview.index, preview.start, preview.end, "concept");
    openPanel(snap);
  };

  const onSaved = useCallback((concept) => {
    setConcepts((list) => (list.some((c) => c.id === concept.id) ? list : [...list, concept]));
  }, []);

  if (article.status === "error") {
    const notFound = article.error?.code === "not_found";
    return (
      <main id="main" className="mx-auto max-w-[720px] px-4">
        <div className="py-3">
          <Link href="/read" className="inline-flex min-h-[44px] items-center gap-1 font-semibold no-underline">
            <Icon name="chevronLeft" size={20} /> Library
          </Link>
        </div>
        {notFound ? (
          <FullPageError title="We can't find that article." body="It may have been deleted." primary={{ label: "Back to Library", href: "/read" }} icon="book" />
        ) : (
          <ErrorState title="Couldn't open this article." error={article.error} onRetry={() => { setArticle({ status: "loading" }); setAttempt((a) => a + 1); }} secondary={{ label: "Back to Library", href: "/read" }} />
        )}
      </main>
    );
  }

  const a = article.data;
  const fontSize = SIZES[sizeKey] || SIZES.M;
  const panelOpen = Boolean(active);
  const showPill = !coarse && pending && !panelOpen;
  const showBar = coarse && pending && !panelOpen;

  return (
    <>
      <TopBar title={a?.title || ""} size={sizeKey} setSize={setSizeKey} coarse={coarse} tapMode={tapMode} setTapMode={setTapMode} />
      <div className={`transition-[padding] duration-[var(--dur)] ${panelOpen ? "xl:pr-[420px]" : ""}`}>
        <main id="main" className="mx-auto max-w-[68ch] px-4 pt-6 md:px-6" style={{ paddingBottom: "calc(120px + env(safe-area-inset-bottom))" }}>
          {article.status === "loading" ? (
            <div>
              <Skeleton variant="block" height={30} className="mb-3 w-4/5" />
              <Skeleton variant="block" height={14} className="mb-8 w-2/5" />
              <Skeleton lines={8} height={16} label="Loading article" />
            </div>
          ) : (
            <article>
              <h1 className="text-[24px] leading-[1.3] font-semibold break-anywhere">{a?.title || "Untitled"}</h1>
              <p className="mt-1 mb-6 text-[14px] text-muted break-anywhere">
                {[a?.domain || "Pasted text", a?.createdAt ? `Imported ${formatDate(a.createdAt)}` : null].filter(Boolean).join(" · ")}
                {a?.url ? (
                  <>
                    {" · "}
                    <a href={a.url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-0.5">
                      Open original ↗
                    </a>
                  </>
                ) : null}
              </p>
              {article.fromCache ? <SavedCopyNote className="mb-4" /> : null}
              {marksError && marksError.code !== "unauthenticated" ? (
                <Alert
                  tone="neutral"
                  compact
                  className="mb-4"
                  action={{ label: "Try again", onClick: () => setMarksAttempt((n) => n + 1) }}
                  onDismiss={() => setMarksError(null)}
                >
                  {marksError.code === "offline"
                    ? "You're offline, so the words you saved aren't highlighted. Reading still works."
                    : "Couldn't load the words you saved from this article, so they aren't highlighted. Reading still works."}
                </Alert>
              ) : null}

              {coachSeen !== "1" ? (
                <div className="mb-6 rounded-md border border-accent/30 bg-accent-soft p-4 text-[15px]" role="note">
                  <p>
                    Select any word or sentence you don&apos;t understand, then tap <strong>I don&apos;t understand</strong>.
                  </p>
                  {coarse ? (
                    <p className="mt-1">
                      Prefer tapping? Turn on <strong>Tap a sentence</strong> at the top.
                    </p>
                  ) : null}
                  <Button variant="secondary" className="mt-3" onClick={() => setCoachSeen("1")}>
                    Got it
                  </Button>
                </div>
              ) : null}

              {paragraphs.length === 0 ? (
                <p className="text-muted">This article has no readable text.</p>
              ) : (
                <ArticleBody
                  bodyRef={bodyRef}
                  blocks={blocks}
                  concepts={concepts}
                  activeRanges={active?.ranges}
                  tapRanges={!active ? tap?.ranges : null}
                  fontSize={fontSize}
                  onConceptOpen={onConceptOpen}
                  onPointerDown={onPointerDown}
                  onPointerUp={onPointerUp}
                />
              )}
            </article>
          )}
        </main>
      </div>

      {showPill ? <SelectionPill snapshot={pending} onActivate={() => openPanel(pending)} /> : null}
      {showBar ? (
        <SelectionActionBar
          snapshot={pending}
          onActivate={() => openPanel(pending)}
          onClear={() => {
            setPending(null);
            setTap(null);
            window.getSelection()?.removeAllRanges();
          }}
        />
      ) : null}

      {active ? (
        <ExplainPanel
          key={active.key}
          snapshot={active}
          articleId={a?.id}
          defaultLevel={[1, 2, 3].includes(user?.helpLevel) ? user.helpLevel : 1}
          locale={user?.locale}
          suggestions={suggestions}
          onClose={closePanel}
          onPickSmaller={pickAgain}
          onPickDifferent={pickAgain}
          onSaved={onSaved}
        />
      ) : null}

      <ConceptPreview preview={preview} isDesktop={isDesktop} now={now} onClose={() => setPreview(null)} onExplainAgain={explainAgain} />
    </>
  );
}
