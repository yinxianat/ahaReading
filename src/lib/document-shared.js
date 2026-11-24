/**
 * The one error type document uploads throw. Plain module with no imports, so the parse
 * worker (document-worker.mjs, run by Node outside the Next bundle) can share it.
 */

/**
 * Error with a user-facing code:
 * file_unsupported (415) | file_too_large (413) | file_unreadable (422) | server_busy (503).
 */
export class DocumentImportError extends Error {
  /**
   * @param {"file_unsupported"|"file_too_large"|"file_unreadable"|"server_busy"} code
   * @param {string} message shown to the user; names the fix
   * @param {string} [detail] short machine reason for logs, never document text
   * @param {{retryAfter?: number}} [extra] seconds before a retry can work (server_busy)
   */
  constructor(code, message, detail, { retryAfter } = {}) {
    super(message);
    this.name = "DocumentImportError";
    this.code = code;
    this.detail = detail;
    this.retryAfter = retryAfter;
  }
}

// Control characters except tab/newline, and the invisible ones used to hide or reorder
// text (zero-width, bidi overrides that make "\u202Efdp.exe" display as "exe.pdf", BOM).
export const UNWANTED_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
