"use client";
/**
 * Route-level crash screen (UX-SPEC 5, last row). Reports once per error.
 */
import { useEffect } from "react";
import { reportClientError } from "@/lib/client/report-error.js";
import { FullPageError } from "@/components/ui/Misc.js";

export default function RouteError({ error, retry, reset }) {
  useEffect(() => {
    reportClientError(error, { kind: "render", digest: error?.digest, source: "route" });
  }, [error]);
  return (
    <main id="main">
      <FullPageError
        title="Something went wrong."
        body="Reload this page — your saved concepts are safe."
        primary={{ label: "Reload", onClick: () => (retry || reset)?.() }}
        secondary={{ label: "Go to Library", href: "/read" }}
      />
    </main>
  );
}
