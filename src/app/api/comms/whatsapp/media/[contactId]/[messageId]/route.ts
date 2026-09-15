import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireContactAccessible, requireUid } from "@/lib/comms/route-auth";
import {
  openWhatsappMedia,
  whatsappMediaPath,
} from "@/lib/comms/whatsapp/media-storage";
import { isAllowedWhatsappMediaMime } from "@/types/whatsapp-media";
import type { WhatsappMedia } from "@/types/whatsapp-media";

export const dynamic = "force-dynamic";

/**
 * Serve one WhatsApp media object.
 *
 * Authorised with the same `requireUid` + `requireContactAccessible` pair the
 * WhatsApp send route uses — the object is tenant data and the only readers are
 * the agency owner and active members of the contact's sub-account.
 *
 * Sits under `/api/comms/whatsapp/` beside the send route rather than a
 * `/api/sa/*` namespace, which this repo does not have (every sub-account API
 * route is `/api/sub-accounts/[id]/…`; `/sa/*` is the page namespace).
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ contactId: string; messageId: string }> },
) {
  const { contactId, messageId } = await params;

  const auth = requireUid(request);
  if (auth instanceof NextResponse) return auth;

  const contact = await requireContactAccessible(auth.uid, contactId);
  if (contact instanceof NextResponse) return contact;

  const snap = await getAdminDb()
    .doc(`contacts/${contactId}/whatsappMessages/${messageId}`)
    .get();
  const media = snap.exists
    ? ((snap.data()?.media ?? null) as WhatsappMedia | null)
    : null;
  if (!media?.storagePath) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Re-derive the path rather than trusting the stored one. A stored path is
  // data; a mismatch means the row was written by something that does not agree
  // with `whatsappMediaPath`, and is refused rather than served.
  const row = snap.data() ?? {};
  const derived = whatsappMediaPath({
    agencyId: String(row.agencyId ?? ""),
    subAccountId: String(row.subAccountId ?? ""),
    contactId,
    messageDocId: messageId,
  });
  if (derived !== media.storagePath) {
    console.warn(
      "[whatsapp-media] stored path disagrees with derived path — refusing",
      { contactId, messageId },
    );
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const opened = await openWhatsappMedia(derived);
  if (!opened) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of opened.stream) {
          controller.enqueue(new Uint8Array(chunk));
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      // From the doc's own validated set, never echoed from the request. An
      // unrecognised mime is served as an opaque download so a row carrying
      // `text/html` can never render in the operator's origin.
      "Content-Type": isAllowedWhatsappMediaMime(media.mimeType)
        ? media.mimeType
        : "application/octet-stream",
      "Content-Disposition": contentDisposition(media),
      "Content-Length": String(opened.sizeBytes),
      // Private: the object is tenant data, so no shared cache may hold it.
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * A raw filename in a response header is a response-splitting vector, so the
 * name is reduced to a basename, stripped of control characters, quotes and
 * separators, and then percent-encoded into the RFC 5987 `filename*` slot. The
 * ASCII `filename="file"` fallback is deliberately constant — no byte of the
 * sender's name reaches an unencoded position.
 */
function contentDisposition(media: WhatsappMedia): string {
  const type = media.kind === "document" ? "attachment" : "inline";
  const basename = media.filename.split(/[/\\]/).pop() ?? "";
  const safe = basename.replace(/[\u0000-\u001f\u007f"'\\]/g, "").trim();
  const encoded = encodeURIComponent(safe || "file");
  return `${type}; filename="file"; filename*=UTF-8''${encoded}`;
}
