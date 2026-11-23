/**
 * Test helpers for the platform suites. `makePrismaMock()` returns an object
 * whose `model.method` is a lazily-created vi.fn, so tests stub only what they use.
 */
import { vi } from "vitest";

export function makePrismaMock() {
  const models = new Map();
  const root = {
    $transaction: vi.fn(async (ops) => (Array.isArray(ops) ? Promise.all(ops) : ops(proxy))),
    $queryRaw: vi.fn(async () => []),
    $executeRaw: vi.fn(async () => 0),
    // Fresh vi.fn for every model method; call in beforeEach.
    _reset() {
      models.clear();
      root.$transaction.mockClear();
      root.$queryRaw.mockReset().mockImplementation(async () => []);
      root.$executeRaw.mockReset().mockImplementation(async () => 0);
    },
  };
  const proxy = new Proxy(root, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop !== "string" || prop === "then") return undefined;
      if (!models.has(prop)) {
        const fns = new Map();
        models.set(prop, new Proxy({}, {
          get(_, method) {
            if (typeof method !== "string" || method === "then") return undefined;
            if (!fns.has(method)) fns.set(method, vi.fn());
            return fns.get(method);
          },
        }));
      }
      return models.get(prop);
    },
  });
  return proxy;
}

export function jsonRequest(url, { method = "POST", body, headers = {} } = {}) {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Snapshot process.env and return a restore function. */
export function snapshotEnv() {
  const saved = { ...process.env };
  return () => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  };
}

/** Credential-shaped strings built at runtime so no literal trips a scanner (LESSONS 55). */
export const fakeCreds = {
  anthropic: () => ["sk", "ant", "api03", "A".repeat(24)].join("-"),
  openai: () => ["sk", "proj", "B".repeat(32)].join("-"),
  google: () => ["AI", "za", "C".repeat(35)].join(""),
  github: () => ["ghp", "D".repeat(36)].join("_"),
  jwt: () => ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJ1c2VyMSJ9", "E".repeat(43)].join("."),
  hexToken: () => "ab".repeat(32),
  connection: () => ["postgres", "://", "admin", ":", "hunter", "2", "@", "db.internal:5432/app"].join(""),
};
