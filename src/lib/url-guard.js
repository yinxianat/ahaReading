import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

/**
 * SSRF guard for server-side article import.
 * - http/https only, ports 80/443 only, no credentials in the URL
 * - every resolved address must be public (one private record rejects the host)
 * - the socket connects to the address we vetted (custom `lookup`), so a DNS answer that
 *   changes between check and connect (rebinding) cannot reach an internal host
 * - redirects followed manually (max 3), each hop re-checked
 * - 5 s overall timeout, 2 MB body cap, text/html or text/plain only
 */
export const MAX_REDIRECTS = 3;
export const FETCH_TIMEOUT_MS = 5000;
export const MAX_BYTES = 2 * 1024 * 1024;
// getaddrinfo runs on the libuv threadpool and ignores our deadline; we stop waiting after this.
export const DNS_TIMEOUT_MS = 2000;
const ALLOWED_TYPES = ["text/html", "text/plain", "application/xhtml+xml"];

/** Error with a user-facing code: url_blocked | url_unreachable | url_not_readable. */
export class UrlGuardError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "UrlGuardError";
    this.code = code;
    this.detail = detail;
  }
}

const BLOCKED_MSG = "That address can't be imported. Use a public web page link that starts with http:// or https://.";

// ─── Address classification ─────────────────────────

function ipv4ToInt(ip) {
  const parts = ip.split(".").map(Number);
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

const V4_BLOCKS = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local incl. cloud metadata 169.254.169.254
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
].map(([base, bits]) => ({ base: ipv4ToInt(base), mask: bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0 }));

function isBlockedV4(ip) {
  const n = ipv4ToInt(ip);
  return V4_BLOCKS.some(({ base, mask }) => ((n & mask) >>> 0) === ((base & mask) >>> 0));
}

