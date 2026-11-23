"use client";
/**
 * Page header with optional back link and actions.
 */
import Link from "next/link";
import Icon from "@/components/ui/icons.js";

/**
 * @param {{title?:any, back?:{href:string,label:string}, actions?:any, sub?:any}} props
 */
export default function TopBar({ title, back, actions, sub }) {
  return (
    <header className="pt-4 pb-3 safe-top">
      {back ? (
        <Link href={back.href} className="-ml-2 mb-1 inline-flex min-h-[44px] items-center gap-1 rounded-md px-2 font-semibold no-underline">
          <Icon name="chevronLeft" size={20} />
          {back.label}
        </Link>
      ) : null}
      {title || actions ? (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {title ? <h1 className="text-[28px] leading-tight font-bold break-anywhere">{title}</h1> : null}
            {sub ? <p className="mt-0.5 text-muted">{sub}</p> : null}
          </div>
          {actions ? <div className="flex flex-none items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
    </header>
  );
}
