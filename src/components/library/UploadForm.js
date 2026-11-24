"use client";
/**
 * "Upload file" tab of New reading: pick or drop a PDF / Word (.docx) file, which
 * the server turns into an article (POST /api/articles/upload, raw file body).
 * Obvious problems (wrong type, too big, old .doc) are caught here before uploading,
 * with the same wording the server would use.
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client/api.js";
import { MAX_UPLOAD_BYTES, UPLOAD_EXTENSIONS } from "@/lib/limits.js";
import Button, { IconButton } from "@/components/ui/Button.js";
import ErrorAlert from "@/components/ui/ErrorAlert.js";
import Icon from "@/components/ui/icons.js";

// Parsing a long PDF takes a while on top of the upload itself.
const UPLOAD_TIMEOUT_MS = 90_000;
const ACCEPT = [...UPLOAD_EXTENSIONS, "application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"].join(",");
const MAX_MB = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024));
// Some browsers label a .docx "application/zip" (or nothing); the server reads the bytes
// to tell what a file is, so anything else goes as a generic binary type.
const SENDABLE_TYPES = new Set(["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]);

/**
 * @param {number} n bytes
 * @returns {string} "820 KB", "3.4 MB"
 */
export function formatBytes(n) {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Why this file can't be uploaded, or null when it looks fine.
 * @param {{name:string, size:number}} file
 * @returns {string|null}
 */
export function fileProblem(file) {
  const name = String(file?.name || "").toLowerCase();
  if (name.endsWith(".doc")) return "This is an older Word file (.doc). Open it in Word, Pages or Google Docs, save it as .docx or PDF, then upload that.";
  if (!UPLOAD_EXTENSIONS.some((ext) => name.endsWith(ext))) return "Choose a PDF or Word (.docx) file. For anything else, copy the text and use Paste text.";
  if (file.size === 0) return "That file is empty. Choose another one.";
  if (file.size > MAX_UPLOAD_BYTES) return `That file is ${formatBytes(file.size)}; the limit is ${MAX_MB} MB. Upload a smaller file, or paste the part you want to read.`;
  return null;
}

/**
 * @param {{onPasteInstead: () => void}} props
 */
export default function UploadForm({ onPasteInstead }) {
  const router = useRouter();
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [fieldError, setFieldError] = useState("");
  const [dragging, setDragging] = useState(false);
  const inFlight = useRef(false);
  const inputRef = useRef(null);
  const request = useRef(null);

  // Leaving the tab (or the page) mid-upload cancels it, so a late reply can't pull the
  // user into the reader from wherever they went.
  useEffect(() => () => request.current?.abort(), []);

  const pick = (chosen) => {
    if (!chosen) return;
    setError(null);
    const problem = fileProblem(chosen);
    setFieldError(problem || "");
    setFile(problem ? null : chosen);
  };

  const clear = () => {
    setFile(null);
    setFieldError("");
    setError(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  const submit = async (e) => {
    e?.preventDefault();
    if (inFlight.current) return;
    if (!file) {
      setFieldError("Choose a PDF or Word file first.");
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const controller = new AbortController();
    request.current = controller;
    try {
      const data = await api("/api/articles/upload", {
        method: "POST",
        body: SENDABLE_TYPES.has(file.type) ? file : file.slice(0, file.size, "application/octet-stream"),
        headers: { "X-File-Name": encodeURIComponent(file.name) },
        timeoutMs: UPLOAD_TIMEOUT_MS,
        signal: controller.signal,
      });
      // A reply that lands after the form was left (some engines still resolve it) is ignored.
      if (controller.signal.aborted) return;
      router.push(`/read/${data.article.id}`);
    } catch (err) {
      if (controller.signal.aborted) return; // unmounted: nobody is looking
      if (err.code === "invalid_input") setFieldError(err.message || "Choose a PDF or Word file to upload.");
      else setError(err);
      inFlight.current = false;
      setBusy(false);
    }
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    if (!busy) pick(e.dataTransfer?.files?.[0]);
  };

  // A file dropped a few pixels outside the zone would otherwise replace the app with the
  // PDF (or download the .docx). While this tab is open, a drop anywhere picks the file.
  const dropAnywhere = useRef(onDrop);
  useEffect(() => {
    dropAnywhere.current = onDrop;
  });
  useEffect(() => {
    const onDocumentDragOver = (e) => {
      if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
    };
    const onDocumentDrop = (e) => {
      if (!e.dataTransfer?.types?.includes("Files")) return;
      dropAnywhere.current(e);
    };
    document.addEventListener("dragover", onDocumentDragOver);
    document.addEventListener("drop", onDocumentDrop);
    return () => {
      document.removeEventListener("dragover", onDocumentDragOver);
      document.removeEventListener("drop", onDocumentDrop);
    };
  }, []);

  return (
    <form id="new-panel-file" role="tabpanel" aria-labelledby="new-file" className="mt-4 space-y-3" onSubmit={submit} noValidate>
      <div
        className={`rounded-lg border-2 border-dashed p-5 text-center transition-colors ${dragging ? "border-accent bg-accent-soft" : fieldError ? "border-danger" : "border-border"}`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!busy) setDragging(true);
        }}
        onDragLeave={(e) => {
          // Moving over the zone's own children fires dragleave too; only leaving the zone counts.
          if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false);
        }}
        onDrop={(e) => {
          e.stopPropagation();
          onDrop(e);
        }}
      >
        <Icon name="upload" size={28} className="mx-auto text-muted" />
        <p className="mt-2 font-semibold">
          <span className="hidden sm:inline">Drop a PDF or Word file here, or choose one</span>
          <span className="sm:hidden">Choose a PDF or Word file</span>
        </p>
        <input
          ref={inputRef}
          id="upload-input"
          type="file"
          accept={ACCEPT}
          className="sr-only"
          // The visible button below is the control; the native input stays out of the tab order.
          tabIndex={-1}
          aria-hidden="true"
          disabled={busy}
          onChange={(e) => pick(e.target.files?.[0])}
        />
        <Button variant="secondary" icon="file" className="mt-3" onClick={() => inputRef.current?.click()} disabled={busy} aria-describedby="upload-help">
          {file ? "Choose a different file" : "Choose a file"}
        </Button>
        <p id="upload-help" className="mt-3 text-[14px] text-muted">
          PDF or Word (.docx), up to {MAX_MB} MB. Scanned PDFs (photos of pages) have no text to read.
        </p>
      </div>

      {/* Always mounted, so screen readers announce the file once it is picked. */}
      <div aria-live="polite">
        {file ? (
          <div className="flex items-center gap-3 rounded-md border border-border bg-surface px-3 py-2" data-testid="upload-file">
            <Icon name="file" size={20} className="flex-none text-muted" />
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold">
                <span className="sr-only">Selected file: </span>
                {file.name}
              </p>
              <p className="text-[13px] text-muted">{formatBytes(file.size)}</p>
            </div>
            <IconButton icon="x" label="Remove file" onClick={clear} disabled={busy} />
          </div>
        ) : null}
      </div>

      {fieldError ? (
        <p className="text-[14px] text-danger break-anywhere" role="alert">
          {fieldError}
        </p>
      ) : null}
      {busy ? (
        <p className="text-[14px] text-muted" role="status">
          Reading your document. Long PDFs can take up to 30 seconds.
        </p>
      ) : null}
      {error ? <ErrorAlert error={error} context="upload" onRetry={submit} onPasteInstead={onPasteInstead} onDismiss={() => setError(null)} /> : null}

      <Button type="submit" fullWidth loading={busy} loadingLabel="Uploading…" disabled={!file}>
        Upload and read
      </Button>
    </form>
  );
}
