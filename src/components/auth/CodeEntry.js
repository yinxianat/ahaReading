"use client";
/**
 * "Or type the 6-digit code" on the check-your-email screen (PO-1, TEAM-BRIEF
 * round 2 #1). An installed iOS web app has its own cookie jar: the emailed
 * link opens in Safari and signs Safari in, never the app. The code lets the
 * user finish signing in right here.
 *
 * Paste-friendly: any pasted text keeps only its digits ("123 456",
 * "123-456", "Your code: 123456" all work), and a full code submits itself.
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client/api.js";
import { describeError } from "@/lib/client/errors.js";
import { installContext } from "@/lib/client/install.js";
import Button from "@/components/ui/Button.js";
import { TextField } from "@/components/ui/Field.js";
import ErrorAlert from "@/components/ui/ErrorAlert.js";
import Alert from "@/components/ui/Alert.js";
import { finishSignIn } from "./VerifyClient.js";

/** Codes that mean "this code can never work now": only a new email helps. */
const DEAD_CODE = new Set(["code_locked", "code_spent", "link_expired", "link_used", "link_invalid"]);
const SPENT_COPY = "That code isn't right, and it can't be tried again. Send a new link to get a fresh code.";

/**
 * @param {string} value
 * @param {number} length
 * @returns {string} digits only, at most `length`
 */
export function normaliseCode(value, length = 6) {
  return String(value || "").replace(/\D/g, "").slice(0, length);
}

/**
 * @param {object} props
 * @param {string} props.email the address the code was sent to
 * @param {string} props.next post-sign-in path ("" when none)
 * @param {number} [props.codeLength]
 * @param {() => void} props.onResend sends a new link + code
 * @param {boolean} props.resendDisabled
 * @param {number} props.sentKey changes on every successful (re)send
 */
export default function CodeEntry({ email, next, codeLength = 6, onResend, resendDisabled, sentKey }) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState("");
  const [error, setError] = useState(null);
  const [standalone, setStandalone] = useState(false);
  const inFlight = useRef(false);
  const lastSubmitted = useRef("");
  const inputRef = useRef(null);

  useEffect(() => {
    queueMicrotask(() => setStandalone(installContext() === "standalone"));
  }, []);

  useEffect(() => {
    // A new email means a new code: start clean.
    queueMicrotask(() => {
      setCode("");
      setFieldError("");
      setError(null);
      lastSubmitted.current = "";
    });
  }, [sentKey]);

  const submit = async (value = code) => {
    if (inFlight.current) return;
    const digits = normaliseCode(value, codeLength);
    if (digits.length !== codeLength) {
      setFieldError(`Enter all ${codeLength} digits from the email.`);
      inputRef.current?.focus();
      return;
    }
    inFlight.current = true;
    lastSubmitted.current = digits;
    setBusy(true);
    setFieldError("");
    setError(null);
    try {
      const body = next ? { email, code: digits, next } : { email, code: digits };
      const data = await api("/api/auth/verify", { method: "POST", body, timeoutMs: 20000, redirectOn401: false });
      await finishSignIn(router, data, next);
      // Keep the busy state: the page is navigating away.
      return;
    } catch (err) {
      if (err.code === "code_invalid" && Number(err.data?.attemptsLeft) === 0) {
        // That was the last try (or there is no live code for this email): only a new email helps.
        setError({ code: "code_spent" });
      } else if (err.code === "code_invalid") {
        const left = Number(err.data?.attemptsLeft);
        const tries = Number.isFinite(left) ? ` ${left} ${left === 1 ? "try" : "tries"} left.` : "";
        setFieldError(`That code isn't right. Check the newest email and try again.${tries}`);
        setCode("");
        lastSubmitted.current = "";
        setTimeout(() => inputRef.current?.focus(), 0);
      } else if (err.code === "invalid_input" && err.field === "code") {
        setFieldError(err.message || `Enter all ${codeLength} digits from the email.`);
      } else {
        setError(err);
      }
    } finally {
      inFlight.current = false;
    }
    setBusy(false);
  };

  const onChange = (e) => {
    const digits = normaliseCode(e.target.value, codeLength);
    setCode(digits);
    if (fieldError) setFieldError("");
    // A complete code (typed, pasted or filled by the keyboard's one-time-code
    // suggestion) submits itself once; editing it re-arms the auto-submit.
    if (digits.length === codeLength && digits !== lastSubmitted.current && !(error && DEAD_CODE.has(error.code))) submit(digits);
  };

  const dead = error && DEAD_CODE.has(error.code);
  const deadMessage = !dead ? "" : error.code === "code_spent" ? SPENT_COPY : describeError(error, "code").message;

  return (
    <section className="mt-6 border-t border-border pt-5" aria-labelledby="code-h">
      <h2 id="code-h" className="text-[17px] font-semibold">
        Or type the {codeLength}-digit code from the email
      </h2>
      {standalone ? (
        <p className="mt-1 text-[14px] text-muted">
          You&apos;re in the installed app. Links from email open in your browser, so use the code here.
        </p>
      ) : (
        <p className="mt-1 text-[14px] text-muted">Handy if the link opens in a different browser or app.</p>
      )}
      <form
        className="mt-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <TextField
          ref={inputRef}
          label="Sign-in code"
          name="one-time-code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          // Wider than the code so a pasted "123 456" isn't cut before it is cleaned.
          maxLength={codeLength + 24}
          placeholder={"0".repeat(codeLength).replace(/0/g, "•")}
          value={code}
          onChange={onChange}
          error={fieldError}
          disabled={busy || Boolean(dead)}
          className="[&_input]:text-center [&_input]:text-[22px] [&_input]:tracking-[.3em] [&_input]:tabular-nums"
        />
        {error && !dead ? (
          <ErrorAlert className="mt-3" compact error={error} context="code" onRetry={() => submit()} onDismiss={() => setError(null)} />
        ) : null}
        {dead ? (
          <Alert
            tone="danger"
            compact
            className="mt-3"
            role="alert"
            action={{ label: "Send a new link", onClick: onResend, disabled: resendDisabled }}
          >
            {deadMessage}
          </Alert>
        ) : null}
        {!dead ? (
          <Button type="submit" fullWidth className="mt-3" loading={busy} loadingLabel="Signing in…" disabled={code.length === 0}>
            Sign in with code
          </Button>
        ) : null}
      </form>
    </section>
  );
}
