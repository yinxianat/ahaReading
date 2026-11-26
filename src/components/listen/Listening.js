"use client";
/**
 * Listening history (/listen): every series with its progress ("Part 3 of 6 · In progress"),
 * newest listened first. Tap to resume exactly where you stopped.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/client/api.js";
import { LISTEN_STYLES, LISTEN_LEVELS } from "@/lib/client/listen.js";
import { relativeTime } from "@/lib/client/relative-time.js";
import TopBar from "@/components/app/TopBar.js";
import Dialog from "@/components/ui/Dialog.js";
import Button, { IconButton } from "@/components/ui/Button.js";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/Misc.js";
import Icon from "@/components/ui/icons.js";
import { useToast } from "@/components/ui/Toast.js";

function progress(series) {
  const parts = series.parts;
  const played = parts.filter((p) => p.completedAt).length;
  if (played === parts.length && parts.length) return "Finished";
  const current = parts.find((p) => !p.completedAt) || parts[0];
  const started = current && (current.position.chapter > 0 || current.position.sentence > 0);
  return `Part ${(current?.order ?? 0) + 1} of ${parts.length}${started ? " · In progress" : played ? "" : " · Not started"}`;
}

export default function Listening() {
  const { toast } = useToast();
  const [state, setState] = useState({ status: "loading", series: [], usage: null });
  const [attempt, setAttempt] = useState(0);
  const [confirm, setConfirm] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [now, setNow] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    api("/api/listen", { signal: controller.signal, timeoutMs: 15000 })
      .then((data) => {
        setNow(Date.now());
        setState({ status: "ready", series: data?.series || [], usage: data?.usage || null });
      })
      .catch((err) => {
        if (err.code !== "aborted") setState((s) => ({ ...s, status: "error", error: err }));
      });
    return () => controller.abort();
  }, [attempt]);

  const remove = async () => {
    if (!confirm || deleting) return;
    setDeleting(true);
    try {
      await api(`/api/listen/${encodeURIComponent(confirm.id)}`, { method: "DELETE", timeoutMs: 15000 });
      setState((s) => ({ ...s, series: s.series.filter((x) => x.id !== confirm.id) }));
      toast({ message: "Listening series deleted." });
      setConfirm(null);
    } catch (err) {
      toast({ message: err.message || "We couldn't delete it. Try again.", tone: "danger" });
    } finally {
      setDeleting(false);
    }
  };

  const usage = state.usage;
  return (
    <main id="main" className="app-main mx-auto max-w-[720px] px-4 md:px-6 pb-24">
      <TopBar
        back={{ href: "/read", label: "Library" }}
        title="Listening"
        sub={usage ? `${usage.usedMinutes} of ${usage.dailyMinutes} audio minutes used today` : "Audio made from your reading"}
      />
      {state.status === "loading" ? <Skeleton lines={5} label="Loading listening history" /> : null}
      {state.status === "error" ? <ErrorState error={state.error} onRetry={() => setAttempt((a) => a + 1)} /> : null}
      {state.status === "ready" && state.series.length === 0 ? (
        <EmptyState
          icon="headphones"
          title="Nothing to listen to yet"
          body="Open an article and choose Listen, or select a passage and tap the headphones. You pick the level, the style and how long each part is."
          action={<Button href="/read">Go to Library</Button>}
        />
      ) : null}
      {state.status === "ready" && state.series.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {state.series.map((s) => (
            <li key={s.id} className="flex items-stretch gap-1 rounded-lg border border-border bg-surface">
              <Link href={`/listen/${encodeURIComponent(s.id)}`} className="flex min-w-0 flex-1 items-center gap-3 p-3 text-text no-underline">
                <span className="inline-flex h-10 w-10 flex-none items-center justify-center rounded-full bg-accent-soft text-accent">
                  <Icon name="headphones" size={20} />
                </span>
                <span className="min-w-0">
                  <span className="block font-semibold break-anywhere">{s.title}</span>
                  <span className="block text-[13px] text-muted break-anywhere">
                    {[progress(s), LISTEN_STYLES[s.style]?.label, LISTEN_LEVELS[s.level]?.label].filter(Boolean).join(" · ")}
                  </span>
                  <span className="block text-[13px] text-muted break-anywhere">
                    {s.sourceTitle}
                    {now && s.lastListenedAt ? ` · ${relativeTime(s.lastListenedAt, now)}` : ""}
                  </span>
                </span>
              </Link>
              <IconButton icon="trash" label={`Delete ${s.title}`} onClick={() => setConfirm(s)} className="self-center" />
            </li>
          ))}
        </ul>
      ) : null}
      <Dialog
        open={Boolean(confirm)}
        onClose={() => !deleting && setConfirm(null)}
        title="Delete this listening series?"
        description="Its parts and progress are removed. Minutes already used today stay used."
        actions={
          <>
            <Button variant="secondary" onClick={() => setConfirm(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="danger" onClick={remove} loading={deleting} loadingLabel="Deleting…">
              Delete
            </Button>
          </>
        }
      />
    </main>
  );
}
