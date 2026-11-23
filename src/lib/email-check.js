/**
 * Email address checks shared by the sign-in page and /api/auth/request-link.
 * Pure and isomorphic (no Node or browser APIs) so both sides give the same
 * answer. A magic link sent to a typo'd address produces a success screen and
 * silence forever, so every message names the fix, and likely typos on
 * well-known domains get a "did you mean" suggestion before sending.
 */

/** RFC 5321 maximum (spec 14.3). */
export const EMAIL_MAX_LENGTH = 254;

const COMMON_DOMAINS = [
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "yahoo.com", "icloud.com", "me.com", "mac.com", "proton.me", "protonmail.com",
  "aol.com", "qq.com", "163.com", "126.com", "foxmail.com", "sina.com", "yeah.net",
];

// Typos too far (or too ambiguous) for edit distance alone.
const KNOWN_TYPOS = {
  "gmail.co": "gmail.com",
  "gmail.cm": "gmail.com",
  "gmail.om": "gmail.com",
  "gmail.con": "gmail.com",
  "gmail.cmo": "gmail.com",
  "gmail.comm": "gmail.com",
  "gmal.com": "gmail.com",
  "gmial.com": "gmail.com",
  "gamil.com": "gmail.com",
  "gnail.com": "gmail.com",
  "gmaill.com": "gmail.com",
  "hotmial.com": "hotmail.com",
  "hotmal.com": "hotmail.com",
  "hotmail.co": "hotmail.com",
  "hotmail.con": "hotmail.com",
  "outlok.com": "outlook.com",
  "outloo.com": "outlook.com",
  "outlook.co": "outlook.com",
  "yahooo.com": "yahoo.com",
  "yaho.com": "yahoo.com",
  "yahoo.co": "yahoo.com",
  "yahoo.con": "yahoo.com",
  "iclod.com": "icloud.com",
  "icloud.co": "icloud.com",
  "icoud.com": "icloud.com",
  "qq.co": "qq.com",
  "qq.con": "qq.com",
};

// Deliberately permissive: rejecting a valid-but-unusual address is worse than
// accepting a bad one.
const SHAPE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/**
 * Validate the shape of an address and say how to fix it.
 * @param {unknown} value
 * @returns {{ok:true, email:string} | {ok:false, message:string}} email is trimmed and lowercased
 */
export function validateEmail(value) {
  if (typeof value !== "string") return { ok: false, message: "Enter your email address." };
  const email = value.trim();

  if (email.length === 0) return { ok: false, message: "Enter your email address." };
  if (email.length > EMAIL_MAX_LENGTH) {
    return { ok: false, message: `That address is too long — it must be ${EMAIL_MAX_LENGTH} characters or fewer.` };
  }
  if (/\s/.test(email)) return { ok: false, message: "Remove the space from your email address." };
  if (!email.includes("@")) {
    return { ok: false, message: "Add an @ — for example you@example.com" };
  }
  if ((email.match(/@/g) || []).length > 1) {
    return { ok: false, message: "Use only one @ in your email address." };
  }

  const [local, domain] = email.split("@");
  if (!local) return { ok: false, message: "Add the part before the @, like you@example.com" };
  if (!domain) return { ok: false, message: "Add the part after the @, like gmail.com" };
  if (!domain.includes(".")) {
    return { ok: false, message: "The part after @ needs a dot, like gmail.com" };
  }
  if (domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) {
    return { ok: false, message: "Check the part after @ — it has a misplaced dot." };
  }
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) {
    return { ok: false, message: "Check the part before @ — it has a misplaced dot." };
  }
  if (!SHAPE.test(email)) {
    return { ok: false, message: "That doesn't look like an email address — check it for typos." };
  }
  return { ok: true, email: email.toLowerCase() };
}

function editDistance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = above;
    }
  }
  return prev[b.length];
}

/**
 * A corrected address for a near-miss on a well-known domain ("gmial.com"),
 * or null. Unfamiliar domains are never "corrected" — a wrong suggestion is
 * worse than none.
 * @param {unknown} value
 * @returns {string|null}
 */
export function suggestEmailCorrection(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at <= 0) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!domain || COMMON_DOMAINS.includes(domain)) return null;

  if (KNOWN_TYPOS[domain]) return `${local}@${KNOWN_TYPOS[domain]}`;

  let best = null;
  for (const candidate of COMMON_DOMAINS) {
    const distance = editDistance(domain, candidate);
    const closeEnough = candidate.length > 8 ? distance <= 2 : distance === 1;
    if (distance > 0 && closeEnough && (!best || distance < best.distance)) {
      best = { candidate, distance };
    }
  }
  return best ? `${local}@${best.candidate}` : null;
}
