import Link from "next/link";
import { redirect } from "next/navigation";
import { hasValidSession } from "@/lib/session.js";

// Landing page (UX-SPEC 3.1): server-rendered copy, no client JS beyond links.

const steps = [
  { title: "Bring the text.", body: "Paste any article, or import it from a link." },
  { title: "Select what confuses you.", body: "Tap “I don't understand.” Still confused? Ask again — each step goes simpler, then deeper." },
  { title: "Keep what you learned.", body: "Save it to your Notebook. Short reviews bring it back right before you'd forget." },
];

const nevers = [
  "Never a chatbot — you get explanations of your text, not a conversation.",
  "Never reads other websites as you browse — only what you bring.",
  "Never shows your notes or reading to anyone else.",
  "Never needs a password.",
];

function Cta({ children }) {
  return (
    <Link
      href="/login"
      className="inline-flex min-h-[52px] items-center justify-center rounded-md bg-accent px-6 text-[17px] font-semibold text-accent-fg no-underline hover:brightness-110"
    >
      {children}
    </Link>
  );
}

export default async function Landing() {
  if (await hasValidSession()) redirect("/read");

  return (
    <div className="mx-auto max-w-[720px] px-4 md:px-6">
      <header className="flex items-center justify-between py-4 safe-top">
        <span className="text-[18px] font-bold tracking-tight">AhaReading</span>
        <Link href="/login" className="inline-flex min-h-[44px] items-center rounded-md px-3 font-semibold no-underline">
          Sign in
        </Link>
      </header>

      <main id="main">
        <section className="pt-8 pb-12">
          <p className="text-[12px] font-semibold tracking-[.04em] text-muted uppercase">AI reading tutor</p>
          <h1 className="mt-2 text-[28px] leading-[1.2] font-bold md:text-[36px] md:leading-[1.15]">
            Understand every sentence you read.
          </h1>
          <p className="mt-4 text-[17px] text-muted">
            Paste an article or import a link, select the part that loses you, and AhaReading explains it — simply first,
            then with an analogy, then in depth. Save what clicks and review it before you forget.
          </p>
          <div className="mt-6">
            <Cta>Get started — it&apos;s free</Cta>
          </div>
          <p className="mt-3 text-[14px] text-muted">Works on iPhone and laptop. No password — we email you a sign-in link.</p>

          {/* Product illustration built in HTML so it is real, readable content. */}
          <figure className="mt-10 rounded-lg border border-border bg-surface p-5 shadow-1" aria-label="Example of AhaReading explaining a phrase">
            <p className="font-reading text-read">
              To stay fast at global scale, the service relies on{" "}
              <mark className="rounded-[2px] px-0.5 text-text" style={{ background: "var(--selection)" }}>
                eventual consistency
              </mark>{" "}
              between its data centres.
            </p>
            <div className="mt-3 flex justify-center">
              <span className="inline-flex h-10 items-center rounded-full bg-accent px-4 text-[15px] font-semibold text-accent-fg shadow-2">
                I don&apos;t understand
              </span>
            </div>
            <div className="mt-4 rounded-md border border-border bg-bg p-4">
              <p className="text-[12px] font-semibold tracking-[.04em] text-muted uppercase">Level 1 · Simple</p>
              <p className="mt-1 font-reading text-[17px] leading-relaxed">
                <strong>Eventual consistency</strong> means copies of the same data in different places may briefly
                disagree, but they all catch up to the same value soon after a change.
              </p>
            </div>
            <figcaption className="sr-only">A selected phrase, the “I don&apos;t understand” button, and a simple explanation.</figcaption>
          </figure>
        </section>

        <section className="border-t border-border py-10">
          <h2 className="text-[22px] font-semibold leading-tight">Technical writing assumes you already know.</h2>
          <p className="mt-3 text-[17px] text-muted">
            One unfamiliar term and the rest of the paragraph stops making sense. Searching breaks your focus, and
            chatbots answer a different question than the one you had.
          </p>
        </section>

        <section className="border-t border-border py-10">
          <h2 className="text-[22px] font-semibold leading-tight">How it works</h2>
          <ol className="mt-5 space-y-5">
            {steps.map((s, i) => (
              <li key={s.title} className="flex gap-4">
                <span className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-full bg-accent-soft font-bold text-accent" aria-hidden="true">
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <p className="font-semibold">{s.title}</p>
                  <p className="text-muted">{s.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="border-t border-border py-10">
          <h2 className="text-[22px] font-semibold leading-tight">What it will never do</h2>
          <ul className="mt-4 space-y-3">
            {nevers.map((n) => (
              <li key={n} className="flex gap-3">
                <span className="mt-2 h-1.5 w-1.5 flex-none rounded-full bg-muted" aria-hidden="true" />
                <span>{n}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="border-t border-border py-10">
          <h2 className="text-[22px] font-semibold leading-tight">Who it&apos;s for</h2>
          <p className="mt-3 text-[17px] text-muted">
            People reading above their comfort zone — engineers in a new field, students, and bilingual readers who want
            an explanation in <span lang="zh-Hans">中文</span> too.
          </p>
        </section>

        <section className="border-t border-border py-12 text-center">
          <Cta>Get started</Cta>
        </section>
      </main>

      <footer className="pb-8 text-center text-[12px] text-muted safe-bottom">© AhaReading</footer>
    </div>
  );
}
