"use client";
/**
 * Save-to-Notebook row that expands inline into tags + note (UX-SPEC 4.6).
 */
import { useRef, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/client/api.js";
import Button from "@/components/ui/Button.js";
import TagInput from "@/components/ui/TagInput.js";
import { TextArea, TextField } from "@/components/ui/Field.js";
import { MAX_TERM_CHARS } from "@/lib/limits.js";
import ErrorAlert from "@/components/ui/ErrorAlert.js";
import Icon from "@/components/ui/icons.js";
import { announce } from "@/components/ui/announce.js";

/**
 * @param {object} props
 * @param {string} props.explanationId
 * @param {string[]} props.suggestions
 * @param {(concept:object) => void} props.onSaved
 * @param {boolean} [props.disabled]
 * @param {"idle"|"form"} [props.initialMode] "form" when the caller already showed the Save button
 * @param {() => void} [props.onCancel] Cancel in the form; defaults to collapsing to the idle button
 * @param {() => void} [props.onExplainAgain] recovery when the explanation expired (404)
 * @param {string} [props.defaultTerm] the highlighted text; editable as the flashcard front (PO-11)
 * @param {() => void} [props.onSettled] the form closed into its saved / already-saved row
 */
export default function SaveConceptForm({ explanationId, suggestions, onSaved, disabled, initialMode = "idle", onCancel, onExplainAgain, defaultTerm = "", onSettled }) {
  const initialTerm = String(defaultTerm).replace(/\s+/g, " ").trim().slice(0, MAX_TERM_CHARS);
  const [mode, setMode] = useState(initialMode);
  const [term, setTerm] = useState(initialTerm);
  const [termError, setTermError] = useState("");
  const [tags, setTags] = useState([]);
  const [note, setNote] = useState("");
  const [error, setError] = useState(null);
  const [conceptId, setConceptId] = useState(null);
  const inFlight = useRef(false);

  const save = async () => {
    if (inFlight.current) return;
    const front = term.replace(/\s+/g, " ").trim();
    if (!front) {
      setTermError("Add the word or phrase for the front of the flashcard.");
      return;
    }
    setTermError("");
    inFlight.current = true;
    setMode("saving");
    setError(null);
    try {
      const body = { explanationId };
      // Only send a term the user changed; otherwise the server uses the highlight.
      if (front !== initialTerm) body.term = front;
      if (tags.length) body.tags = tags;
      if (note.trim()) body.userNotes = note.trim();
      const data = await api("/api/notebook", { method: "POST", body, timeoutMs: 15000 });
      setConceptId(data?.concept?.id || null);
      setMode("saved");
      onSettled?.();
      announce("Saved to your Notebook.");
      if (data?.concept) onSaved?.(data.concept);
    } catch (err) {
      if (err.code === "already_saved") {
        setConceptId(err.data?.conceptId || null);
        setMode("already");
        onSettled?.();
      } else if (err.code === "invalid_input" && err.field === "term") {
        setTermError(err.message || "Shorten the flashcard front and try again.");
        setMode("form");
      } else {
        setError(err);
        setMode("form");
      }
    } finally {
      inFlight.current = false;
    }
  };

  if (mode === "saved") {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-success-soft px-3 py-2.5" role="status">
        <span className="inline-flex items-center gap-1.5 font-semibold text-success">
          <Icon name="check" size={18} /> Saved ✓ · Review tomorrow
        </span>
        {conceptId ? (
          <Link href={`/notebook/${conceptId}`} className="inline-flex min-h-[44px] items-center font-semibold">
            Open in Notebook
          </Link>
        ) : null}
      </div>
    );
  }
  if (mode === "already") {
    return (
      <div className="flex flex-wrap items-center gap-x-3 rounded-md bg-surface-2 px-3 py-1.5">
        <span className="text-text">Already in your Notebook</span>
        {conceptId ? (
          <Link href={`/notebook/${conceptId}`} className="inline-flex min-h-[44px] items-center font-semibold">
            Open
          </Link>
        ) : null}
      </div>
    );
  }
  if (mode === "idle") {
    return (
      <Button variant="tertiary" icon="bookmark" fullWidth onClick={() => setMode("form")} disabled={disabled}>
        Save to Notebook
      </Button>
    );
  }
  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <TextField
        label="Flashcard front"
        value={term}
        maxLength={MAX_TERM_CHARS}
        error={termError}
        onChange={(e) => {
          setTerm(e.target.value);
          if (termError) setTermError("");
        }}
        disabled={mode === "saving"}
      />
      <TagInput value={tags} onChange={setTags} suggestions={suggestions} label="Tags" disabled={mode === "saving"} />
      <TextArea
        label="Your note (optional)"
        placeholder="What does this remind you of?"
        value={note}
        maxLength={5000}
        minHeight={56}
        maxHeightVh={30}
        onChange={(e) => setNote(e.target.value)}
        disabled={mode === "saving"}
      />
      {error ? (
        <ErrorAlert
          error={error}
          context="save"
          onRetry={save}
          onDismiss={() => setError(null)}
          extraActions={error.code === "not_found" && onExplainAgain ? [{ label: "Explain again", onClick: onExplainAgain }] : []}
          compact
        />
      ) : null}
      <div className="flex gap-2">
        <Button onClick={save} loading={mode === "saving"} loadingLabel="Saving…" disabled={disabled}>
          Save
        </Button>
        <Button variant="text" onClick={() => (onCancel ? onCancel() : setMode("idle"))} disabled={mode === "saving"}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
