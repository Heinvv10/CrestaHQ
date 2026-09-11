import "server-only";

import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { clientIpFrom } from "@/lib/checkout/rate-limit";
import { buildFeed, resolveFeedTarget, type FeedTarget } from "@/lib/gbp/feed/build";
import { checkFeedRateLimit } from "@/lib/gbp/feed/rate-limit";

/**
 * GET /api/public/gbp/feed/[publicId] (+ OPTIONS) — the public reviews feed a
 * website embeds (contract v1: docs/features/gbp-reviews.md › Public feed).
 *
 * PUBLIC path (middleware): no session, and no identity header is ever read —
 * on a public path a caller can send its own. The only credential is the
 * opaque publicId; the only authority is the widget's config.
 *
 *   429 rate_limited        120/min per IP + publicId, Retry-After, no-store
 *   404 not_found           malformed / unknown / disabled / gate off — ONE body
 *   403 origin_not_allowed  an Origin not on the allow-list; no CORS grant
 *   200 / 304               ACAO echoes an allowed Origin (never *), Vary: Origin,
 *                           public 5-min cache, strong ETag over the body minus generatedAt
 */

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ publicId: string }> };

const CACHE = "public, max-age=300, stale-while-revalidate=600";
const refuse = (status: number, error: string, headers: Record<string, string> = {}) =>
  NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store", ...headers } });

/** Rate limit, resolve, then the origin allow-list — shared by GET and OPTIONS. */
async function admit(request: Request, publicId: string): Promise<{ target: FeedTarget; cors: Record<string, string> } | NextResponse> {
  const limit = checkFeedRateLimit(clientIpFrom(request), publicId);
  if (!limit.ok) return refuse(429, "rate_limited", { "Retry-After": String(limit.retryAfterSec) });
  const target = await resolveFeedTarget(publicId);
  if (!target) return refuse(404, "not_found");
  const origin = request.headers.get("origin");
  if (origin === null) return { target, cors: { Vary: "Origin" } };
  if (!target.widget.allowedOrigins.includes(origin)) return refuse(403, "origin_not_allowed");
  return { target, cors: { "Access-Control-Allow-Origin": origin, Vary: "Origin" } };
}

export async function GET(request: Request, ctx: Ctx) {
  const { publicId } = await ctx.params;
  const admitted = await admit(request, publicId);
  if (admitted instanceof NextResponse) return admitted;

  const body = await buildFeed(admitted.target, new Date());
  const hash = createHash("sha256")
    .update(JSON.stringify(body, (key, value) => (key === "generatedAt" ? undefined : value)))
    .digest("hex");
  const etag = `"${hash}"`;
  const headers = { ...admitted.cors, "Cache-Control": CACHE, ETag: etag };

  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch?.split(",").some((tag) => tag.trim() === etag)) {
    return new NextResponse(null, { status: 304, headers });
  }
  return NextResponse.json(body, { headers });
}

export async function OPTIONS(request: Request, ctx: Ctx) {
  const { publicId } = await ctx.params;
  const admitted = await admit(request, publicId);
  if (admitted instanceof NextResponse) return admitted;
  return new NextResponse(null, {
    status: 204,
    headers: { ...admitted.cors, "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Max-Age": "600" },
  });
}
