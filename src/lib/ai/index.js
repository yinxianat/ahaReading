import { ProviderError, ErrorKind, providerTimeoutMs, chainDeadlineMs, timeoutError } from "./errors.js";
import anthropic from "./providers/anthropic.js";
import openai from "./providers/openai.js";
import google from "./providers/gemini.js";
import mock from "./providers/mock.js";
import prisma from "@/lib/db.js";
import { logger } from "@/lib/logger.js";
import { redact } from "@/lib/redact.js";
import { trimToLastSentence } from "./safety.js";

/**
 * Provider registry. To add a provider, write an adapter implementing
 * {name, isConfigured, defaultModel, models, complete} and add one line here.
 * The contract test fails the build if an entry is half-wired.
 */
export const REGISTRY = { anthropic, openai, google, mock };

const DEFAULT_CHAIN = "anthropic,openai,google";
const TASK_MODEL_ENV = { explain: "AI_EXPLAIN_MODEL", translate: "AI_TRANSLATE_MODEL", listen: "AI_LISTEN_MODEL" };
const STATUS = {
  [ErrorKind.INFRASTRUCTURE]: "infrastructure",
  [ErrorKind.REFUSAL]: "refusal",
  [ErrorKind.INVALID_OUTPUT]: "invalid_output",
};

function chainNames() {
  return (process.env.AI_PROVIDER_CHAIN || DEFAULT_CHAIN)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Providers named in AI_PROVIDER_CHAIN that are registered and configured, in order.
 * Unknown and unconfigured names are skipped, so one-provider operation is supported.
 * @returns {Array<object>}
 */
export function resolveChain() {
  return chainNames()
    .map((name) => REGISTRY[name])
    .filter((p) => p && p.isConfigured());
}

/**
 * Pick the model for one provider: an explicit or per-task override applies only to the
 * provider whose model list contains it; every other provider uses its own default.
 * @param {object} provider
 * @param {string} task
 * @param {string} [requested]
 * @returns {string}
 */
export function modelFor(provider, task, requested) {
  const ids = new Set((provider.models?.() || []).map((m) => m.id));
  for (const candidate of [requested, process.env[TASK_MODEL_ENV[task]]]) {
    if (candidate && ids.has(candidate)) return candidate;
  }
  return provider.defaultModel();
}

/**
 * Record one provider attempt in the AiCall ledger. Never throws: a ledger failure must
 * not turn a successful explanation into an error.
 * @param {{task: string, provider: string, model?: string|null, status: string, tokens?: number|null,
 *          inputTokens?: number|null, outputTokens?: number|null, latencyMs?: number|null, detail?: string|null}} row
 */
export async function recordAiCall(row) {
  try {
    await prisma.aiCall.create({
      data: {
        task: String(row.task).slice(0, 32),
        provider: String(row.provider).slice(0, 32),
        model: row.model ? String(row.model).slice(0, 100) : null,
        status: row.status,
        tokens: Number.isFinite(row.tokens) ? row.tokens : null,
        inputTokens: Number.isFinite(row.inputTokens) ? row.inputTokens : null,
        outputTokens: Number.isFinite(row.outputTokens) ? row.outputTokens : null,
        latencyMs: Number.isFinite(row.latencyMs) ? row.latencyMs : null,
        detail: row.detail ? safeRedact(row.detail).slice(0, 500) : null,
      },
    });
  } catch {
    // Deliberately swallowed; the logger may be what's down too, so don't log here.
  }
}

function safeRedact(value) {
  try {
    return redact(value);
  } catch {
    return "[unredactable]";
  }
}

function errorSummary(err) {
  return safeRedact(err?.cause?.message || err?.message || String(err)).slice(0, 500);
}

// Below this, starting another provider can only end in a timeout.
const MIN_ATTEMPT_MS = 500;
const VALIDATION_SPIKE = { windowMs: 60 * 60 * 1000, threshold: 5 };
let validationFailures = [];
const tokenBudget = { day: "", used: 0 };

// Repeated invalid output is a prompt or model regression, not one bad answer: escalate
// to ERROR (which alerts) once per spike instead of leaving it at WARN.
function noteValidationFailure(task, provider) {
  const now = Date.now();
  validationFailures = validationFailures.filter((t) => now - t < VALIDATION_SPIKE.windowMs);
  validationFailures.push(now);
  if (validationFailures.length === VALIDATION_SPIKE.threshold) {
    void logger.error("ai", "AI output validation failing repeatedly", { task, provider, failuresLastHour: validationFailures.length });
  }
}

function dailyTokenBudget() {
  const parsed = parseInt(process.env.AI_DAILY_TOKEN_BUDGET || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function budgetSpent() {
  const today = new Date().toISOString().slice(0, 10);
  if (tokenBudget.day !== today) Object.assign(tokenBudget, { day: today, used: 0 });
  const budget = dailyTokenBudget();
  return budget > 0 && tokenBudget.used >= budget;
}

function spendTokens(n) {
  if (Number.isFinite(n) && n > 0) tokenBudget.used += n;
}

// The signal asks a well-behaved adapter to abort; the race enforces the limit even if one doesn't.
function attempt(provider, params, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(timeoutError(provider.name));
    }, timeoutMs);
  });
  return Promise.race([provider.complete({ ...params, signal: controller.signal }), expired]).finally(() => clearTimeout(timer));
}

