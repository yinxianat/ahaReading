import prisma from "@/lib/db.js";
import { requireUser } from "@/lib/auth.js";
import { jsonError, withErrorHandling } from "@/lib/http.js";
import { audioUsage, serializeSeries } from "@/lib/listen.js";

const notFound = () => jsonError(404, "not_found", "We couldn't find that listening series. It may have been deleted.");

async function seriesId(context) {
  const { id } = await context.params;
  return typeof id === "string" && id.length <= 100 ? id : null;
}

/** GET → {series (with each ready part's script), usage} */
export const GET = withErrorHandling(async (request, context) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const id = await seriesId(context);
  if (!id) return notFound();
  const [series, usage] = await Promise.all([
    prisma.audioSeries.findFirst({ where: { id, userId: auth.user.id }, include: { parts: true } }),
    audioUsage(auth.user),
  ]);
  if (!series) return notFound();
  return Response.json({ series: serializeSeries(series, { withScripts: true }), usage }, { headers: { "Cache-Control": "no-store" } });
}, { source: "api" });

/** DELETE → 204. Minutes already used today stay used. */
export const DELETE = withErrorHandling(async (request, context) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const id = await seriesId(context);
  if (!id) return notFound();
  const { count } = await prisma.audioSeries.deleteMany({ where: { id, userId: auth.user.id } });
  if (count === 0) return notFound();
  return new Response(null, { status: 204 });
}, { source: "api" });
