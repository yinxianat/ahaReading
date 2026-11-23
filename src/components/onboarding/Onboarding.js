"use client";
/**
 * Three-step onboarding (UX-SPEC 3.4). Each "Continue" PATCHes /api/me.
 * If saving "onboarded" fails, the user sees why and can retry — or continue
 * anyway: a session flag keeps AuthGuard from sending them straight back
 * here while the save is retried in the background (PO-4).
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client/api.js";
import { useUser } from "@/components/app/UserContext.js";
import { markOnboardingSkipped } from "@/lib/client/local-data.js";
import Button, { IconButton } from "@/components/ui/Button.js";
import ErrorAlert from "@/components/ui/ErrorAlert.js";

const LANGS = [
  { value: "en", title: "English", body: "Explanations in English" },
  { value: "zh", title: "English + 中文", body: "English, with a Chinese translation underneath · 英文解释并附中文翻译" },
];
const LEVELS = [
  { value: 1, title: "1 · Simple", body: "A cache keeps a copy of something nearby so you can get it faster." },
  { value: 2, title: "2 · Analogy", body: "Like keeping snacks on your desk instead of walking to the kitchen." },
  { value: 3, title: "3 · Deep dive", body: "How caches decide what to keep, when copies go stale, and why it matters." },
];
const STEPS = [
  { title: "Bring the text.", body: "Paste any article, or import it from a link." },
  { title: "Select what confuses you.", body: "Tap “I don't understand.” Still confused? Ask again — each step goes simpler, then deeper." },
  { title: "Keep what you learned.", body: "Save it to your Notebook. Short reviews bring it back right before you'd forget." },
];

function RadioCard({ name, checked, onChange, title, body, lang }) {
  return (
    <label
      className={`flex min-h-[72px] cursor-pointer items-start gap-3 rounded-md border p-4 ${checked ? "border-accent bg-accent-soft" : "border-border bg-surface"}`}
    >
      <input type="radio" name={name} checked={checked} onChange={onChange} className="mt-1 h-5 w-5 flex-none accent-[var(--accent)]" />
      <span className="min-w-0">
        <span className="block font-semibold">{title}</span>
        <span className="block text-[15px] text-muted" lang={lang}>
          {body}
        </span>
      </span>
    </label>
  );
}

function Demo() {
  const [level, setLevel] = useState(0);
  return (
    <div className="mt-6 rounded-md border border-border bg-surface p-4">
      <p className="font-reading text-read">
        Most web apps put a{" "}
        <button
          type="button"
          onClick={() => setLevel((l) => (l === 0 ? 1 : l))}
          className="relative rounded-[2px] px-0.5 font-semibold"
          style={{ background: "var(--selection)" }}
          aria-expanded={level > 0}
        >
          CDN
          {level === 0 ? <span className="pulse-dot absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-accent" aria-hidden="true" /> : null}
        </button>{" "}
        in front of their servers so pages load quickly worldwide.
      </p>
      {level === 0 ? <p className="mt-2 text-[14px] text-muted">Tap the highlighted word.</p> : null}
      {level > 0 ? (
        <div className="anim-fade mt-4 rounded-md border border-border bg-bg p-4">
          <p className="text-[12px] font-semibold tracking-[.04em] text-muted uppercase">{level === 1 ? "Level 1 · Simple" : "Level 2 · Analogy"}</p>
          <p className="mt-1 font-reading text-[17px] leading-relaxed">
            {level === 1
              ? "A CDN is a network of servers around the world that keeps copies of your site close to visitors."
              : "Like a chain of local libraries holding copies of a popular book, so nobody has to travel to the one central library."}
          </p>
          {level === 1 ? (
            <Button variant="secondary" className="mt-3" onClick={() => setLevel(2)}>
              Still confused
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default function Onboarding({ next }) {
  const router = useRouter();
  const { user, setUser } = useUser();
  const [step, setStep] = useState(0);
  const [locale, setLocale] = useState(user?.locale === "zh" ? "zh" : "en");
  const [helpLevel, setHelpLevel] = useState([1, 2, 3].includes(user?.helpLevel) ? user.helpLevel : 1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [finishError, setFinishError] = useState(null);
  const headingRef = useRef(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  const patch = async (body) => {
    const data = await api("/api/me", { method: "PATCH", body, timeoutMs: 15000 });
    if (data?.user) setUser(data.user);
    return data;
  };

  const finish = async () => {
    setSaving(true);
    setError(null);
    setFinishError(null);
    try {
      await patch({ onboarded: true });
    } catch (err) {
      // 401 is already redirecting to sign-in.
      if (err.code === "unauthenticated") return;
      setSaving(false);
      setFinishError(err);
      return;
    }
    setSaving(false);
    router.replace(next);
  };

  const continueAnyway = () => {
    markOnboardingSkipped();
    api("/api/me", { method: "PATCH", body: { onboarded: true }, timeoutMs: 15000, redirectOn401: false })
      .then((data) => data?.user && setUser(data.user))
      .catch(() => {
        // Still failing: onboarding shows again next session, nothing is lost.
      });
    router.replace(next);
  };

  const continueStep = async () => {
    if (step === 2) return finish();
    setSaving(true);
    setError(null);
    try {
      await patch(step === 0 ? { locale } : { helpLevel });
      setStep(step + 1);
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-dvh max-w-[560px] flex-col px-4 safe-top">
      <header className="flex min-h-[56px] items-center justify-between gap-2">
        <div className="w-11">{step > 0 ? <IconButton icon="chevronLeft" label="Back" onClick={() => setStep(step - 1)} /> : null}</div>
        <div className="flex items-center gap-2" aria-label={`Step ${step + 1} of 3`}>
          {[0, 1, 2].map((i) => (
            <span key={i} className={`h-2 w-2 rounded-full ${i === step ? "bg-accent" : "bg-border"}`} aria-hidden="true" />
          ))}
          <span className="ml-1 text-[14px] text-muted">Step {step + 1} of 3</span>
        </div>
        <button type="button" onClick={finish} className="min-h-[44px] rounded-md px-3 font-semibold text-accent" disabled={saving}>
          Skip
        </button>
      </header>

      <main id="main" className="flex-1 pt-6 pb-32">
        {step === 0 ? (
          <section>
            <h1 ref={headingRef} tabIndex={-1} className="text-[28px] leading-tight font-bold outline-none">
              How would you like explanations?
            </h1>
            <p className="mt-1 text-muted" lang="zh-Hans">
              你希望如何查看解释？
            </p>
            <fieldset className="mt-6 space-y-3">
              <legend className="sr-only">Explanation language</legend>
              {LANGS.map((l) => (
                <RadioCard key={l.value} name="locale" checked={locale === l.value} onChange={() => setLocale(l.value)} title={l.title} body={l.body} />
              ))}
            </fieldset>
          </section>
        ) : null}

        {step === 1 ? (
          <section>
            <h1 ref={headingRef} tabIndex={-1} className="text-[28px] leading-tight font-bold outline-none">
              Where should explanations start?
            </h1>
            <fieldset className="mt-6 space-y-3">
              <legend className="sr-only">Starting help level, shown for the word “cache”</legend>
              {LEVELS.map((l) => (
                <RadioCard key={l.value} name="level" checked={helpLevel === l.value} onChange={() => setHelpLevel(l.value)} title={l.title} body={l.body} />
              ))}
            </fieldset>
            <p className="mt-4 text-[14px] text-muted">You can always ask for a simpler or deeper explanation.</p>
          </section>
        ) : null}

        {step === 2 ? (
          <section>
            <h1 ref={headingRef} tabIndex={-1} className="text-[28px] leading-tight font-bold outline-none">
              Here&apos;s how it works.
            </h1>
            <ol className="mt-6 space-y-4">
              {STEPS.map((s, i) => (
                <li key={s.title} className="flex gap-4">
                  <span className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-full bg-accent-soft font-bold text-accent" aria-hidden="true">
                    {i + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="font-semibold">{s.title}</p>
                    <p className="text-muted">{s.body}</p>
                  </div>
                </li>
              ))}
            </ol>
            <Demo />
          </section>
        ) : null}

        {finishError ? (
          <div className="mt-5">
            <ErrorAlert
              error={finishError}
              context="settings"
              onRetry={finish}
              onDismiss={() => setFinishError(null)}
              extraActions={[{ label: "Continue anyway", onClick: continueAnyway }]}
            />
          </div>
        ) : null}
        {error ? (
          <div className="mt-5">
            <ErrorAlert error={error} context="settings" onRetry={continueStep} onDismiss={() => setError(null)} extraActions={[{ label: "Skip", onClick: finish }]} />
          </div>
        ) : null}
      </main>

      <div className="fixed inset-x-0 bottom-0 border-t border-border bg-bg px-4 pt-3" style={{ paddingBottom: "max(16px, env(safe-area-inset-bottom))" }}>
        <div className="mx-auto max-w-[560px]">
          <Button fullWidth size="lg" loading={saving} loadingLabel="Saving…" onClick={continueStep}>
            {step === 2 ? "Start reading" : "Continue"}
          </Button>
        </div>
      </div>
    </div>
  );
}
