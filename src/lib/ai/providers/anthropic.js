import { ProviderError, ErrorKind, providerFetch, throwHttpError } from "../errors.js";

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2026-10-21";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const DEFAULT_MODEL = "claude-opus-5-5";

// REST via fetch rather than the SDK: one endpoint, symmetric adapters, no vendor dependency.
const anthropic = {
  name: "anthropic",

  isConfigured() {
    return Boolean(process.env.ANTHROPIC_API_KEY);
  },

  defaultModel() {
    return process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  },

  models() {
    const list = [
      { id: "claude-opus-5-5", label: "Claude Opus 5.5", tier: "premium", notes: "Default. Highest quality." },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", tier: "standard", notes: "Balanced quality and cost." },
      { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", tier: "fast", notes: "Fastest, lowest cost." },
    ];
    const custom = process.env.ANTHROPIC_MODEL;
    if (custom && !list.some((m) => m.id === custom)) {
      list.unshift({ id: custom, label: custom, tier: "custom", notes: "Set via ANTHROPIC_MODEL" });
    }
    return list;
  },

  /**
   * @param {{system: string, userMessage: string, model?: string, maxTokens?: number, signal?: AbortSignal}} params
   * @returns {Promise<{text: string, model: string, tokensUsed: number, inputTokens: number, outputTokens: number}>}
   */
  async complete({ system, userMessage, model, maxTokens, signal }) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new ProviderError(ErrorKind.INFRASTRUCTURE, "anthropic", new Error("ANTHROPIC_API_KEY not set"));
    const selected = model || this.defaultModel();

    const res = await providerFetch("anthropic", ENDPOINT, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": API_VERSION,
        "anthropic-beta": FALLBACK_BETA,
      },
      body: JSON.stringify({
        model: selected,
        max_tokens: maxTokens || 1024,
        system,
        messages: [{ role: "user", content: userMessage }],
        // Short tasks: low effort keeps latency and cost down. No temperature (not accepted).
        output_config: { effort: "low" },
        // Server-side refusal rescue within Anthropic before we see a refusal.
        fallbacks: "default",
      }),
    });

    // Anthropic content decisions arrive as 200 + stop_reason, so a 400 is our request's fault.
    if (!res.ok) await throwHttpError("anthropic", res, { refusalOn400: false });

    const data = await res.json().catch(() => null);
    if (!data) throw new ProviderError(ErrorKind.INFRASTRUCTURE, "anthropic", new Error("unparseable response"));

    if (data.stop_reason === "refusal") {
      throw new ProviderError(ErrorKind.REFUSAL, "anthropic", new Error("stop_reason=refusal"));
    }

    // Thinking blocks may precede the answer; only text blocks are the answer.
    const text = Array.isArray(data.content)
      ? data.content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("")
      : "";

    if (!text.trim()) {
      throw new ProviderError(
        ErrorKind.INFRASTRUCTURE,
        "anthropic",
        new Error(`empty response (stop_reason=${data.stop_reason || "none"})`)
      );
    }

    const inputTokens = data.usage?.input_tokens || 0;
    const outputTokens = data.usage?.output_tokens || 0;
    return { text, model: data.model || selected, tokensUsed: inputTokens + outputTokens, inputTokens, outputTokens };
  },
};

export default anthropic;
