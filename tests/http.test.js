import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/logger.js", () => ({ logger: { warn: vi.fn(), error: vi.fn(async () => {}), critical: vi.fn() } }));

const { parseJsonBody, jsonError, badRequest, requireString, rateLimited, clientIp, withErrorHandling, stripControlChars, hasNul } =
  await import("@/lib/http.js");
const { logger } = await import("@/lib/logger.js");

const req = (body, headers = { "content-type": "application/json" }) =>
  new Request("http://localhost/api/x", { method: "POST", headers, body });

describe("parseJsonBody", () => {
  it("accepts a JSON object", async () => {
    expect(await parseJsonBody(req('{"a":1}'))).toEqual({ ok: true, data: { a: 1 } });
    expect(await parseJsonBody(req('{"a":1}', { "content-type": "application/json; charset=utf-8" }))).toEqual({ ok: true, data: { a: 1 } });
  });
  it("[SEC-9] refuses a non-JSON content type (a cross-site text/plain form)", async () => {
    expect(await parseJsonBody(req('{"a":1}', { "content-type": "text/plain" }))).toEqual({ ok: false });
    expect(await parseJsonBody(req('{"a":1}', { "content-type": "application/x-www-form-urlencoded" }))).toEqual({ ok: false });
  });
  it("[QA-2] strips control characters from every string but keeps NUL for field checks", async () => {
    const parsed = await parseJsonBody(req('{"a":"x\\u0007y\\r\\nz","b":["\\u0000"],"c":{"d":"\\t\\u001b"}}'));
    expect(parsed).toEqual({ ok: true, data: { a: "xy\nz", b: ["\u0000"], c: { d: "\t" } } });
  });
  it.each([["malformed", "{nope"], ["empty", ""], ["null", "null"], ["array", "[1]"], ["number", "42"], ["string", '"x"']])(
    "rejects %s bodies without throwing",
    async (_, body) => {
      expect(await parseJsonBody(req(body))).toEqual({ ok: false });
    }
  );
});

describe("error responses", () => {
  it("jsonError merges extra and drops undefined", async () => {
    const res = jsonError(418, "teapot", "Short and stout.", { field: "lid", retryAfter: undefined });
    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({ error: "teapot", message: "Short and stout.", field: "lid" });
  });
  it("badRequest is 400 invalid_input with field", async () => {
    const res = badRequest("Add an @.", "email");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_input", message: "Add an @.", field: "email" });
  });
  it("rateLimited sets Retry-After and names the wait", async () => {
    const res = rateLimited(7.2);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("8");
    expect(await res.json()).toEqual({
      error: "rate_limited",
      message: "You're going a bit fast. Try again in 8 seconds.",
      retryAfter: 8,
    });
  });
});

describe("requireString", () => {
  it("trims and bounds", () => {
    expect(requireString("  hi  ", { maxLength: 5 })).toBe("hi");
    expect(requireString("toolong", { maxLength: 3 })).toBeNull();
    expect(requireString("   ", { maxLength: 3 })).toBeNull();
    expect(requireString("ab", { maxLength: 9, minLength: 3 })).toBeNull();
  });
  it.each([[42], [null], [undefined], [{}], [["a"]], [true]])("rejects non-string %p", (v) => {
    expect(requireString(v, { maxLength: 10 })).toBeNull();
  });
  it("[QA-2] refuses NUL and strips other control characters", () => {
    expect(requireString("a\u0000b", { maxLength: 10 })).toBeNull();
    expect(requireString(" a\u0007b ", { maxLength: 10 })).toBe("ab");
    expect(hasNul("x\u0000")).toBe(true);
    expect(stripControlChars("a\u0001\u007f\tb\r\nc")).toBe("a\tb\nc");
  });
});

describe("clientIp", () => {
  const ipReq = (headers) => req(null, headers);
  let saved;
  beforeEach(() => {
    saved = process.env.TRUSTED_IP_HEADER;
    delete process.env.TRUSTED_IP_HEADER;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.TRUSTED_IP_HEADER;
    else process.env.TRUSTED_IP_HEADER = saved;
  });

  it("[SEC-1] prefers x-real-ip, which the edge sets", () => {
    expect(clientIp(ipReq({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "6.6.6.6, 203.0.113.9" }))).toBe("203.0.113.9");
  });
  it("[SEC-1][QA-1] uses the RIGHTMOST forwarded hop, so a spoofed leftmost value is ignored", () => {
    expect(clientIp(ipReq({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" }))).toBe("10.0.0.1");
    const keys = new Set(Array.from({ length: 7 }, (_, i) => clientIp(ipReq({ "x-forwarded-for": `10.9.9.${i}, 198.51.100.7` }))));
    expect([...keys]).toEqual(["198.51.100.7"]);
  });
  it("TRUSTED_IP_HEADER=x-forwarded-for skips x-real-ip", () => {
    process.env.TRUSTED_IP_HEADER = "x-forwarded-for";
    expect(clientIp(ipReq({ "x-real-ip": "1.1.1.1", "x-forwarded-for": "9.9.9.9, 8.8.8.8" }))).toBe("8.8.8.8");
  });
  it("falls back to unknown", () => {
    expect(clientIp(req(null))).toBe("unknown");
  });
});

describe("withErrorHandling", () => {
  beforeEach(() => vi.mocked(logger.error).mockClear());

  it("passes through a normal response", async () => {
    const handler = withErrorHandling(async () => Response.json({ ok: true }), { source: "api" });
    expect((await handler(req("{}"))).status).toBe(200);
  });

  it("turns a throw into a logged 500 with the standard shape", async () => {
    const handler = withErrorHandling(async () => {
      throw new Error("boom at /secret");
    }, { source: "auth" });
    const res = await handler(req("{}"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "server_error",
      message: "Something went wrong on our side. Please try again.",
    });
    expect(logger.error).toHaveBeenCalledWith("auth", "Unhandled route error", expect.objectContaining({ detail: "boom at /secret", path: "/api/x" }));
  });

  it("[SEC-9] rejects a cross-site state-changing request before the handler runs", async () => {
    const handler = vi.fn(async () => Response.json({ ok: true }));
    const wrapped = withErrorHandling(handler);
    const res = await wrapped(req("{}", { "content-type": "application/json", "sec-fetch-site": "cross-site" }));
    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    expect((await wrapped(req("{}", { "content-type": "application/json", "sec-fetch-site": "same-origin" }))).status).toBe(200);
  });

  it("[QA-2] maps a Postgres NUL-byte rejection to 400, not 500", async () => {
    const handler = withErrorHandling(async () => {
      throw Object.assign(new Error('invalid byte sequence for encoding "UTF8": 0x00'), { code: "22021" });
    });
    const res = await handler(req("{}"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_input");
  });
});
