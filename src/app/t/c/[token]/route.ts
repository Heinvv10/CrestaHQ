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

/**
 * Firestore lookups per token. Past it, a destination this instance already
 * resolved is served from memory (the stored link never changes), and an
 * unknown one gets a 429 — a replayed token can't cost a read per request.
 */
const checkClickLookupLimit = createFixedWindowLimiter({ limit: 30, windowMs: 60_000 });
const RESOLVED_CACHE_MAX = 1_000;
/** token → resolved destination, oldest first (insertion order). */
const resolvedCache = new Map<string, Resolved>();

function remember(token: string, resolved: Resolved): void {
  resolvedCache.delete(token);
  resolvedCache.set(token, resolved);
  if (resolvedCache.size > RESOLVED_CACHE_MAX) {
    const oldest = resolvedCache.keys().next().value;
    if (oldest !== undefined) resolvedCache.delete(oldest);
  }
}

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
 * Past a token's lookup budget the redirect comes from the in-memory cache of
 * destinations this instance resolved (only ever filled from the stored doc),
 * or a 429 when there is none.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  let token: string;
  let resolved: Resolved | null;
  try {
    token = (await params).token;
    const lookup = checkClickLookupLimit(token);
    if (!lookup.ok) {
      const cached = resolvedCache.get(token);
      if (!cached) {
        return new NextResponse("Too many requests", {
          status: 429,
          headers: { "Retry-After": String(lookup.retryAfterSec), "Cache-Control": "no-store" },
        });
      }
      // Over the lookup budget is over the record budget too: redirect only.
      return NextResponse.redirect(cached.destination, {
        status: 302,
        headers: { "Cache-Control": "no-store" },
      });
    }
    resolved = await resolveDestination(token);
  } catch (err) {
    console.error("[t/c] link lookup failed", err instanceof Error ? err.message : String(err));
    return notFound();
  }
  if (!resolved) return notFound();
  remember(token, resolved);

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
