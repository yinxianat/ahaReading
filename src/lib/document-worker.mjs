/**
 * Parse worker: one document per worker, started by document-sandbox.js with memory
 * limits and a hard timeout. Node loads this file directly (it is not bundled by
 * Next), so it and everything it imports use relative paths only.
 *
 * In: workerData {bytes: ArrayBuffer, kind: "pdf"|"zip", deadlineMs}.
 * Out: one message, {ok: true, title, text} or {ok: false, code, message, detail}.
 */
import { parentPort, workerData } from "node:worker_threads";
import { parseDocument } from "./document-parse.js";

try {
  const { title, text } = await parseDocument(new Uint8Array(workerData.bytes), workerData.kind, { deadlineMs: workerData.deadlineMs });
  parentPort.postMessage({ ok: true, title, text });
} catch (err) {
  parentPort.postMessage({
    ok: false,
    code: err?.name === "DocumentImportError" ? err.code : null,
    message: err?.name === "DocumentImportError" ? err.message : null,
    detail: String(err?.detail || err?.message || err).slice(0, 200),
  });
}
