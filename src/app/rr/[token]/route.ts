import { NextResponse } from "next/server";
import { clientIpFrom } from "@/lib/checkout/rate-limit";
import { resolveReviewClick } from "@/lib/reviews/click";
import { checkReviewClickRateLimit } from "@/lib/reviews/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Public tracked review link (SP5 d2): `/rr/{token}` in a review request sent
 * while reminders are on. A valid click 302s to the sub-account's configured
 * Google review link and stops the request's reminders; a forged or unknown
 * token, or no usable review link, is a 404 — never a redirect. Reads no
 * identity header (a public path: a caller can send its own). Per-IP limited.
 */
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const rate = checkReviewClickRateLimit(clientIpFrom(request));
  if (!rate.ok) {
    return new NextResponse("Too many requests", { status: 429, headers: { "retry-after": String(rate.retryAfterSec) } });
  }
  const { token } = await params;
  const destination = await resolveReviewClick(token);
  if (!destination) return new NextResponse("Not found", { status: 404 });
  return NextResponse.redirect(destination, 302);
}
