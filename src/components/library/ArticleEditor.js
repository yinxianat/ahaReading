"use client";
/**
 * Edit one article: rename it, change its text, or delete it (/read/[id]/edit).
 * The text is shown in the stored block format, which is plain text with a few
 * markers ("## " headings, "- " bullets, ``` code fences), so what you see is what
 * gets saved. Unsaved changes are guarded (leaving the page, Cancel, and a
 * session that expires mid-edit keeps a draft).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, BEFORE_AUTH_REDIRECT } from "@/lib/client/api.js";
import { MAX_ARTICLE_CHARS, MAX_TITLE_CHARS } from "@/lib/limits.js";
import TopBar from "@/components/app/TopBar.js";
import Button from "@/components/ui/Button.js";
import { TextField, TextArea } from "@/components/ui/Field.js";
import ErrorAlert from "@/components/ui/ErrorAlert.js";
import Dialog from "@/components/ui/Dialog.js";
import Alert from "@/components/ui/Alert.js";
import { FullPageError, ErrorState, Skeleton } from "@/components/ui/Misc.js";
import { useToast } from "@/components/ui/Toast.js";
import { Segmented } from "@/components/ui/Tabs.js";
import ArticleBody from "@/components/reader/ArticleBody.js";
import { parseArticle } from "@/lib/client/article-blocks.js";

const draftKey = (id) => `aha.editDraft.${id}`;

/** @param {{id: string}} props */
export default function ArticleEditor({ id }) {
  const router = useRouter();
  const { toast } = useToast();
  const [state, setState] = useState({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [title, setTitle] = useState("");
  // Markdown keeps formatting (bold, links, tables…); plain text shows exactly as typed.
  const [markdown, setMarkdown] = useState(false);
  const [originalMarkdown, setOriginalMarkdown] = useState(false);
  const [view, setView] = useState("write");
  const [text, setText] = useState("");
  const [original, setOriginal] = useState({ title: "", text: "" });
  const [restored, setRestored] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [fieldError, setFieldError] = useState({});
  const [leaving, setLeaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const titleRef = useRef(null);
  const textRef = useRef(null);
  const stayRef = useRef(null);
  const cancelDeleteRef = useRef(null);
  const done = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    api(`/api/articles/${encodeURIComponent(id)}`, { signal: controller.signal, timeoutMs: 20000 })
      .then((data) => {
        const a = data.article;
        const base = { title: a.title || "", text: a.content || "" };
        let draft = null;
        try {
          draft = JSON.parse(sessionStorage.getItem(draftKey(id)) || "null");
          sessionStorage.removeItem(draftKey(id));
        } catch {
          // storage blocked: no draft to restore
        }
        setOriginal(base);
        setMarkdown(a.format === "markdown");
        setOriginalMarkdown(a.format === "markdown");
        setTitle(draft?.title ?? base.title);
        setText(draft?.text ?? base.text);
        setRestored(Boolean(draft));
        setState({ status: "ready", article: a });
      })
      .catch((err) => {
        if (err.code !== "aborted") setState({ status: "error", error: err });
      });
    return () => controller.abort();
  }, [id, attempt]);

  const dirty = state.status === "ready" && (title !== original.title || text !== original.text || markdown !== originalMarkdown);
  const previewBlocks = useMemo(() => (view === "preview" ? parseArticle(text, markdown ? "markdown" : "blocks") : []), [view, text, markdown]);

  useEffect(() => {
    if (!dirty) return undefined;
    const onBeforeUnload = (e) => {
      if (done.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    // A session that expires mid-edit reloads to sign-in: keep the draft for when they're back.
    const onAuthRedirect = () => {
      try {
        sessionStorage.setItem(draftKey(id), JSON.stringify({ title, text }));
      } catch {
        // storage blocked
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener(BEFORE_AUTH_REDIRECT, onAuthRedirect);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener(BEFORE_AUTH_REDIRECT, onAuthRedirect);
    };
  }, [dirty, id, title, text]);

  const backToReader = useCallback(() => {
    done.current = true;
    router.push(`/read/${encodeURIComponent(id)}`);
  }, [router, id]);

  const save = async (e) => {
    e?.preventDefault();
    if (saving) return;
    if (!text.trim()) {
      setFieldError({ text: "The article needs some text. To remove it, use Delete article below." });
      textRef.current?.focus();
      return;
    }
    if (text.length > MAX_ARTICLE_CHARS) {
      setFieldError({ text: `That's longer than ${MAX_ARTICLE_CHARS.toLocaleString()} characters. Shorten it to save.` });
      textRef.current?.focus();
      return;
    }
    const body = {};
    if (title !== original.title) body.title = title.trim();
    // Switching format sends the text with it (the server needs both).
    if (text !== original.text || markdown !== originalMarkdown) {
      body.text = text;
      body.markdown = markdown;
    }
    if (Object.keys(body).length === 0) {
      backToReader();
      return;
    }
    setSaving(true);
    setError(null);
    setFieldError({});
    try {
      await api(`/api/articles/${encodeURIComponent(id)}`, { method: "PATCH", body, timeoutMs: 20000 });
      toast({ message: "Changes saved.", tone: "success" });
      backToReader();
    } catch (err) {
      setSaving(false);
      if (err.code === "invalid_input" && (err.field === "title" || err.field === "text")) {
        setFieldError({ [err.field]: err.message || "Check this field." });
        (err.field === "title" ? titleRef : textRef).current?.focus();
      } else setError(err);
    }
  };

  const cancel = () => {
    if (dirty) setLeaving(true);
    else backToReader();
  };

  const doDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await api(`/api/articles/${encodeURIComponent(id)}`, { method: "DELETE", timeoutMs: 15000 });
    } catch (err) {
      if (err.code !== "not_found") {
        setDeleting(false);
        setDeleteError(err);
        return;
      }
    }
    done.current = true;
    toast({ message: "Article deleted. Concepts you saved from it stay in your Notebook." });
    router.push("/read");
  };

  if (state.status === "error") {
    return (
      <main id="main" className="app-main mx-auto max-w-[720px] px-4 md:px-6">
        {state.error?.code === "not_found" ? (
          <FullPageError title="We can't find that article." body="It may have been deleted." primary={{ label: "Back to Library", href: "/read" }} icon="book" />
        ) : (
          <ErrorState title="Couldn't open this article for editing." error={state.error} onRetry={() => { setState({ status: "loading" }); setAttempt((a) => a + 1); }} secondary={{ label: "Back to Library", href: "/read" }} />
        )}
      </main>
    );
  }

  const source = state.article?.fileName || state.article?.domain;
  return (
    <main id="main" className="app-main mx-auto max-w-[720px] px-4 md:px-6">
      <TopBar title="Edit article" back={{ href: `/read/${encodeURIComponent(id)}`, label: "Back to reading" }} />
      {state.status === "loading" ? (
        <div className="space-y-4">
          <Skeleton variant="block" height={56} />
          <Skeleton variant="block" height={320} />
        </div>
      ) : (
        <form className="space-y-4 pb-8" onSubmit={save} noValidate>
          {restored ? (
            <Alert tone="info" compact onDismiss={() => setRestored(false)}>
              We kept the changes you hadn&apos;t saved before you were signed out.
            </Alert>
          ) : null}
          <TextField
            ref={titleRef}
            label="Title"
            value={title}
            maxLength={MAX_TITLE_CHARS}
            onChange={(e) => {
              setTitle(e.target.value);
              if (fieldError.title) setFieldError({});
            }}
            error={fieldError.title}
            helper="Leave empty to use the first line of the text."
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="flex min-h-[44px] items-center gap-2 text-[15px]">
              <input type="checkbox" className="h-5 w-5 accent-[var(--accent)]" checked={markdown} onChange={(e) => setMarkdown(e.target.checked)} />
              <span className="font-semibold">Markdown formatting</span>
            </label>
            <Segmented
              size="sm"
              ariaLabel="Editor view"
              options={[
                { value: "write", label: "Write" },
                { value: "preview", label: "Preview" },
              ]}
              value={view}
              onChange={setView}
            />
          </div>
          {view === "preview" ? (
            <div className="max-h-[70vh] overflow-y-auto rounded-md border border-border bg-bg p-4" aria-label="Preview">
              {previewBlocks.length ? (
                <ArticleBody blocks={previewBlocks} concepts={[]} fontSize={17} bodyRef={null} />
              ) : (
                <p className="text-muted">Nothing to preview yet.</p>
              )}
            </div>
          ) : null}
          <TextArea
            ref={textRef}
            label="Text"
            value={text}
            minHeight={320}
            maxHeightVh={70}
            onChange={(e) => {
              setText(e.target.value);
              if (fieldError.text) setFieldError({});
            }}
            error={fieldError.text}
            counter={{ text: `${text.length.toLocaleString()} / ${MAX_ARTICLE_CHARS.toLocaleString()}`, over: text.length > MAX_ARTICLE_CHARS }}
            className={`[&_textarea]:font-reading [&_textarea]:leading-relaxed ${view === "preview" ? "hidden" : ""}`}
          />
          <details className="rounded-md border border-border bg-surface px-3 py-2 text-[14px]">
            <summary className="min-h-[36px] cursor-pointer font-semibold">Formatting tips</summary>
            <ul className="mt-1 mb-2 list-disc space-y-1 pl-5 text-muted">
              <li>Leave a blank line between paragraphs.</li>
              {markdown ? (
                <li>
                  <code>**bold**</code>, <code>*italics*</code>, <code>[link text](https://…)</code>, <code>&gt; quote</code>, and tables with{" "}
                  <code>| a | b |</code> rows.
                </li>
              ) : null}
              <li>
                Start a line with <code>## </code> for a heading.
              </li>
              <li>
                Start lines with <code>- </code> or <code>1. </code> for a list.
              </li>
              <li>
                Put code between two lines of <code>```</code>.
              </li>
            </ul>
          </details>
          {source ? (
            <p className="text-[14px] text-muted break-anywhere">
              Your edits change your copy here only; the original {state.article?.fileName ? "file" : "web page"} ({source}) isn&apos;t touched. Saved concepts stay linked.
            </p>
          ) : (
            <p className="text-[14px] text-muted">Saved concepts from this article stay linked after you edit it.</p>
          )}
          {error ? <ErrorAlert error={error} context="form" onRetry={save} onDismiss={() => setError(null)} /> : null}
          <div className="flex flex-col gap-2 sm:flex-row-reverse">
            <Button type="submit" loading={saving} loadingLabel="Saving…" className="sm:min-w-[160px]">
              Save changes
            </Button>
            <Button variant="secondary" onClick={cancel} disabled={saving}>
              Cancel
            </Button>
          </div>
          <div className="border-t border-border pt-4">
            <Button variant="danger-text" icon="trash" onClick={() => { setDeleteError(null); setConfirmDelete(true); }} disabled={saving}>
              Delete article
            </Button>
          </div>
        </form>
      )}

      <Dialog
        open={leaving}
        onClose={() => setLeaving(false)}
        title="Discard your changes?"
        description="Your edits to this article haven't been saved."
        initialFocusRef={stayRef}
        actions={
          <>
            <Button ref={stayRef} variant="secondary" onClick={() => setLeaving(false)}>
              Keep editing
            </Button>
            <Button variant="danger" onClick={backToReader}>
              Discard
            </Button>
          </>
        }
      />
      <Dialog
        open={confirmDelete}
        onClose={() => !deleting && setConfirmDelete(false)}
        title={`Delete “${title.trim() || original.title || "Untitled"}”?`}
        description="Concepts you saved from it stay in your Notebook; its bookmarks are deleted. This can't be undone."
        initialFocusRef={cancelDeleteRef}
        actions={
          <>
            <Button ref={cancelDeleteRef} variant="secondary" onClick={() => setConfirmDelete(false)} disabled={deleting}>
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
    </main>
  );
}
