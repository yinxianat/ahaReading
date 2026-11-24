import { requireUser } from "@/lib/auth.js";
import { badRequest, jsonError, rateLimited, withErrorHandling } from "@/lib/http.js";
import { checkRateLimit } from "@/lib/rate-limit.js";
import { logger } from "@/lib/logger.js";
import { createUploadedArticle, serializeArticle } from "@/lib/articles.js";
import { DocumentImportError, cleanFileName } from "@/lib/document-import.js";
import { MAX_UPLOAD_BYTES } from "@/lib/limits.js";
import { readUploadBody } from "@/lib/upload-body.js";

// The file itself is the body, so it must say what it is. Every one of these makes a
// cross-site fetch preflight (which we never answer), unlike multipart or text/plain forms.
const ACCEPTED_TYPES = new Set([
  "application/pdf",
  "application/x-pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "application/octet-stream",
]);
const STATUS = { file_unsupported: 415, file_too_large: 413, file_unreadable: 422, server_busy: 503 };
const MAX_MB = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024));
const TOO_LARGE = `That file is over ${MAX_MB} MB. Upload a smaller file, or paste the part you want to read.`;
const LOCK_RETRY_SECONDS = 5;
// Parsing a document holds CPU and memory for seconds: one at a time per user (and a
// global cap on parses in document-sandbox.js).
const uploadsInFlight = new Set();

/**
 * POST (body = the raw file; Content-Type = its type; X-File-Name = encodeURIComponent(name))
 *   → 201 {article}, or 200 {article} when the same file was uploaded in the last few minutes.
 *   Errors: 400 invalid_input (field "file") | upload_interrupted, 413 file_too_large,
 *   415 file_unsupported, 422 file_unreadable, 429 rate_limited | upload_in_progress,
 *   503 server_busy (all 429/503 with retryAfter).
 */
export const POST = withErrorHandling(async (request) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const userId = auth.user.id;

  const limit = checkRateLimit(`articles:${userId}`, { maxRequests: 20, windowMs: 60_000 });
  if (!limit.allowed) return rateLimited(limit.retryAfter);

  const type = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!ACCEPTED_TYPES.has(type)) {
    return jsonError(415, "file_unsupported", "We can read PDF and Word (.docx) files. For anything else, copy the text and use Paste text.", { field: "file" });
  }
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) return jsonError(413, "file_too_large", TOO_LARGE, { field: "file" });

  if (uploadsInFlight.has(userId)) {
    return jsonError(
      429,
      "upload_in_progress",
      "Another file is still uploading. Wait for it to finish, then try again.",
      { retryAfter: LOCK_RETRY_SECONDS },
      { "Retry-After": String(LOCK_RETRY_SECONDS) }
    );
  }
  uploadsInFlight.add(userId);
  try {
    const body = await readUploadBody(request, MAX_UPLOAD_BYTES);
    if (body.interrupted) {
      void logger.warn("api", "Upload body interrupted", { reason: body.interrupted });
      return jsonError(400, "upload_interrupted", "The upload stopped before the whole file arrived. Check your connection and try again.", { field: "file" });
    }
    if (body.tooLarge) return jsonError(413, "file_too_large", TOO_LARGE, { field: "file" });
    if (body.bytes.length === 0) return badRequest("Choose a PDF or Word file to upload.", "file");

    const fileName = cleanFileName(request.headers.get("x-file-name"));
    const { article, created } = await createUploadedArticle(userId, { bytes: body.bytes, fileName, signal: request.signal });
    return Response.json({ article: serializeArticle(article) }, { status: created ? 201 : 200 });
  } catch (err) {
    if (!(err instanceof DocumentImportError)) throw err;
    // The reason is a short code we wrote, never document text.
    void logger.warn("api", "Document upload rejected", { code: err.code, reason: err.detail });
    const retry = err.retryAfter ? { "Retry-After": String(err.retryAfter) } : undefined;
    return jsonError(STATUS[err.code] || 422, err.code, err.message, { field: err.code === "server_busy" ? undefined : "file", retryAfter: err.retryAfter }, retry);
  } finally {
    uploadsInFlight.delete(userId);
  }
}, { source: "api" });
