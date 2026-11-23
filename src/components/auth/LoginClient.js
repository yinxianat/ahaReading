"use client";
/**
 * Sign-in form and the check-your-email state (UX-SPEC 3.2, LESSONS 63–65):
 * validation that names the fix, a refusable "did you mean" before sending,
 * stated wait and expiry, and a guarded resend with a visible cooldown.
 */
import { useEffect, useRef, useState } from "react";
import { validateEmail, suggestEmailCorrection, EMAIL_MAX_LENGTH } from "@/lib/email-check.js";
import { api } from "@/lib/client/api.js";
import { useCountdown } from "@/lib/client/hooks.js";
import Button from "@/components/ui/Button.js";
import { TextField } from "@/components/ui/Field.js";
import Alert from "@/components/ui/Alert.js";
import ErrorAlert from "@/components/ui/ErrorAlert.js";
import Icon from "@/components/ui/icons.js";
import { useToast } from "@/components/ui/Toast.js";
import CodeEntry from "./CodeEntry.js";

const RESEND_COOLDOWN = 60;

export default function LoginClient({ next, reason }) {
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [suggestion, setSuggestion] = useState(null);
  const [declined, setDeclined] = useState(() => new Set());
  const [sending, setSending] = useState(false);
  const [apiError, setApiError] = useState(null);
  const [sent, setSent] = useState(null);
  const [cooldownKey, setCooldownKey] = useState(0);
  const inFlight = useRef(false);
  const inputRef = useRef(null);
  const headingRef = useRef(null);
  const { toast } = useToast();

  const cooldownLeft = useCountdown(sent ? RESEND_COOLDOWN : 0, cooldownKey);
  const rateLimitLeft = useCountdown(apiError?.code === "rate_limited" ? apiError.retryAfter || 60 : 0, apiError);

  useEffect(() => {
    if (sent) headingRef.current?.focus();
  }, [sent]);

  const send = async (address, { resend = false } = {}) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setApiError(null);
    try {
      const data = await api("/api/auth/request-link", {
        method: "POST",
        body: next ? { email: address, next } : { email: address },
        timeoutMs: 20000,
        redirectOn401: false,
      });
      setSent({
        email: address,
        expiresInMinutes: data?.expiresInMinutes || 15,
        codeLength: Number.isInteger(data?.codeLength) && data.codeLength > 0 ? data.codeLength : 6,
        devLink: data?.devLink || null,
        devCode: typeof data?.devCode === "string" ? data.devCode : null,
        deliveryDegraded: data?.deliveryDegraded === true,
      });
      setCooldownKey((k) => k + 1);
      setSuggestion(null);
      if (resend) toast({ message: "New link sent. Use the newest email.", tone: "success" });
    } catch (err) {
      if (err.code === "invalid_input" && (err.field === "email" || !err.field) && !resend) {
        setFieldError(err.message || "Check your email address and try again.");
        inputRef.current?.focus();
      } else {
        setApiError(err);
      }
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };

  const validate = (value) => {
    const result = validateEmail(value);
    if (!result.ok) {
      setFieldError(result.message);
      return null;
    }
    setFieldError("");
    return result.email;
  };

  const onSubmit = (e) => {
    e.preventDefault();
    setSubmitted(true);
    const address = validate(email);
    if (!address) {
      inputRef.current?.focus();
      return;
    }
    const suggested = suggestEmailCorrection(address);
    if (suggested && !declined.has(address)) {
      setSuggestion({ typed: address, suggested });
      return;
    }
    send(address);
  };

  const acceptSuggestion = () => {
    const fixed = suggestion.suggested;
    setEmail(fixed);
    setSuggestion(null);
    send(fixed);
  };
  const declineSuggestion = () => {
    const typed = suggestion.typed;
    setDeclined((d) => new Set(d).add(typed));
    setSuggestion(null);
    send(typed);
  };

  const switchEmail = () => {
    setSent(null);
    setApiError(null);
    queueMicrotask(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  };

  if (sent) {
    const resendDisabled = sending || cooldownLeft > 0 || rateLimitLeft > 0;
    return (
      <div>
        <span className="mb-3 inline-flex h-12 w-12 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Icon name="mail" size={26} />
        </span>
        <h1 ref={headingRef} tabIndex={-1} className="text-[24px] font-bold leading-tight outline-none">
          Check your email
        </h1>
        <p className="mt-2 break-anywhere">
          We sent a sign-in link to <strong>{sent.email}</strong>.
        </p>
        {sent.deliveryDegraded ? (
          <Alert tone="warning" compact className="mt-3">
            Email delivery is slow right now — the email may take a few minutes. You can resend it once the timer runs out.
          </Alert>
        ) : null}
        <ul className="mt-3 list-disc space-y-1 pl-5 text-[15px] text-muted">
          <li>It usually arrives within a minute.</li>
          <li>The link works for {sent.expiresInMinutes} minutes.</li>
          <li>Not there? Check your spam or promotions folder.</li>
        </ul>

        {apiError ? (
          <ErrorAlert
            className="mt-4"
            error={apiError}
            context="login"
            onRetry={() => send(sent.email, { resend: true })}
            onDismiss={() => setApiError(null)}
          />
        ) : null}

        <div className="mt-5 flex flex-col gap-2">
          <Button
            variant="secondary"
            fullWidth
            loading={sending}
            loadingLabel="Sending…"
            disabled={resendDisabled}
            onClick={() => send(sent.email, { resend: true })}
          >
            {cooldownLeft > 0 ? `Resend in ${cooldownLeft}s` : "Resend link"}
          </Button>
          <Button variant="text" fullWidth onClick={switchEmail}>
            Use a different email
          </Button>
        </div>

        <CodeEntry
          email={sent.email}
          next={next}
          codeLength={sent.codeLength}
          sentKey={cooldownKey}
          onResend={() => send(sent.email, { resend: true })}
          resendDisabled={resendDisabled}
        />

        {sent.devLink || sent.devCode ? (
          <div className="mt-5 rounded-md border border-dashed border-border p-3 text-[14px]">
            {sent.devLink ? (
              <>
                <p className="font-semibold">Dev sign-in link</p>
                <a href={sent.devLink} className="break-anywhere" data-testid="dev-link">
                  {sent.devLink}
                </a>
              </>
            ) : null}
            {sent.devCode ? (
              <p className={sent.devLink ? "mt-2" : ""}>
                <span className="font-semibold">Dev code: </span>
                <code data-testid="dev-code">{sent.devCode}</code>
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div>
      {reason === "expired" ? (
        <Alert tone="info" className="mb-4">
          Your session ended. Sign in again to pick up where you left off.
        </Alert>
      ) : null}
      <h1 className="text-[24px] font-bold leading-tight">Sign in to AhaReading</h1>
      <p className="mt-1 text-muted">We&apos;ll email you a link — no password needed.</p>

      <form className="mt-5" noValidate onSubmit={onSubmit}>
        <TextField
          ref={inputRef}
          label="Email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="you@example.com"
          maxLength={EMAIL_MAX_LENGTH + 20}
          value={email}
          error={fieldError}
          onChange={(e) => {
            setEmail(e.target.value);
            if (suggestion) setSuggestion(null);
          }}
          onBlur={() => {
            if (submitted) validate(email);
          }}
        />

        {suggestion ? (
          <div className="mt-3 rounded-md border border-warning/40 bg-warning-soft p-3" role="status">
            <p className="break-anywhere">
              Did you mean <strong>{suggestion.suggested}</strong>?
            </p>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <Button variant="primary" onClick={acceptSuggestion} disabled={sending}>
                Yes, use {suggestion.suggested.split("@")[1]}
              </Button>
              <Button variant="secondary" onClick={declineSuggestion} disabled={sending}>
                No, send to {suggestion.typed.split("@")[1]}
              </Button>
            </div>
          </div>
        ) : null}

        {apiError ? (
          <ErrorAlert
            className="mt-4"
            error={apiError}
            context="login"
            onRetry={() => {
              const address = validate(email);
              if (address) send(address);
            }}
            onDismiss={() => setApiError(null)}
          />
        ) : null}

        <Button
          type="submit"
          fullWidth
          size="lg"
          className="mt-4"
          loading={sending}
          loadingLabel="Sending…"
          disabled={rateLimitLeft > 0 || Boolean(suggestion)}
        >
          Email me a sign-in link
        </Button>
      </form>
    </div>
  );
}
