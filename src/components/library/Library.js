"use client";
/**
 * Library (UX-SPEC 3.5): new reading (paste / import URL) and recent reads.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, BEFORE_AUTH_REDIRECT } from "@/lib/client/api.js";
import { relativeTime } from "@/lib/client/relative-time.js";
import { useStoredState } from "@/lib/client/hooks.js";
import TopBar from "@/components/app/TopBar.js";
import Tabs from "@/components/ui/Tabs.js";
import Button, { IconButton } from "@/components/ui/Button.js";
import { TextField, TextArea } from "@/components/ui/Field.js";
import ErrorAlert from "@/components/ui/ErrorAlert.js";
import Dialog from "@/components/ui/Dialog.js";
import { Card, EmptyState, ErrorState, Skeleton, SavedCopyNote } from "@/components/ui/Misc.js";
import Alert from "@/components/ui/Alert.js";
import { useToast } from "@/components/ui/Toast.js";

const MAX_TEXT = 200000;
const DRAFT_KEY = "aha.draft";
const IMPORT_TIMEOUT_MS = 20000;

/**
 * The link inside `text` when it is essentially just a link (PO-7), else null.
 * @param {string} text
 * @returns {string|null}
 */
export function linkIn(text) {
  const t = String(text || "").trim();
  if (!t || t.length > 2048) return null;
  if (/^(https?:\/\/|www\.)\S+$/i.test(t)) return t;
  // Share sheets often send "Title https://…": take the one link if that's all there is.
  const found = t.match(/https?:\/\/\S+/gi);
  if (found && found.length === 1 && t.length - found[0].length <= 200 && !t.includes("\n\n")) return found[0];
  return null;
}

