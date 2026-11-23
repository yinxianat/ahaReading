import { ProviderError, ErrorKind, providerFetch, throwHttpError } from "../errors.js";

const ENDPOINT = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4o";

const openai = {
  name: "openai",

  isConfigured() {
    return Boolean(process.env.OPENAI_API_KEY);
  },

  defaultModel() {
    return process.env.OPENAI_MODEL || DEFAULT_MODEL;
  },

  models() {
    const list = [
      { id: "gpt-4o", label: "GPT-4o", tier: "standard", notes: "Best quality" },
      { id: "gpt-4o-mini", label: "GPT-4o Mini", tier: "fast", notes: "Fastest, lowest cost" },
    ];
    const custom = process.env.OPENAI_MODEL;
    if (custom && !list.some((m) => m.id === custom)) {
      list.unshift({ id: custom, label: custom, tier: "custom", notes: "Set via OPENAI_MODEL" });
    }
    return list;
  },

  /**
   * @param {{system: string, userMessage: string, model?: string, maxTokens?: number, signal?: AbortSignal}} params
   * @returns {Promise<{text: string, model: string, tokensUsed: number, inputTokens: number, outputTokens: number}>}
   */
  async complete({ system, userMessage, model, maxTokens, signal }) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new ProviderError(ErrorKind.INFRASTRUCTURE, "openai", new Error("OPENAI_API_KEY not set"));
    const selected = model || this.defaultModel();

    const res = await providerFetch("openai", ENDPOINT, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: selected,
        max_tokens: maxTokens || 1024,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userMessage },
        ],
      }),
    });

    if (!res.ok) await throwHttpError("openai", res, { refusalOn400: false });

    const data = await res.json().catch(() => null);
    const choice = data?.choices?.[0];

    // Content-policy stops arrive as 200 + finish_reason or a structured refusal field.
    if (choice?.finish_reason === "content_filter" || (typeof choice?.message?.refusal === "string" && choice.message.refusal)) {
      throw new ProviderError(ErrorKind.REFUSAL, "openai", new Error("content_filter"));
    }

    const text = typeof choice?.message?.content === "string" ? choice.message.content : "";
    if (!text.trim()) {
      throw new ProviderError(
        ErrorKind.INFRASTRUCTURE,
        "openai",
        new Error(`empty response (finish_reason=${choice?.finish_reason || "none"})`)
      );
    }

    const inputTokens = data.usage?.prompt_tokens || 0;
    const outputTokens = data.usage?.completion_tokens || 0;
    return { text, model: data.model || selected, tokensUsed: data.usage?.total_tokens || inputTokens + outputTokens, inputTokens, outputTokens };
  },
};

export default openai;
