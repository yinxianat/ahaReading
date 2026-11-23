import { describe, it, expect } from "vitest";
import { validateEmail, suggestEmailCorrection, EMAIL_MAX_LENGTH } from "@/lib/email-check.js";
import { readFileSync } from "node:fs";

describe("validateEmail", () => {
  it("normalises a valid address", () => {
    expect(validateEmail("  Alice@Example.COM ")).toEqual({ ok: true, email: "alice@example.com" });
  });

  it.each([
    ["", /enter your email/i],
    ["alice.example.com", /add an @/i],
    ["a@b@c.com", /only one @/i],
    ["@example.com", /before the @/i],
    ["alice@", /after the @/i],
    ["alice@localhost", /needs a dot/i],
    ["alice@example..com", /misplaced dot/i],
    ["ali ce@example.com", /space/i],
    [`${"a".repeat(EMAIL_MAX_LENGTH)}@x.com`, /too long/i],
  ])("names the fix for %p", (input, pattern) => {
    const result = validateEmail(input);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(pattern);
  });

  it.each([[42], [null], [undefined], [{}]])("rejects non-strings %p without throwing", (v) => {
    expect(validateEmail(v).ok).toBe(false);
  });
});

describe("suggestEmailCorrection", () => {
  it.each([
    ["bob@gmial.com", "bob@gmail.com"],
    ["bob@gmail.con", "bob@gmail.com"],
    ["bob@gmail.co", "bob@gmail.com"],
    ["bob@hotmial.com", "bob@hotmail.com"],
    ["bob@yahooo.com", "bob@yahoo.com"],
    ["bob@outlok.com", "bob@outlook.com"],
    ["Bob@Gmai.com", "bob@gmail.com"],
  ])("suggests %s -> %s", (input, expected) => {
    expect(suggestEmailCorrection(input)).toBe(expected);
  });

  it.each(["bob@gmail.com", "bob@mycompany.io", "bob@hotmail.fr", "bob@yahoo.co.jp", "nope", 7])(
    "does not suggest for %p",
    (input) => {
      expect(suggestEmailCorrection(input)).toBeNull();
    }
  );
});

describe("isomorphism", () => {
  it("imports nothing, so the browser bundle can use it", () => {
    const src = readFileSync(new URL("../src/lib/email-check.js", import.meta.url), "utf8");
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/\brequire\(|process\.|window\.|document\./);
  });
});
