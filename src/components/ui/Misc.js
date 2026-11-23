"use client";
/**
 * Small presentational pieces: Skeleton, Badge, Card, EmptyState, ErrorState,
 * FullPageError, Spinner, SavedCopyNote.
 */
import Link from "next/link";
import Icon from "./icons.js";
import Button from "./Button.js";
import ErrorAlert from "./ErrorAlert.js";
import { useOnline } from "@/lib/client/hooks.js";

/**
 * "Showing saved copy" line for data the service worker served from cache:
 * offline, or online while the server is failing (5xx, PO-12).
 * @param {{className?:string}} props
 */
export function SavedCopyNote({ className = "mb-3" }) {
  const online = useOnline();
  return (
    <p className={`${className} text-[14px] text-muted`} role="status">
      {online ? "Showing saved copy — we can't reach the server right now." : "Showing saved copy — you're offline."}
    </p>
  );
}

/**
 * @param {{lines?:number, widths?:string[], height?:number, variant?:"text"|"card"|"block", label?:string}} props
 */
export function Skeleton({ lines = 3, widths, height = 14, variant = "text", className = "", label = "Loading" }) {
  if (variant === "block") return <div className={`skeleton ${className}`} style={{ height }} aria-hidden="true" />;
  if (variant === "card") {
    return (
      <div className={`rounded-md border border-border bg-surface p-4 ${className}`} aria-hidden="true">
        <div className="skeleton mb-3" style={{ height: 18, width: "60%" }} />
        <div className="skeleton mb-3" style={{ height: 12, width: "30%" }} />
        <div className="skeleton mb-2" style={{ height: 12, width: "100%" }} />
        <div className="skeleton" style={{ height: 12, width: "85%" }} />
      </div>
    );
  }
  return (
    <div className={className} role="status" aria-label={label}>
      {Array.from({ length: lines }, (_, i) => (
        <div
          key={i}
          className="skeleton mb-2.5"
          style={{ height, width: widths?.[i] || (i === lines - 1 ? "60%" : "100%") }}
          aria-hidden="true"
        />
      ))}
    </div>
  );
}

const BADGE = {
  neutral: "bg-surface-2 text-muted",
  accent: "bg-accent text-accent-fg",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  success: "bg-success-soft text-success",
  info: "bg-accent-soft text-accent",
};

/**
 * @param {{tone?:string, max?:number, children:any}} props numbers above `max` render "9+"
 */
export function Badge({ tone = "neutral", max, children, className = "" }) {
  const content = typeof children === "number" && max && children > max ? `${max}+` : children;
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[12px] font-semibold tracking-[.02em] ${BADGE[tone] || BADGE.neutral} ${className}`}>
      {content}
    </span>
  );
}

/**
 * @param {{href?:string, interactive?:boolean, padding?:string, as?:string}} props
 */
export function Card({ href, interactive = false, padding = "p-4", className = "", children, ...rest }) {
  const classes = `block rounded-md border border-border bg-surface shadow-1 ${padding} ${interactive || href ? "hover:border-accent/50 transition-colors" : ""} ${className}`;
  if (href) {
    return (
      <Link href={href} className={`${classes} text-text no-underline`} {...rest}>
        {children}
      </Link>
    );
  }
  return (
    <div className={classes} {...rest}>
      {children}
    </div>
  );
}

/**
 * @param {{icon?:string, title:string, body?:any, action?:{label:string, href?:string, onClick?:() => void}}} props
 */
export function EmptyState({ icon = "book", title, body, action, tone }) {
  return (
    <div className="flex flex-col items-center px-4 py-10 text-center">
      <span className={`mb-3 inline-flex h-14 w-14 items-center justify-center rounded-full ${tone === "success" ? "bg-success-soft text-success" : "bg-surface-2 text-muted"}`}>
        <Icon name={icon} size={28} />
      </span>
      <h2 className="text-[20px] font-semibold">{title}</h2>
      {body ? <p className="mt-1 max-w-[40ch] text-muted">{body}</p> : null}
      {action ? (
        <div className="mt-4">
          <Button href={action.href} onClick={action.onClick}>
            {action.label}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Load-failure block with retry; uses the error catalogue when `error` given.
 * @param {{title?:string, body?:string, error?:any, onRetry:() => void, secondary?:{label:string, href:string}}} props
 */
export function ErrorState({ title, body, error, onRetry, secondary }) {
  if (error && (error.code === "offline" || error.code === "rate_limited" || error.code === "server_error")) {
    return (
      <div className="py-4">
        {title ? <p className="mb-2 font-semibold">{title}</p> : null}
        <ErrorAlert error={error} context="load" onRetry={onRetry} extraActions={secondary ? [secondary] : []} />
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center px-4 py-10 text-center" role="alert">
      <span className="mb-3 inline-flex h-14 w-14 items-center justify-center rounded-full bg-danger-soft text-danger">
        <Icon name="alert" size={28} />
      </span>
      <h2 className="text-[18px] font-semibold">{title || "Something went wrong."}</h2>
      <p className="mt-1 max-w-[40ch] text-muted">{body || "Something went wrong on our side. Please try again."}</p>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        <Button variant="secondary" onClick={onRetry} icon="refresh">
          Try again
        </Button>
        {secondary ? (
          <Button variant="text" href={secondary.href}>
            {secondary.label}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Route-level failure: the page cannot render its data.
 * @param {{title:string, body?:string, primary:{label:string, href?:string, onClick?:() => void}, secondary?:{label:string, href?:string, onClick?:() => void}, icon?:string}} props
 */
export function FullPageError({ title, body, primary, secondary, icon = "alert" }) {
  return (
    <div className="mx-auto flex min-h-[60dvh] max-w-[480px] flex-col items-center justify-center px-4 py-12 text-center">
      <span className="mb-4 inline-flex h-16 w-16 items-center justify-center rounded-full bg-surface-2 text-muted">
        <Icon name={icon} size={32} />
      </span>
      <h1 className="text-[24px] font-bold leading-tight">{title}</h1>
      {body ? <p className="mt-2 text-muted">{body}</p> : null}
      <div className="mt-6 flex flex-col gap-2 sm:flex-row">
        <Button href={primary.href} onClick={primary.onClick}>
          {primary.label}
        </Button>
        {secondary ? (
          <Button variant="secondary" href={secondary.href} onClick={secondary.onClick}>
            {secondary.label}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Centered loading indicator with a visible label. */
export function PageSpinner({ label = "Loading…" }) {
  return (
    <div className="flex min-h-[40dvh] items-center justify-center gap-3 text-muted" role="status">
      <span className="spinner text-accent" aria-hidden="true" style={{ width: 20, height: 20 }} />
      <span>{label}</span>
    </div>
  );
}
