import { NextResponse } from "next/server";
import { feedClientKey } from "@/lib/gbp/feed/rate-limit";
import { isLinkPreviewAgent, resolveReviewClick } from "@/lib/reviews/click";
import { checkReviewClickRateLimit } from "@/lib/reviews/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Public tracked review link (SP5 d2): `/rr/{token}` in a review request sent
 * while reminders are on. A valid click 302s to the sub-account's configured
 * Google review link and stops the request's reminders; a forged or unknown
 * token, or no usable review link, is a 404 — never a redirect. Reads no
 * identity header (a public path: a caller can send its own). Per-client
 * limited, the client keyed like the GBP feed. Only a person's GET counts as a
 * click: HEAD and known link-preview fetchers are redirected without one.
 */
async function handle(request: Request, token: string, stamp: boolean) {
  const rate = checkReviewClickRateLimit(feedClientKey(request));
  if (!rate.ok) {
    return new NextResponse("Too many requests", { status: 429, headers: { "retry-after": String(rate.retryAfterSec) } });
  }
  const destination = await resolveReviewClick(token, { stamp });
  if (!destination) return new NextResponse("Not found", { status: 404 });
  return NextResponse.redirect(destination, 302);
}

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  return handle(request, (await params).token, !isLinkPreviewAgent(request.headers.get("user-agent")));
}

export async function HEAD(request: Request, { params }: { params: Promise<{ token: string }> }) {
  return handle(request, (await params).token, false);
}
