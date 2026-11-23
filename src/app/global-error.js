"use client";
/**
 * Last-resort screen when the root layout itself fails. Renders its own
 * document and inline styles because globals.css is not loaded here.
 */
import { useEffect } from "react";
import { reportClientError } from "@/lib/client/report-error.js";

const btn = {
  minHeight: 44,
  padding: "0 16px",
  borderRadius: 12,
  fontWeight: 600,
  fontSize: 16,
  border: "1px solid #E3E0D9",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  textDecoration: "none",
};

export default function GlobalError({ error, retry, reset }) {
  useEffect(() => {
    reportClientError(error, { kind: "render", digest: error?.digest, source: "global" });
  }, [error]);
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif", background: "#FAF9F6", color: "#1C1D1F" }}>
        <title>Something went wrong · AhaReading</title>
        <main style={{ maxWidth: 480, margin: "0 auto", padding: "80px 16px", textAlign: "center" }}>
          <h1 style={{ fontSize: 24, margin: 0 }}>Something went wrong.</h1>
          <p style={{ color: "#5F6368" }}>Reload this page — your saved concepts are safe.</p>
          <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap", marginTop: 24 }}>
            <button type="button" onClick={() => (retry || reset)?.()} style={{ ...btn, background: "#2557D6", color: "#fff", border: 0 }}>
              Reload
            </button>
            {/* Plain <a>: the root layout (and router) failed, so do a full navigation. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/read" style={{ ...btn, color: "#1C1D1F" }}>
              Go to Library
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
