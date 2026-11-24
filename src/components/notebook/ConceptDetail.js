"use client";
/**
 * Concept detail (UX-SPEC 6.2): edit term/definition, autosaving note, tags,
 * and delete-with-undo (the DELETE fires when the Undo toast expires).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client/api.js";
import { AI_CLIENT_TIMEOUT_MS } from "@/lib/client/errors.js";
import { MAX_TERM_CHARS } from "@/lib/limits.js";
import { formatDate, nextReviewPhrase } from "@/lib/client/relative-time.js";
import { markPendingDelete, clearPendingDelete } from "@/lib/client/pending-deletes.js";
import TopBar from "@/components/app/TopBar.js";
import Button from "@/components/ui/Button.js";
import { TextField, TextArea } from "@/components/ui/Field.js";
import TagInput from "@/components/ui/TagInput.js";
import ErrorAlert from "@/components/ui/ErrorAlert.js";
import { FullPageError, ErrorState, Skeleton, SavedCopyNote } from "@/components/ui/Misc.js";
import { useToast } from "@/components/ui/Toast.js";
import ExplanationText from "@/components/reader/ExplanationText.js";

function NoteEditor({ concept, onSaved }) {
  const [note, setNote] = useState(concept.userNotes || "");
  const [status, setStatus] = useState("idle");
  const timer = useRef(null);
  const lastSaved = useRef(concept.userNotes || "");

  const save = useCallback(
    async (value) => {
      clearTimeout(timer.current);
      if (value === lastSaved.current) return;
      setStatus("saving");
      try {
        const data = await api(`/api/notebook/${encodeURIComponent(concept.id)}`, { method: "PATCH", body: { userNotes: value }, timeoutMs: 15000 });
        lastSaved.current = value;
        setStatus("saved");
        if (data?.concept) onSaved(data.concept);
      } catch {
        setStatus("error");
      }
    },
    [concept.id, onSaved]
  );

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <div>
      <TextArea
        label="Your note"
        value={note}
        maxLength={5000}
        minHeight={96}
        placeholder="What does this remind you of?"
        onChange={(e) => {
          const v = e.target.value;
          setNote(v);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => save(v), 800);
        }}
        onBlur={() => save(note)}
      />
      <p className="mt-1 min-h-[24px] text-[14px] text-muted" role="status">
        {status === "saving" ? "Saving…" : status === "saved" ? "Saved" : null}
        {status === "error" ? (
          <span className="text-danger">
            Couldn&apos;t save your note.{" "}
            <button type="button" className="min-h-[36px] font-semibold text-accent underline" onClick={() => save(note)}>
              Retry
            </button>
          </span>
        ) : null}
      </p>
    </div>
  );
}

/**
 * "Translate to 中文" for a concept saved without a translation (PO-9).
 * /api/translate writes definitionZh onto the saved concept itself.
 */
function TranslateConcept({ concept, onTranslated }) {
  const [state, setState] = useState({ status: "idle" });
  const run = async () => {
    setState({ status: "loading" });
    try {
      const data = await api("/api/translate", { method: "POST", body: { explanationId: concept.explanationId }, timeoutMs: AI_CLIENT_TIMEOUT_MS });
      if (data?.translation) onTranslated({ definitionZh: data.translation });
      setState({ status: "idle" });
    } catch (err) {
      setState({ status: "error", error: err });
    }
  };
  return (
    <section className="mt-6 border-t border-border pt-4">
      {state.status === "error" ? (
        <ErrorAlert
          compact
          error={state.error}
          context="translate"
          onRetry={run}
          onDismiss={() => setState({ status: "idle" })}
          extraActions={state.error?.code === "not_found" ? [{ label: "Open the article", href: concept.articleId ? `/read/${concept.articleId}` : "/read" }] : []}
        />
      ) : (
        <Button variant="secondary" onClick={run} loading={state.status === "loading"} loadingLabel="正在翻译… Translating…">
          Translate to <span lang="zh-Hans">中文</span>
        </Button>
      )}
    </section>
  );
}

