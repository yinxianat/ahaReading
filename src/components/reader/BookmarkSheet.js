"use client";
/**
 * Create or edit one bookmark: what it marks (the quote), its kind (re-visit later /
 * important) and an optional note. Bottom sheet on phones, dialog on desktop.
 */
import { useRef, useState } from "react";
import { BOOKMARK_KINDS, MAX_BOOKMARK_NOTE_CHARS } from "@/lib/limits.js";
import { KIND_LABEL } from "@/lib/client/bookmarks.js";
import Sheet from "@/components/ui/Sheet.js";
import Button from "@/components/ui/Button.js";
import { Segmented } from "@/components/ui/Tabs.js";
import { TextArea } from "@/components/ui/Field.js";
import ErrorAlert from "@/components/ui/ErrorAlert.js";

/**
 * @param {object} props
 * @param {"create"|"edit"} props.mode
 * @param {string} props.quote the marked text
 * @param {{kind?:string, note?:string|null}} [props.initial]
 * @param {(values:{kind:string, note:string}) => Promise<void>} props.onSave throws an ApiError to show
 * @param {() => Promise<void>} [props.onDelete] edit mode only
 * @param {() => void} props.onClose
 */
export default function BookmarkSheet({ mode, quote, initial = {}, onSave, onDelete, onClose }) {
  const [kind, setKind] = useState(initial.kind || "revisit");
  const [note, setNote] = useState(initial.note || "");
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [fieldError, setFieldError] = useState("");
  const noteRef = useRef(null);

  const run = async (which, action) => {
    if (busy) return;
    setBusy(which);
    setError(null);
    setFieldError("");
    try {
      await action();
    } catch (err) {
      setBusy(null);
      if (err.code === "invalid_input" && err.field === "note") {
        setFieldError(err.message || "Check your note.");
        noteRef.current?.focus();
      } else setError(err);
    }
  };

  const footer = (
    <div className="flex flex-wrap gap-2">
      {mode === "edit" && onDelete ? (
        <Button variant="danger-text" icon="trash" onClick={() => run("delete", onDelete)} loading={busy === "delete"} loadingLabel="Deleting…" disabled={Boolean(busy)}>
          Delete
        </Button>
      ) : null}
      <div className="ml-auto flex gap-2">
        <Button variant="secondary" onClick={onClose} disabled={Boolean(busy)}>
          Cancel
        </Button>
        <Button onClick={() => run("save", () => onSave({ kind, note: note.trim() }))} loading={busy === "save"} loadingLabel="Saving…" disabled={Boolean(busy)}>
          {mode === "edit" ? "Save" : "Add bookmark"}
        </Button>
      </div>
    </div>
  );

  return (
    <Sheet open onClose={onClose} title={mode === "edit" ? "Edit bookmark" : "Bookmark this passage"} footer={footer} snapPoints={[0.62, 0.92]}>
      <blockquote className="mt-2 line-clamp-3 border-l-[3px] border-border pl-3 font-reading text-[16px] text-muted break-anywhere">{quote}</blockquote>
      <div className="mt-4">
        <p id="bm-kind" className="mb-1.5 font-semibold">
          Mark it as
        </p>
        <Segmented
          ariaLabel="Mark it as"
          className="w-full"
          options={BOOKMARK_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))}
          value={kind}
          onChange={setKind}
        />
      </div>
      <TextArea
        ref={noteRef}
        className="mt-4"
        label="Note (optional)"
        placeholder="Why does this matter? What do you want to check later?"
        value={note}
        minHeight={88}
        maxLength={MAX_BOOKMARK_NOTE_CHARS}
        onChange={(e) => {
          setNote(e.target.value);
          if (fieldError) setFieldError("");
        }}
        error={fieldError}
      />
      {error ? <ErrorAlert className="mt-3" compact error={error} context="save" onRetry={() => run("save", () => onSave({ kind, note: note.trim() }))} onDismiss={() => setError(null)} /> : null}
    </Sheet>
  );
}
