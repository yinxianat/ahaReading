import prisma from "@/lib/db.js";
import { requireUser } from "@/lib/auth.js";
import { parseJsonBody, badRequest, jsonError, rateLimited, hasNul, withErrorHandling } from "@/lib/http.js";
import { checkRateLimit } from "@/lib/rate-limit.js";
import { CONCEPT_INCLUDE, MAX_DEFINITION_CHARS, parseNotes, parseTags, parseTerm, serializeConcept } from "@/lib/concepts.js";

const notFound = () => jsonError(404, "not_found", "We couldn't find that concept. It may have been deleted — go back to your notebook.");

async function conceptId(context) {
  const { id } = await context.params;
  return typeof id === "string" && id.length <= 100 ? id : null;
}

/** GET → {concept} */
export const GET = withErrorHandling(async (request, context) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const id = await conceptId(context);
  if (!id) return notFound();
  const concept = await prisma.concept.findFirst({ where: { id, userId: auth.user.id }, include: CONCEPT_INCLUDE });
  if (!concept) return notFound();
  return Response.json({ concept: serializeConcept(concept) }, { headers: { "Cache-Control": "no-store" } });
}, { source: "api" });

function parsePatch(input) {
  const data = {};
  if ("userNotes" in input) {
    const notes = parseNotes(input.userNotes);
    if (notes.error) return notes;
    data.userNotes = notes.userNotes;
  }
  if ("tags" in input) {
    const tags = parseTags(input.tags);
    if (tags.error) return tags;
    data.tags = tags.tags;
  }
  if ("term" in input) {
    const term = parseTerm(input.term);
    if (term.error) return term;
    data.term = term.term;
  }
  if ("definition" in input) {
    if (typeof input.definition !== "string" || !input.definition.trim()) return { error: badRequest("The definition can't be empty.", "definition") };
    if (hasNul(input.definition)) return { error: badRequest("The definition contains a hidden character. Retype it and try again.", "definition") };
    if (input.definition.trim().length > MAX_DEFINITION_CHARS) {
      return { error: badRequest(`Keep the definition to ${MAX_DEFINITION_CHARS.toLocaleString("en-US")} characters or fewer.`, "definition") };
    }
    data.definition = input.definition.trim();
  }
  if (Object.keys(data).length === 0) return { error: badRequest("Nothing to update. Send userNotes, tags, term or definition.") };
  return { data };
}

/** PATCH {userNotes?, tags?, term?, definition?} → {concept} */
export const PATCH = withErrorHandling(async (request, context) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const userId = auth.user.id;
  const limit = checkRateLimit(`notebook:${userId}`, { maxRequests: 60, windowMs: 60_000 });
  if (!limit.allowed) return rateLimited(limit.retryAfter);

  const id = await conceptId(context);
  if (!id) return notFound();
  const body = await parseJsonBody(request);
  if (!body.ok) return badRequest("Send your changes as a JSON object.");
  const parsed = parsePatch(body.data);
  if (parsed.error) return parsed.error;

  const { count } = await prisma.concept.updateMany({ where: { id, userId }, data: parsed.data });
  if (count === 0) return notFound();
  const concept = await prisma.concept.findFirst({ where: { id, userId }, include: CONCEPT_INCLUDE });
  if (!concept) return notFound();
  return Response.json({ concept: serializeConcept(concept) });
}, { source: "api" });

/** DELETE → {ok:true} */
export const DELETE = withErrorHandling(async (request, context) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const userId = auth.user.id;
  const limit = checkRateLimit(`notebook:${userId}`, { maxRequests: 60, windowMs: 60_000 });
  if (!limit.allowed) return rateLimited(limit.retryAfter);

  const id = await conceptId(context);
  if (!id) return notFound();
  const { count } = await prisma.concept.deleteMany({ where: { id, userId } });
  if (count === 0) return notFound();
  return Response.json({ ok: true });
}, { source: "api" });
