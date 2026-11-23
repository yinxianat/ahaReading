#!/usr/bin/env node
/**
 * Secret guard. Fails (exit 1) if the files about to be committed include an
 * env file, the PLANS folder, or anything shaped like a real credential.
 *
 * Usage:
 *   node scripts/check-secrets.mjs            # scan staged files (pre-commit hook)
 *   node scripts/check-secrets.mjs --all      # scan every tracked + unignored file
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { FORBIDDEN_PATHS, SECRET_PATTERNS, ASSIGNMENT_ALLOWED } from "./secret-patterns.mjs";

const scanAll = process.argv.includes("--all");

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).split("\n").filter(Boolean);
}

const files = scanAll
  ? git(["ls-files", "--cached", "--others", "--exclude-standard"])
  : git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]);

const problems = [];
for (const file of files) {
  for (const [re, label] of FORBIDDEN_PATHS) {
    if (re.test(file)) problems.push(`${file}: ${label} must never be committed`);
  }
  let text;
  try {
    // Pre-commit: scan the staged blob (what will actually be committed), not the working copy.
    text = scanAll
      ? (statSync(file).size > 2_000_000 ? null : readFileSync(file, "utf8"))
      : execFileSync("git", ["show", `:${file}`], { encoding: "utf8", maxBuffer: 4_000_000 });
  } catch {
    continue; // deleted, unreadable, or too large
  }
  if (text == null) continue;
  if (text.includes("\u0000")) continue; // binary
  text.split("\n").forEach((line, i) => {
    for (const [re, label] of SECRET_PATTERNS) {
      if (label === "credential assignment" && ASSIGNMENT_ALLOWED.has(file)) continue;
      if (re.test(line)) problems.push(`${file}:${i + 1}: looks like a ${label}`);
    }
  });
}

if (problems.length) {
  console.error("✖ Secret guard blocked this commit:\n  " + problems.join("\n  "));
  console.error("\nMove real values to .env (git-ignored). Fixtures: build credential shapes at runtime.");
  process.exit(1);
}
console.log(`✓ Secret guard: ${files.length} file(s) clean`);
