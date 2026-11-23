"use client";
/**
 * Article blocks (paragraphs, headings, list items, code) with saved-concept
 * marks and the active/tap highlight (UX-SPEC 3.6, 4.8, PO-6). Every block is
 * one `[data-p]` element whose textContent is exactly `block.text`, so the
 * selection offsets in selection.js work the same for every kind. Content is
 * rendered as React text only — never HTML.
 */
import { memo, useMemo } from "react";

const WORD = /[\p{L}\p{N}]/u;

/**
 * Non-overlapping whole-phrase matches of concept terms, longest first.
 * @param {string[]} paragraphs
 * @param {Array<{id:string, term:string}>} concepts
 * @returns {Array<Array<{start:number,end:number,concept:object}>>}
 */
export function findConceptMarks(paragraphs, concepts) {
  const terms = concepts
    .filter((c) => typeof c.term === "string" && c.term.trim().length >= 2 && c.term.length <= 200)
    .map((c) => ({ concept: c, needle: c.term.trim().toLowerCase() }))
    .sort((a, b) => b.needle.length - a.needle.length);
  return paragraphs.map((text) => {
    const hay = text.toLowerCase();
    const marks = [];
    for (const { concept, needle } of terms) {
      let from = 0;
      while (from <= hay.length - needle.length) {
        const at = hay.indexOf(needle, from);
        if (at === -1) break;
        const end = at + needle.length;
        const before = at > 0 ? text[at - 1] : "";
        const after = end < text.length ? text[end] : "";
        const whole = !(before && WORD.test(before) && WORD.test(needle[0])) && !(after && WORD.test(after) && WORD.test(needle[needle.length - 1]));
        const overlaps = marks.some((m) => at < m.end && end > m.start);
        if (whole && !overlaps) marks.push({ start: at, end, concept });
        from = at + Math.max(1, needle.length);
      }
    }
    return marks.sort((a, b) => a.start - b.start);
  });
}

function segments(text, marks, active, tap) {
  const highlight = active || tap;
  const list = highlight ? marks.filter((m) => m.end <= highlight[0] || m.start >= highlight[1]) : marks;
  const all = [...list.map((m) => ({ ...m, kind: "concept" }))];
  if (highlight) all.push({ start: highlight[0], end: highlight[1], kind: active ? "active" : "tap" });
  all.sort((a, b) => a.start - b.start);
  const out = [];
  let pos = 0;
  for (const s of all) {
    if (s.start > pos) out.push({ kind: "text", text: text.slice(pos, s.start) });
    out.push({ ...s, text: text.slice(s.start, s.end) });
    pos = s.end;
  }
  if (pos < text.length) out.push({ kind: "text", text: text.slice(pos) });
  return out;
}

function Inline({ index, text, marks, active, tap, onConceptOpen }) {
  const parts = segments(text, marks, active, tap);
  return parts.map((s, i) => {
        if (s.kind === "text") return s.text;
        if (s.kind === "concept") {
          const open = (e) => {
            // A drag-select that ends on a mark is a selection, not a tap.
            const sel = window.getSelection();
            if (sel && !sel.isCollapsed) return;
            e.stopPropagation();
            onConceptOpen?.(s.concept, e.currentTarget.getBoundingClientRect(), index, s.start, s.end);
          };
          return (
            <mark
              key={i}
              className="concept"
              role="button"
              tabIndex={0}
              aria-label={`Saved concept: ${s.concept.term}`}
              onClick={open}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  open(e);
                }
              }}
            >
              {s.text}
            </mark>
          );
        }
        return (
          <mark key={i} className={s.kind === "active" ? "active" : undefined} data-tap={s.kind === "tap" ? "" : undefined}>
            {s.text}
          </mark>
        );
  });
}

const HEADING_TAG = { 1: "h2", 2: "h3", 3: "h4" };
const HEADING_CLASS = { h2: "mt-8 mb-3 text-[1.3em] leading-snug font-semibold", h3: "mt-7 mb-3 text-[1.15em] leading-snug font-semibold", h4: "mt-6 mb-2 text-[1.05em] font-semibold" };

const Block = memo(function Block({ index, block, marks, active, tap, onConceptOpen }) {
  const inline = <Inline index={index} text={block.text} marks={marks} active={active} tap={tap} onConceptOpen={onConceptOpen} />;
  if (block.type === "code") {
    // Verbatim, monospace, scrolls sideways inside the block — never the page.
    return (
      <pre data-p={index} className="article-code mb-6 max-w-full overflow-x-auto rounded-md border border-border bg-surface-2 p-3 font-mono text-[0.8em] leading-relaxed whitespace-pre" tabIndex={0} aria-label="Code block">
        <code>{inline}</code>
      </pre>
    );
  }
  if (block.type === "h") {
    const Tag = HEADING_TAG[block.level] || "h3";
    return (
      <Tag data-p={index} className={`font-sans break-anywhere ${HEADING_CLASS[Tag]}`}>
        {inline}
      </Tag>
    );
  }
  if (block.type === "li") {
    return (
      <li data-p={index} value={block.ordered && block.number ? block.number : undefined} className="mb-2 pl-1 break-anywhere">
        {inline}
      </li>
    );
  }
  return (
    <p data-p={index} className="mb-6 break-anywhere">
      {inline}
    </p>
  );
});

/** Items of the same source list share one <ul>/<ol>. */
function groupBlocks(blocks) {
  const groups = [];
  blocks.forEach((block, index) => {
    const last = groups[groups.length - 1];
    if (block.type === "li" && last?.list && last.id === block.list) last.items.push(index);
    else if (block.type === "li") groups.push({ list: true, id: block.list, ordered: Boolean(block.ordered), items: [index] });
    else groups.push({ list: false, items: [index] });
  });
  return groups;
}

/**
 * @param {{blocks:import("@/lib/client/article-blocks.js").Block[], concepts:object[], activeRanges?:Object<number,[number,number]>, tapRanges?:Object<number,[number,number]>, onConceptOpen?:Function, fontSize:number, bodyRef:any}} props
 */
export default function ArticleBody({ blocks, concepts, activeRanges, tapRanges, onConceptOpen, fontSize, bodyRef, onPointerDown, onPointerUp }) {
  const texts = useMemo(() => blocks.map((b) => b.text), [blocks]);
  const marks = useMemo(() => findConceptMarks(texts, concepts), [texts, concepts]);
  const groups = useMemo(() => groupBlocks(blocks), [blocks]);
  const render = (i) => (
    <Block
      key={i}
      index={i}
      block={blocks[i]}
      marks={marks[i]}
      active={activeRanges?.[i] || null}
      tap={tapRanges?.[i] || null}
      onConceptOpen={onConceptOpen}
    />
  );
  return (
    <div
      ref={bodyRef}
      tabIndex={-1}
      className="article-body font-reading outline-none"
      style={{ fontSize, lineHeight: 1.7 }}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
    >
      {groups.map((g) => {
        if (!g.list) return render(g.items[0]);
        const List = g.ordered ? "ol" : "ul";
        return (
          <List key={`l${g.items[0]}`} className={`mb-6 pl-6 ${g.ordered ? "list-decimal" : "list-disc"}`}>
            {g.items.map(render)}
          </List>
        );
      })}
    </div>
  );
}
