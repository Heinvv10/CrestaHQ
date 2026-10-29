import "server-only";

import { recordBroadcastEngagement } from "@/lib/broadcasts/engagement";
import { verifyOpenToken } from "@/lib/broadcasts/tracking-token";
import { clientIpFrom } from "@/lib/checkout/rate-limit";
import { isDocId } from "@/lib/server/doc-id";
import { createFixedWindowLimiter } from "@/lib/server/fixed-window-limit";

export const dynamic = "force-dynamic";

/** Transparent 1×1 GIF. */
const PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

/**
 * Generous: Gmail and Apple fetch images through shared proxy addresses, so
 * one IP stands for many readers. Over the limit the pixel is still served,
 * just not recorded — opens are an estimate either way.
 */
const checkOpenRateLimit = createFixedWindowLimiter({ limit: 600, windowMs: 60_000 });

/**
 * Broadcast open pixel. `/t/o/{token}` always answers 200 with the GIF —
 * a forged, bit-flipped or unknown token included — so the response says
 * nothing about whether the token was good. Only a verified token for a
 * sent row, on a sub-account with open tracking on, writes anything.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  if (checkOpenRateLimit(clientIpFrom(request)).ok) {
    const signed = verifyOpenToken(token);
    if (signed && isDocId(signed.broadcastId) && isDocId(signed.contactId)) {
      try {
        await recordBroadcastEngagement({ ...signed, kind: "opened" });
      } catch (err) {
        console.error(
          "[t/o] open record failed",
          signed.broadcastId,
          signed.contactId,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
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
