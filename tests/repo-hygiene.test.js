import { describe, it, expect, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ignored = (path) => spawnSync("git", ["check-ignore", "-q", path]).status === 0;

describe("repository hygiene — no secrets in git", () => {
  it("ignores every env file except the template", () => {
    for (const f of [".env", ".env.local", ".env.production", ".env.test"]) expect(ignored(f)).toBe(true);
    expect(ignored(".env.example")).toBe(false);
  });

  it("ignores the internal PLANS folder", () => {
    expect(ignored("PLANS/LESSONS.md")).toBe(true);
  });

  it("the secret guard finds nothing in committable files", () => {
    const out = spawnSync("node", ["scripts/check-secrets.mjs", "--all"], { encoding: "utf8" });
    expect(out.stderr).toBe("");
    expect(out.status).toBe(0);
  });

  it(".env.example holds placeholders only (no 32+ char hex values)", () => {
    const text = readFileSync(".env.example", "utf8");
    expect(text).not.toMatch(/=["']?[A-Fa-f0-9]{32,}/);
  });

  it(".env.example documents every env var the code reads", () => {
    const src = execFileSync("grep", ["-rhoE", "process\\.env\\.[A-Z_0-9]+|\"[A-Z][A-Z0-9_]+_(SECRET|KEY|MODEL)\"", "src"], { encoding: "utf8" });
    const names = new Set(src.match(/[A-Z][A-Z0-9_]{2,}/g));
    names.delete("NODE_ENV");
    const template = readFileSync(".env.example", "utf8");
    const missing = [...names].filter((n) => !template.includes(n));
    expect(missing).toEqual([]);
  });
});

describe("[SEC-14] secret patterns", async () => {
  const { SECRET_PATTERNS, ASSIGNMENT_ALLOWED } = await import("../scripts/secret-patterns.mjs");
  const j = (...p) => p.join("");
  const hits = (line) => SECRET_PATTERNS.filter(([re]) => re.test(line)).map(([, label]) => label);

  it.each([
    [j("SMTP_PASS=", "hunter2hunter2xyz"), "credential assignment"],
    [j("export OPENAI_API_KEY=", "abcdefghijklmnop"), "credential assignment"],
    [j("key: re", "_abcdefghijklmnopqrstuvwx"), "Resend API key"],
    [j("SG", ".abcdefghijklmnopq.abcdefghijklmnopqrs"), "SendGrid API key"],
  ])("flags %s", (line, label) => expect(hits(line)).toContain(label));

  it.each([
    'JWT_SECRET="replace-with-openssl-rand-hex-32"',
    'SMTP_PASS=""',
    'process.env.SMTP_PASS = "app-password-value";',
    '  JWT_SECRET: "missing_jwt_secret",',
  ])("does not cry wolf on %s", (line) => expect(hits(line)).toEqual([]));

  it("only the template may hold placeholder assignments", () => {
    expect([...ASSIGNMENT_ALLOWED]).toEqual([".env.example"]);
  });
});

describe("[SEC-8] security headers", async () => {
  it("HSTS and COOP in production builds", async () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      vi.resetModules();
      const { default: config } = await import("../next.config.mjs");
      const [all] = await config.headers();
      const keys = all.headers.map((h) => h.key);
      expect(keys).toEqual(expect.arrayContaining(["Strict-Transport-Security", "Cross-Origin-Opener-Policy", "Content-Security-Policy"]));
    } finally {
      process.env.NODE_ENV = saved;
    }
  });
});

describe("[ENG-22] Railway's migrate step needs no devDependency", () => {
  it("prisma.config.mjs does not import dotenv", () => {
    expect(readFileSync("prisma.config.mjs", "utf8")).not.toMatch(/import\s+["']dotenv|from\s+["']dotenv/);
  });
});
