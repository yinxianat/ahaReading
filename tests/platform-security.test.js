import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "src");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (full.startsWith(path.join(SRC, "generated"))) continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(m?js|jsx)$/.test(name)) out.push(full);
  }
  return out;
}
const files = walk(SRC);
const read = (f) => readFileSync(f, "utf8");
const rel = (f) => path.relative(ROOT, f);

describe(".gitignore keeps source tracked (LESSONS 50)", () => {
  it("ignores nothing under src/ except the generated Prisma client", () => {
    const out = execFileSync("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "--", "src"], { cwd: ROOT, encoding: "utf8" });
    const ignored = out.split("\n").filter(Boolean).filter((f) => !f.startsWith("src/generated/"));
    expect(ignored).toEqual([]);
  });

  it("does not ignore every source file, including admin/logs", () => {
    const candidates = [...files.map(rel), "src/app/api/admin/logs/route.js", "src/app/api/admin/logs/[id]/resolve/route.js"];
    let ignored = "";
    try {
      ignored = execFileSync("git", ["check-ignore", "--no-index", ...candidates], { cwd: ROOT, encoding: "utf8" });
    } catch (err) {
      // exit 1 = none ignored
      if (err.status !== 1) throw err;
    }
    expect(ignored.trim()).toBe("");
  });
});

describe("secrets (LESSONS 2/3)", () => {
  const SECRET_NAME = /(SECRET|_KEY|PASS|PASSWORD|TOKEN|DATABASE_URL)\b/;
  it("no secret env var has a non-empty literal fallback", () => {
    const findings = [];
    const pattern = /process\.env\.([A-Z0-9_]+)\s*(?:\|\||\?\?)\s*(["'`])([^"'`]*)\2/g;
    for (const f of files) {
      for (const m of read(f).matchAll(pattern)) {
        if (SECRET_NAME.test(m[1]) && m[3].length > 0) findings.push(`${rel(f)}: ${m[0]}`);
      }
    }
    expect(findings).toEqual([]);
  });

  it("no hard-coded credential-shaped strings in src", () => {
    const shapes = [/sk-ant-[A-Za-z0-9_-]{16,}/, /\bsk-[A-Za-z0-9]{32,}/, /AIza[A-Za-z0-9_-]{35}/, /ghp_[A-Za-z0-9]{36}/];
    const hits = files.filter((f) => shapes.some((s) => s.test(read(f)))).map(rel);
    expect(hits).toEqual([]);
  });
});

describe("structural rules", () => {
  const imports = (f) => [...read(f).matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);

  it("mailer is a leaf and alerts never imports the logger (LESSONS 41)", () => {
    const mailer = imports(path.join(SRC, "lib/mailer.js"));
    expect(mailer.some((i) => /logger|alerts|db/.test(i))).toBe(false);
    const alerts = imports(path.join(SRC, "lib/alerts.js"));
    expect(alerts.some((i) => /logger|auth|db/.test(i))).toBe(false);
  });

  it("request.json() is only called inside http.js (LESSONS 13)", () => {
    const hits = files.filter((f) => /\brequest\.json\(\)/.test(read(f))).map(rel);
    expect(hits).toEqual(["src/lib/http.js"]);
  });

  it("no URL is built from the Host header (LESSONS 1)", () => {
    const hits = files.filter((f) => /headers\.get\(\s*["'](?:host|x-forwarded-host)["']\s*\)/i.test(read(f))).map(rel);
    expect(hits).toEqual([]);
  });

  it("sign-in email is not awaited inside a route (LESSONS 56)", () => {
    const routes = files.filter((f) => f.includes(`${path.sep}app${path.sep}api${path.sep}`));
    const hits = routes.filter((f) => /await\s+sendMail\(/.test(read(f))).map(rel);
    expect(hits).toEqual([]);
  });

  it("platform log messages are constants, not template literals (LESSONS 39)", () => {
    const hits = [];
    for (const f of files) {
      for (const m of read(f).matchAll(/logger\.(?:warn|error|critical)\(\s*[^,]+,\s*`/g)) hits.push(`${rel(f)}: ${m[0]}`);
    }
    expect(hits).toEqual([]);
  });
});
