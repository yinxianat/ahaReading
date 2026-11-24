"use client";
/**
 * The explain → escalate → translate → save loop (UX-SPEC 4.5–4.7). One
 * panel instance per selection: the parent keys it by snapshot id, so a new
 * selection starts fresh at the user's default level.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client/api.js";
import { AI_CLIENT_TIMEOUT_MS } from "@/lib/client/errors.js";
import { useOnline } from "@/lib/client/hooks.js";
import Sheet from "@/components/ui/Sheet.js";
import Button, { IconButton } from "@/components/ui/Button.js";
import { Segmented } from "@/components/ui/Tabs.js";
import { Skeleton } from "@/components/ui/Misc.js";
import ErrorAlert from "@/components/ui/ErrorAlert.js";
import Alert from "@/components/ui/Alert.js";
import { announce } from "@/components/ui/announce.js";
import LevelStepper, { LEVEL_NAMES } from "./LevelStepper.js";
import ExplanationText from "./ExplanationText.js";
import SaveConceptForm from "./SaveConceptForm.js";

const LOADING_LABEL = { 1: "Thinking…", 2: "Finding an analogy…", 3: "Digging deeper…" };
const IDLE_PHASE = { slow: false, verySlow: false };
// Errors where the Notebook is the useful way out while AI is unavailable.
const NOTEBOOK_WAYOUT = new Set(["ai_unavailable", "daily_limit"]);

/**
 * @param {object} props
 * @param {{highlightedText:string, surroundingText:string}} props.snapshot
 * @param {string} [props.articleId]
 * @param {number} props.defaultLevel
 * @param {string} props.locale "en" | "zh"
 * @param {string[]} props.suggestions tag suggestions
 * @param {(opts?:{restore?:boolean}) => void} props.onClose
 * @param {() => void} props.onPickSmaller level-3 hint
 * @param {() => void} props.onPickDifferent content_refused / invalid selection
 * @param {(concept:object) => void} props.onSaved
 */
