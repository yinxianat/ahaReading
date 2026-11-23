"use client";
/**
 * Labelled inputs with helper/error text wired through aria-describedby.
 */
import { forwardRef, useId, useLayoutEffect, useRef } from "react";

const inputBase =
  "w-full min-h-[44px] rounded-sm border bg-surface px-3 py-2 text-[16px] text-text placeholder:text-muted " +
  "focus:outline-none focus:border-accent focus-visible:shadow-[var(--focus)] disabled:opacity-60";

function Help({ id, error, helper, counter }) {
  if (!error && !helper && !counter) return null;
  return (
    <div className="mt-1 flex items-start justify-between gap-3 text-[14px]">
      <p id={id} className={`min-w-0 break-anywhere ${error ? "text-danger" : "text-muted"}`}>
        {error || helper}
      </p>
      {counter ? <span className={`flex-none tabular-nums ${counter.over ? "text-danger" : "text-muted"}`}>{counter.text}</span> : null}
    </div>
  );
}

/**
 * @param {{label:string, error?:string, helper?:string, counter?:{text:string,over?:boolean}, hideLabel?:boolean}} props
 */
export const TextField = forwardRef(function TextField(
  { label, error, helper, counter, hideLabel = false, id: idProp, className = "", ...rest },
  ref
) {
  const autoId = useId();
  const id = idProp || autoId;
  const helpId = `${id}-help`;
  return (
    <div className={className}>
      <label htmlFor={id} className={hideLabel ? "sr-only" : "mb-1 block text-[14px] font-semibold"}>
        {label}
      </label>
      <input
        ref={ref}
        id={id}
        className={`${inputBase} ${error ? "border-danger" : "border-border"}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || helper ? helpId : undefined}
        {...rest}
      />
      <Help id={helpId} error={error} helper={helper} counter={counter} />
    </div>
  );
});

/**
 * Auto-growing textarea.
 * @param {{label:string, error?:string, helper?:string, counter?:{text:string,over?:boolean}, minHeight?:number, maxHeightVh?:number}} props
 */
export const TextArea = forwardRef(function TextArea(
  { label, error, helper, counter, hideLabel = false, id: idProp, className = "", minHeight = 96, maxHeightVh = 50, value, ...rest },
  ref
) {
  const autoId = useId();
  const id = idProp || autoId;
  const helpId = `${id}-help`;
  const innerRef = useRef(null);
  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    el.style.height = "auto";
    const max = (window.innerHeight * maxHeightVh) / 100;
    el.style.height = `${Math.min(Math.max(el.scrollHeight, minHeight), max)}px`;
  }, [value, minHeight, maxHeightVh]);
  const setRefs = (el) => {
    innerRef.current = el;
    if (typeof ref === "function") ref(el);
    else if (ref) ref.current = el;
  };
  return (
    <div className={className}>
      <label htmlFor={id} className={hideLabel ? "sr-only" : "mb-1 block text-[14px] font-semibold"}>
        {label}
      </label>
      <textarea
        ref={setRefs}
        id={id}
        value={value}
        style={{ minHeight }}
        className={`${inputBase} resize-none ${error ? "border-danger" : "border-border"}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || helper ? helpId : undefined}
        {...rest}
      />
      <Help id={helpId} error={error} helper={helper} counter={counter} />
    </div>
  );
});
