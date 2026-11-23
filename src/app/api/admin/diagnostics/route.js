import { requireAdmin } from "@/lib/auth.js";
import { withErrorHandling } from "@/lib/http.js";
import { getFindings } from "@/lib/diagnostics.js";
import { getInfrastructure } from "@/lib/admin.js";
import { verifyTransport } from "@/lib/mailer.js";

export const dynamic = "force-dynamic";

/**
 * GET [?smtp=1] -> {findings:[{code, severity, title, detail, remediation}], counts, infrastructure, smtpProbe?}.
 * Findings are derived on read. `smtp=1` additionally connects and
 * authenticates to SMTP without sending (up to ~30s on a blocked port).
 */
export const GET = withErrorHandling(async (request) => {
  const auth = await requireAdmin(request);
  if (auth.response) return auth.response;
  const probe = new URL(request.url).searchParams.get("smtp") === "1";
  const [findings, infrastructure, smtpProbe] = await Promise.all([
    getFindings(),
    getInfrastructure(),
    probe ? verifyTransport() : Promise.resolve(undefined),
  ]);
  const counts = { high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return Response.json(
    { findings, counts, infrastructure, ...(smtpProbe ? { smtpProbe } : {}) },
    { headers: { "Cache-Control": "no-store" } }
  );
}, { source: "admin" });
