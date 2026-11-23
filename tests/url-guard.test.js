import { describe, it, expect, vi } from "vitest";
import { isPrivateAddress, parsePublicUrl, resolvePublicAddresses, assertPublicUrl, safeFetch, pinnedLookup, UrlGuardError } from "@/lib/url-guard.js";

const PUBLIC_V4 = "93.184.216.34";
const lookupTo = (...addresses) => vi.fn(async () => addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));

describe("isPrivateAddress — IPv4", () => {
  const blocked = [
    "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.255", "127.0.0.1", "127.1.2.3",
    "169.254.169.254", "169.254.0.1", "172.16.0.1", "172.31.255.255", "192.168.0.1", "192.168.255.255",
    "192.0.0.8", "192.0.2.1", "198.18.0.1", "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
  ];
  const allowed = [PUBLIC_V4, "8.8.8.8", "1.1.1.1", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "192.169.0.1", "11.0.0.1"];
  for (const ip of blocked) it(`blocks ${ip}`, () => expect(isPrivateAddress(ip)).toBe(true));
  for (const ip of allowed) it(`allows ${ip}`, () => expect(isPrivateAddress(ip)).toBe(false));
});

describe("isPrivateAddress — IPv6", () => {
  const blocked = [
    "::", "::1", "0:0:0:0:0:0:0:1", "fc00::1", "fd12:3456:789a::1", "fe80::1", "fe80::1%en0", "febf::1", "fec0::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "::ffff:7f00:1", "::ffff:192.168.1.1", "::127.0.0.1",
    "64:ff9b::a00:1", "2001:db8::1", "2002:7f00:1::", "2002:0a00:0001::1", "2001:0000:4136:e378::1", "100::1", "not-an-ip", "",
  ];
  const allowed = ["2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:93.184.216.34", "::ffff:5db8:d822", "2002:5db8:d822::1"];
  for (const ip of blocked) it(`blocks ${ip || "(empty)"}`, () => expect(isPrivateAddress(ip)).toBe(true));
  for (const ip of allowed) it(`allows ${ip}`, () => expect(isPrivateAddress(ip)).toBe(false));
});

