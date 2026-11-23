"use client";
/**
 * Notebook list item and its review-status badge (UX-SPEC 6.1).
 */
import { Badge, Card } from "@/components/ui/Misc.js";
import { nextReviewPhrase, relativeTime } from "@/lib/client/relative-time.js";

/**
 * @param {{nextReviewAt:string|null, reviewCount:number, now:number}} props
 */
export function ReviewStatusBadge({ nextReviewAt, reviewCount, now }) {
  const t = nextReviewAt ? new Date(nextReviewAt).getTime() : null;
  if (t == null || t <= now) return <Badge tone="warning">Due now</Badge>;
  if (!reviewCount) return <Badge>New · review {nextReviewPhrase(nextReviewAt, now)}</Badge>;
  return <Badge>Next review {relativeTime(nextReviewAt, now)}</Badge>;
}

/**
 * One-line preview of an explanation: no **bold** markers or bullet dashes (PO-19).
 * @param {string} text
 * @returns {string}
 */
export function plainPreview(text) {
  return String(text || "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/^\s*[-•*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {{concept:object, now:number}} props
 */
export default function ConceptCard({ concept, now }) {
  const tags = Array.isArray(concept.tags) ? concept.tags : [];
  return (
    <li>
      <Card href={`/notebook/${concept.id}`}>
        <p className="line-clamp-2 font-semibold break-anywhere">{concept.term}</p>
        <p className="mt-1 line-clamp-2 text-[15px] text-muted break-anywhere">{plainPreview(concept.definition)}</p>
        {tags.length ? (
          <div className="mt-2 flex flex-wrap gap-1">
            {tags.slice(0, 3).map((t) => (
              <span key={t} className="max-w-full truncate rounded-full bg-accent-soft px-2 py-0.5 text-[12px] text-text">
                {t}
              </span>
            ))}
            {tags.length > 3 ? <span className="px-1 text-[12px] text-muted">+{tags.length - 3}</span> : null}
          </div>
        ) : null}
        <div className="mt-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <ReviewStatusBadge nextReviewAt={concept.nextReviewAt} reviewCount={concept.reviewCount} now={now} />
          {concept.articleTitle ? <span className="min-w-0 flex-1 truncate text-[13px] text-muted">From {concept.articleTitle}</span> : null}
        </div>
      </Card>
    </li>
  );
}
