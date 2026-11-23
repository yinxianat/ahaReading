/**
 * Outbound email (magic links, admin alerts).
 *
 * Guarantees callers depend on:
 *   1. Nothing here throws — every failure is a return value with a reason
 *      code and the remedy it implies (LESSONS 61).
 *   2. This module is a leaf: it never imports the logger or alerts. The alert
 *      path is logger -> alerts -> mailer, so logging from here would recurse
 *      on an SMTP failure. Callers log the returned failure themselves.
 */
import nodemailer from "nodemailer";
import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";
import { isProduction } from "./env.js";

// Generous: nothing waits on these, because sends happen after the HTTP
// response. An ETIMEDOUT here is our own budget expiring, not a network verdict.
const TIMEOUTS = {
  connectionTimeout: 30_000,
  greetingTimeout: 30_000,
  socketTimeout: 45_000,
};

// Per-address slice of the connect budget, so one silently dropped path cannot
// spend the whole budget before a working address is tried (LESSONS 58).
const PER_ADDRESS_CONNECT_MS = 10_000;

/** @returns {string} SMTP_USER, else SMTP_USERNAME, else "" — both pairs are standard. */
export function smtpUser() {
  return process.env.SMTP_USER || process.env.SMTP_USERNAME || "";
}

/** @returns {string} SMTP_PASS, else SMTP_PASSWORD, else "". */
export function smtpPass() {
  return process.env.SMTP_PASS || process.env.SMTP_PASSWORD || "";
}

/**
 * Configuration state of SMTP. A host with no credentials is reported apart
 * from no host, because it is worse: sends are attempted and rejected.
 * @returns {"configured"|"not_configured"|"credentials_incomplete"}
 */
export function smtpState() {
  if (!process.env.SMTP_HOST) return "not_configured";
  if (!smtpUser() || !smtpPass()) return "credentials_incomplete";
  return "configured";
}

/** @returns {boolean} host, user and password are all set. */
export function smtpConfigured() {
  return smtpState() === "configured";
}

function smtpPort() {
  const port = parseInt(process.env.SMTP_PORT ?? "", 10);
  return Number.isFinite(port) && port > 0 ? port : 587;
}

function fromAddress() {
  return process.env.SMTP_FROM || smtpUser();
}

/**
 * Reason codes, each naming the single action it implies. Order matters: when
 * several markers appear at once (a per-address list), the most actionable wins.
 */
export const FAILURE_REASONS = {
  smtp_not_configured: "Set SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASS (or SMTP_USERNAME/SMTP_PASSWORD) on the deployed service.",
  smtp_credentials_incomplete: "SMTP_HOST is set but the user or password is missing. Set SMTP_USER/SMTP_PASS (or SMTP_USERNAME/SMTP_PASSWORD).",
  smtp_auth_rejected: "The mail server rejected the credentials. For Gmail use a 16-character App Password and the full address as SMTP_USER.",
  smtp_host_not_found: "SMTP_HOST does not resolve. Check it for typos.",
  smtp_unreachable: "No session could be opened, so credentials were never tested. Check SMTP_HOST/SMTP_PORT on the deployed host, try the other port (587 STARTTLS / 465 TLS), and compare each address's error in the detail.",
  smtp_no_route: "No route to any resolved address. On Railway enable Settings -> Networking -> Outbound IPv6 for this service, then retry.",
  smtp_tls_failed: "TLS negotiation failed. Use port 465 for implicit TLS or 587 for STARTTLS, and check the host name matches the certificate.",
  smtp_sender_rejected: "The server refused the From address. SMTP_FROM must be an address the authenticated account may send as.",
  smtp_recipient_rejected: "The server refused the recipient address. Ask the user to check the address they typed.",
  smtp_failed: "Unclassified SMTP failure. Read the server response in the detail.",
};

/**
 * Map a nodemailer/socket error to a reason code and remedy.
 * @param {unknown} err
 * @returns {{reason:string, hint:string}}
 */
export function classifyMailError(err) {
  const code = err?.code || "";
  const responseCode = err?.responseCode || "";
  const text = `${code} ${responseCode} ${err?.message || String(err)}`;
  const pick = (reason) => ({ reason, hint: FAILURE_REASONS[reason] });

  if (/EAUTH|\b535\b|\b534\b|Username and Password not accepted|BadCredentials|Invalid login/i.test(text)) return pick("smtp_auth_rejected");
  if (/ENOTFOUND|EAI_AGAIN|EAI_NONAME|getaddrinfo/i.test(text)) return pick("smtp_host_not_found");
  if (/ECONNREFUSED|ECONNECTION|ETIMEDOUT|ESOCKET|ECONNRESET|Greeting never received/i.test(text)) return pick("smtp_unreachable");
  if (/ENETUNREACH|EHOSTUNREACH/i.test(text)) return pick("smtp_no_route");
  if (/ETLS|wrong version number|certificate|SSL routines/i.test(text)) return pick("smtp_tls_failed");
  if (/\b55[0-4]\b/.test(text) && /recipient|RCPT|mailbox/i.test(text)) return pick("smtp_recipient_rejected");
  if (/EENVELOPE|\b55[03]\b|Sender address rejected|not owned by user/i.test(text)) return pick("smtp_sender_rejected");
  return pick("smtp_failed");
}

