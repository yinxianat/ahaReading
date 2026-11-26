/**
 * Uploaded documents (PDF, Word .docx, Markdown .md) → readable article blocks.
 *
 * Markdown has no signature bytes: a file is Markdown when its bytes are not PDF/Word/etc.,
 * its name ends in .md/.markdown (or it was sent as text/markdown), and it is valid UTF-8
 * without NUL bytes. It is converted in-process (markdown.js is linear and the source is
 * capped), not in the parse worker.
 *
 * Trust nothing about the upload: the type comes from the file's first bytes, not its
 * name or Content-Type; a .docx (a zip) is size-checked from its central directory
 * before anything is decompressed; then the actual parsing (document-parse.js) runs in
 * a worker with capped memory and a hard timeout (document-sandbox.js), because a
 * small file can still expand into gigabytes inside a parser. Output is the plain
 * block text of article-blocks.js, never HTML.
 */
import { serializeArticleBlocks, parseArticleBlocks } from "./article-blocks.js";
import { MAX_ARTICLE_CHARS, MAX_TITLE_CHARS, MARKDOWN_TYPES } from "./limits.js";
import { DocumentImportError, UNWANTED_CHARS } from "./document-shared.js";
import { parseInWorker } from "./document-sandbox.js";
import { prepareMarkdownSource } from "./markdown.js";
import { markdownPlainText, markdownUnits } from "./article-markdown.js";

export { DocumentImportError };

// Real .docx files with images rarely expand past a few MB beyond their own size.
export const MAX_DOCX_UNCOMPRESSED_BYTES = 40 * 1024 * 1024;
// A 300-page document's word/document.xml is 2-4 MB. Parsing costs ~50x its size in memory
// (more for dense XML), so this fails the obvious cases fast; the worker bounds the rest.
export const MAX_DOCX_DOCUMENT_XML_BYTES = 6 * 1024 * 1024;
export const MAX_DOCX_ENTRIES = 5000;
const MIN_TEXT_CHARS = 50;
const MAX_FILE_NAME_CHARS = 200;

const NOT_SUPPORTED = "We can read PDF, Word (.docx) and Markdown (.md) files. For anything else, copy the text and use Paste text.";

/**
 * Is this upload meant to be Markdown (by name or declared type)? The bytes still decide.
 * @param {string} fileName
 * @param {string} [contentType]
 */
export function looksLikeMarkdown(fileName, contentType = "") {
  return /\.(md|markdown)$/i.test(String(fileName || "")) || MARKDOWN_TYPES.includes(String(contentType).split(";")[0].trim().toLowerCase());
}

function decodeMarkdown(bytes) {
  if (bytes.includes(0)) {
    throw new DocumentImportError("file_unsupported", `That file isn't a text Markdown file. ${NOT_SUPPORTED}`, "markdown_binary");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new DocumentImportError("file_unreadable", "We couldn't read this Markdown file: it isn't saved as UTF-8 text. Save it as UTF-8 in your editor and upload it again.", "markdown_not_utf8");
  }
}

function startsWith(bytes, signature, offset = 0) {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i++) if (bytes[offset + i] !== signature[i]) return false;
  return true;
}

const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));
const PDF_MAGIC = ascii("%PDF-");
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const RTF_MAGIC = ascii("{\\rtf");

/**
 * What the bytes are, from their signature.
 * @param {Uint8Array} bytes
 * @returns {"pdf"|"zip"|"ole"|"rtf"|null}
 */
export function detectKind(bytes) {
  // The PDF spec lets the header start anywhere in the first 1024 bytes.
  const head = Math.min(bytes.length - PDF_MAGIC.length, 1024);
  for (let i = 0; i <= head; i++) if (bytes[i] === 0x25 && startsWith(bytes, PDF_MAGIC, i)) return "pdf";
  if (startsWith(bytes, ZIP_MAGIC)) return "zip";
  if (startsWith(bytes, OLE_MAGIC)) return "ole";
  if (startsWith(bytes, RTF_MAGIC)) return "rtf";
  return null;
}

/**
 * Title from an uploaded file name: no path, no extension, tidy spaces.
 * @param {string} fileName
 * @returns {string}
 */
