import { ProviderError, ErrorKind, providerFetch, throwHttpError } from "../errors.js";

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemini-2.5-flash";
const REFUSAL_FINISH = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"]);

function apiKey() {
  return process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY;
}

const gemini = {
  name: "google",

  isConfigured() {
    return Boolean(apiKey());
  },

  defaultModel() {
    return process.env.GOOGLE_AI_MODEL || DEFAULT_MODEL;
  },

  models() {
    const list = [
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", tier: "fast", notes: "Fast and cheap" },
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", tier: "standard", notes: "Higher quality" },
    ];
    const custom = process.env.GOOGLE_AI_MODEL;
    if (custom && !list.some((m) => m.id === custom)) {
      list.unshift({ id: custom, label: custom, tier: "custom", notes: "Set via GOOGLE_AI_MODEL" });
    }
    return list;
  },

  /**
   * @param {{system: string, userMessage: string, model?: string, maxTokens?: number, signal?: AbortSignal}} params
   * @returns {Promise<{text: string, model: string, tokensUsed: number, inputTokens: number, outputTokens: number, truncated: boolean}>}
   */
  async complete({ system, userMessage, model, maxTokens, signal }) {
    const key = apiKey();
    if (!key) throw new ProviderError(ErrorKind.INFRASTRUCTURE, "google", new Error("GOOGLE_AI_API_KEY not set"));
    const selected = model || this.defaultModel();

    // Key in a header, never the URL — query strings reach proxy and access logs.
    const res = await providerFetch("google", `${BASE}/${encodeURIComponent(selected)}:generateContent`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: userMessage }] }],
        generationConfig: { maxOutputTokens: maxTokens || 1024 },
      }),
    });

    // Gemini signals content blocks on 200, so any non-2xx (incl. 400 API_KEY_INVALID) is infrastructure.
    if (!res.ok) await throwHttpError("google", res, { refusalOn400: false });

    const data = await res.json().catch(() => null);

    if (data?.promptFeedback?.blockReason) {
      throw new ProviderError(ErrorKind.REFUSAL, "google", new Error(`prompt blocked: ${data.promptFeedback.blockReason}`));
    }
    const candidate = data?.candidates?.[0];
    if (REFUSAL_FINISH.has(candidate?.finishReason)) {
      throw new ProviderError(ErrorKind.REFUSAL, "google", new Error(`finishReason=${candidate.finishReason}`));
    }

    const text = Array.isArray(candidate?.content?.parts)
      ? candidate.content.parts.filter((p) => typeof p?.text === "string" && !p.thought).map((p) => p.text).join("")
      : "";
    if (!text.trim()) {
      throw new ProviderError(
        ErrorKind.INFRASTRUCTURE,
        "google",
        new Error(`empty response (finishReason=${candidate?.finishReason || "none"})`)
      );
    }

    const inputTokens = data.usageMetadata?.promptTokenCount || 0;
    // Thinking tokens are billed as output.
    const outputTokens = (data.usageMetadata?.candidatesTokenCount || 0) + (data.usageMetadata?.thoughtsTokenCount || 0);
    const truncated = candidate?.finishReason === "MAX_TOKENS";
    return { text, model: data.modelVersion || selected, tokensUsed: data.usageMetadata?.totalTokenCount || inputTokens + outputTokens, inputTokens, outputTokens, truncated };
  },
};

export default gemini;
