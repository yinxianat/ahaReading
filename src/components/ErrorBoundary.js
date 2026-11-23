"use client";
/**
 * Component-level error boundary (spec 18.5). Reports to /api/client-error and
 * offers a retry and a way out — never a dead end.
 */
import { Component } from "react";
import Link from "next/link";
import { reportClientError } from "@/lib/client/report-error.js";

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    reportClientError(error, { kind: "render", componentStack: info?.componentStack, source: this.props.name || "boundary" });
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    if (this.props.fallback) return this.props.fallback;
    return (
      <div role="alert" className="mx-auto max-w-[480px] px-4 py-10 text-center">
        <h2 className="text-[20px] font-semibold">Something went wrong.</h2>
        <p className="mt-2 text-muted">Reload this page — your saved concepts are safe.</p>
        <div className="mt-5 flex flex-col justify-center gap-2 sm:flex-row">
          <button
            type="button"
            onClick={() => this.setState({ hasError: false })}
            className="min-h-[44px] rounded-md bg-accent px-4 font-semibold text-accent-fg"
          >
            Try again
          </button>
          <Link href="/read" className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-border px-4 font-semibold text-text">
            Go to Library
          </Link>
        </div>
      </div>
    );
  }
}
