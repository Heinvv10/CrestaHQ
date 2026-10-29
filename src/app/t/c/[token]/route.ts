import "server-only";

import { NextResponse } from "next/server";

import { recordBroadcastEngagement } from "@/lib/broadcasts/engagement";
import { verifyClickToken } from "@/lib/broadcasts/tracking-token";
import { clientIpFrom } from "@/lib/checkout/rate-limit";
import { getAdminDb } from "@/lib/firebase/admin";
import { isDocId } from "@/lib/server/doc-id";
import { createFixedWindowLimiter } from "@/lib/server/fixed-window-limit";
import { normalizeDestinationUrl } from "@/lib/tracked-links/destination";

export const dynamic = "force-dynamic";

const checkClickRateLimit = createFixedWindowLimiter({ limit: 120, windowMs: 60_000 });

const notFound = () =>
  new NextResponse("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });

/**
 * Broadcast click redirect. `/t/c/{token}` 302s ONLY to the destination the
 * send step stored at `broadcasts/{id}/links/{linkKey}` — never to anything
 * in the request. A forged token, an unknown link or a stored value that is
 * no longer an http(s) URL 404s; a 302 there would be an open redirect.
 *
 * The click is recorded before the redirect (the process may stop once the
 * response is written). A failed record still redirects: the reader asked
 * for the page, and the destination check above is what guards the redirect.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const limit = checkClickRateLimit(clientIpFrom(request));
  if (!limit.ok) {
    return new NextResponse("Too many requests", {
      status: 429,
      headers: { "Retry-After": String(limit.retryAfterSec), "Cache-Control": "no-store" },
    });
  }

  const { token } = await params;
  const signed = verifyClickToken(token);
  if (
    !signed ||
    !isDocId(signed.broadcastId) ||
    !isDocId(signed.contactId) ||
    !isDocId(signed.linkKey)
  ) {
    return notFound();
  }

  const linkSnap = await getAdminDb()
    .collection("broadcasts")
    .doc(signed.broadcastId)
    .collection("links")
    .doc(signed.linkKey)
    .get();
  // Re-validated on read, as /l/ does: the redirect is what an attacker aims at.
  const destination = normalizeDestinationUrl(linkSnap.data()?.url);
  if (!destination) return notFound();

  try {
    await recordBroadcastEngagement({
      broadcastId: signed.broadcastId,
      contactId: signed.contactId,
      kind: "clicked",
      link: destination,
    });
  } catch (err) {
    console.error(
      "[t/c] click record failed",
      signed.broadcastId,
      signed.contactId,
      err instanceof Error ? err.message : String(err),
    );
  }
  return NextResponse.redirect(destination, {
    status: 302,
    headers: { "Cache-Control": "no-store" },
  });
}
