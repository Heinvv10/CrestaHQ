import "server-only";

import { recordBroadcastEngagement } from "@/lib/broadcasts/engagement";
import { verifyOpenToken } from "@/lib/broadcasts/tracking-token";
import { isDocId } from "@/lib/server/doc-id";
import { createFixedWindowLimiter } from "@/lib/server/fixed-window-limit";

export const dynamic = "force-dynamic";

/** Transparent 1×1 GIF. */
const PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

/**
 * Records per verified token, so a replayed pixel can't cost a transaction
 * per request. Keyed by token, not IP: Gmail and Apple fetch images through
 * shared proxies, and a request with no IP header must not share one bucket
 * with every other such request. Over the limit the GIF is still served.
 */
const checkOpenRecordLimit = createFixedWindowLimiter({ limit: 20, windowMs: 60_000 });

/**
 * Broadcast open pixel. `/t/o/{token}` always answers 200 with the GIF —
 * a forged, bit-flipped or unknown token included, and whatever fails
 * inside — so the response says nothing about whether the token was good.
 * Only a verified token for a sent row, on a sub-account with open tracking
 * on, writes anything.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  try {
    const { token } = await params;
    const signed = verifyOpenToken(token);
    if (
      signed &&
      isDocId(signed.broadcastId) &&
      isDocId(signed.contactId) &&
      checkOpenRecordLimit(token).ok
    ) {
      await recordBroadcastEngagement({ ...signed, kind: "opened" });
    }
  } catch (err) {
    console.error("[t/o] open record failed", err instanceof Error ? err.message : String(err));
  }
  return new Response(new Uint8Array(PIXEL), {
    status: 200,
    headers: {
      "Content-Type": "image/gif",
      "Content-Length": String(PIXEL.length),
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      Pragma: "no-cache",
    },
  });
}
