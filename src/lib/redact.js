/**
 * Redaction for anything persisted to logs. Logs outlive requests and are read
 * by people, so credential-shaped strings and email local parts never land there.
 */

const MAX_LENGTH = 2000;

const PATTERNS = [
  // Connection strings, with or without credentials
  [/\b(?:postgres(?:ql)?|mysql|redis|rediss|mongodb(?:\+srv)?|amqp|smtp|smtps):\/\/[^\s"'<>]+/gi, "[connection-string]"],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'/@<>]+:[^\s"'@<>]+@[^\s"'<>]+/gi, "[connection-string]"],
  // Provider API keys
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, "[api-key]"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/g, "[api-key]"],
  [/\bAIza[A-Za-z0-9_-]{20,}/g, "[api-key]"],
  [/\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/g, "[api-key]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]"],
  // JWTs
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, "[jwt]"],
  // Long hex runs: magic-link tokens are 64 hex chars
  [/\b[a-f0-9]{32,}\b/gi, "[token]"],
  // token=... in query strings, whatever its shape
  [/([?&](?:token|key|api_key|apikey|password|secret)=)[^&\s"']+/gi, "$1[redacted]"],
];

const EMAIL = /\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;

/**
 * Mask every email in a string: alice@example.com -> a***@example.com.
 * The domain is kept because it helps when debugging delivery.
 * @param {unknown} email
 * @returns {string}
 */
export function maskEmail(email) {
  if (email === null || email === undefined) return "";
  return String(email).replace(EMAIL, (_, first, domain) => `${first}***@${domain}`);
}

function safeStringify(value) {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    const out = JSON.stringify(value, (_, v) => (v instanceof Error ? `${v.name}: ${v.message}` : v));
    return out === undefined ? String(value) : out;
  } catch {
    return "[unserializable]";
  }
}

/**
 * Redact credentials and emails, then cap to 2000 chars.
 * @param {unknown} value string or any serialisable value
 * @returns {string} "" for null/undefined
 */
export function redact(value) {
  if (value === null || value === undefined) return "";
  let out = typeof value === "string" ? value : safeStringify(value);
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  out = maskEmail(out);
  return out.length > MAX_LENGTH ? `${out.slice(0, MAX_LENGTH)}... [truncated]` : out;
}
