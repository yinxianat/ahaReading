"use client";
/**
 * Add a concept by hand (/notebook/new): the user writes the term and what it means,
 * with optional notes, tags and the article it came from. It joins the Notebook and
 * the review schedule like a saved explanation (POST /api/notebook without an
 * explanationId). `?articleId=` preselects an article.
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/client/api.js";
import { MAX_TERM_CHARS, MAX_DEFINITION_CHARS, MAX_NOTES_CHARS } from "@/lib/limits.js";
import TopBar from "@/components/app/TopBar.js";
import Button from "@/components/ui/Button.js";
import { TextField, TextArea } from "@/components/ui/Field.js";
import TagInput from "@/components/ui/TagInput.js";
import ErrorAlert from "@/components/ui/ErrorAlert.js";
import Alert from "@/components/ui/Alert.js";
import Dialog from "@/components/ui/Dialog.js";
import { useToast } from "@/components/ui/Toast.js";

export default function NewConcept() {
  const router = useRouter();
  const { toast } = useToast();
  const [term, setTerm] = useState("");
  const [definition, setDefinition] = useState("");
  const [notes, setNotes] = useState("");
  const [tags, setTags] = useState([]);
  const [articleId, setArticleId] = useState("");
  const [articles, setArticles] = useState({ status: "loading", list: [] });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [fieldError, setFieldError] = useState({});
  const [duplicate, setDuplicate] = useState(null);
  const [leaving, setLeaving] = useState(false);
  const termRef = useRef(null);
  const definitionRef = useRef(null);
  const stayRef = useRef(null);
  const done = useRef(false);

  useEffect(() => {
    const preset = new URLSearchParams(window.location.search).get("articleId");
    const controller = new AbortController();
    api("/api/articles", { signal: controller.signal, timeoutMs: 15000 })
      .then((data) => {
        const list = data?.articles || [];
        setArticles({ status: "ready", list });
        if (preset && list.some((a) => a.id === preset)) setArticleId(preset);
      })
      .catch((err) => {
        // The article link is optional: without the list, the concept is saved on its own.
        if (err.code !== "aborted") setArticles({ status: "error", list: [] });
      });
    return () => controller.abort();
  }, []);

  const dirty = Boolean(term.trim() || definition.trim() || notes.trim() || tags.length);
  useEffect(() => {
    if (!dirty) return undefined;
    const onBeforeUnload = (e) => {
      if (done.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const leave = () => {
    done.current = true;
    router.push("/notebook");
  };

  const save = async (e) => {
    e?.preventDefault();
    if (saving) return;
    const problems = {};
    if (!term.trim()) problems.term = "Add the word or phrase you want to remember.";
    if (!definition.trim()) problems.definition = "Write what it means, in your own words.";
    if (Object.keys(problems).length) {
      setFieldError(problems);
      (problems.term ? termRef : definitionRef).current?.focus();
      return;
    }
    setSaving(true);
    setError(null);
    setDuplicate(null);
    setFieldError({});
    try {
      const body = { term: term.trim(), definition: definition.trim(), tags };
      if (notes.trim()) body.userNotes = notes.trim();
      if (articleId) body.articleId = articleId;
      const data = await api("/api/notebook", { method: "POST", body, timeoutMs: 15000 });
      done.current = true;
      toast({ message: "Added to your Notebook. It'll come up for review tomorrow.", tone: "success" });
      router.push(`/notebook/${encodeURIComponent(data.concept.id)}`);
    } catch (err) {
      setSaving(false);
      if (err.code === "already_saved") setDuplicate(err.data?.conceptId || null);
      else if (err.code === "invalid_input" && ["term", "definition", "userNotes", "tags"].includes(err.field)) {
        setFieldError({ [err.field]: err.message || "Check this field." });
        if (err.field === "term") termRef.current?.focus();
        if (err.field === "definition") definitionRef.current?.focus();
      } else setError(err);
    }
  };

  return (
    <main id="main" className="app-main mx-auto max-w-[720px] px-4 md:px-6">
      <TopBar title="Add a concept" back={{ href: "/notebook", label: "Notebook" }} sub="Write down a word or idea in your own words. It joins your reviews." />
      <form className="space-y-4 pb-8" onSubmit={save} noValidate>
        <TextField
          ref={termRef}
          label="Term or phrase"
          value={term}
          maxLength={MAX_TERM_CHARS}
          autoCapitalize="none"
          onChange={(e) => {
            setTerm(e.target.value);
            if (fieldError.term) setFieldError((f) => ({ ...f, term: "" }));
            if (duplicate) setDuplicate(null);
          }}
          error={fieldError.term}
        />
        <TextArea
          ref={definitionRef}
          label="What it means"
          placeholder="Explain it the way you'd explain it to a friend."
          value={definition}
          minHeight={120}
          maxLength={MAX_DEFINITION_CHARS}
          onChange={(e) => {
            setDefinition(e.target.value);
            if (fieldError.definition) setFieldError((f) => ({ ...f, definition: "" }));
          }}
          error={fieldError.definition}
        />
        <TextArea
          label="Your note (optional)"
          placeholder="An example, where you saw it, what it reminds you of…"
          value={notes}
          minHeight={80}
          maxLength={MAX_NOTES_CHARS}
          onChange={(e) => setNotes(e.target.value)}
          error={fieldError.userNotes}
        />
        <TagInput value={tags} onChange={setTags} label="Tags (optional)" disabled={saving} />
        {articles.status === "ready" && articles.list.length > 0 ? (
          <div>
            <label htmlFor="nc-article" className="mb-1 block font-semibold">
              From an article (optional)
            </label>
            <select
              id="nc-article"
              value={articleId}
              onChange={(e) => {
                setArticleId(e.target.value);
                if (duplicate) setDuplicate(null);
              }}
              className="min-h-[44px] w-full rounded-sm border border-border bg-surface px-3 text-[16px] focus:border-accent focus:outline-none"
            >
              <option value="">None</option>
              {articles.list.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.title || "Untitled"}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {duplicate !== null ? (
          <Alert tone="info" compact action={duplicate ? { label: "Open it", href: `/notebook/${encodeURIComponent(duplicate)}` } : undefined}>
            You already have “{term.trim()}” in your Notebook{articleId ? " for this article" : ""}. Open it to edit, or change the term.
          </Alert>
        ) : null}
        {error ? <ErrorAlert error={error} context="save" onRetry={save} onDismiss={() => setError(null)} /> : null}

        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <Button type="submit" loading={saving} loadingLabel="Adding…" className="sm:min-w-[180px]">
            Add to Notebook
          </Button>
          <Button variant="secondary" onClick={() => (dirty ? setLeaving(true) : leave())} disabled={saving}>
            Cancel
          </Button>
        </div>
        <p className="text-[14px] text-muted">
          Prefer an AI explanation? Select text while <Link href="/read">reading</Link> and tap <strong>I don&apos;t understand</strong>.
        </p>
      </form>

      <Dialog
        open={leaving}
        onClose={() => setLeaving(false)}
        title="Discard this concept?"
        description="What you've written hasn't been added yet."
        initialFocusRef={stayRef}
        actions={
          <>
            <Button ref={stayRef} variant="secondary" onClick={() => setLeaving(false)}>
              Keep writing
            </Button>
            <Button variant="danger" onClick={leave}>
              Discard
            </Button>
          </>
        }
      />
    </main>
  );
}
