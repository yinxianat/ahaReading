"use client";
/**
 * Primary navigation: bottom tab bar below 1024px, left sidebar above.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import Icon from "@/components/ui/icons.js";
import { useUser } from "./UserContext.js";
import { useDue } from "./DueContext.js";

const ITEMS = [
  { href: "/read", label: "Read", icon: "book" },
  { href: "/notebook", label: "Notebook", icon: "bookmark" },
  { href: "/review", label: "Review", icon: "layers" },
  { href: "/settings", label: "Settings", icon: "gear" },
];

function isActive(pathname, href) {
  // Bookmarks live beside Notebook concepts (one "things I kept" tab).
  if (href === "/notebook" && (pathname === "/bookmarks" || pathname.startsWith("/bookmarks/"))) return true;
  return pathname === href || pathname.startsWith(`${href}/`);
}

function DueBadge({ count, className = "" }) {
  if (!count) return null;
  return (
    <span className={`inline-flex min-w-[18px] items-center justify-center rounded-full bg-danger px-1 text-[11px] font-bold leading-[18px] text-white dark:text-[#2a0e0b] ${className}`} aria-hidden="true">
      {count > 9 ? "9+" : count}
    </span>
  );
}

function label(item, due) {
  return item.href === "/review" && due > 0 ? `Review, ${due} due` : undefined;
}

export function TabBar() {
  const pathname = usePathname();
  const { dueCount } = useDue();
  return (
    <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface-2 lg:hidden safe-bottom">
      <ul className="mx-auto grid h-14 max-w-[560px] grid-cols-4">
        {ITEMS.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <li key={item.href} className="relative">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                aria-label={label(item, dueCount)}
                className={`flex h-full flex-col items-center justify-center gap-0.5 text-[12px] font-semibold no-underline ${active ? "text-accent" : "text-muted"}`}
              >
                {active ? <span className="absolute inset-x-6 top-0 h-0.5 rounded-full bg-accent" aria-hidden="true" /> : null}
                <span className="relative">
                  <Icon name={item.icon} size={22} />
                  {item.href === "/review" ? <DueBadge count={dueCount} className="absolute -top-1.5 -right-3" /> : null}
                </span>
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const { dueCount } = useDue();
  const { user } = useUser();
  return (
    <nav aria-label="Main" className="fixed inset-y-0 left-0 z-30 hidden w-[232px] flex-col border-r border-border bg-surface-2 px-3 py-5 lg:flex">
      <Link href="/read" className="mb-6 px-3 text-[18px] font-bold tracking-tight text-text no-underline">
        AhaReading
      </Link>
      <ul className="flex flex-col gap-1">
        {ITEMS.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                aria-label={label(item, dueCount)}
                className={`flex min-h-[44px] items-center gap-3 rounded-md px-3 font-semibold no-underline ${active ? "bg-accent-soft text-accent" : "text-text hover:bg-surface"}`}
              >
                <Icon name={item.icon} size={20} />
                <span className="flex-1">{item.label}</span>
                {item.href === "/review" ? <DueBadge count={dueCount} /> : null}
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="mt-auto border-t border-border px-3 pt-4 text-[14px]">
        <p className="truncate text-muted" title={user?.email}>
          {user?.email}
        </p>
        {user?.isAdmin ? (
          <Link href="/admin" className="mt-2 inline-flex min-h-[44px] items-center font-semibold">
            Admin
          </Link>
        ) : null}
      </div>
    </nav>
  );
}