function NewReading() {
  const router = useRouter();
  const [tab, setTab] = useStoredState("aha.newTab", "paste");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [fieldError, setFieldError] = useState({});
  const inFlight = useRef(false);
  const textRef = useRef(null);
  const urlRef = useRef(null);
  const titleRef = useRef(null);
  const draftTimer = useRef(null);
  const [clip, setClip] = useState(null);

  useEffect(() => {
    // Android share target (manifest share_target → /read?url=…&text=…).
    const params = new URLSearchParams(window.location.search);
    const shared = linkIn(params.get("url") || "") || linkIn(params.get("text") || "");
    if (shared) {
      queueMicrotask(() => {
        setTab("url");
        setUrl(shared);
      });
      window.history.replaceState(window.history.state, "", "/read");
      return;
    }
    try {
      const saved = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || "null");
      if (saved?.text) {
        queueMicrotask(() => {
          setText(saved.text);
          setTitle(saved.title || "");
        });
      }
    } catch {
      // unreadable draft: start empty
    }
  }, [setTab]);

  const saveDraft = useCallback((nextText, nextTitle) => {
    try {
      if (nextText) sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ text: nextText, title: nextTitle }));
      else sessionStorage.removeItem(DRAFT_KEY);
    } catch {
      // storage blocked
    }
  }, []);

  useEffect(() => {
    clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => saveDraft(text, title), 500);
    return () => clearTimeout(draftTimer.current);
  }, [text, title, saveDraft]);

  useEffect(() => {
    // A 401 mid-session reloads the page; keep the paste safe first.
    const onRedirect = () => saveDraft(text, title);
    window.addEventListener(BEFORE_AUTH_REDIRECT, onRedirect);
    return () => window.removeEventListener(BEFORE_AUTH_REDIRECT, onRedirect);
  }, [text, title, saveDraft]);

  const submit = async (body) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setFieldError({});
    try {
      const data = await api("/api/articles", { method: "POST", body, timeoutMs: IMPORT_TIMEOUT_MS });
      if (!body.url) {
        try {
          sessionStorage.removeItem(DRAFT_KEY);
        } catch {
          // ignore
        }
      }
      router.push(`/read/${data.article.id}`);
    } catch (err) {
      if (err.code === "invalid_input" && err.field) {
        const field = err.field === "url" ? "url" : err.field === "title" ? "title" : "text";
        setFieldError({ [field]: err.message || "Check this field." });
        (field === "url" ? urlRef : field === "title" ? titleRef : textRef).current?.focus();
      } else {
        setError(err);
      }
      inFlight.current = false;
      setBusy(false);
    }
  };

  const onPaste = (e) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) {
      setFieldError({ text: "Paste some text to start reading." });
      textRef.current?.focus();
      return;
    }
    if (trimmed.length > MAX_TEXT) {
      setFieldError({ text: `That's longer than ${MAX_TEXT.toLocaleString()} characters. Paste a shorter part of the article.` });
      textRef.current?.focus();
      return;
    }
    submit(title.trim() ? { text: trimmed, title: title.trim() } : { text: trimmed });
  };

  const onImport = (e) => {
    e.preventDefault();
    let value = url.trim();
    if (!value) {
      setFieldError({ url: "Paste the link of the article you want to read." });
      urlRef.current?.focus();
      return;
    }
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
    setUrl(value);
    submit({ url: value });
  };

  const pasteLink = async () => {
    setClip(null);
    setError(null);
    let value = "";
    try {
      if (!navigator.clipboard?.readText) throw new Error("unsupported");
      value = await navigator.clipboard.readText();
    } catch {
      setClip({ tone: "warning", message: "We couldn't read your clipboard. Tap the link field, then long-press and choose Paste." });
      urlRef.current?.focus();
      return;
    }
    const link = linkIn(value);
    if (!link) {
      setClip({ tone: "neutral", message: "Your clipboard doesn't have a link in it. Copy the article's address first, or paste its text instead." });
      return;
    }
    setUrl(link);
    if (fieldError.url) setFieldError({});
    urlRef.current?.focus();
  };

  const importLinkInstead = (link) => {
    setTab("url");
    setUrl(link);
    setError(null);
    setFieldError({});
    queueMicrotask(() => urlRef.current?.focus());
  };

  const pasteInstead = () => {
    setError(null);
    setTab("paste");
    queueMicrotask(() => textRef.current?.focus());
  };

  const count = text.length;
  const pastedLink = tab === "paste" ? linkIn(text) : null;
  return (
    <Card padding="p-4 sm:p-5">
      <h2 className="mb-2 text-[20px] font-semibold">New reading</h2>
      <Tabs
        ariaLabel="New reading"
        idPrefix="new"
        tabs={[
          { id: "paste", label: "Paste text" },
          { id: "url", label: "Import from URL" },
        ]}
        value={tab}
        onChange={(t) => {
          setTab(t);
          setError(null);
        }}
      />
      {tab === "paste" ? (
        <form id="new-panel-paste" role="tabpanel" aria-labelledby="new-paste" className="mt-4 space-y-3" onSubmit={onPaste} noValidate>
          <TextField ref={titleRef} label="Title (optional)" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} error={fieldError.title} />
          <TextArea
            ref={textRef}
            label="Article text"
            placeholder="Paste the article you're reading…"
            value={text}
            minHeight={180}
            onChange={(e) => {
              setText(e.target.value);
              if (fieldError.text) setFieldError({});
            }}
            error={fieldError.text}
            counter={{ text: `${count.toLocaleString()} / ${MAX_TEXT.toLocaleString()}`, over: count > MAX_TEXT }}
          />
          {pastedLink ? (
            <Alert tone="info" compact action={{ label: "Import this link instead", onClick: () => importLinkInstead(pastedLink) }}>
              That looks like a link. We can fetch the article for you.
            </Alert>
          ) : null}
          {error ? <ErrorAlert error={error} context="articles" onRetry={onPaste} onDismiss={() => setError(null)} /> : null}
          <Button type="submit" fullWidth loading={busy} loadingLabel="Opening…" disabled={!text.trim()}>
            Start reading
          </Button>
        </form>
      ) : (
        <form id="new-panel-url" role="tabpanel" aria-labelledby="new-url" className="mt-4 space-y-3" onSubmit={onImport} noValidate>
          <TextField
            ref={urlRef}
            label="Article link"
            type="url"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="https://…"
            value={url}
            maxLength={2048}
            onChange={(e) => {
              setUrl(e.target.value);
              if (fieldError.url) setFieldError({});
            }}
            error={fieldError.url}
            helper="Works with most articles and blogs. Paywalled or login-only pages won't import — paste the text instead."
          />
          <Button variant="secondary" icon="clipboard" fullWidth onClick={pasteLink} disabled={busy}>
            Paste link from clipboard
          </Button>
          {clip ? (
            <Alert tone={clip.tone} compact onDismiss={() => setClip(null)} secondaryAction={clip.tone === "neutral" ? { label: "Paste text instead", onClick: pasteInstead } : undefined}>
              {clip.message}
            </Alert>
          ) : null}
          {busy ? <p className="text-[14px] text-muted" role="status">Fetching the page — up to 10 seconds.</p> : null}
          {error ? (
            <ErrorAlert error={error} context="import" onRetry={onImport} onPasteInstead={pasteInstead} onDismiss={() => setError(null)} />
          ) : null}
          <Button type="submit" fullWidth loading={busy} loadingLabel="Importing…">
            Import
          </Button>
        </form>
      )}
    </Card>
  );
}