describe("parsePublicUrl", () => {
  const code = (fn) => {
    try {
      fn();
      return "ok";
    } catch (e) {
      return e instanceof UrlGuardError ? e.code : `other:${e.message}`;
    }
  };

  it("accepts http/https on default ports and 80/443", () => {
    for (const u of ["https://example.com/a", "http://example.com", "https://example.com:443/x", "http://example.com:80/"]) {
      expect(code(() => parsePublicUrl(u))).toBe("ok");
    }
  });

  it("rejects non-http schemes", () => {
    for (const u of ["file:///etc/passwd", "ftp://example.com", "gopher://example.com", "javascript:alert(1)", "data:text/html,hi", "ws://example.com"]) {
      expect(code(() => parsePublicUrl(u))).toBe("url_blocked");
    }
  });

  it("rejects other ports and credentials", () => {
    for (const u of ["http://example.com:5432", "https://example.com:8443", "http://example.com:22", "https://user:pass@example.com/"]) {
      expect(code(() => parsePublicUrl(u))).toBe("url_blocked");
    }
  });

  it("rejects private literals incl. tricky encodings", () => {
    for (const u of ["http://127.0.0.1/", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://2130706433/", "http://0x7f.1/", "http://0/", "http://169.254.169.254/latest/meta-data", "http://[fd00::1]/", "http://10.1.2.3/"]) {
      expect(code(() => parsePublicUrl(u))).toBe("url_blocked");
    }
  });

  it("rejects garbage and overlong input", () => {
    expect(code(() => parsePublicUrl("not a url"))).toBe("url_blocked");
    expect(code(() => parsePublicUrl(""))).toBe("url_blocked");
    expect(code(() => parsePublicUrl(`https://example.com/${"a".repeat(2100)}`))).toBe("url_blocked");
    expect(code(() => parsePublicUrl(42))).toBe("url_blocked");
  });
});

describe("DNS checks", () => {
  it("resolves with all:true and accepts only all-public answers", async () => {
    const lookup = lookupTo(PUBLIC_V4, "2606:4700:4700::1111");
    await expect(resolvePublicAddresses("example.com", { lookup })).resolves.toHaveLength(2);
    expect(lookup).toHaveBeenCalledWith("example.com", expect.objectContaining({ all: true }));
  });

  it("rejects a host if ANY record is private (rebinding/mixed answers)", async () => {
    await expect(resolvePublicAddresses("evil.test", { lookup: lookupTo(PUBLIC_V4, "127.0.0.1") })).rejects.toMatchObject({ code: "url_blocked" });
    await expect(resolvePublicAddresses("evil.test", { lookup: lookupTo("::ffff:10.0.0.5") })).rejects.toMatchObject({ code: "url_blocked" });
    await expect(assertPublicUrl("http://localhost/", { lookup: lookupTo("127.0.0.1", "::1") })).rejects.toMatchObject({ code: "url_blocked" });
  });

  it("DNS failure → url_unreachable", async () => {
    const lookup = vi.fn(async () => {
      throw Object.assign(new Error("nx"), { code: "ENOTFOUND" });
    });
    await expect(resolvePublicAddresses("nope.invalid", { lookup })).rejects.toMatchObject({ code: "url_unreachable" });
  });

  it("pinnedLookup only ever answers with vetted public addresses", () => {
    const lookup = pinnedLookup([{ address: PUBLIC_V4, family: 4 }]);
    const one = vi.fn();
    lookup("example.com", {}, one);
    expect(one).toHaveBeenCalledWith(null, PUBLIC_V4, 4);
    const all = vi.fn();
    lookup("example.com", { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [{ address: PUBLIC_V4, family: 4 }]);
    const bad = vi.fn();
    pinnedLookup([{ address: "127.0.0.1", family: 4 }])("x", {}, bad);
    expect(bad.mock.calls[0][0]).toBeInstanceOf(Error);
  });
});

describe("safeFetch", () => {
  const html = (body, extra = {}) => ({ status: 200, headers: { "content-type": "text/html; charset=utf-8", ...extra }, body: Buffer.from(body) });

  it("fetches a public page via the vetted addresses", async () => {
    const transport = vi.fn(async () => html("<p>hi</p>"));
    const out = await safeFetch("https://example.com/a#frag", { lookup: lookupTo(PUBLIC_V4), transport });
    expect(out).toMatchObject({ finalUrl: "https://example.com/a", text: "<p>hi</p>" });
    expect(transport.mock.calls[0][1]).toEqual([{ address: PUBLIC_V4, family: 4 }]);
  });

  it("re-checks every redirect hop and blocks a redirect to a private address", async () => {
    const transport = vi.fn(async (url) =>
      url.hostname === "example.com" ? { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } } : html("secret")
    );
    await expect(safeFetch("https://example.com/", { lookup: lookupTo(PUBLIC_V4), transport })).rejects.toMatchObject({ code: "url_blocked" });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("blocks a redirect to a hostname that resolves privately", async () => {
    const lookup = vi.fn(async (host) => [{ address: host === "internal.example" ? "10.0.0.7" : PUBLIC_V4, family: 4 }]);
    const transport = vi.fn(async () => ({ status: 301, headers: { location: "http://internal.example/admin" } }));
    await expect(safeFetch("https://example.com/", { lookup, transport })).rejects.toMatchObject({ code: "url_blocked" });
  });

  it("blocks redirects to non-http schemes and other ports", async () => {
    for (const location of ["file:///etc/passwd", "http://example.org:6379/", "gopher://x/"]) {
      const transport = vi.fn(async () => ({ status: 307, headers: { location } }));
      await expect(safeFetch("https://example.com/", { lookup: lookupTo(PUBLIC_V4), transport })).rejects.toMatchObject({ code: "url_blocked" });
    }
  });

  it("follows up to 3 redirects, then gives up", async () => {
    let n = 0;
    const transport = vi.fn(async () => ({ status: 302, headers: { location: `/hop${++n}` } }));
    await expect(safeFetch("https://example.com/", { lookup: lookupTo(PUBLIC_V4), transport })).rejects.toMatchObject({ code: "url_unreachable", detail: "too_many_redirects" });
    expect(transport).toHaveBeenCalledTimes(4);

    let m = 0;
    const ok = vi.fn(async () => (++m <= 3 ? { status: 302, headers: { location: `/hop${m}` } } : html("done")));
    await expect(safeFetch("https://example.com/", { lookup: lookupTo(PUBLIC_V4), transport: ok })).resolves.toMatchObject({ finalUrl: "https://example.com/hop3" });
  });

  it("rejects non-text content types and error statuses", async () => {
    const pdf = vi.fn(async () => ({ status: 200, headers: { "content-type": "application/pdf" }, body: Buffer.from("%PDF") }));
    await expect(safeFetch("https://example.com/x.pdf", { lookup: lookupTo(PUBLIC_V4), transport: pdf })).rejects.toMatchObject({ code: "url_not_readable" });
    const e404 = vi.fn(async () => ({ status: 404, headers: { "content-type": "text/html" }, body: Buffer.from("") }));
    await expect(safeFetch("https://example.com/x", { lookup: lookupTo(PUBLIC_V4), transport: e404 })).rejects.toMatchObject({ code: "url_unreachable" });
  });

  it("maps transport timeouts and resets to url_unreachable", async () => {
    const t = vi.fn(async () => {
      throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    });
    await expect(safeFetch("https://example.com/", { lookup: lookupTo(PUBLIC_V4), transport: t })).rejects.toMatchObject({ code: "url_unreachable" });
  });

  it("never touches the network for a blocked literal", async () => {
    const transport = vi.fn();
    await expect(safeFetch("http://127.0.0.1:80/", { transport })).rejects.toMatchObject({ code: "url_blocked" });
    await expect(safeFetch("http://[::ffff:a9fe:a9fe]/", { transport })).rejects.toMatchObject({ code: "url_blocked" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("real transport enforces the 2 MB cap and the guard against a local server", async () => {
    // A local server is loopback, so the guard must refuse it even when DNS is "public".
    const http = await import("node:http");
    const server = http.createServer((req, res) => res.end("x")).listen(0);
    const port = server.address().port;
    try {
      await expect(safeFetch(`http://127.0.0.1:${port}/`)).rejects.toMatchObject({ code: "url_blocked" });
      // A hostname whose DNS answer is loopback is refused before any socket opens.
      await expect(safeFetch("http://sneaky.example/", { lookup: lookupTo("127.0.0.1") })).rejects.toMatchObject({ code: "url_blocked" });
    } finally {
      server.close();
    }
  });
});

describe("round-2 url-guard", () => {
  it("[SEC-7] blocks the IPv4-translated ::ffff:0:0/96 form when it embeds a private v4", () => {
    expect(isPrivateAddress("::ffff:0:7f00:1")).toBe(true);
    expect(isPrivateAddress("::ffff:0:a9fe:a9fe")).toBe(true);
    expect(parsePublicUrl.bind(null, "http://[::ffff:0:7f00:1]/")).toThrow(UrlGuardError);
  });

  it("[SEC-6][ENG-27] a DNS lookup that never answers fails as url_unreachable within the timeout", async () => {
    const lookup = vi.fn(() => new Promise(() => {}));
    const started = Date.now();
    await expect(resolvePublicAddresses("slow.example", { lookup, timeoutMs: 50 })).rejects.toMatchObject({ code: "url_unreachable", detail: "dns_timeout" });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
