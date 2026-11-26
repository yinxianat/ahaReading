"use client";
/**
 * "Listen" setup (design §3A): level, style and part length for an article or a selection.
 * Choices are remembered on this device. Creating the series plans its parts (one AI call),
 * then the player opens and writes part 1.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client/api.js";
import { useStoredState } from "@/lib/client/hooks.js";
import { LISTEN_LEVELS, LISTEN_STYLES, PART_MINUTE_CHOICES } from "@/lib/client/listen.js";
import Sheet from "@/components/ui/Sheet.js";
import Button from "@/components/ui/Button.js";
import { Segmented } from "@/components/ui/Tabs.js";
import ErrorAlert from "@/components/ui/ErrorAlert.js";

/**
 * @param {{articleId: string, quote?: string|null, language?: string, onClose: () => void}} props
 */
export default function ListenSetup({ articleId, quote = null, language = "en", onClose }) {
  const router = useRouter();
  const [level, setLevel] = useStoredState("aha.listen.level", "foundations");
  const [style, setStyle] = useStoredState("aha.listen.style", "ground_up");
  const [minutes, setMinutes] = useStoredState("aha.listen.minutes", "5");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const safeLevel = Object.hasOwn(LISTEN_LEVELS, level) ? level : "foundations";
  const safeStyle = Object.hasOwn(LISTEN_STYLES, style) ? style : "ground_up";
  const safeMinutes = PART_MINUTE_CHOICES.includes(Number(minutes)) ? Number(minutes) : 5;

  const start = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const data = await api("/api/listen", {
        method: "POST",
        body: { articleId, ...(quote ? { quote } : {}), level: safeLevel, style: safeStyle, partMinutes: safeMinutes, language },
        timeoutMs: 60_000,
      });
      router.push(`/listen/${encodeURIComponent(data.series.id)}?autoplay=1`);
    } catch (err) {
      setBusy(false);
      setError(err);
    }
  };

  const footer = (
    <div className="flex justify-end gap-2">
      <Button variant="secondary" onClick={onClose} disabled={busy}>
        Cancel
      </Button>
      <Button icon="headphones" onClick={start} loading={busy} loadingLabel="Planning your audio…">
        Start listening
      </Button>
    </div>
  );

  return (
    <Sheet open onClose={busy ? () => {} : onClose} title={quote ? "Listen to this selection" : "Listen to this article"} footer={footer} snapPoints={[0.85, 0.95]}>
      <div className="flex flex-col gap-5 pb-2">
        {quote ? <p className="line-clamp-2 text-[14px] text-muted">“{quote}”</p> : null}
        <p className="text-[14px] text-muted">Audio written for listening: no screen needed. Each part is saved, so you can come back to it any time.</p>

        <fieldset>
          <legend className="mb-2 font-semibold">Level</legend>
          <Segmented
            ariaLabel="Level"
            value={safeLevel}
            onChange={setLevel}
            className="w-full"
            options={Object.entries(LISTEN_LEVELS).map(([value, l]) => ({ value, label: l.short, ariaLabel: l.label }))}
          />
          <p className="mt-1.5 text-[13px] text-muted">{LISTEN_LEVELS[safeLevel].hint}</p>
        </fieldset>

        <fieldset>
          <legend className="mb-2 font-semibold">Style</legend>
          <div role="radiogroup" aria-label="Style" className="grid gap-2 sm:grid-cols-2">
            {Object.entries(LISTEN_STYLES).map(([value, s]) => {
              const checked = value === safeStyle;
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  onClick={() => setStyle(value)}
                  className={`rounded-md border p-3 text-left transition-colors ${checked ? "border-accent bg-accent-soft" : "border-border bg-surface hover:bg-surface-2"}`}
                >
                  <span className="block font-semibold">{s.label}</span>
                  <span className="mt-0.5 block text-[13px] text-muted">{s.hint}</span>
                </button>
              );
            })}
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-2 font-semibold">Length of each part</legend>
          <Segmented
            ariaLabel="Length of each part"
            value={String(safeMinutes)}
            onChange={setMinutes}
            className="w-full"
            options={PART_MINUTE_CHOICES.map((m) => ({ value: String(m), label: `${m} min`, ariaLabel: `${m} minutes` }))}
          />
          <p className="mt-1.5 text-[13px] text-muted">Longer material is split into parts of about this length.</p>
        </fieldset>

        {error ? <ErrorAlert error={error} context="listen" onRetry={start} onDismiss={() => setError(null)} /> : null}
      </div>
    </Sheet>
  );
}
