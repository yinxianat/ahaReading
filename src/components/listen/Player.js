"use client";
/**
 * The listening player (/listen/:id), built to work without looking (design §3A):
 * play/pause, back 15 s, forward 30 s, previous/next chapter and part, speed, voice, sleep
 * timer, continuous play, lock-screen and headphone controls (Media Session, where the
 * browser offers them), and an optional transcript that follows along.
 *
 * Parts are written when first played (POST …/parts/:order); the next part is written ahead
 * once the current one is half done. Progress (chapter + sentence) is saved as you listen, so
 * any device resumes at the same sentence. Speech goes through lib/client/speech, so a server
 * voice can replace the browser's without changing this component.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/client/api.js";
import { useStoredState } from "@/lib/client/hooks.js";
import { getSpeechProvider } from "@/lib/client/speech/index.js";
import { buildQueue, createPlayer, indexFor, splitSentences } from "@/lib/client/speech/player.js";
import { LISTEN_LEVELS, LISTEN_STYLES, aboutMinutes, formatClock, partIntro } from "@/lib/client/listen.js";
import TopBar from "@/components/app/TopBar.js";
import Alert from "@/components/ui/Alert.js";
import Button, { IconButton } from "@/components/ui/Button.js";
import ErrorAlert from "@/components/ui/ErrorAlert.js";
import { ErrorState, Skeleton } from "@/components/ui/Misc.js";
import Icon from "@/components/ui/icons.js";
import { announce } from "@/components/ui/announce.js";

const RATES = ["0.75", "1", "1.25", "1.5", "1.75", "2"];
const SLEEP = [
  { value: "off", label: "Off" },
  { value: "10", label: "10 min" },
  { value: "20", label: "20 min" },
  { value: "30", label: "30 min" },
  { value: "part", label: "End of this part" },
];
const SAVE_EVERY_MS = 4000;
const LANG = { en: "en-US", zh: "zh-CN" };

function partLabel(p) {
  if (p.completedAt) return "Played";
  if (p.position.chapter > 0 || p.position.sentence > 0) return "In progress";
  if (p.status === "ready") return aboutMinutes(p.durationSec);
  return "Written when you play it";
}

export default function Player({ seriesId }) {
  const params = useSearchParams();
  const [load, setLoad] = useState({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [order, setOrder] = useState(null);
  const [partState, setPartState] = useState({ status: "idle" });
  const [ps, setPs] = useState(null); // player state
  const [provider, setProvider] = useState(undefined);
  const [voices, setVoices] = useState([]);
  const [rate, setRate] = useStoredState("aha.listen.rate", "1");
  const [voiceId, setVoiceId] = useStoredState("aha.listen.voice", "");
  const [continuous, setContinuous] = useStoredState("aha.listen.continuous", "1");
  const [showTranscript, setShowTranscript] = useStoredState("aha.listen.transcript", "1");
  const [sleep, setSleep] = useState({ value: "off", until: 0 });
  const [speechError, setSpeechError] = useState(null);

  const playerRef = useRef(null);
  const autoplayRef = useRef(params.get("autoplay") === "1");
  const saveRef = useRef({ at: 0, key: "" });
  const prefetchRef = useRef(new Set());
  const seriesRef = useRef(null);
  const orderRef = useRef(null);
  const sleepRef = useRef(sleep);
  useEffect(() => {
    sleepRef.current = sleep;
  }, [sleep]);

  const series = load.status === "ready" ? load.series : null;
  const parts = useMemo(() => series?.parts || [], [series]);
  const part = order === null ? null : parts.find((p) => p.order === order) || null;
  useEffect(() => {
    seriesRef.current = series;
    orderRef.current = order;
  }, [series, order]);

  // Speech is browser-only: pick the provider after mount.
  useEffect(() => {
    const p = getSpeechProvider();
    queueMicrotask(() => setProvider(p));
    if (p) p.voices().then(setVoices).catch(() => {});
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    api(`/api/listen/${encodeURIComponent(seriesId)}`, { signal: controller.signal, timeoutMs: 15000 })
      .then((data) => {
        setLoad({ status: "ready", series: data.series, usage: data.usage });
        const wanted = Number(params.get("part"));
        const list = data.series.parts;
        const start = Number.isInteger(wanted) && list.some((p) => p.order === wanted) ? wanted : (list.find((p) => !p.completedAt) || list[0])?.order ?? 0;
        setOrder((o) => (o === null ? start : o));
      })
      .catch((err) => {
        if (err.code !== "aborted") setLoad({ status: "error", error: err });
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload only on retry
  }, [seriesId, attempt]);

  const updatePart = useCallback((next, usage) => {
    setLoad((l) => (l.status !== "ready" ? l : { ...l, usage: usage || l.usage, series: { ...l.series, parts: l.series.parts.map((p) => (p.order === next.order ? { ...p, ...next } : p)) } }));
  }, []);

  /** Write a part if needed. 409 (being written elsewhere) waits and asks again. */
  const writePart = useCallback(
    async (n, { quiet = false } = {}) => {
      for (let tries = 0; tries < 24; tries++) {
        try {
          const data = await api(`/api/listen/${encodeURIComponent(seriesId)}/parts/${n}`, { method: "POST", timeoutMs: 110_000 });
          updatePart(data.part, data.usage);
          return data.part;
        } catch (err) {
          if (err.code === "audio_generating") {
            await new Promise((r) => setTimeout(r, (err.retryAfter || 5) * 1000));
            continue;
          }
          if (!quiet) throw err;
          return null;
        }
      }
      if (!quiet) throw Object.assign(new Error("timeout"), { code: "timeout" });
      return null;
    },
    [seriesId, updatePart]
  );

  const saveProgress = useCallback(
    (state, { completed, keepalive = false } = {}) => {
      const n = orderRef.current;
      if (n === null || !state) return;
      const body = { chapter: state.chapter, sentence: state.sentence, ...(completed !== undefined ? { completed } : {}) };
      saveRef.current = { at: Date.now(), key: `${n}:${state.chapter}:${state.sentence}` };
      api(`/api/listen/${encodeURIComponent(seriesId)}/parts/${n}`, { method: "PATCH", body, keepalive, redirectOn401: false, timeoutMs: 10000 })
        .then((data) => data?.part && updatePart(data.part))
        .catch(() => {});
    },
    [seriesId, updatePart]
  );

  const goToPart = useCallback((n, { autoplay = false } = {}) => {
    autoplayRef.current = autoplay;
    playerRef.current?.pause();
    setOrder(n);
  }, []);

  // One engine per provider.
  useEffect(() => {
    if (!provider) return undefined;
    const player = createPlayer({
      provider,
      onChange: (s) => {
        setPs(s);
        const key = `${orderRef.current}:${s.chapter}:${s.sentence}`;
        if (s.playing && key !== saveRef.current.key && Date.now() - saveRef.current.at > SAVE_EVERY_MS) saveProgress(s);
      },
      onEnded: () => {
        const s = seriesRef.current;
        const n = orderRef.current;
        saveProgress({ chapter: 0, sentence: 0 }, { completed: true });
        announce("Part finished.");
        if (sleepRef.current.value === "part") {
          setSleep({ value: "off", until: 0 });
          return;
        }
        const next = s?.parts.find((p) => p.order === n + 1);
        if (next && continuous !== "0") goToPart(next.order, { autoplay: true });
      },
      onError: (err) => {
        // Browsers refuse speech before the first tap on the page; that's a paused player, not an error.
        if (err?.message !== "not-allowed") setSpeechError(err);
      },
    });
    playerRef.current = player;
    return () => {
      player.destroy();
      playerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recreated only when the voice provider changes
  }, [provider]);

  useEffect(() => {
    playerRef.current?.setRate(Number(rate));
  }, [rate, provider]);
  useEffect(() => {
    playerRef.current?.setVoice(voiceId);
  }, [voiceId, provider]);

  // Load the current part into the engine (writing it first if needed).
  const partId = part?.id;
  const partReady = part?.status === "ready" && Array.isArray(part?.chapters);
  useEffect(() => {
    if (!part || provider === undefined) return undefined;
    let cancelled = false;
    if (!partReady) {
      queueMicrotask(() => setPartState({ status: "writing" }));
      writePart(part.order)
        .then(() => !cancelled && setPartState({ status: "idle" }))
        .catch((err) => !cancelled && setPartState({ status: "error", error: err }));
      return () => {
        cancelled = true;
      };
    }
    const queue = buildQueue(part, { intro: partIntro(part, parts.length), lang: LANG[series.language] || "en-US" });
    const start = part.completedAt ? 0 : indexFor(queue, part.position);
    playerRef.current?.load(queue, start);
    if (!playerRef.current) setPs({ playing: false, index: start, length: queue.length, chapter: queue[start]?.chapter ?? 0, sentence: 0, secondsLeft: 0, secondsTotal: 0, rate: 1 });
    if (autoplayRef.current && playerRef.current) {
      autoplayRef.current = false;
      playerRef.current.play();
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when the part (or its script) changes
  }, [partId, partReady, provider]);

  // Write the next part ahead once this one is half done.
  useEffect(() => {
    if (!ps || !part || ps.length === 0 || ps.index / ps.length < 0.5) return;
    const next = parts.find((p) => p.order === part.order + 1);
    if (!next || next.status === "ready" || prefetchRef.current.has(next.order)) return;
    prefetchRef.current.add(next.order);
    writePart(next.order, { quiet: true });
  }, [ps, part, parts, writePart]);

  // Save on pause, when the tab is hidden, and when leaving.
  const wasPlaying = useRef(false);
  useEffect(() => {
    if (wasPlaying.current && ps && !ps.playing) saveProgress(ps);
    wasPlaying.current = Boolean(ps?.playing);
  }, [ps, saveProgress]);
  useEffect(() => {
    const hide = () => {
      if (document.visibilityState === "hidden" && playerRef.current) saveProgress(playerRef.current.state, { keepalive: true });
    };
    document.addEventListener("visibilitychange", hide);
    return () => {
      document.removeEventListener("visibilitychange", hide);
      if (playerRef.current?.state.playing) saveProgress(playerRef.current.state, { keepalive: true });
    };
  }, [saveProgress]);

  // Sleep timer.
  useEffect(() => {
    if (!sleep.until) return undefined;
    const t = setTimeout(() => {
      playerRef.current?.pause();
      setSleep({ value: "off", until: 0 });
      announce("Sleep timer: paused.");
    }, Math.max(0, sleep.until - Date.now()));
    return () => clearTimeout(t);
  }, [sleep]);

  const prevPart = parts.find((p) => p.order === (part?.order ?? 0) - 1);
  const nextPart = parts.find((p) => p.order === (part?.order ?? 0) + 1);

  // Lock-screen and headphone controls, where the browser offers them for speech.
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.mediaSession || !part || !series) return undefined;
    const ms = navigator.mediaSession;
    try {
      if (typeof window.MediaMetadata === "function") ms.metadata = new window.MediaMetadata({ title: part.title, artist: "AhaReading", album: series.title });
      const set = (action, fn) => {
        try {
          ms.setActionHandler(action, fn);
        } catch {
          // action not supported by this browser
        }
      };
      set("play", () => playerRef.current?.play());
      set("pause", () => playerRef.current?.pause());
      set("seekbackward", () => playerRef.current?.skipSeconds(-15));
      set("seekforward", () => playerRef.current?.skipSeconds(30));
      set("previoustrack", prevPart ? () => goToPart(prevPart.order, { autoplay: true }) : null);
      set("nexttrack", nextPart ? () => goToPart(nextPart.order, { autoplay: true }) : null);
    } catch {
      // Media Session is optional
    }
    return () => {
      for (const a of ["play", "pause", "seekbackward", "seekforward", "previoustrack", "nexttrack"]) {
        try {
          ms.setActionHandler(a, null);
        } catch {
          // ignore
        }
      }
    };
  }, [part, series, prevPart, nextPart, goToPart]);
  useEffect(() => {
    if (typeof navigator !== "undefined" && navigator.mediaSession) navigator.mediaSession.playbackState = ps?.playing ? "playing" : "paused";
  }, [ps?.playing]);

  // Follow along in the transcript.
  const transcriptRef = useRef(null);
  useEffect(() => {
    if (!ps?.playing || showTranscript !== "1") return;
    const el = transcriptRef.current?.querySelector('[data-current="true"]');
    el?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [ps?.index, ps?.playing, showTranscript]);

  if (load.status === "loading") {
    return (
      <main id="main" className="app-main mx-auto max-w-[720px] px-4 md:px-6">
        <TopBar back={{ href: "/listen", label: "Listening" }} />
        <Skeleton variant="block" height={28} className="mb-3 w-3/4" />
        <Skeleton lines={6} label="Loading audio" />
      </main>
    );
  }
  if (load.status === "error") {
    return (
      <main id="main" className="app-main mx-auto max-w-[720px] px-4 md:px-6">
        <TopBar back={{ href: "/listen", label: "Listening" }} />
        <ErrorState error={load.error} onRetry={() => setAttempt((a) => a + 1)} />
      </main>
    );
  }

  const playing = Boolean(ps?.playing);
  const ready = partReady && provider !== undefined;
  const canSpeak = Boolean(provider);
  const level = LISTEN_LEVELS[series.level]?.label || series.level;
  const style = LISTEN_STYLES[series.style]?.label || series.style;
  const done = ps && ps.secondsTotal ? Math.min(100, Math.round(((ps.secondsTotal - ps.secondsLeft) / ps.secondsTotal) * 100)) : 0;

  return (
    <main id="main" className="app-main mx-auto max-w-[720px] px-4 md:px-6 pb-32">
      <TopBar back={{ href: "/listen", label: "Listening" }} title={series.title} sub={[style, level, series.sourceKind === "selection" ? "From a selection" : null].filter(Boolean).join(" · ")} />
      {series.articleId ? (
        <p className="-mt-1 mb-4 text-[14px] text-muted break-anywhere">
          From{" "}
          <Link href={`/read/${encodeURIComponent(series.articleId)}`} className="font-semibold">
            {series.sourceTitle}
          </Link>
        </p>
      ) : null}

      {provider === null ? (
        <Alert tone="warning" className="mb-4" action={{ label: "Show transcript", onClick: () => setShowTranscript("1") }}>
          This browser can&apos;t read text aloud. Try Chrome, Edge or Safari, or read the transcript below.
        </Alert>
      ) : null}
      {speechError ? (
        <Alert tone="warning" className="mb-4" onDismiss={() => setSpeechError(null)} action={{ label: "Play again", onClick: () => { setSpeechError(null); playerRef.current?.play(); } }}>
          The voice stopped unexpectedly. Press play to carry on from this sentence.
        </Alert>
      ) : null}

      <section aria-label="Player" className="rounded-lg border border-border bg-surface p-4 shadow-1">
        <p className="text-[13px] font-semibold uppercase tracking-wide text-muted">
          Part {(part?.order ?? 0) + 1} of {parts.length}
        </p>
        <h2 className="mt-0.5 text-[20px] font-semibold break-anywhere">{part?.title}</h2>
        {partReady && ps ? (
          <p className="mt-1 text-[14px] text-muted" aria-live="off">
            {part.chapters[ps.chapter]?.title ? `${part.chapters[ps.chapter].title} · ` : ""}
            {formatClock(ps.secondsLeft)} left
          </p>
        ) : null}
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-label="Part progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={done}>
          <div className="h-full bg-accent transition-[width]" style={{ width: `${done}%` }} />
        </div>

        {partState.status === "writing" ? (
          <p className="mt-4 flex items-center gap-2 text-muted" role="status">
            <span className="spinner" aria-hidden="true" /> Writing this part for listening… this takes up to a minute.
          </p>
        ) : null}
        {partState.status === "error" ? (
          <ErrorAlert
            className="mt-4"
            error={partState.error}
            context="listen"
            onRetry={() => {
              setPartState({ status: "writing" });
              writePart(part.order)
                .then(() => setPartState({ status: "idle" }))
                .catch((err) => setPartState({ status: "error", error: err }));
            }}
          />
        ) : null}

        <div className="mt-4 flex items-center justify-center gap-1 sm:gap-3">
          <IconButton icon="skipBack" label="Previous chapter" onClick={() => playerRef.current?.prevChapter()} disabled={!ready || !canSpeak} />
          <IconButton icon="back15" label="Back 15 seconds" onClick={() => playerRef.current?.skipSeconds(-15)} disabled={!ready || !canSpeak} />
          <button
            type="button"
            onClick={() => {
              setSpeechError(null);
              playerRef.current?.toggle();
            }}
            disabled={!ready || !canSpeak}
            aria-label={playing ? "Pause" : "Play"}
            className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-accent text-accent-fg shadow-2 disabled:opacity-50"
          >
            <Icon name={playing ? "pause" : "play"} size={30} />
          </button>
          <IconButton icon="forward30" label="Forward 30 seconds" onClick={() => playerRef.current?.skipSeconds(30)} disabled={!ready || !canSpeak} />
          <IconButton icon="skipForward" label="Next chapter" onClick={() => playerRef.current?.nextChapter()} disabled={!ready || !canSpeak} />
        </div>

        <div className="mt-3 flex justify-between gap-2">
          <Button variant="text" icon="chevronLeft" disabled={!prevPart} onClick={() => prevPart && goToPart(prevPart.order)}>
            Previous part
          </Button>
          <Button variant="text" disabled={!nextPart} onClick={() => nextPart && goToPart(nextPart.order, { autoplay: playing })}>
            <span className="inline-flex items-center gap-1 whitespace-nowrap">
              Next part <Icon name="chevronRight" size={20} />
            </span>
          </Button>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label className="flex flex-col gap-1 text-[13px] font-semibold text-muted">
            Speed
            <select className="min-h-[44px] rounded-md border border-border bg-surface px-2 text-[15px] text-text" value={RATES.includes(rate) ? rate : "1"} onChange={(e) => setRate(e.target.value)}>
              {RATES.map((r) => (
                <option key={r} value={r}>
                  {r}×
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[13px] font-semibold text-muted">
            Sleep timer
            <select
              className="min-h-[44px] rounded-md border border-border bg-surface px-2 text-[15px] text-text"
              value={sleep.value}
              onChange={(e) => {
                const v = e.target.value;
                setSleep({ value: v, until: /^\d+$/.test(v) ? Date.now() + Number(v) * 60_000 : 0 });
              }}
            >
              {SLEEP.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="col-span-2 flex flex-col gap-1 text-[13px] font-semibold text-muted">
            Voice
            <select className="min-h-[44px] rounded-md border border-border bg-surface px-2 text-[15px] text-text" value={voiceId} onChange={(e) => setVoiceId(e.target.value)} disabled={!canSpeak}>
              <option value="">Device default</option>
              {voices
                .filter((v) => v.lang.toLowerCase().startsWith(series.language === "zh" ? "zh" : "en"))
                .map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <label className="mt-3 flex min-h-[44px] items-center gap-2">
          <input type="checkbox" className="h-5 w-5" checked={continuous !== "0"} onChange={(e) => setContinuous(e.target.checked ? "1" : "0")} />
          Play the next part automatically
        </label>
      </section>

      <section aria-label="Parts" className="mt-6">
        <h2 className="mb-2 text-[17px] font-semibold">Parts</h2>
        <ol className="flex flex-col gap-1">
          {parts.map((p) => {
            const current = p.order === part?.order;
            return (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => goToPart(p.order)}
                  aria-current={current ? "true" : undefined}
                  className={`flex min-h-[52px] w-full items-center gap-3 rounded-md px-3 text-left ${current ? "bg-accent-soft" : "hover:bg-surface-2"}`}
                >
                  <span className="w-6 flex-none text-center font-semibold text-muted">{p.completedAt ? <Icon name="check" size={18} /> : p.order + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold break-anywhere">{p.title}</span>
                    <span className="block text-[13px] text-muted">{partLabel(p)}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </section>

      <section aria-label="Transcript" className="mt-6">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-[17px] font-semibold">Transcript</h2>
          <Button variant="text" onClick={() => setShowTranscript(showTranscript === "1" ? "0" : "1")} aria-expanded={showTranscript === "1"}>
            {showTranscript === "1" ? "Hide" : "Show"}
          </Button>
        </div>
        {showTranscript === "1" && partReady ? (
          <div ref={transcriptRef} className="flex flex-col gap-4 text-[16px] leading-relaxed">
            {part.chapters.map((c, ci) => (
              <div key={ci}>
                <h3 className="mb-1 font-semibold">{c.title}</h3>
                <p>
                  {splitSentences(c.text).map((s, si) => {
                    if (/^\[pause\]$/i.test(s)) return <span key={si} className="mx-1 text-muted">(pause) </span>;
                    const isCurrent = ps && ps.chapter === ci && ps.sentence === si;
                    return (
                      <span
                        key={si}
                        data-current={isCurrent ? "true" : undefined}
                        onClick={() => {
                          const player = playerRef.current;
                          if (!player) return;
                          const queue = buildQueue(part, { intro: partIntro(part, parts.length) });
                          player.seek(queue.findIndex((q) => q.chapter === ci && q.sentence === si));
                        }}
                        className={`cursor-pointer rounded-sm ${isCurrent ? "bg-accent-soft" : ""}`}
                      >
                        {s}{" "}
                      </span>
                    );
                  })}
                </p>
              </div>
            ))}
          </div>
        ) : showTranscript === "1" ? (
          <p className="text-muted">The transcript appears once this part is written.</p>
        ) : null}
      </section>

      {load.usage ? (
        <p className="mt-6 text-[13px] text-muted">
          {load.usage.usedMinutes} of {load.usage.dailyMinutes} audio minutes used today.
        </p>
      ) : null}
    </main>
  );
}
