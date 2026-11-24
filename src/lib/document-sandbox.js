/**
 * Runs document parsing (document-parse.js) in a worker thread, so a hostile or merely
 * huge upload can't take the server down with it:
 * - memory: the worker's V8 heap is capped (resourceLimits); decoded PDF streams live in
 *   ArrayBuffers outside that heap, so the worker's external memory is polled too. Over
 *   either limit, the worker is killed and the upload gets `file_too_large`.
 * - time: a hard timeout terminates the worker (`file_unreadable`, "took too long").
 *   Inside, PDFs stop at a softer deadline and keep the pages already read.
 * - load: at most MAX_CONCURRENT_PARSES workers per process; a few more uploads wait
 *   briefly in a queue, and beyond that get `server_busy` with a retry time.
 * The main thread only copies bytes and waits, so other requests stay responsive.
 *
 * The worker file is loaded from disk at runtime, never bundled: Next (dev and
 * `next start`, not standalone output) runs from the project root, where
 * `src/lib/document-worker.mjs` and node_modules are.
 */
import { Worker } from "node:worker_threads";
import path from "node:path";
import { DocumentImportError } from "./document-shared.js";

export const MAX_CONCURRENT_PARSES = 2;
export const MAX_QUEUED_PARSES = 4;
export const QUEUE_WAIT_MS = 15_000;
export const PARSE_TIMEOUT_MS = 20_000;
/** PDFs stop reading pages at this point and keep what they have (inside the hard timeout). */
export const PARSE_SOFT_DEADLINE_MS = 14_000;
// A 300-page Word file needs ~120 MB of heap; a DOM-dense 5 MB document.xml needs gigabytes.
export const PARSE_RESOURCE_LIMITS = Object.freeze({ maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 });
export const MAX_PARSE_EXTERNAL_BYTES = 192 * 1024 * 1024;
const MEMORY_POLL_MS = 25;
const BUSY_RETRY_SECONDS = 10;
const KNOWN_CODES = new Set(["file_unsupported", "file_too_large", "file_unreadable"]);

const TOO_COMPLEX = "This file needs more memory to read than we allow. Save it as a new PDF or split it into smaller files, or paste the part you want to read.";
const TOO_SLOW = "This file took too long to read. Try a smaller file, or paste the text instead.";
const CRASHED = "We couldn't read this file. Try saving or exporting it again, or paste the text instead.";

/** @returns {string} absolute path of the worker entry file */
export function defaultWorkerFile() {
  return path.join(process.cwd(), "src", "lib", "document-worker.mjs");
}

// ─── Concurrency gate ───────────────────────────────────────────────────

let active = 0;
const waiting = [];

function busy(detail) {
  return new DocumentImportError("server_busy", "We're reading a lot of files right now. Try again in a few seconds.", detail, { retryAfter: BUSY_RETRY_SECONDS });
}

function acquire({ waitMs, maxConcurrent, signal }) {
  if (active < maxConcurrent) {
    active++;
    return Promise.resolve();
  }
  if (waiting.length >= MAX_QUEUED_PARSES) return Promise.reject(busy("parse_queue_full"));
  return new Promise((resolve, reject) => {
    const leave = (err) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const i = waiting.indexOf(entry);
      if (i >= 0) waiting.splice(i, 1);
      if (err) reject(err);
    };
    const entry = {
      // The slot passes straight from the finishing parse to this one; `active` is unchanged.
      grant: () => {
        leave();
        resolve();
      },
    };
    const onAbort = () => leave(new DocumentImportError("file_unreadable", "The upload was cancelled.", "client_aborted"));
    const timer = setTimeout(() => leave(busy("parse_queue_wait")), waitMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    waiting.push(entry);
  });
}

function release() {
  const next = waiting[0];
  if (next) next.grant();
  else active--;
}

/** @returns {{active: number, waiting: number}} parses running and queued in this process */
export function parseGateState() {
  return { active, waiting: waiting.length };
}

// ─── Worker run ─────────────────────────────────────────────────────────

