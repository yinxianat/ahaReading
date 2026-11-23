/**
 * AI cost estimation. These rates are a configured default, NOT a billing source of truth:
 * RATES_VERIFIED_ON says how old they are, and AI_PRICE_OVERRIDES replaces any entry at
 * runtime as JSON: {"claude-opus-5-5":{"input":4,"output":20}} (USD per 1M tokens).
 */
export const RATES_VERIFIED_ON = "2026-11-20";

const DEFAULT_RATES = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "gemini-2.5-pro": { input: 1.25, output: 10 },
  "mock-1": { input: 0, output: 0 },
};

// Unknown models still cost something rather than silently nothing.
const FALLBACK_RATE = { input: 4, output: 20 };
// Only for rows without the input/output split (recorded before it existed): explanations
// are mostly prompt, so assume 30% output.
export const ASSUMED_OUTPUT_SHARE = 0.3;

function overrides() {
  const raw = process.env.AI_PRICE_OVERRIDES;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Rate for a model id (exact, override, or versioned-family prefix match).
 * @param {string|null|undefined} model
 * @returns {{input: number, output: number, known: boolean}}
 */
export function rateFor(model) {
  if (!model) return { ...FALLBACK_RATE, known: false };
  const custom = overrides()[model];
  if (custom && typeof custom.input === "number" && typeof custom.output === "number") {
    return { input: custom.input, output: custom.output, known: true };
  }
  if (DEFAULT_RATES[model]) return { ...DEFAULT_RATES[model], known: true };
  const prefix = Object.keys(DEFAULT_RATES).find((k) => model.startsWith(k));
  if (prefix) return { ...DEFAULT_RATES[prefix], known: true };
  return { ...FALLBACK_RATE, known: false };
}

/**
 * Estimated USD for one call (or a sum of calls on one model). Exact when the
 * input/output split is known; any tokens not covered by the split are priced at
 * the blended rate.
 * @param {string} model
 * @param {number} tokensUsed total tokens
 * @param {{inputTokens?: number|null, outputTokens?: number|null}} [split]
 * @returns {number}
 */
export function estimateCost(model, tokensUsed, { inputTokens, outputTokens } = {}) {
  const input = Math.max(0, Number(inputTokens) || 0);
  const output = Math.max(0, Number(outputTokens) || 0);
  const total = Math.max(Number(tokensUsed) || 0, input + output);
  if (total <= 0) return 0;
  const rate = rateFor(model);
  const blended = rate.input * (1 - ASSUMED_OUTPUT_SHARE) + rate.output * ASSUMED_OUTPUT_SHARE;
  const unsplit = total - input - output;
  return (input * rate.input + output * rate.output + unsplit * blended) / 1_000_000;
}

/**
 * Roll AiCall rows up into totals and a per-model breakdown.
 * @param {Array<{model?: string, tokens?: number, inputTokens?: number, outputTokens?: number, status?: string}>} calls
 */
export function summarizeUsage(calls = []) {
  const byModel = {};
  const unknownModels = new Set();
  let totalTokens = 0;
  let totalUsd = 0;
  for (const call of calls) {
    const tokens = Number(call.tokens) || 0;
    const model = call.model || "unrecorded";
    const usd = estimateCost(call.model, tokens, call);
    if (tokens > 0 && !rateFor(call.model).known) unknownModels.add(model);
    totalTokens += tokens;
    totalUsd += usd;
    byModel[model] ||= { model, calls: 0, tokens: 0, usd: 0 };
    byModel[model].calls += 1;
    byModel[model].tokens += tokens;
    byModel[model].usd += usd;
  }
  return {
    totalCalls: calls.length,
    totalTokens,
    totalUsd,
    byModel: Object.values(byModel).sort((a, b) => b.usd - a.usd),
    unknownModels: [...unknownModels],
    ratesVerifiedOn: RATES_VERIFIED_ON,
    assumedOutputShare: ASSUMED_OUTPUT_SHARE,
  };
}
