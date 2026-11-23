"use client";
/**
 * Flashcard (front: term; back: definition, 中文, note) and the
 * Forgot / Hard / Easy rating bar (UX-SPEC 6.3).
 */
import { useState } from "react";
import ExplanationText from "@/components/reader/ExplanationText.js";

/**
 * @param {{concept:object, revealed:boolean, onReveal:() => void, locale:string}} props
 */
export function Flashcard({ concept, revealed, onReveal, locale }) {
  const [zhOpen, setZhOpen] = useState(locale === "zh");
  if (!revealed) {
    return (
      <button
        type="button"
        aria-expanded={false}
        onClick={onReveal}
        className="anim-fade flex min-h-[280px] w-full flex-col items-center justify-center rounded-lg border border-border bg-surface p-6 text-center shadow-1"
      >
        <span className="text-[12px] font-semibold tracking-[.04em] text-muted uppercase">Do you remember?</span>
        <span className="mt-3 font-reading text-[24px] leading-snug break-anywhere">{concept.term}</span>
        {concept.articleTitle ? <span className="mt-3 text-[14px] text-muted break-anywhere">From {concept.articleTitle}</span> : null}
        <span className="sr-only">Show answer</span>
      </button>
    );
  }
  return (
    <div className="anim-fade min-h-[280px] rounded-lg border border-border bg-surface p-6 shadow-1" aria-live="polite">
      <p className="font-reading text-[18px] font-semibold break-anywhere">{concept.term}</p>
      <ExplanationText text={concept.definition} className="mt-3 font-reading text-[17px] leading-relaxed" />
      {concept.definitionZh ? (
        zhOpen ? (
          <div className="mt-4 border-t border-border pt-3" lang="zh-Hans">
            <ExplanationText text={concept.definitionZh} lang="zh-Hans" className="text-[16px] leading-relaxed" />
          </div>
        ) : (
          <button type="button" className="mt-3 min-h-[44px] font-semibold text-accent" onClick={() => setZhOpen(true)}>
            Show <span lang="zh-Hans">中文</span>
          </button>
        )
      ) : null}
      {concept.userNotes ? <blockquote className="mt-4 border-l-2 border-border pl-3 text-[15px] text-muted break-anywhere">{concept.userNotes}</blockquote> : null}
    </div>
  );
}

const RATINGS = [
  { quality: 1, label: "Forgot", key: "1", cls: "bg-danger-soft text-danger" },
  { quality: 3, label: "Hard", key: "2", cls: "bg-warning-soft text-warning" },
  { quality: 5, label: "Easy", key: "3", cls: "bg-success-soft text-success" },
];

/**
 * @param {{onRate:(q:number) => void, disabled?:boolean}} props
 */
export function RatingBar({ onRate, disabled }) {
  return (
    <div className="grid grid-cols-3 gap-2" role="group" aria-label="How well did you remember?">
      {RATINGS.map((r) => (
        <button
          key={r.quality}
          type="button"
          disabled={disabled}
          onClick={() => onRate(r.quality)}
          aria-keyshortcuts={r.key}
          className={`flex min-h-[56px] flex-col items-center justify-center rounded-md font-semibold ${r.cls} disabled:opacity-50`}
        >
          {r.label}
          <span className="hidden text-[12px] font-normal opacity-80 lg:block" aria-hidden="true">
            {r.key}
          </span>
        </button>
      ))}
    </div>
  );
}
