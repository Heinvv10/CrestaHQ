import "server-only";

import { NextResponse } from "next/server";

import { recordBroadcastEngagement } from "@/lib/broadcasts/engagement";
import { verifyClickToken } from "@/lib/broadcasts/tracking-token";
import { getAdminDb } from "@/lib/firebase/admin";
import { isDocId } from "@/lib/server/doc-id";
import { createFixedWindowLimiter } from "@/lib/server/fixed-window-limit";
import { normalizeDestinationUrl } from "@/lib/tracked-links/destination";

export const dynamic = "force-dynamic";

/**
 * Records per verified token. The redirect itself never waits on this: a
 * reader clicking twice, or a shared office IP, always reaches the page.
 */
const checkClickRecordLimit = createFixedWindowLimiter({ limit: 20, windowMs: 60_000 });

const notFound = () =>
  new NextResponse("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });

interface Resolved {
  destination: string;
  broadcastId: string;
  contactId: string;
}

/** The stored destination for a click token, or null for a bad token or link. */
async function resolveDestination(token: string): Promise<Resolved | null> {
  const signed = verifyClickToken(token);
  if (
    !signed ||
    !isDocId(signed.broadcastId) ||
    !isDocId(signed.contactId) ||
    !isDocId(signed.linkKey)
  ) {
    return null;
  }
  const linkSnap = await getAdminDb()
    .collection("broadcasts")
    .doc(signed.broadcastId)
    .collection("links")
    .doc(signed.linkKey)
    .get();
  // Re-validated on read, as /l/ does: the redirect is what an attacker aims at.
  const destination = normalizeDestinationUrl(linkSnap.data()?.url);
  if (!destination) return null;
  return { destination, broadcastId: signed.broadcastId, contactId: signed.contactId };
}

/**
 * Broadcast click redirect. `/t/c/{token}` 302s ONLY to the destination the
 * send step stored at `broadcasts/{id}/links/{linkKey}` — never to anything
 * in the request. A forged token, an unknown link, a stored value that is no
 * longer an http(s) URL, or a failed lookup 404s; a 302 there would be an
 * open redirect.
 *
 * The click is recorded before the redirect (the process may stop once the
 * response is written). A failed or rate-limited record still redirects: the
 * reader asked for the page, and the destination check is what guards it.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  let token: string;
  let resolved: Resolved | null;
  try {
    token = (await params).token;
    resolved = await resolveDestination(token);
  } catch (err) {
    console.error("[t/c] link lookup failed", err instanceof Error ? err.message : String(err));
    return notFound();
  }
  if (!resolved) return notFound();

  if (checkClickRecordLimit(token).ok) {
    try {
      await recordBroadcastEngagement({
        broadcastId: resolved.broadcastId,
        contactId: resolved.contactId,
        kind: "clicked",
        link: resolved.destination,
      });
    } catch (err) {
      console.error(
        "[t/c] click record failed",
        resolved.broadcastId,
        resolved.contactId,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return NextResponse.redirect(resolved.destination, {
    status: 302,
    headers: { "Cache-Control": "no-store" },
  });
}
