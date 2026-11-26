"use client";
/**
 * Article blocks (paragraphs, headings, list items, code) with saved-concept
 * marks and the active/tap highlight (UX-SPEC 3.6, 4.8, PO-6). Every block is
 * one `[data-p]` element whose textContent is exactly `block.text`, so the
 * selection offsets in selection.js work the same for every kind. Content is
 * rendered as React text only — never HTML.
 */
import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import { CELL_SEPARATOR } from "@/lib/article-markdown.js";

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
    if (s.start > pos) out.push({ kind: "text", start: pos, end: s.start });
    out.push(s);
    pos = s.end;
  }
  if (pos < text.length) out.push({ kind: "text", start: pos, end: text.length });
  return out;
}

const EMPTY = [];

/** One run of text with its formatting (bold, italics, strikethrough, inline code, line break). */
function run(text, covering, key) {
  if (covering.some((s) => s.kind === "br")) {
    return (
      <Fragment key={key}>
        {text}
        <br />
      </Fragment>
    );
  }
  let node = text;
  if (covering.some((s) => s.kind === "code")) node = <code className="rounded-sm bg-surface-2 px-1 py-px font-mono text-[0.88em]">{node}</code>;
  if (covering.some((s) => s.kind === "del")) node = <del>{node}</del>;
  if (covering.some((s) => s.kind === "em")) node = <em>{node}</em>;
  if (covering.some((s) => s.kind === "strong")) node = <strong className="font-semibold">{node}</strong>;
  return <Fragment key={key}>{node}</Fragment>;
}

function linkFor(span, children, key) {
  const className = span.kind === "image" ? "aha-img-chip" : "text-accent underline underline-offset-2";
  if (!span.href) return <span key={key} className={className}>{children}</span>;
  return (
    <a key={key} href={span.href} target="_blank" rel="noopener noreferrer nofollow" className={className}>
      {children}
    </a>
  );
}

/**
 * text[start, end) with its formatting spans. Without spans it stays a plain string, so older
 * articles render exactly as before. Consecutive runs inside one link share one <a>.
 */
function formatted(text, start, end, spans) {
  if (!spans.length) return text.slice(start, end);
  const cuts = new Set([start, end]);
  for (const s of spans) {
    if (s.end > start && s.start < end) {
      cuts.add(Math.max(s.start, start));
      cuts.add(Math.min(s.end, end));
    }
  }
  const points = [...cuts].sort((a, b) => a - b);
  const out = [];
  let group = null;
  const flush = () => {
    if (group) out.push(linkFor(group.span, group.runs, `l${group.at}`));
    group = null;
  };
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const covering = spans.filter((s) => s.start <= a && s.end >= b);
    const link = covering.find((s) => s.kind === "link" || s.kind === "image");
    const node = run(text.slice(a, b), covering, `r${a}`);
    if (link) {
      if (group?.span !== link) {
        flush();
        group = { span: link, runs: [], at: a };
      }
      group.runs.push(node);
    } else {
      flush();
      out.push(node);
    }
  }
  flush();
  return out;
}

function Inline({ index, text, spans = EMPTY, marks, active, tap, onConceptOpen, from = 0, to = text.length }) {
  const parts = segments(text, marks, active, tap)
    .map((s) => ({ ...s, a: Math.max(s.start, from), b: Math.min(s.end, to) }))
    .filter((s) => s.b > s.a);
  return parts.map((s) => {
    const content = formatted(text, s.a, s.b, spans);
    if (s.kind === "text") return <Fragment key={`t${s.a}`}>{content}</Fragment>;
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
          key={`c${s.a}`}
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
          {content}
        </mark>
      );
    }
    return (
      <mark key={`m${s.a}`} className={s.kind === "active" ? "active" : undefined} data-tap={s.kind === "tap" ? "" : undefined}>
        {content}
      </mark>
    );
  });
}

const HEADING_TAG = { 1: "h2", 2: "h3", 3: "h4" };
const HEADING_CLASS = { h2: "mt-8 mb-3 text-[1.3em] leading-snug font-semibold", h3: "mt-7 mb-3 text-[1.15em] leading-snug font-semibold", h4: "mt-6 mb-2 text-[1.05em] font-semibold" };

/**
 * Verbatim, monospace code that scrolls sideways inside the block — never the page.
 * Long lines are easy to miss (macOS hides scrollbars), so while there's more to the
 * right the edge fades out and a hint says so.
 */
function CodeBlock({ index, children, extraClass = "" }) {
  const ref = useRef(null);
  const [overflow, setOverflow] = useState({ wide: false, atEnd: true });
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const check = () => {
      const wide = el.scrollWidth > el.clientWidth + 1;
      setOverflow({ wide, atEnd: !wide || el.scrollLeft + el.clientWidth >= el.scrollWidth - 4 });
    };
    check();
    el.addEventListener("scroll", check, { passive: true });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(check) : null;
    observer?.observe(el);
    return () => {
      el.removeEventListener("scroll", check);
      observer?.disconnect();
    };
  }, []);
  return (
    <div className="mb-6">
      <div className="relative">
        <pre ref={ref} data-p={index} className={`article-code${extraClass} max-w-full overflow-x-auto rounded-md border border-border bg-surface-2 p-3 font-mono text-[0.8em] leading-relaxed whitespace-pre`} tabIndex={0} aria-label="Code block">
          <code>{children}</code>
        </pre>
        <div
          aria-hidden="true"
          className={`pointer-events-none absolute inset-y-px right-px w-10 rounded-r-md bg-gradient-to-l from-surface-2 to-transparent transition-opacity duration-[var(--dur)] ${overflow.atEnd ? "opacity-0" : "opacity-100"}`}
        />
      </div>
      {overflow.wide ? (
        <p aria-hidden="true" className="mt-1 font-sans text-[13px] text-muted">
          {overflow.atEnd ? "← Scroll back to the start of the lines" : "Scroll sideways to see the full lines →"}
        </p>
      ) : null}
    </div>
  );
}

