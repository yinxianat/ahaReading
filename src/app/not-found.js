import Link from "next/link";

export const metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <main id="main" className="mx-auto flex min-h-[80dvh] max-w-[480px] flex-col items-center justify-center px-4 text-center">
      <p className="text-[14px] font-semibold tracking-[.04em] text-muted uppercase">AhaReading</p>
      <h1 className="mt-2 text-[28px] font-bold leading-tight">This page doesn&apos;t exist.</h1>
      <p className="mt-2 text-muted">The link may be mistyped or out of date.</p>
      <Link href="/read" className="mt-6 inline-flex min-h-[44px] items-center rounded-md bg-accent px-5 font-semibold text-accent-fg no-underline">
        Go to Library
      </Link>
    </main>
  );
}
