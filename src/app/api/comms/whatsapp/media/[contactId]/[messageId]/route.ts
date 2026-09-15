import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireContactAccessible, requireUid } from "@/lib/comms/route-auth";
import {
  openWhatsappMedia,
  whatsappMediaPath,
  type MediaByteRange,
} from "@/lib/comms/whatsapp/media-storage";
import {
  isAllowedWhatsappMediaMime,
  parseWhatsappMedia,
} from "@/types/whatsapp-media";
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
 *
 * Every refusal below is a 404, deliberately: a caller who has passed the
 * contact gate learns only that there is nothing to serve, never why.
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
  const row = (snap.exists ? snap.data() : null) ?? null;

  // A stored row is data, not a type. Validate the shape rather than casting
  // it: a partial write leaving `mimeType` or `filename` undefined would
  // otherwise throw on `.split()` and answer 500 instead of 404.
  const media = parseWhatsappMedia(row?.media);
  if (!row || !media) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Defence in depth: the row must belong to the same tenant as the contact the
  // caller was authorised against. The path re-derivation below already binds
  // the object to the row's own keys; this binds those keys to the contact, so
  // no future writer can create a row that misroutes across tenants.
  if (
    row.agencyId !== contact.agencyId ||
    row.subAccountId !== contact.subAccountId
  ) {
    console.warn("[whatsapp-media] row tenancy disagrees with contact", {
      contactId,
      messageId,
    });
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Re-derive the path rather than trusting the stored one. A stored path is
  // data; a mismatch means the row was written by something that does not agree
  // with `whatsappMediaPath`, and is refused rather than served.
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

  const range = parseRange(request.headers.get("range"), opened.sizeBytes);
  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: {
        "Content-Range": `bytes */${opened.sizeBytes}`,
        "Accept-Ranges": "bytes",
      },
    });
  }

  const headers: Record<string, string> = {
    // From the doc's own validated set, never echoed from the request. An
    // unrecognised mime is served as an opaque download so a row carrying
    // `text/html` can never render in the operator's origin. There is no CSP on
    // this route, so this plus `nosniff` is the whole defence.
    "Content-Type": isAllowedWhatsappMediaMime(media.mimeType)
      ? media.mimeType
      : "application/octet-stream",
    "Content-Disposition": contentDisposition(media),
    // Voice notes are the commonest inbound media and an operator needs to seek
    // in them, which needs range requests.
    "Accept-Ranges": "bytes",
    // Private: the object is tenant data, so no shared cache may hold it.
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
  };

  if (range) {
    // Content-Length here is derived from the SAME range handed to the reader,
    // so the header and the body cannot disagree. On a full response there is
    // no such guarantee — the size came from metadata, the bytes from a
    // separate stream — so no Content-Length is sent and the response is
    // chunked instead of silently truncating.
    headers["Content-Range"] =
      `bytes ${range.start}-${range.end}/${opened.sizeBytes}`;
    headers["Content-Length"] = String(range.end - range.start + 1);
  }

  return new Response(toWebStream(opened.read(range ?? undefined)), {
    status: range ? 206 : 200,
    headers,
  });
}

function toWebStream(source: AsyncIterable<Buffer>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of source) {
          controller.enqueue(new Uint8Array(chunk));
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

/**
 * A single `bytes=` range, clamped to the object.
 *
 * Anything this does not understand — a multi-range header, garbage, a syntax
 * it cannot parse — returns null and the whole object is served, which RFC 9110
 * permits and which is what a media element falls back to anyway.
 */
function parseRange(
  header: string | null,
  size: number,
): MediaByteRange | "unsatisfiable" | null {
  if (!header || size <= 0) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (!rawStart && !rawEnd) return null;

  let start: number;
  let end: number;
  if (!rawStart) {
    // Suffix form: the last N bytes.
    const n = Number(rawEnd);
    if (n <= 0) return "unsatisfiable";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Math.min(Number(rawEnd), size - 1) : size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
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
  return `${type}; filename="file"; filename*=UTF-8''${rfc5987(safe || "file")}`;
}

/**
 * `encodeURIComponent` leaves `! * ( )` alone, and none of them is an RFC 5987
 * `attr-char`, so a strict parser may discard the whole `filename*` parameter.
 * It also THROWS on a lone surrogate — which a filename copied out of a broken
 * client can carry — and an unencodable name must not cost the response.
 */
function rfc5987(value: string): string {
  try {
    return encodeURIComponent(value).replace(
      /[!*()]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  } catch {
    return "file";
  }
}