const Block = memo(function Block({ index, block, marks, active, tap, onConceptOpen, bookmark }) {
  const inline = <Inline index={index} text={block.text} spans={block.spans || EMPTY} marks={marks} active={active} tap={tap} onConceptOpen={onConceptOpen} />;
  // A bookmark only adds a class to the [data-p] element, so its textContent (which
  // selection offsets rely on) is unchanged.
  const bm = bookmark ? ` bm bm-${bookmark}` : "";
  if (block.type === "code") return <CodeBlock index={index} extraClass={bm}>{inline}</CodeBlock>;
  if (block.type === "h") {
    const Tag = HEADING_TAG[block.level] || "h3";
    return (
      <Tag data-p={index} className={`font-sans break-anywhere ${HEADING_CLASS[Tag]}${bm}`}>
        {inline}
      </Tag>
    );
  }
  if (block.type === "li") {
    return (
      <li
        data-p={index}
        value={block.ordered && block.number ? block.number : undefined}
        className={`mb-2 pl-1 break-anywhere${bm}`}
        style={block.depth ? { marginLeft: `${block.depth * 1.5}em` } : undefined}
      >
        {inline}
      </li>
    );
  }
  if (block.type === "quote") {
    return (
      <p data-p={index} className={`mb-3 break-anywhere${bm}`}>
        {inline}
      </p>
    );
  }
  if (block.type === "row") {
    const Cell = block.header ? "th" : "td";
    // Cells are separated by a visually hidden " · " that is part of the row's text, so
    // selection offsets, screen readers and the AI read "a · b" rather than "ab".
    return (
      <tr data-p={index} className={bm.trim() || undefined}>
        {block.cells.map(([from, to], k) => (
          <Cell
            key={k}
            className={`border border-border px-3 py-2 align-top break-anywhere ${block.header ? "bg-surface-2 font-semibold" : ""}`}
            style={{ textAlign: block.align?.[k] || "left" }}
          >
            {k > 0 ? <span className="sr-only">{CELL_SEPARATOR}</span> : null}
            <Inline index={index} text={block.text} spans={block.spans || EMPTY} marks={marks} active={active} tap={tap} onConceptOpen={onConceptOpen} from={from} to={to} />
          </Cell>
        ))}
      </tr>
    );
  }
  return (
    <p data-p={index} className={`mb-6 break-anywhere${bm}`}>
      {inline}
    </p>
  );
});

/** Items of one list share a <ul>/<ol>; rows of one table a <table>; paragraphs of one quote a <blockquote>. */
function groupBlocks(blocks) {
  const groups = [];
  blocks.forEach((block, index) => {
    const last = groups[groups.length - 1];
    const kind = block.type === "li" ? "list" : block.type === "row" ? "table" : block.type === "quote" ? "quote" : null;
    const id = kind === "list" ? block.list : kind === "table" ? block.table : kind === "quote" ? block.quote : null;
    if (kind && last?.kind === kind && last.id === id) last.items.push(index);
    else if (kind) groups.push({ kind, list: kind === "list", id, ordered: Boolean(block.ordered), items: [index] });
    else groups.push({ kind: null, list: false, items: [index] });
  });
  return groups;
}

/**
 * @param {{blocks:import("@/lib/client/article-blocks.js").Block[], concepts:object[], activeRanges?:Object<number,[number,number]>, tapRanges?:Object<number,[number,number]>, onConceptOpen?:Function, fontSize:number, bodyRef:any, bookmarkKinds?:Object<number,"revisit"|"important">}} props `bookmarkKinds`: block index → bookmark kind shown on that block
 */
export default function ArticleBody({ blocks, concepts, activeRanges, tapRanges, onConceptOpen, fontSize, bodyRef, onPointerDown, onPointerUp, bookmarkKinds }) {
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
      bookmark={bookmarkKinds?.[i] || null}
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
        if (g.kind === "table") {
          const head = g.items.filter((i) => blocks[i].header);
          const body = g.items.filter((i) => !blocks[i].header);
          return (
            <div key={`t${g.items[0]}`} className="scroll-visible mb-6 max-w-full overflow-x-auto">
              <table className="w-full border-collapse font-sans text-[0.9em]">
                {head.length ? <thead>{head.map(render)}</thead> : null}
                <tbody>{body.map(render)}</tbody>
              </table>
            </div>
          );
        }
        if (g.kind === "quote") {
          return (
            <blockquote key={`q${g.items[0]}`} className="mb-6 border-l-4 border-border pl-4 text-muted">
              {g.items.map(render)}
            </blockquote>
          );
        }
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
