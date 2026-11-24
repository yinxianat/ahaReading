"use client";
/**
 * This article's bookmarks, in reading order: jump to one, edit it, or add one at
 * the spot being read ("Bookmark where I am").
 */
import { KIND_ICON, KIND_LABEL } from "@/lib/client/bookmarks.js";
import Sheet from "@/components/ui/Sheet.js";
import Button from "@/components/ui/Button.js";
import Icon from "@/components/ui/icons.js";

/**
 * @param {object} props
 * @param {Array<object>} props.bookmarks each with `at` = resolved block index
 * @param {(b:object) => void} props.onGo
 * @param {(b:object) => void} props.onEdit
 * @param {() => void} props.onAddHere
 * @param {() => void} props.onClose
 */
export default function ArticleBookmarks({ bookmarks, onGo, onEdit, onAddHere, onClose }) {
  const ordered = [...bookmarks].sort((a, b) => a.at - b.at || new Date(a.createdAt) - new Date(b.createdAt));
  return (
    <Sheet
      open
      onClose={onClose}
      title={`Bookmarks in this article (${bookmarks.length})`}
      snapPoints={[0.6, 0.92]}
      footer={
        <Button variant="secondary" icon="bookmark" fullWidth onClick={onAddHere}>
          Bookmark where I am
        </Button>
      }
    >
      {ordered.length === 0 ? (
        <p className="py-4 text-muted">
          No bookmarks yet. Select a passage and tap <strong>Bookmark</strong>, or bookmark the spot you&apos;re reading.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {ordered.map((b) => (
            <li key={b.id} className="py-3">
              <p className={`inline-flex items-center gap-1 text-[13px] font-semibold ${b.kind === "important" ? "text-warning" : "text-accent"}`}>
                <Icon name={KIND_ICON[b.kind]} size={14} /> {KIND_LABEL[b.kind]}
              </p>
              <p className="mt-1 line-clamp-2 font-reading text-[16px] break-anywhere">“{b.quote}”</p>
              {b.note ? <p className="mt-1 text-[14px] text-muted break-anywhere whitespace-pre-wrap">{b.note}</p> : null}
              <div className="mt-2 flex gap-2">
                <Button variant="secondary" onClick={() => onGo(b)}>
                  Go to
                </Button>
                <Button variant="text" icon="pencil" onClick={() => onEdit(b)} aria-label={`Edit bookmark “${b.quote.slice(0, 40)}”`}>
                  Edit
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}