function runWorker(bytes, kind, { workerFile, timeoutMs, deadlineMs, resourceLimits, maxExternalBytes, signal }) {
  return new Promise((resolve, reject) => {
    // A private copy whose buffer can be handed over without copying again.
    const copy = bytes.slice();
    let worker;
    try {
      worker = new Worker(/* turbopackIgnore: true */ workerFile, {
        workerData: { bytes: copy.buffer, kind, deadlineMs },
        transferList: [copy.buffer],
        resourceLimits,
        // The parser needs no configuration, so it never sees secrets.
        env: {},
      });
    } catch (err) {
      reject(new DocumentImportError("file_unreadable", CRASHED, `worker_start: ${err?.message || err}`.slice(0, 200)));
      return;
    }

    let settled = false;
    let polling = false;
    const baselineRss = process.memoryUsage.rss();
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      signal?.removeEventListener("abort", onAbort);
      worker.terminate().catch(() => {});
      if (err) reject(err);
      else resolve(value);
    };
    const tooBig = (detail) => finish(new DocumentImportError("file_too_large", TOO_COMPLEX, detail));

    const timer = setTimeout(() => finish(new DocumentImportError("file_unreadable", TOO_SLOW, "worker_timeout")), timeoutMs);
    const poll = setInterval(() => {
      if (typeof worker.getHeapStatistics !== "function") {
        // Older Node: no per-worker figure, so judge by how much the whole process grew.
        if (process.memoryUsage.rss() - baselineRss > maxExternalBytes + resourceLimits.maxOldGenerationSizeMb * 1024 * 1024) tooBig("worker_rss");
        return;
      }
      if (polling) return;
      polling = true;
      worker.getHeapStatistics().then(
        (stats) => {
          polling = false;
          if (stats.external_memory > maxExternalBytes) tooBig("worker_external_memory");
        },
        () => {
          polling = false; // the worker already exited
        }
      );
    }, MEMORY_POLL_MS);
    const onAbort = () => finish(new DocumentImportError("file_unreadable", "The upload was cancelled.", "client_aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    worker.on("message", (msg) => {
      if (msg?.ok) return finish(null, { title: String(msg.title || ""), text: String(msg.text || "") });
      const code = KNOWN_CODES.has(msg?.code) ? msg.code : "file_unreadable";
      finish(new DocumentImportError(code, (KNOWN_CODES.has(msg?.code) && msg.message) || CRASHED, String(msg?.detail || "worker_failed").slice(0, 200)));
    });
    worker.on("error", (err) => {
      if (err?.code === "ERR_WORKER_OUT_OF_MEMORY") return tooBig("worker_heap");
      finish(new DocumentImportError("file_unreadable", CRASHED, `worker_error: ${err?.message || err}`.slice(0, 200)));
    });
    worker.on("exit", (exitCode) => finish(new DocumentImportError("file_unreadable", CRASHED, `worker_exit_${exitCode}`)));
  });
}

/**
 * Parse a document in a fresh, resource-limited worker (waiting for a free slot first).
 * @param {Uint8Array} bytes not modified; the worker gets a copy
 * @param {"pdf"|"zip"} kind from detectKind
 * @param {{signal?: AbortSignal, workerFile?: string, timeoutMs?: number, deadlineMs?: number,
 *   queueWaitMs?: number, maxConcurrent?: number, resourceLimits?: object, maxExternalBytes?: number}} [options]
 *   everything but `signal` exists for tests
 * @returns {Promise<{title: string, text: string}>}
 * @throws {DocumentImportError} including `server_busy` (with retryAfter) when the queue is full
 */
export async function parseInWorker(bytes, kind, options = {}) {
  const {
    signal,
    workerFile = defaultWorkerFile(),
    timeoutMs = PARSE_TIMEOUT_MS,
    deadlineMs = PARSE_SOFT_DEADLINE_MS,
    queueWaitMs = QUEUE_WAIT_MS,
    maxConcurrent = MAX_CONCURRENT_PARSES,
    resourceLimits = PARSE_RESOURCE_LIMITS,
    maxExternalBytes = MAX_PARSE_EXTERNAL_BYTES,
  } = options;
  await acquire({ waitMs: queueWaitMs, maxConcurrent, signal });
  try {
    return await runWorker(bytes, kind, { workerFile, timeoutMs, deadlineMs, resourceLimits: { ...resourceLimits }, maxExternalBytes, signal });
  } finally {
    release();
  }
}