export function titleFromFileName(fileName) {
  const base = String(fileName || "").split(/[\\/]/).pop() || "";
  const stem = base.replace(/\.(pdf|docx?|md|markdown)$/i, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
  return Array.from(stem || "Uploaded document").slice(0, MAX_TITLE_CHARS).join("");
}

/**
 * The original file name from the `X-File-Name` header (URI-encoded by the client):
 * no path, no control or invisible/bidi characters, at most 200 characters (whole
 * characters, so an emoji is never cut in half). "" when absent or garbled.
 * @param {string|null} header
 * @returns {string}
 */
export function cleanFileName(header) {
  if (!header) return "";
  let name;
  try {
    name = decodeURIComponent(header);
  } catch {
    return "";
  }
  const base = (name.split(/[\\/]/).pop() || "").replace(UNWANTED_CHARS, "").replace(/[\u000a\u000d\u0009]/g, "").replace(/\s+/g, " ").trim();
  return Array.from(base).slice(0, MAX_FILE_NAME_CHARS).join("").trim();
}

// ─── Word (.docx) ───────────────────────────────────────────────────────

/**
 * Read a zip's central directory without decompressing anything, and refuse sizes
 * that can't be parsed safely.
 * @param {Uint8Array} bytes
 * @returns {{names: string[], uncompressed: number, documentXml: number}} sizes as declared;
 *   a lie is caught later, when inflating, by JSZip's size check
 * @throws {DocumentImportError}
 */
export function inspectZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const corrupt = () => new DocumentImportError("file_unreadable", "This Word file looks damaged. Open it in Word or Google Docs, save it again, and upload the new copy.", "zip_corrupt");
  // End-of-central-directory record: 22 bytes plus an optional comment of up to 64 KB.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw corrupt();
  const entries = view.getUint16(eocd + 10, true);
  const dirSize = view.getUint32(eocd + 12, true);
  const dirOffset = view.getUint32(eocd + 16, true);
  if (entries === 0xffff || dirOffset === 0xffffffff) {
    throw new DocumentImportError("file_too_large", "This Word file is too large to read here. Save it as a PDF, or paste the part you need.", "zip64");
  }
  if (entries > MAX_DOCX_ENTRIES) throw new DocumentImportError("file_unreadable", "This Word file has an unusual structure we can't read. Save it as a PDF and upload that.", "too_many_entries");
  if (dirOffset + dirSize > bytes.length) throw corrupt();

  const names = [];
  let uncompressed = 0;
  let documentXml = 0;
  let p = dirOffset;
  const decoder = new TextDecoder();
  for (let n = 0; n < entries; n++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) throw corrupt();
    const size = view.getUint32(p + 24, true);
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    if (size === 0xffffffff) throw new DocumentImportError("file_too_large", "This Word file is too large to read here. Save it as a PDF, or paste the part you need.", "zip64_entry");
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLength));
    uncompressed += size;
    if (name === "word/document.xml") documentXml = size;
    names.push(name);
    p += 46 + nameLength + extraLength + commentLength;
  }
  if (uncompressed > MAX_DOCX_UNCOMPRESSED_BYTES) {
    throw new DocumentImportError("file_too_large", "This Word file expands to more than we can read. Save it as a PDF, or paste the part you need.", "zip_bomb");
  }
  if (documentXml > MAX_DOCX_DOCUMENT_XML_BYTES) {
    throw new DocumentImportError("file_too_large", "This Word file has more text than we can read at once. Split it into smaller files, or paste the part you need.", "docx_xml_too_large");
  }
  return { names, uncompressed, documentXml };
}

// ─── Entry point ────────────────────────────────────────────────────────

/**
 * Turn an uploaded file into {title, text} in the article block format.
 * @param {Uint8Array} bytes
 * @param {{fileName?: string, signal?: AbortSignal, sandbox?: object}} [options]
 *   `signal` stops the parse when the client goes away; `sandbox` is passed to
 *   parseInWorker (tests only)
 * @returns {Promise<{title: string, text: string, kind: "pdf"|"docx"|"markdown", format: "markdown"|"blocks"}>}
 * @throws {DocumentImportError}
 */
export async function extractDocument(bytes, { fileName = "", contentType = "", signal, sandbox = {} } = {}) {
  const detected = detectKind(bytes);
  // No signature matched, but the name or type says Markdown: treat it as text.
  const kind = detected === null && looksLikeMarkdown(fileName, contentType) ? "markdown" : detected;
  if (kind === "ole") {
    throw new DocumentImportError("file_unsupported", "This is an older Word file (.doc). Open it in Word, Pages or Google Docs, save it as .docx or PDF, then upload that.", "doc_legacy");
  }
  if (kind === "rtf") {
    throw new DocumentImportError("file_unsupported", "Rich Text (.rtf) files aren't supported. Save it as .docx or PDF, then upload that.", "rtf");
  }
  if (kind !== "pdf" && kind !== "zip" && kind !== "markdown") throw new DocumentImportError("file_unsupported", NOT_SUPPORTED, "unknown_signature");
  if (kind === "zip" && !inspectZip(bytes).names.includes("word/document.xml")) {
    throw new DocumentImportError("file_unsupported", `That file isn't a Word document. ${NOT_SUPPORTED}`, "zip_not_docx");
  }

  // Markdown and Word keep their original formatting (stored as Markdown); PDFs become block text.
  const extracted = kind === "markdown"
    ? (({ title, markdown }) => ({ title, text: markdown, format: "markdown" }))(prepareMarkdownSource(decodeMarkdown(bytes)))
    : (({ format, ...rest }) => ({ ...rest, format: format === "markdown" ? "markdown" : "blocks" }))(await parseInWorker(bytes, kind, { signal, ...sandbox }));
  const readable = extracted.format === "markdown" ? markdownPlainText(extracted.text) : extracted.text;
  if (readable.replace(/\s/g, "").length < MIN_TEXT_CHARS) {
    throw new DocumentImportError(
      "file_unreadable",
      kind === "pdf"
        ? "This PDF has no text we can read. It's probably scanned pages (pictures of text). Copy the text another way and use Paste text."
        : kind === "markdown"
          ? "This Markdown file has almost no text to read. Check it's the right file, or paste the text instead."
          : "This Word file has no text we can read. Check it isn't empty, or paste the text instead.",
      "no_text"
    );
  }
  const title = (extracted.title || titleFromFileName(fileName)).slice(0, MAX_TITLE_CHARS);
  // The reader shows the title above the text, so an opening heading that is the title would repeat.
  let text = extracted.text;
  if (extracted.format === "markdown") {
    const units = markdownUnits(text);
    // Drop the opening "# Title" line (ATX or underlined) when it is the title.
    if (units[0]?.type === "h" && units[0].text === title && units.length > 1) {
      text = text.replace(/^\s*#{1,6}[ \t]+[^\n]*\n?|^\s*[^\n]+\n[ \t]*(=+|-+)[ \t]*\n?/, "").trimStart();
    }
  } else {
    const blocks = parseArticleBlocks(text);
    if (blocks[0]?.type === "heading" && blocks[0].text === title && blocks.length > 1) text = serializeArticleBlocks(blocks.slice(1));
  }
  return { kind: kind === "zip" ? "docx" : kind, title, text: text.slice(0, MAX_ARTICLE_CHARS), format: extracted.format };
}
