/**
 * Safe plain-text renderer for AI output (UX-SPEC 4.5 body): blank lines →
 * paragraphs, "- " / "• " lines → bullets, "1." / "1)" lines → a numbered list,
 * **x** → bold. Nothing else, and never HTML.
 */

import { explanationBlocks } from "@/lib/client/explanation-blocks.js";

function inline(text) {
  const parts = String(text).split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) => (p.startsWith("**") && p.endsWith("**") && p.length > 4 ? <strong key={i}>{p.slice(2, -2)}</strong> : p));
}

/**
 * @param {{text:string, lang?:string, className?:string}} props
 */
export default function ExplanationText({ text, lang, className = "" }) {
  return (
    <div lang={lang} className={`space-y-3 break-anywhere ${className}`}>
      {explanationBlocks(text).map((b, i) => {
        if (b.type === "ul") {
          return (
            <ul key={i} className="list-disc space-y-1 pl-5">
              {b.items.map((item, j) => (
                <li key={j}>{inline(item)}</li>
              ))}
            </ul>
          );
        }
        if (b.type === "ol") {
          return (
            <ol key={i} start={b.start === 1 ? undefined : b.start} className="list-decimal space-y-2 pl-6">
              {b.items.map((item, j) => (
                <li key={j}>{inline(item)}</li>
              ))}
            </ol>
          );
        }
        return <p key={i}>{inline(b.text)}</p>;
      })}
    </div>
  );
}