/** Parse an IPv6 literal into 16 bytes, or null. Handles "::" and a trailing dotted quad. */
function parseV6(ip) {
  let addr = ip.toLowerCase().replace(/%.*$/, "");
  if (addr.includes(".")) {
    // Rewrite a trailing dotted quad (::ffff:127.0.0.1) as two hex groups.
    const lastColon = addr.lastIndexOf(":");
    const v4 = addr.slice(lastColon + 1);
    if (!net.isIPv4(v4)) return null;
    const n = ipv4ToInt(v4);
    addr = `${addr.slice(0, lastColon + 1)}${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const toGroups = (s) => (s ? s.split(":") : []);
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  let groups = head;
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...Array(fill).fill("0"), ...rest];
  }
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  const bytes = [];
  for (const g of groups) {
    const w = parseInt(g, 16);
    bytes.push((w >> 8) & 0xff, w & 0xff);
  }
  return bytes;
}

function bytesToV4(bytes, offset) {
  return `${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`;
}

function isBlockedV6(ip) {
  const b = parseV6(ip);
  if (!b) return true; // unparseable → refuse
  const allZeroUpTo = (n) => b.slice(0, n).every((x) => x === 0);
  if (allZeroUpTo(15) && (b[15] === 0 || b[15] === 1)) return true; // :: and ::1
  if (allZeroUpTo(10) && b[10] === 0xff && b[11] === 0xff) return isBlockedV4(bytesToV4(b, 12)); // ::ffff:a.b.c.d
  if (allZeroUpTo(8) && b[8] === 0xff && b[9] === 0xff && b[10] === 0 && b[11] === 0) return isBlockedV4(bytesToV4(b, 12)); // ::ffff:0:a.b.c.d (SIIT)
  if (allZeroUpTo(12)) return true; // deprecated IPv4-compatible ::a.b.c.d
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return true; // 64:ff9b::/96 NAT64 → could reach internal v4
  if (b[0] === 0x01 && b[1] === 0x00 && b.slice(2, 8).every((x) => x === 0)) return true; // 100::/64 discard-only
  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true; // fec0::/10 site-local (deprecated)
  if (b[0] === 0xff) return true; // multicast
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // 2001:db8::/32 documentation
  if (b[0] === 0x20 && b[1] === 0x02) return isBlockedV4(bytesToV4(b, 2)); // 6to4 embeds a v4
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return true; // Teredo
  return false;
}

/**
 * True if `ip` is not a public unicast address (private, loopback, link-local, metadata,
 * reserved, multicast, documentation, IPv4-mapped/embedded private, or unparseable).
 * @param {string} ip
 * @returns {boolean}
 */
export function isPrivateAddress(ip) {
  if (typeof ip !== "string") return true;
  const family = net.isIP(ip.replace(/%.*$/, ""));
  if (family === 4) return isBlockedV4(ip);
  if (family === 6) return isBlockedV6(ip);
  return true;
}

// ─── URL + DNS checks ───────────────────────────────

/**
 * Parse and statically check a URL (scheme, port, credentials, literal IPs).
 * @param {string} raw
 * @returns {URL}
 * @throws {UrlGuardError}
 */
export function parsePublicUrl(raw) {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 2000) {
    throw new UrlGuardError("url_blocked", "Paste a full link that starts with http:// or https:// (up to 2,000 characters).");
  }
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UrlGuardError("url_blocked", "That doesn't look like a web link. Paste a full link that starts with http:// or https://.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UrlGuardError("url_blocked", BLOCKED_MSG, "scheme");
  if (url.username || url.password) throw new UrlGuardError("url_blocked", BLOCKED_MSG, "credentials");
  if (url.port && url.port !== "80" && url.port !== "443") throw new UrlGuardError("url_blocked", BLOCKED_MSG, "port");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new UrlGuardError("url_blocked", BLOCKED_MSG, "host");
  if (net.isIP(host) && isPrivateAddress(host)) throw new UrlGuardError("url_blocked", BLOCKED_MSG, "private_literal");
  url.hash = "";
  return url;
}

/**
 * Resolve a hostname and return its addresses only if every one is public.
 * @param {string} host
 * @param {{lookup?: Function, timeoutMs?: number}} [options] injectable resolver with dns.promises.lookup's
 *   shape; the lookup is abandoned after `timeoutMs` (a slow authoritative server must not hold the request)
 * @returns {Promise<Array<{address: string, family: number}>>}
 * @throws {UrlGuardError}
 */
export async function resolvePublicAddresses(host, { lookup = dns.promises.lookup, timeoutMs = DNS_TIMEOUT_MS } = {}) {
  const bare = host.replace(/^\[|\]$/g, "");
  const family = net.isIP(bare);
  if (family) {
    if (isPrivateAddress(bare)) throw new UrlGuardError("url_blocked", BLOCKED_MSG, "private_literal");
    return [{ address: bare, family }];
  }
  let records;
  let timer;
  try {
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("dns timeout"), { code: "ETIMEDOUT" })), Math.max(1, timeoutMs));
    });
    records = await Promise.race([lookup(bare, { all: true, verbatim: true }), expired]);
  } catch (err) {
    if (err?.code === "ETIMEDOUT") {
      throw new UrlGuardError("url_unreachable", "That website took too long to respond. Try again, or paste the text instead.", "dns_timeout");
    }
    throw new UrlGuardError("url_unreachable", "We couldn't find that website. Check the link for typos and try again.", err?.code);
  } finally {
    clearTimeout(timer);
  }
  if (!Array.isArray(records) || records.length === 0) {
    throw new UrlGuardError("url_unreachable", "We couldn't find that website. Check the link for typos and try again.", "no_records");
  }
  if (records.some((r) => isPrivateAddress(r.address))) throw new UrlGuardError("url_blocked", BLOCKED_MSG, "private_dns");
  return records.map((r) => ({ address: r.address, family: r.family || net.isIP(r.address) }));
}

/**
 * Check a URL end to end (static checks + DNS) without fetching it.
 * @param {string} raw
 * @param {{lookup?: Function, timeoutMs?: number}} [options]
 * @returns {Promise<{url: URL, addresses: Array<{address: string, family: number}>}>}
 */
export async function assertPublicUrl(raw, options) {
  const url = parsePublicUrl(raw);
  const addresses = await resolvePublicAddresses(url.hostname, options);
  return { url, addresses };
}

/**
 * Build a socket `lookup` that answers only with pre-vetted addresses, so the connection
 * cannot be pointed elsewhere after the check.
 * @param {Array<{address: string, family: number}>} addresses
 */
export function pinnedLookup(addresses) {
  return (hostname, options, callback) => {
    const cb = typeof options === "function" ? options : callback;
    const opts = typeof options === "object" && options ? options : {};
    const usable = addresses.filter((a) => !isPrivateAddress(a.address) && (!opts.family || opts.family === a.family));
    if (usable.length === 0) {
      cb(Object.assign(new Error("no vetted address"), { code: "ENOTFOUND" }));
      return;
    }
    if (opts.all) cb(null, usable);
    else cb(null, usable[0].address, usable[0].family);
  };
}

// ─── Fetch ──────────────────────────────────────────

function requestOnce(url, addresses, { deadline, maxBytes }) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const remaining = Math.max(1, deadline - Date.now());
    const req = lib.request(
      url,
      {
        method: "GET",
        lookup: pinnedLookup(addresses),
        headers: {
          "user-agent": "AhaReadingBot/1.0 (+reading import)",
          accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
          "accept-encoding": "identity",
        },
        timeout: remaining,
      },
      (res) => {
        const status = res.statusCode || 0;
        const headers = res.headers;
        if (status >= 300 && status < 400) {
          res.resume();
          resolve({ status, headers, body: null });
          return;
        }
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy(new UrlGuardError("url_not_readable", "That page is too large to import (over 2 MB). Try pasting the text you want to read instead.", "too_large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ status, headers, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      }
    );
    const timer = setTimeout(() => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })), remaining);
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    req.on("error", (err) => reject(err));
    req.on("close", () => clearTimeout(timer));
    req.end();
  });
}

function decodeBody(buffer, contentType) {
  const charset = (/charset=["']?([\w-]+)/i.exec(contentType || "") || [])[1];
  try {
    return new TextDecoder(charset || "utf-8").decode(buffer);
  } catch {
    return new TextDecoder("utf-8").decode(buffer);
  }
}

/**
 * Fetch a public URL through the SSRF guard.
 * @param {string} raw
 * @param {{lookup?: Function, transport?: Function, timeoutMs?: number, maxBytes?: number}} [options]
 *   `transport(url, addresses, {deadline, maxBytes})` is injectable for tests.
 * @returns {Promise<{finalUrl: string, contentType: string, text: string}>}
 * @throws {UrlGuardError}
 */
export async function safeFetch(raw, { lookup, transport = requestOnce, timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_BYTES } = {}) {
  const deadline = Date.now() + timeoutMs;
  let current = raw;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new UrlGuardError("url_unreachable", "That website took too long to respond. Try again, or paste the text instead.", "timeout");
    const { url, addresses } = await assertPublicUrl(current, { lookup, timeoutMs: Math.min(DNS_TIMEOUT_MS, remaining) });
    if (Date.now() >= deadline) throw new UrlGuardError("url_unreachable", "That website took too long to respond. Try again, or paste the text instead.", "timeout");

    let res;
    try {
      res = await transport(url, addresses, { deadline, maxBytes });
    } catch (err) {
      if (err instanceof UrlGuardError) throw err;
      const timedOut = err?.code === "ETIMEDOUT" || err?.code === "ESOCKETTIMEDOUT";
      throw new UrlGuardError(
        "url_unreachable",
        timedOut ? "That website took too long to respond. Try again, or paste the text instead." : "We couldn't reach that website. Check the link, or paste the text instead.",
        err?.code || err?.message
      );
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers?.location;
      if (!location) throw new UrlGuardError("url_unreachable", "That link redirects somewhere we can't follow. Paste the text instead.", "redirect_no_location");
      let next;
      try {
        next = new URL(location, url).href;
      } catch {
        throw new UrlGuardError("url_unreachable", "That link redirects somewhere we can't follow. Paste the text instead.", "redirect_bad_location");
      }
      current = next;
      continue;
    }

    if (res.status < 200 || res.status >= 300) {
      throw new UrlGuardError("url_unreachable", `That page answered with an error (HTTP ${res.status}). Check the link, or paste the text instead.`, `status_${res.status}`);
    }
    const contentType = String(res.headers?.["content-type"] || "").toLowerCase();
    if (!ALLOWED_TYPES.some((t) => contentType.startsWith(t))) {
      throw new UrlGuardError("url_not_readable", "That link isn't a readable web page (only HTML or plain-text pages can be imported). Paste the text instead.", contentType || "no_content_type");
    }
    return { finalUrl: url.href, contentType, text: decodeBody(res.body || Buffer.alloc(0), contentType) };
  }
  throw new UrlGuardError("url_unreachable", "That link redirects too many times. Open it in your browser and paste the final address or the text.", "too_many_redirects");
}
