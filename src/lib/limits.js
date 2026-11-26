/**
 * Input caps shared by server validation and client forms (pure, no imports), so a
 * limit is defined once and the UI's maxLength can never drift from the API's.
 */

export const MAX_HIGHLIGHT_CHARS = 1000;
export const MAX_SURROUNDING_CHARS = 3000;
export const MAX_ARTICLE_CHARS = 200_000;
export const MAX_TITLE_CHARS = 200;
export const MAX_URL_CHARS = 2000;
export const MAX_TERM_CHARS = 200;
export const MAX_DEFINITION_CHARS = 10_000;
export const MAX_TAGS = 10;
export const MAX_TAG_CHARS = 50;
export const MAX_NOTES_CHARS = 5000;
export const MAX_DISPLAY_NAME_CHARS = 100;
export const SIGN_IN_CODE_LENGTH = 6;
/** Largest PDF, Word or Markdown file accepted for upload (bytes). */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** File types the Upload tab accepts (extensions, for the file picker and client checks). */
export const UPLOAD_EXTENSIONS = [".pdf", ".docx", ".md", ".markdown"];
/** Content types an upload may declare for Markdown (none of them can be sent cross-site without a preflight). */
export const MARKDOWN_TYPES = ["text/markdown", "text/x-markdown"];
/** Bookmarks: note length, how much of the marked text is kept, and a per-article ceiling. */
export const MAX_BOOKMARK_NOTE_CHARS = 2000;
export const MAX_BOOKMARK_QUOTE_CHARS = 300;
export const MAX_BOOKMARKS_PER_ARTICLE = 300;
/** Bookmark kinds: re-visit later, or important. */
export const BOOKMARK_KINDS = ["revisit", "important"];