export default function ExplainPanel({ snapshot, articleId, defaultLevel, locale, suggestions, onClose, onPickSmaller, onPickDifferent, onSaved, topOffset = 52 }) {
  const [levels, setLevels] = useState(() => ({ [defaultLevel]: { status: "loading" } }));
  const [level, setLevel] = useState(defaultLevel);
  const [phase, setPhase] = useState(IDLE_PHASE);
  const [showZh, setShowZh] = useState(locale === "zh");
  const [translations, setTranslations] = useState({});
  const [termOpen, setTermOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveSettled, setSaveSettled] = useState(false);
  const [expandKey, setExpandKey] = useState(0);
  const online = useOnline();

  const controller = useRef(null);
  const timers = useRef([]);
  const showZhRef = useRef(showZh);
  const translationsRef = useRef({});
  const translateCtl = useRef(null);
  // The level the user was reading before the request in flight (Cancel returns there).
  const backTo = useRef(null);
  const saveRef = useRef(null);

  useEffect(() => {
    showZhRef.current = showZh;
  }, [showZh]);

  const clearTimers = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };

  const translate = useCallback((explanationId, { force = false } = {}) => {
    const existing = translationsRef.current[explanationId];
    if (!force && existing && existing.status !== "error") return;
    const set = (v) => {
      translationsRef.current = { ...translationsRef.current, [explanationId]: v };
      setTranslations(translationsRef.current);
    };
    set({ status: "loading" });
    const c = new AbortController();
    translateCtl.current = c;
    api("/api/translate", { method: "POST", body: { explanationId }, signal: c.signal, timeoutMs: AI_CLIENT_TIMEOUT_MS })
      .then((data) => {
        set({ status: "ready", text: data?.translation || "" });
        announce("Translation ready.");
      })
      .catch((err) => {
        if (err.code === "aborted") return;
        set({ status: "error", error: err });
      });
  }, []);

  const fetchLevel = useCallback(
    (n) => {
      controller.current?.abort();
      const c = new AbortController();
      controller.current = c;
      clearTimers();
      timers.current = [
        // Cached answers arrive in < 150ms: no skeleton flash for them.
        setTimeout(() => {
          setPhase((p) => ({ ...p, slow: true }));
          announce(LOADING_LABEL[n]);
        }, 150),
        setTimeout(() => setPhase((p) => ({ ...p, verySlow: true })), 8000),
      ];
      const body = { highlightedText: snapshot.highlightedText, surroundingText: snapshot.surroundingText, helpLevel: n, language: "en" };
      if (articleId) body.articleId = articleId;
      api("/api/explain", { method: "POST", body, signal: c.signal, timeoutMs: AI_CLIENT_TIMEOUT_MS })
        .then((data) => {
          if (c.signal.aborted) return;
          setLevels((l) => ({ ...l, [n]: { status: "ready", data } }));
          announce(`Explanation ready, level ${n}, ${LEVEL_NAMES[n]}.`);
          if (showZhRef.current && data?.explanationId) translate(data.explanationId);
        })
        .catch((err) => {
          if (err.code === "aborted") return;
          setLevels((l) => ({ ...l, [n]: { status: "error", error: err } }));
        })
        .finally(() => {
          if (controller.current === c) {
            clearTimers();
            setPhase(IDLE_PHASE);
          }
        });
    },
    [snapshot, articleId, translate]
  );

  useEffect(() => {
    fetchLevel(defaultLevel);
    return () => {
      controller.current?.abort();
      translateCtl.current?.abort();
      clearTimers();
    };
  }, [fetchLevel, defaultLevel]);

  const startLevel = (n) => {
    if (levels[level]?.status === "ready" && level !== n) backTo.current = level;
    setLevels((l) => ({ ...l, [n]: { status: "loading" } }));
    setLevel(n);
    setPhase(IDLE_PHASE);
    fetchLevel(n);
  };

  const escalate = () => {
    const n = Math.min(3, level + 1);
    if (levels[n]?.status === "ready") setLevel(n);
    else startLevel(n);
  };

  const cancel = () => {
    controller.current?.abort();
    clearTimers();
    setPhase(IDLE_PHASE);
    const ready = [1, 2, 3].filter((n) => levels[n]?.status === "ready");
    if (ready.length === 0) {
      onClose({ restore: true });
      return;
    }
    setLevels((l) => {
      const copy = { ...l };
      delete copy[level];
      return copy;
    });
    setLevel(ready.includes(backTo.current) ? backTo.current : ready[ready.length - 1]);
  };

  // Levels below the highest one reached are always reachable — fetched on
  // demand if needed — so a user whose default is 2 or 3 can still go simpler
  // (PO-2). Only unfetched *deeper* levels wait for "Still confused".
  const highest = Math.max(level, ...[1, 2, 3].filter((n) => levels[n]?.status === "ready"));
  const selectLevel = (n) => {
    if (n === level && levels[n]?.status !== "error") return;
    if (levels[n]?.status === "ready") {
      setLevel(n);
      const id = levels[n].data?.explanationId;
      if (showZh && id) translate(id);
      return;
    }
    if (n < highest || n === level) startLevel(n);
  };
  const simpler = () => selectLevel(Math.max(1, level - 1));

  const openSave = () => {
    setSaveOpen(true);
    // Mobile sheet: grow to full height so the form and its Save button fit
    // beside the explanation (QA-5); then bring the form into view.
    setExpandKey((k) => k + 1);
    setTimeout(() => saveRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 350);
  };

  const toggleZh = (on) => {
    setShowZh(on);
    const id = levels[level]?.data?.explanationId;
    if (on && id) translate(id);
  };

  const current = levels[level] || { status: "loading" };
  const fetchedLevels = [1, 2, 3].filter((n) => levels[n]?.status === "ready");
  const explanationId = current.status === "ready" ? current.data?.explanationId : null;
  const translation = explanationId ? translations[explanationId] : null;

  // Compact header (label + phrase beside the close button) so a phone's bottom sheet
  // keeps most of its height for the explanation itself.
  const header = (
    <div className="px-4 pt-1">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 pt-1.5">
          <p className="text-[12px] font-semibold tracking-[.04em] text-muted uppercase">Explaining</p>
          <p className={`font-reading text-[19px] leading-snug break-anywhere ${termOpen ? "" : "line-clamp-2"}`}>{snapshot.highlightedText}</p>
          {snapshot.highlightedText.length > 80 ? (
            <button type="button" className="min-h-[32px] text-[14px] font-semibold text-accent" onClick={() => setTermOpen((o) => !o)} aria-expanded={termOpen}>
              {termOpen ? "less" : "more"}
            </button>
          ) : null}
        </div>
        <IconButton icon="x" label="Close explanation" className="-mr-2 flex-none" onClick={() => onClose()} />
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
        <LevelStepper level={level} fetchedLevels={fetchedLevels} reachableBelow={highest} onSelect={selectLevel} disabled={!online} />
        <Segmented
          size="sm"
          ariaLabel="Show Chinese translation"
          options={[
            { value: false, label: "EN" },
            { value: true, label: <span lang="zh-Hans">中文</span>, ariaLabel: "中文" },
          ]}
          value={showZh}
          onChange={toggleZh}
        />
      </div>
    </div>
  );

  let footer;
  if (current.status === "loading") {
    footer = (
      <Button variant="secondary" fullWidth onClick={cancel}>
        Cancel
      </Button>
    );
  } else if (current.status === "error") {
    footer = (
      <Button variant="secondary" fullWidth onClick={() => onClose()}>
        Close
      </Button>
    );
  } else if (saveOpen && !saveSettled) {
    // While the save form is open its own Save / Cancel are the actions; the
    // footer's room goes to the form and the explanation (QA-5).
    footer = null;
  } else {
    // One row of actions (wraps on very narrow screens), so the explanation gets the height.
    footer = (
      <div className="flex flex-wrap gap-2">
        {!saveOpen ? (
          <Button variant="tertiary" icon="bookmark" className="flex-none" onClick={openSave} disabled={!online} aria-label="Save to Notebook">
            Save
          </Button>
        ) : null}
        {level < 3 ? (
          <Button variant="secondary" className="min-w-[136px] flex-1 whitespace-nowrap" onClick={escalate} disabled={!online}>
            Still confused
          </Button>
        ) : null}
        <Button className="min-w-[96px] flex-1 whitespace-nowrap" onClick={() => onClose()}>
          Got it
        </Button>
      </div>
    );
  }

  return (
    <Sheet
      open
      onClose={() => onClose()}
      desktop="side"
      // Not modal: the article stays readable and scrollable behind the sheet, so the
      // surrounding text is always one scroll away.
      modal={false}
      title="Explanation"
      header={header}
      footer={footer}
      topOffset={topOffset}
      snapPoints={[0.55, 0.92]}
      expandKey={expandKey}
    >
      <div className="pt-4" aria-busy={current.status === "loading"}>
        {current.status === "loading" ? (
          phase.slow ? (
            <div>
              <p className="mb-3 text-[15px] font-semibold text-muted">{LOADING_LABEL[level]}</p>
              <Skeleton lines={4} widths={["100%", "95%", "88%", "60%"]} height={16} label={LOADING_LABEL[level]} />
              {phase.verySlow ? <p className="mt-2 text-[14px] text-muted">Still working — trying a backup. This can take up to 30 seconds.</p> : null}
            </div>
          ) : (
            <div style={{ minHeight: 120 }} />
          )
        ) : null}

        {current.status === "error" ? (
          <ErrorAlert
            error={current.error}
            context="explain"
            onRetry={() => startLevel(level)}
            onPickText={onPickDifferent}
            extraActions={
              NOTEBOOK_WAYOUT.has(current.error?.code)
                ? [{ label: "Open Notebook", href: "/notebook" }]
                : current.error?.code === "not_found"
                  ? [{ label: "Back to Library", href: "/read" }]
                  : []
            }
          />
        ) : null}

        {current.status === "ready" ? (
          <div key={level} className="anim-fade">
            <ExplanationText text={current.data?.explanation} className="font-reading text-read" />

            {showZh ? (
              <div className="mt-5 border-t border-border pt-4" lang="zh-Hans">
                <p className="mb-2 text-[12px] font-semibold tracking-[.04em] text-muted">中文翻译</p>
                {!translation || translation.status === "loading" ? (
                  <div>
                    <Skeleton lines={3} height={14} label="Translating" />
                    <p className="text-[14px] text-muted">正在翻译… Translating…</p>
                  </div>
                ) : null}
                {translation?.status === "ready" ? <ExplanationText text={translation.text} lang="zh-Hans" className="text-[17px] leading-relaxed" /> : null}
                {translation?.status === "error" ? (
                  <ErrorAlert
                    compact
                    error={translation.error}
                    context="translate"
                    onRetry={() => translate(explanationId, { force: true })}
                    extraActions={[
                      translation.error?.code === "not_found"
                        ? { label: "Explain again", onClick: () => startLevel(level) }
                        : { label: "Show English", onClick: () => setShowZh(false) },
                    ]}
                  />
                ) : null}
              </div>
            ) : null}

            {saveOpen ? (
              <div ref={saveRef} className="mt-5 scroll-mb-4">
                <SaveConceptForm
                  key={explanationId}
                  explanationId={explanationId}
                  suggestions={suggestions}
                  onSaved={onSaved}
                  disabled={!online}
                  initialMode="form"
                  onCancel={() => setSaveOpen(false)}
                  onExplainAgain={() => startLevel(level)}
                  defaultTerm={snapshot.highlightedText}
                  onSettled={() => setSaveSettled(true)}
                />
              </div>
            ) : null}

            {level === 3 ? (
              <Alert
                tone="neutral"
                className="mt-5"
                action={{ label: "Pick a smaller phrase", onClick: onPickSmaller }}
                secondaryAction={{ label: "Simpler, please", onClick: simpler }}
              >
                Still stuck? Try selecting a smaller phrase — one unfamiliar term often unlocks the whole sentence. Or go back to a simpler explanation.
              </Alert>
            ) : null}

            {!online ? (
              <Alert tone="warning" compact className="mt-4">
                You&apos;re offline. Explanations need an internet connection.
              </Alert>
            ) : null}
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}
