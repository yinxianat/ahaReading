/** Unknown /api/* routes: JSON 404 for every method instead of an HTML page. */
function notFound() {
  return Response.json(
    { error: "not_found", message: "This API endpoint doesn't exist. Check the URL and method." },
    { status: 404 }
  );
}

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
export const OPTIONS = notFound;
export const HEAD = notFound;