function ArticleCard({ article, now, onDelete }) {
  const meta = [article.domain || "Pasted text", relativeTime(article.lastReadAt, now), article.conceptCount ? `${article.conceptCount} concept${article.conceptCount === 1 ? "" : "s"}` : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <li className="relative">
      <Card href={`/read/${article.id}`} className="pr-14">
        <p className="line-clamp-2 font-semibold break-anywhere">{article.title || "Untitled"}</p>
        <p className="mt-1 truncate text-[14px] text-muted">{meta}</p>
        {article.excerpt ? <p className="mt-2 line-clamp-2 text-[15px] text-muted break-anywhere">{article.excerpt}</p> : null}
      </Card>
      <IconButton icon="trash" label={`Delete “${article.title || "Untitled"}”`} className="absolute top-2 right-2 text-muted" onClick={() => onDelete(article)} />
    </li>
  );
}

function Recent() {
  const [state, setState] = useState({ status: "loading", articles: [], fromCache: false });
  const [now, setNow] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [confirm, setConfirm] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const cancelRef = useRef(null);
  const { toast } = useToast();

  useEffect(() => {
    const controller = new AbortController();
    api("/api/articles", { signal: controller.signal, timeoutMs: 15000 })
      .then((data) => {
        setNow(Date.now());
        setState({ status: "ready", articles: data?.articles || [], fromCache: Boolean(data?.__fromCache) });
      })
      .catch((err) => {
        if (err.code === "aborted") return;
        setState({ status: "error", error: err, articles: [] });
      });
    return () => controller.abort();
  }, [attempt]);

  const doDelete = async () => {
    if (!confirm) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api(`/api/articles/${encodeURIComponent(confirm.id)}`, { method: "DELETE", timeoutMs: 15000 });
      setState((s) => ({ ...s, articles: s.articles.filter((a) => a.id !== confirm.id) }));
      setConfirm(null);
      toast({ message: "Article deleted." });
    } catch (err) {
      if (err.code === "not_found") {
        setState((s) => ({ ...s, articles: s.articles.filter((a) => a.id !== confirm.id) }));
        setConfirm(null);
      } else setDeleteError(err);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <section className="mt-8" aria-labelledby="recent-h">
      <h2 id="recent-h" className="mb-3 text-[20px] font-semibold">
        Recent reading
      </h2>
      {state.fromCache ? <SavedCopyNote className="mb-3" /> : null}
      {state.status === "loading" ? (
        <div className="space-y-3">
          <Skeleton variant="card" />
          <Skeleton variant="card" />
          <Skeleton variant="card" />
        </div>
      ) : null}
      {state.status === "error" ? (
        <ErrorState title="Couldn't load your reading list." error={state.error} onRetry={() => { setState({ status: "loading", articles: [] }); setAttempt((a) => a + 1); }} />
      ) : null}
      {state.status === "ready" && state.articles.length === 0 ? (
        <EmptyState icon="book" title="Nothing here yet" body="Paste an article above or import a link to start reading." />
      ) : null}
      {state.status === "ready" && state.articles.length > 0 ? (
        <ul className="space-y-3">
          {state.articles.map((a) => (
            <ArticleCard key={a.id} article={a} now={now} onDelete={(article) => { setDeleteError(null); setConfirm(article); }} />
          ))}
        </ul>
      ) : null}

      <Dialog
        open={Boolean(confirm)}
        onClose={() => !deleting && setConfirm(null)}
        title={`Delete “${confirm?.title || "Untitled"}”?`}
        description="Concepts you saved from it stay in your Notebook."
        initialFocusRef={cancelRef}
        actions={
          <>
            <Button ref={cancelRef} variant="secondary" onClick={() => setConfirm(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="danger" onClick={doDelete} loading={deleting} loadingLabel="Deleting…">
              Delete
            </Button>
          </>
        }
      >
        {deleteError ? <ErrorAlert error={deleteError} context="form" onRetry={doDelete} compact /> : null}
      </Dialog>
    </section>
  );
}

export default function Library() {
  return (
    <main id="main" className="app-main mx-auto max-w-[720px] px-4 md:px-6">
      <TopBar title="Read" />
      <NewReading />
      <Recent />
    </main>
  );
}
