"use client";
/**
 * Switch between the two collections of what you've kept: Notebook concepts and
 * reading bookmarks. Links (not tabs), so each list has its own URL.
 */
import Link from "next/link";

const ITEMS = [
  { id: "concepts", href: "/notebook", label: "Concepts" },
  { id: "bookmarks", href: "/bookmarks", label: "Bookmarks" },
];

/** @param {{current: "concepts"|"bookmarks"}} props */
export default function NotebookSwitch({ current }) {
  return (
    <nav aria-label="Notebook sections" className="mb-2 inline-flex w-full rounded-md bg-surface-2 p-1 sm:w-auto">
      {ITEMS.map((item) => {
        const active = item.id === current;
        return (
          <Link
            key={item.id}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`inline-flex min-h-[44px] flex-1 items-center justify-center rounded-sm px-4 font-semibold no-underline sm:flex-none ${
              active ? "bg-surface text-text shadow-1" : "text-muted hover:text-text"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