function connectTo(address, family, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: address, port, family });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(Object.assign(new Error(`connect timeout after ${timeoutMs}ms`), { code: "ETIMEDOUT" }));
    }, timeoutMs);
    sock.once("connect", () => {
      clearTimeout(timer);
      resolve(sock);
    });
    sock.once("error", (err) => {
      clearTimeout(timer);
      sock.destroy();
      reject(err);
    });
  });
}

// getaddrinfo (dns.lookup) walked in resolver order, never reordered by family;
// every attempt is named in the error so the log line alone is diagnostic.
async function openSmtpSocket(host, port, budgetMs) {
  const deadline = Date.now() + budgetMs;
  // getaddrinfo ignores our budget, so stop waiting for it once the budget is spent.
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`DNS lookup for ${host} timed out after ${budgetMs}ms`), { code: "EAI_AGAIN" })), budgetMs);
  });
  const results = await Promise.race([dnsLookup(host, { all: true }), expired]).finally(() => clearTimeout(timer));
  const failures = [];
  for (const { address, family } of results) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      failures.push(`${address} -> skipped (budget spent)`);
      continue;
    }
    try {
      return await connectTo(address, family, port, Math.min(PER_ADDRESS_CONNECT_MS, remaining));
    } catch (err) {
      failures.push(`${address} -> ${err.code || err.message}`);
    }
  }
  if (failures.length === 0) throw Object.assign(new Error(`getaddrinfo returned no addresses for ${host}`), { code: "ENOTFOUND" });
  throw new Error(`No address for ${host} accepted a connection on port ${port}: ${failures.join("; ")}`);
}

function buildTransport(socket) {
  const port = smtpPort();
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: smtpUser(), pass: smtpPass() },
    connection: socket,
    ...TIMEOUTS,
  });
}

// Last delivery failure, so health and sign-in can stop promising an inbox
// we know is unreachable. Global state only — never per-address outcomes.
const DEGRADED_WINDOW_MS = 10 * 60 * 1000;
let lastFailure = null;

/**
 * @returns {{degraded:boolean, reason?:string}} degraded when production lacks SMTP
 *   or a send failed in the last 10 minutes
 */
export function deliveryHealth() {
  const state = smtpState();
  if (state !== "configured") {
    return isProduction() ? { degraded: true, reason: `smtp_${state}` } : { degraded: false };
  }
  if (!lastFailure || Date.now() - lastFailure.at > DEGRADED_WINDOW_MS) return { degraded: false };
  return { degraded: true, reason: lastFailure.reason };
}

function failure(reason, err, elapsedMs) {
  const raw = err ? `${err.code || ""} ${err.message || String(err)}`.trim() : "";
  return {
    delivered: false,
    error: reason,
    hint: FAILURE_REASONS[reason],
    detail: raw ? `${FAILURE_REASONS[reason]} Server said: ${raw}` : FAILURE_REASONS[reason],
    elapsedMs,
  };
}

/**
 * Send one message. Never throws.
 *
 * Without SMTP outside production the message is printed to the server
 * console (the local-development sign-in path). In production it is never
 * printed, because it carries a bearer credential.
 *
 * @param {{to:string, subject:string, text:string, html?:string}} message
 * @returns {Promise<{delivered:boolean, loggedToConsole?:boolean, error?:string, hint?:string, detail?:string, elapsedMs?:number}>}
 */
export async function sendMail({ to, subject, text, html }) {
  const started = Date.now();
  try {
    const state = smtpState();
    if (state !== "configured") {
      if (!isProduction() && state === "not_configured") {
        console.log(`\n--- email (SMTP not configured) to ${to} ---\n${subject}\n\n${text}\n---\n`);
        return { delivered: false, loggedToConsole: true };
      }
      return failure(state === "not_configured" ? "smtp_not_configured" : "smtp_credentials_incomplete", null, 0);
    }

    const socket = await openSmtpSocket(process.env.SMTP_HOST, smtpPort(), TIMEOUTS.connectionTimeout);
    await buildTransport(socket).sendMail({ from: fromAddress(), to, subject, text, html });
    lastFailure = null;
    return { delivered: true, elapsedMs: Date.now() - started };
  } catch (err) {
    const { reason } = classifyMailError(err);
    lastFailure = { reason, at: Date.now() };
    return failure(reason, err, Date.now() - started);
  }
}

/**
 * Connect and authenticate without sending, for the admin Infrastructure tab.
 * Elapsed time distinguishes a blocked port (full timeout) from refused
 * credentials (fast). Never throws.
 * @returns {Promise<{ok:boolean, error?:string, hint?:string, detail?:string, elapsedMs:number, host?:string, port:number}>}
 */
export async function verifyTransport() {
  const started = Date.now();
  const port = smtpPort();
  const state = smtpState();
  if (state !== "configured") {
    const reason = state === "not_configured" ? "smtp_not_configured" : "smtp_credentials_incomplete";
    return { ok: false, error: reason, hint: FAILURE_REASONS[reason], elapsedMs: 0, port };
  }
  const host = process.env.SMTP_HOST;
  try {
    const socket = await openSmtpSocket(host, port, TIMEOUTS.connectionTimeout);
    await buildTransport(socket).verify();
    return { ok: true, host, port, elapsedMs: Date.now() - started };
  } catch (err) {
    const { reason, hint } = classifyMailError(err);
    return {
      ok: false,
      error: reason,
      hint,
      detail: `${err?.code || ""} ${err?.message || String(err)}`.trim(),
      host,
      port,
      elapsedMs: Date.now() - started,
    };
  }
}

/** Test seam. */
export function _resetDeliveryHealth() {
  lastFailure = null;
}