/**
 * Run the provider chain for one task, inside one overall deadline.
 * - Each attempt gets min(AI_TIMEOUT_MS, time left before AI_CHAIN_DEADLINE_MS).
 * - INFRASTRUCTURE (incl. timeout) → record, log, try the next provider.
 * - REFUSAL → record and stop (no shopping for a yes).
 * - An answer cut off at maxTokens (adapter `truncated`) is trimmed to its last whole sentence.
 * - `validate(text)` failing → record invalid_output and stop with INVALID_OUTPUT.
 * - Deadline reached → remaining providers are recorded as "skipped".
 * - All failed → one error log (the logger alerts the admin), throw INFRASTRUCTURE.
 * Ledger rows and warnings are written without awaiting: a slow database must not
 * add to AI latency.
 *
 * Long tasks (audio scripts) pass `timeoutMs` / `deadlineMs` to replace AI_TIMEOUT_MS /
 * AI_CHAIN_DEADLINE_MS for that call only (each capped at 120 s).
 *
 * @param {{task: "explain"|"translate"|"listen", system: string, userMessage: string, model?: string, maxTokens?: number,
 *          timeoutMs?: number, deadlineMs?: number,
 *          validate?: (text: string) => ({valid: boolean, reason?: string, text?: string})}} params
 * @returns {Promise<{text: string, provider: string, model: string, tokensUsed: number, latencyMs: number}>}
 * @throws {ProviderError}
 */