export default function ConceptDetail({ id }) {
  const router = useRouter();
  const { toast } = useToast();
  const [state, setState] = useState({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ term: "", definition: "" });
  const [editErrors, setEditErrors] = useState({});
  const [editError, setEditError] = useState(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [tagError, setTagError] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    api(`/api/notebook/${encodeURIComponent(id)}`, { signal: controller.signal, timeoutMs: 20000 })
      .then((data) => {
        setNow(Date.now());
        setState({ status: "ready", concept: data?.concept || data, fromCache: Boolean(data?.__fromCache) });
      })
      .catch((err) => {
        if (err.code !== "aborted") setState({ status: "error", error: err });
      });
    return () => controller.abort();
  }, [id, attempt]);

  const concept = state.concept;
  const update = useCallback((c) => setState((s) => ({ ...s, concept: { ...s.concept, ...c } })), []);

  const saveTags = async (tags) => {
    const previous = concept.tags || [];
    update({ tags });
    setTagError(null);
    try {
      const data = await api(`/api/notebook/${encodeURIComponent(id)}`, { method: "PATCH", body: { tags }, timeoutMs: 15000 });
      if (data?.concept) update(data.concept);
    } catch (err) {
      update({ tags: previous });
      setTagError({ err, tags });
    }
  };

  const saveEdit = async (e) => {
    e?.preventDefault();
    const term = draft.term.trim();
    const definition = draft.definition.trim();
    const errors = {};
    if (!term) errors.term = "Add a term — it's what you'll see on the flashcard.";
    if (!definition) errors.definition = "Add a definition — it's the answer side of the flashcard.";
    setEditErrors(errors);
    if (Object.keys(errors).length) return;
    setSavingEdit(true);
    setEditError(null);
    try {
      const data = await api(`/api/notebook/${encodeURIComponent(id)}`, { method: "PATCH", body: { term, definition }, timeoutMs: 15000 });
      update(data?.concept || { term, definition });
      setEditing(false);
    } catch (err) {
      if (err.code === "invalid_input" && (err.field === "term" || err.field === "definition")) setEditErrors({ [err.field]: err.message });
      else setEditError(err);
    } finally {
      setSavingEdit(false);
    }
  };

  const remove = () => {
    markPendingDelete(id);
    let undone = false;
    router.push("/notebook");
    toast({
      message: "Concept deleted.",
      action: {
        label: "Undo",
        onClick: () => {
          undone = true;
          clearPendingDelete(id);
        },
      },
      onExpire: () => {
        if (undone) return;
        api(`/api/notebook/${encodeURIComponent(id)}`, { method: "DELETE", keepalive: true, timeoutMs: 15000 })
          .catch((err) => {
            if (err.code === "not_found") return;
            clearPendingDelete(id);
            toast({ message: "Couldn't delete that concept. It's back in your Notebook.", tone: "danger" });
          });
      },
    });
  };

  if (state.status === "loading") {
    return (
      <main id="main" className="app-main mx-auto max-w-[720px] px-4 md:px-6">
        <TopBar back={{ href: "/notebook", label: "Notebook" }} />
        <Skeleton variant="block" height={32} className="mb-4 w-3/5" />
        <Skeleton lines={5} height={16} />
      </main>
    );
  }
  if (state.status === "error") {
    return (
      <main id="main" className="app-main mx-auto max-w-[720px] px-4 md:px-6">
        <TopBar back={{ href: "/notebook", label: "Notebook" }} />
        {state.error?.code === "not_found" ? (
          <FullPageError title="That concept isn't in your Notebook." body="It may have been deleted." primary={{ label: "Back to Notebook", href: "/notebook" }} icon="bookmark" />
        ) : (
          <ErrorState title="Couldn't load this concept." error={state.error} onRetry={() => { setState({ status: "loading" }); setAttempt((a) => a + 1); }} secondary={{ label: "Back to Notebook", href: "/notebook" }} />
        )}
      </main>
    );
  }

  return (
    <main id="main" className="app-main mx-auto max-w-[720px] px-4 md:px-6">
      <TopBar back={{ href: "/notebook", label: "Notebook" }} />
      {state.fromCache ? <SavedCopyNote className="mb-3" /> : null}

      {editing ? (
        <form className="space-y-3" onSubmit={saveEdit} noValidate>
          <TextField label="Term" value={draft.term} maxLength={MAX_TERM_CHARS} error={editErrors.term} onChange={(e) => setDraft((d) => ({ ...d, term: e.target.value }))} />
          <TextArea label="Definition" value={draft.definition} maxLength={10000} minHeight={140} error={editErrors.definition} onChange={(e) => setDraft((d) => ({ ...d, definition: e.target.value }))} />
          {editError ? <ErrorAlert error={editError} context="form" onRetry={saveEdit} onDismiss={() => setEditError(null)} compact /> : null}
          <div className="flex gap-2">
            <Button type="submit" loading={savingEdit} loadingLabel="Saving…">
              Save
            </Button>
            <Button variant="text" onClick={() => { setEditing(false); setEditErrors({}); setEditError(null); }} disabled={savingEdit}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <>
          <div className="flex items-start justify-between gap-3">
            <h1 className="min-w-0 font-reading text-[28px] leading-tight font-semibold break-anywhere">{concept.term}</h1>
            <Button
              variant="text"
              onClick={() => {
                setDraft({ term: concept.term || "", definition: concept.definition || "" });
                setEditing(true);
              }}
            >
              Edit
            </Button>
          </div>
          <ExplanationText text={concept.definition} className="mt-3 font-reading text-read" />
        </>
      )}

      {concept.definitionZh ? (
        <section className="mt-6 border-t border-border pt-4" lang="zh-Hans">
          <p className="mb-2 text-[12px] font-semibold tracking-[.04em] text-muted">中文</p>
          <ExplanationText text={concept.definitionZh} lang="zh-Hans" className="text-[17px] leading-relaxed" />
        </section>
      ) : concept.explanationId && !state.fromCache ? (
        <TranslateConcept concept={concept} onTranslated={update} />
      ) : null}

      <section className="mt-8 space-y-5">
        <NoteEditor concept={concept} onSaved={update} />
        <div>
          <TagInput value={concept.tags || []} onChange={saveTags} label="Tags" />
          {tagError ? (
            <ErrorAlert className="mt-2" compact error={tagError.err} context="settings" onRetry={() => saveTags(tagError.tags)} onDismiss={() => setTagError(null)} />
          ) : null}
        </div>
      </section>

      <dl className="mt-8 space-y-1 text-[14px] text-muted">
        <div>
          <dt className="sr-only">Source</dt>
          <dd className="break-anywhere">
            {concept.articleId ? (
              <>
                From <Link href={`/read/${concept.articleId}`}>{concept.articleTitle || "your article"}</Link>
              </>
            ) : concept.explanationId ? (
              // Saved from an explanation whose article has since been deleted.
              "Article deleted"
            ) : (
              "Written by you"
            )}
          </dd>
        </div>
        <div>
          <dt className="sr-only">Saved</dt>
          <dd>Saved {formatDate(concept.createdAt)}</dd>
        </div>
        <div>
          <dt className="sr-only">Reviews</dt>
          <dd>
            Reviewed {concept.reviewCount || 0} time{concept.reviewCount === 1 ? "" : "s"}
            {concept.nextReviewAt ? ` · Next review ${nextReviewPhrase(concept.nextReviewAt, now)}` : ""}
          </dd>
        </div>
      </dl>

      <div className="mt-8 flex flex-wrap gap-2">
        <Button href={`/review?concept=${encodeURIComponent(concept.id)}`} icon="layers">
          Review now
        </Button>
        <Button variant="danger-text" icon="trash" onClick={remove}>
          Delete
        </Button>
      </div>
    </main>
  );
}
