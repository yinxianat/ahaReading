/**
 * What the secret guard blocks, shared by scripts/check-secrets.mjs and its test.
 * Patterns are assembled from pieces so this file does not match itself.
 */

// Paths that must never enter history, whatever their content.
export const FORBIDDEN_PATHS = [
  [/(^|\/)\.env$/, "env file"],
  [/(^|\/)\.env\.(?!example$)[^/]+$/, "env file"],
  [/^PLANS\//i, "internal PLANS folder"],
  [/\.(pem|key|p12|pfx)$/, "private key / certificate"],
];

// Credential shapes. Patterns are assembled so this file does not match itself.
const j = (...p) => p.join("");
export const SECRET_PATTERNS = [
  [new RegExp(j("sk-", "ant-", "[A-Za-z0-9_-]{20,}")), "Anthropic API key"],
  [new RegExp(j("\\bsk-", "(proj-)?", "[A-Za-z0-9]{32,}")), "OpenAI API key"],
  [new RegExp(j("AI", "za", "[0-9A-Za-z_-]{35}")), "Google API key"],
  [new RegExp(j("gh", "[pousr]_", "[A-Za-z0-9]{36}")), "GitHub token"],
  [new RegExp(j("-----BEGIN ", "[A-Z ]*PRIVATE KEY-----")), "private key"],
  [new RegExp(j("ey", "J[A-Za-z0-9_-]{10,}\\.ey", "J[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}")), "JWT"],
  [/postgres(ql)?:\/\/[^\s:@"'`]+:[^\s@"'`]{6,}@(?!localhost|127\.0\.0\.1|host)/, "database URL with password"],
  [/(JWT_SECRET|MAGIC_LINK_SECRET|SMTP_PASS(WORD)?)\s*=\s*["']?[A-Fa-f0-9]{32,}/, "hard-coded secret value"],
  [new RegExp(j("\\bre", "_[A-Za-z0-9]{20,}")), "Resend API key"],
  [new RegExp(j("\\bSG", "\\.[\\w-]{16,}\\.[\\w-]{16,}")), "SendGrid API key"],
  // KEY=value lines (env files, shell, CI YAML) that assign a literal to a credential-named variable.
  [new RegExp(j("^\\s*(export\\s+)?[A-Z0-9_]*(PASS(WORD)?|API_KEY|SECRET)", "\\s*=\\s*[\"']?(?!replace-|YOUR_|your-|\\$)[^\"'\\s$#]{12,}")), "credential assignment"],
];

// The template documents variable names with obvious placeholders only.
export const ASSIGNMENT_ALLOWED = new Set([".env.example"]);
