// The parse worker's guard rails: hard timeout, crash handling, the global concurrency gate.
// Stand-in workers (tests/fixtures/workers) play a stuck or crashing parser.
import { describe, it, expect } from "vitest";
import path from "node:path";
import { parseInWorker, parseGateState, defaultWorkerFile } from "@/lib/document-sandbox.js";
import { DocumentImportError } from "@/lib/document-shared.js";
import { makePdf, PROSE } from "./fixtures/documents.js";

const worker = (name) => path.join(import.meta.dirname, "fixtures", "workers", `${name}.mjs`);
const PDF = makePdf([[{ text: PROSE, y: 700 }]]);

async function rejection(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

describe("parseInWorker", () => {
  it("runs the real worker file from the project folder", async () => {
    expect(defaultWorkerFile()).toMatch(/src[\\/]lib[\\/]document-worker\.mjs$/);
    const { text } = await parseInWorker(PDF, "pdf");
    expect(text).toContain(PROSE);
  });

  it("does not detach or change the caller's bytes", async () => {
    const bytes = PDF.slice();
    await parseInWorker(bytes, "pdf");
    expect(bytes).toEqual(PDF);
  });

  it("a stuck parser is terminated at the hard timeout and frees its slot", async () => {
    const started = Date.now();
    const err = await rejection(parseInWorker(PDF, "pdf", { workerFile: worker("hang"), timeoutMs: 300 }));
    expect(err).toBeInstanceOf(DocumentImportError);
    expect(err).toMatchObject({ code: "file_unreadable", detail: "worker_timeout" });
    expect(err.message).toMatch(/took too long/);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(parseGateState()).toEqual({ active: 0, waiting: 0 });
  });

  it("a worker that dies without answering is a friendly unreadable error", async () => {
    const err = await rejection(parseInWorker(PDF, "pdf", { workerFile: worker("crash") }));
    expect(err).toMatchObject({ code: "file_unreadable", detail: "worker_exit_3" });
    expect(err.message).toMatch(/paste the text instead/);
  });

  it("an unknown code from the worker never reaches the user as-is", async () => {
    const err = await rejection(parseInWorker(PDF, "pdf", { workerFile: worker("garbage") }));
    expect(err.code).toBe("file_unreadable");
    expect(err.message).not.toMatch(/raw parser text/);
    expect(err.detail.length).toBeLessThanOrEqual(200);
  });

  it("a missing worker file is an error response, not a crash", async () => {
    const err = await rejection(parseInWorker(PDF, "pdf", { workerFile: worker("does-not-exist") }));
    expect(err).toBeInstanceOf(DocumentImportError);
    expect(err.code).toBe("file_unreadable");
  });

  it("parses beyond the concurrency cap wait, then get server_busy with a retry time", async () => {
    const hang = { workerFile: worker("hang"), timeoutMs: 600, maxConcurrent: 1 };
    const first = rejection(parseInWorker(PDF, "pdf", hang));
    const queued = rejection(parseInWorker(PDF, "pdf", { ...hang, queueWaitMs: 100 }));
    expect(parseGateState()).toEqual({ active: 1, waiting: 1 });
    const busy = await queued;
    expect(busy).toMatchObject({ code: "server_busy", detail: "parse_queue_wait", retryAfter: 10 });
    expect(busy.message).toMatch(/Try again in a few seconds/);
    expect((await first).detail).toBe("worker_timeout");
    expect(parseGateState()).toEqual({ active: 0, waiting: 0 });
  });

  it("a queued parse runs once a slot frees up", async () => {
    const first = rejection(parseInWorker(PDF, "pdf", { workerFile: worker("hang"), timeoutMs: 200, maxConcurrent: 1 }));
    const second = parseInWorker(PDF, "pdf", { maxConcurrent: 1 });
    expect(parseGateState().waiting).toBe(1);
    expect((await first).detail).toBe("worker_timeout");
    expect((await second).text).toContain(PROSE);
    expect(parseGateState()).toEqual({ active: 0, waiting: 0 });
  });

  it("a full queue answers server_busy at once", async () => {
    const hang = { workerFile: worker("hang"), timeoutMs: 500, maxConcurrent: 1, queueWaitMs: 2000 };
    const running = [rejection(parseInWorker(PDF, "pdf", hang))];
    for (let i = 0; i < 4; i++) running.push(rejection(parseInWorker(PDF, "pdf", hang)));
    const started = Date.now();
    const err = await rejection(parseInWorker(PDF, "pdf", hang));
    expect(err).toMatchObject({ code: "server_busy", detail: "parse_queue_full" });
    expect(Date.now() - started).toBeLessThan(100);
    await Promise.all(running);
    expect(parseGateState()).toEqual({ active: 0, waiting: 0 });
  }, 10_000);

  it("a client that goes away stops its parse", async () => {
    const controller = new AbortController();
    const pending = rejection(parseInWorker(PDF, "pdf", { workerFile: worker("hang"), timeoutMs: 5000, signal: controller.signal }));
    setTimeout(() => controller.abort(), 50);
    expect((await pending).detail).toBe("client_aborted");
    expect(parseGateState()).toEqual({ active: 0, waiting: 0 });
  });
});
