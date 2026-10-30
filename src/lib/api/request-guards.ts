import type { NextResponse } from "next/server";
import { apiError, type ResponseMeta } from "@/lib/api/responses";
import { readBodyCapped } from "@/lib/api/body-limit";
import { isDocId } from "@/lib/server/doc-id";

/**
 * Read the request body exactly once, capped at `maxBytes`, and parse to
 * JSON. `body` is null when the request has no body or it isn't valid JSON;
 * `tooLarge` when it is over the cap (nothing past the cap is read).
 * withApiAuth forwards both forms to the handler so a handler never
 * re-consumes the stream.
 */
export async function readJsonBody(
  request: Request,
  maxBytes: number,
): Promise<{ rawBody: string; body: unknown; tooLarge?: true }> {
  // GET / HEAD never carry a body in Next's Request shape.
  if (request.method === "GET" || request.method === "HEAD") {
    return { rawBody: "", body: null };
  }
  const rawBody = await readBodyCapped(request, maxBytes);
  if (rawBody === null) return { rawBody: "", body: null, tooLarge: true };
  if (!rawBody) return { rawBody: "", body: null };
  try {
    return { rawBody, body: JSON.parse(rawBody) };
  } catch {
    return { rawBody, body: null };
  }
}

/** The 413 for a body over the route's cap. */
export const bodyTooLarge = (meta: ResponseMeta, maxBytes: number): NextResponse =>
  apiError(meta, "invalid_request", "body_too_large", `The request body is over ${maxBytes} bytes.`, { status: 413 });

/**
 * A 400 invalid_id for the first route param that isn't a doc id, or null.
 * Next decodes %2F in a route param, so "c1%2Fsub%2Fs1" would reach
 * `contacts/${id}` as a subcollection path.
 */
export function invalidParam(meta: ResponseMeta, params: Record<string, string>): NextResponse | null {
  const bad = Object.entries(params).find(([, v]) => !isDocId(v));
  return bad ? apiError(meta, "invalid_request", "invalid_id", `\`${bad[0]}\` is not a valid id.`) : null;
}
