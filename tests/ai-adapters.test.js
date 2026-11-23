// Adapter request shape and response classification, with fetch mocked.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ErrorKind } from "@/lib/ai/errors.js";
import anthropic from "@/lib/ai/providers/anthropic.js";
import openai from "@/lib/ai/providers/openai.js";
import google from "@/lib/ai/providers/gemini.js";

const KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_AI_API_KEY", "ANTHROPIC_MODEL"];
let saved;
let fetchMock;

function respond(status, body) {
  fetchMock.mockResolvedValueOnce(
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  );
}

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
  process.env.OPENAI_API_KEY = "sk-test-openai";
  process.env.GOOGLE_AI_API_KEY = "AIza-test-google";
  delete process.env.ANTHROPIC_MODEL;
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const call = { system: "sys", userMessage: "msg", maxTokens: 300 };

describe("anthropic adapter", () => {
  it("sends the 2026-10-21 version, fallback beta, effort low, no temperature; key only in header", async () => {
    respond(200, { model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "text", text: "Hi" }], usage: { input_tokens: 3, output_tokens: 4 } });
    const out = await anthropic.complete(call);
    expect(out).toEqual({ text: "Hi", model: "claude-opus-5-5", tokensUsed: 7, inputTokens: 3, outputTokens: 4 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(url).not.toContain("sk-ant");
    expect(init.headers["x-api-key"]).toBe("sk-ant-test-key");
    expect(init.headers["anthropic-version"]).toBe("2026-10-21");
    expect(init.headers["anthropic-beta"]).toBe("server-side-fallback-2026-07-01");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ model: "claude-opus-5-5", max_tokens: 300, system: "sys", output_config: { effort: "low" }, fallbacks: "default" });
    expect(body).not.toHaveProperty("temperature");
  });

  it("joins text blocks and ignores thinking blocks that come first", async () => {
    respond(200, {
      model: "claude-opus-5-5",
      stop_reason: "end_turn",
      content: [{ type: "thinking", thinking: "secret reasoning" }, { type: "text", text: "Part one. " }, { type: "text", text: "Part two." }],
      usage: {},
    });
    const out = await anthropic.complete(call);
    expect(out.text).toBe("Part one. Part two.");
  });

  it("stop_reason refusal on HTTP 200 → REFUSAL", async () => {
    respond(200, { stop_reason: "refusal", content: [] });
    await expect(anthropic.complete(call)).rejects.toMatchObject({ kind: ErrorKind.REFUSAL, provider: "anthropic" });
  });

  it("max_tokens with empty text → INFRASTRUCTURE", async () => {
    respond(200, { stop_reason: "max_tokens", content: [{ type: "thinking", thinking: "..." }] });
    await expect(anthropic.complete(call)).rejects.toMatchObject({ kind: ErrorKind.INFRASTRUCTURE });
  });

  it("HTTP errors are INFRASTRUCTURE (401, 429, 529, 400)", async () => {
    for (const status of [401, 429, 529, 400]) {
      respond(status, { type: "error", error: { type: "x", message: "nope" } });
      await expect(anthropic.complete(call)).rejects.toMatchObject({ kind: ErrorKind.INFRASTRUCTURE });
    }
  });

  it("network failure / timeout → INFRASTRUCTURE", async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
    await expect(anthropic.complete(call)).rejects.toMatchObject({ kind: ErrorKind.INFRASTRUCTURE });
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(anthropic.complete(call)).rejects.toMatchObject({ kind: ErrorKind.INFRASTRUCTURE });
  });
});

describe("openai adapter", () => {
  it("bearer header, chat body, token sum", async () => {
    respond(200, { model: "gpt-4o", choices: [{ finish_reason: "stop", message: { content: "Hello" } }], usage: { total_tokens: 12, prompt_tokens: 9, completion_tokens: 3 } });
    const out = await openai.complete(call);
    expect(out).toEqual({ text: "Hello", model: "gpt-4o", tokensUsed: 12, inputTokens: 9, outputTokens: 3 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init.headers.authorization).toBe("Bearer sk-test-openai");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body).messages).toEqual([{ role: "system", content: "sys" }, { role: "user", content: "msg" }]);
  });

  it("finish_reason content_filter → REFUSAL", async () => {
    respond(200, { choices: [{ finish_reason: "content_filter", message: { content: "" } }] });
    await expect(openai.complete(call)).rejects.toMatchObject({ kind: ErrorKind.REFUSAL, provider: "openai" });
  });

  it("structured refusal field → REFUSAL", async () => {
    respond(200, { choices: [{ finish_reason: "stop", message: { content: null, refusal: "I can't" } }] });
    await expect(openai.complete(call)).rejects.toMatchObject({ kind: ErrorKind.REFUSAL });
  });

  it("empty content → INFRASTRUCTURE; 401 → INFRASTRUCTURE", async () => {
    respond(200, { choices: [{ finish_reason: "length", message: { content: "" } }] });
    await expect(openai.complete(call)).rejects.toMatchObject({ kind: ErrorKind.INFRASTRUCTURE });
    respond(401, { error: { message: "Incorrect API key provided" } });
    await expect(openai.complete(call)).rejects.toMatchObject({ kind: ErrorKind.INFRASTRUCTURE });
  });
});

describe("gemini adapter", () => {
  it("key in x-goog-api-key header, never in the URL", async () => {
    respond(200, { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "Hey" }] } }], usageMetadata: { totalTokenCount: 5, promptTokenCount: 2, candidatesTokenCount: 2, thoughtsTokenCount: 1 }, modelVersion: "gemini-2.5-flash" });
    const out = await google.complete(call);
    expect(out).toEqual({ text: "Hey", model: "gemini-2.5-flash", tokensUsed: 5, inputTokens: 2, outputTokens: 3 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    expect(url).not.toMatch(/key=/);
    expect(init.headers["x-goog-api-key"]).toBe("AIza-test-google");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("REGRESSION: HTTP 400 API_KEY_INVALID → INFRASTRUCTURE (fail over, not refusal)", async () => {
    respond(400, {
      error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] },
    });
    await expect(google.complete(call)).rejects.toMatchObject({ kind: ErrorKind.INFRASTRUCTURE, provider: "google" });
  });

  it("HTTP 200 finishReason SAFETY → REFUSAL", async () => {
    respond(200, { candidates: [{ finishReason: "SAFETY", content: { parts: [] } }] });
    await expect(google.complete(call)).rejects.toMatchObject({ kind: ErrorKind.REFUSAL });
  });

  it("HTTP 200 promptFeedback.blockReason → REFUSAL", async () => {
    respond(200, { promptFeedback: { blockReason: "SAFETY" } });
    await expect(google.complete(call)).rejects.toMatchObject({ kind: ErrorKind.REFUSAL });
  });

  it("MAX_TOKENS with no text → INFRASTRUCTURE; ignores thought parts", async () => {
    respond(200, { candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "thinking", thought: true }] } }] });
    await expect(google.complete(call)).rejects.toMatchObject({ kind: ErrorKind.INFRASTRUCTURE });
  });
});
