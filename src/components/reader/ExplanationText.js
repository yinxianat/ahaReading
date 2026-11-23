/**
 * Safe plain-text renderer for AI output (UX-SPEC 4.5 body): blank lines →
 * paragraphs, "- " / "• " lines → bullets, **x** → bold. Nothing else, and
 * never HTML.
 */

function inline(text) {
  const parts = String(text).split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) => (p.startsWith("**") && p.endsWith("**") && p.length > 4 ? <strong key={i}>{p.slice(2, -2)}</strong> : p));
}

/**
 * @param {{text:string, lang?:string, className?:string}} props
 */
export default function ExplanationText({ text, lang, className = "" }) {
  const blocks = String(text || "")
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  return (
    <div lang={lang} className={`space-y-3 break-anywhere ${className}`}>
      {blocks.map((block, i) => {
        const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
        const bullets = lines.every((l) => /^([-•*])\s+/.test(l));
        if (bullets) {
          return (
            <ul key={i} className="list-disc space-y-1 pl-5">
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(/^([-•*])\s+/, ""))}</li>
              ))}
            </ul>
          );
        }
        return <p key={i}>{inline(lines.join(" "))}</p>;
      })}
    </div>
  );
}