export async function runChain({ task, system, userMessage, model, maxTokens, validate, timeoutMs, deadlineMs }) {
  const chain = resolveChain();
  if (chain.length === 0) {
    void logger.error("ai", "No AI providers configured", { chain: chainNames().join(",") });
    throw new ProviderError(ErrorKind.INFRASTRUCTURE, "chain", new Error("no providers configured"));
  }
  if (budgetSpent()) {
    void logger.error("ai", "Daily AI token budget exhausted", { budget: dailyTokenBudget(), used: tokenBudget.used });
    throw new ProviderError(ErrorKind.INFRASTRUCTURE, "chain", new Error("daily token budget exhausted"));
  }

  const started = Date.now();
  const cap = (ms, fallback) => (Number.isFinite(ms) && ms >= 1000 ? Math.min(ms, 120_000) : fallback);
  const deadline = started + cap(deadlineMs, chainDeadlineMs());
  const perAttemptMs = cap(timeoutMs, providerTimeoutMs());
  let lastError = null;
  const attempts = [];

  for (const [index, provider] of chain.entries()) {
    const selected = modelFor(provider, task, model);
    const remaining = deadline - Date.now();
    if (remaining < MIN_ATTEMPT_MS) {
      for (const skipped of chain.slice(index)) {
        void recordAiCall({ task, provider: skipped.name, model: modelFor(skipped, task, model), status: "skipped", latencyMs: 0, detail: "chain deadline reached" });
        attempts.push(`${skipped.name}: skipped (chain deadline)`);
      }
      break;
    }

    const attemptStart = Date.now();
    try {
      const result = await attempt(provider, { system, userMessage, model: selected, maxTokens }, Math.min(perAttemptMs, remaining));
      const latencyMs = Date.now() - attemptStart;
      const tokens = result.tokensUsed || 0;
      const usage = { tokens, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
      spendTokens(tokens);

      let text = result.text;
      // An answer cut off at maxTokens ends mid-sentence: show it up to its last whole sentence.
      const truncated = result.truncated === true;
      if (truncated) {
        text = trimToLastSentence(text);
        void logger.warn("ai", "AI output hit the output-token limit", { task, provider: provider.name, maxTokens });
      }
      if (validate) {
        const check = validate(text);
        if (!check.valid) {
          void recordAiCall({ task, provider: provider.name, model: result.model, status: "invalid_output", ...usage, latencyMs, detail: check.reason });
          void logger.warn("ai", "AI output failed validation", { task, provider: provider.name, reason: check.reason });
          noteValidationFailure(task, provider.name);
          throw new ProviderError(ErrorKind.INVALID_OUTPUT, provider.name, new Error(check.reason || "invalid output"));
        }
        if (typeof check.text === "string") text = check.text;
      }

      void recordAiCall({ task, provider: provider.name, model: result.model, status: "ok", ...usage, latencyMs, detail: truncated ? "truncated at max tokens" : null });
      return { text, provider: provider.name, model: result.model || selected, tokensUsed: tokens, latencyMs: Date.now() - started };
    } catch (raw) {
      if (raw instanceof ProviderError && raw.kind === ErrorKind.INVALID_OUTPUT) throw raw;

      // Anything an adapter failed to classify is treated as infrastructure (fail over).
      const err = raw instanceof ProviderError ? raw : new ProviderError(ErrorKind.INFRASTRUCTURE, provider.name, raw);
      lastError = err;
      const detail = errorSummary(err);
      void recordAiCall({ task, provider: provider.name, model: selected, status: STATUS[err.kind], latencyMs: Date.now() - attemptStart, detail });

      if (err.kind === ErrorKind.REFUSAL) {
        void logger.warn("ai", "AI content refusal — chain stopped", { task, provider: provider.name, detail });
        throw err;
      }
      attempts.push(`${provider.name}: ${detail}`);
      void logger.warn("ai", "AI provider infrastructure error — trying next", { task, provider: provider.name, detail });
    }
  }

  void logger.error("ai", "All AI providers failed", { task, chain: chain.map((p) => p.name).join(","), attempts, elapsedMs: Date.now() - started });
  throw lastError?.kind === ErrorKind.INFRASTRUCTURE
    ? lastError
    : new ProviderError(ErrorKind.INFRASTRUCTURE, "chain", new Error("all providers failed"));
}

/** Test seam: forget the validation-spike window and today's token spend. */
export function _resetChainState() {
  validationFailures = [];
  Object.assign(tokenBudget, { day: "", used: 0 });
}

/**
 * Chain status for health/diagnostics. Never exposes key values.
 * @returns {Array<{name: string, registered: boolean, configured: boolean, defaultModel: string|null}>}
 */
export function getChainStatus() {
  return chainNames().map((name) => {
    const provider = REGISTRY[name];
    const configured = provider ? provider.isConfigured() : false;
    return { name, registered: Boolean(provider), configured, defaultModel: configured ? provider.defaultModel() : null };
  });
}
