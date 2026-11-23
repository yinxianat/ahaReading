import Link from "next/link";

/** Minimal shell for login / verify: logo and a centred card. */
export default function AuthCard({ children }) {
  return (
    <div className="flex min-h-dvh flex-col items-center px-4 safe-top">
      <header className="w-full max-w-[400px] py-5">
        <Link href="/" className="text-[18px] font-bold tracking-tight text-text no-underline">
          AhaReading
        </Link>
      </header>
      <main id="main" className="w-full max-w-[400px] rounded-lg border border-border bg-surface p-5 shadow-1 sm:p-6">
        {children}
      </main>
    </div>
  );
}
