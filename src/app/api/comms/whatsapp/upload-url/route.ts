import { NextResponse } from "next/server";
import { requireContactAccessible, requireUid } from "@/lib/comms/route-auth";
import {
  mediaRefusal,
  newStagedId,
  signStagedUpload,
  stagedUploadCap,
  stagingPath,
  stagingRail,
} from "@/lib/comms/whatsapp/staged-upload";
import { checkUploadUrlRateLimit } from "@/lib/comms/whatsapp/upload-rate-limit";

type Body = { contactId?: string; contentType?: string; sizeBytes?: number };

/**
 * Issue a short-lived signed PUT URL for one composer attachment, so the
 * browser uploads the file straight to Storage instead of posting it as
 * base64 through the send route. See staged-upload.ts.
 *
 * Only a caller who could message this contact gets a URL — the same
 * `requireContactAccessible` the send route uses — and only for a file the
 * contact's rail would accept by its DECLARED type and size. The send route
 * checks the real object again; this check just stops a URL being issued for
 * an upload that could never be sent.
 *
 * The request carries no path. The object's path is derived here from the
 * contact and the caller, and only its random last segment goes back, with
 * the `x-goog-content-length-range` value the PUT must carry: the URL is
 * signed for at most the rail's cap for this kind of file.
 */
export async function POST(request: Request) {
  const auth = requireUid(request);
  if (auth instanceof NextResponse) return auth;

  const limit = checkUploadUrlRateLimit(auth.uid);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many attachments in a short time. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } },
    );
  }

  let payload: Body;
  try {
    payload = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const contactId = typeof payload.contactId === "string" ? payload.contactId.trim() : "";
  const contentType = typeof payload.contentType === "string" ? payload.contentType.trim() : "";
  const sizeBytes = payload.sizeBytes;
  if (!contactId || !contentType || typeof sizeBytes !== "number") {
    return NextResponse.json(
      { error: "contactId, contentType and sizeBytes are required" },
      { status: 400 },
    );
  }

  const contact = await requireContactAccessible(auth.uid, contactId);
  if (contact instanceof NextResponse) return contact;

  const rail = await stagingRail(contact.subAccountId);
  if (!rail.ok) return NextResponse.json({ error: rail.error }, { status: rail.status });
  const refusal = mediaRefusal(rail.capabilities, contentType, sizeBytes);
  if (refusal) return NextResponse.json(refusal, { status: 400 });

  const stagedId = newStagedId();
  const path = stagingPath({
    agencyId: contact.agencyId,
    subAccountId: contact.subAccountId,
    uid: auth.uid,
    stagedId,
  })!;
  let signed: Awaited<ReturnType<typeof signStagedUpload>>;
  try {
    signed = await signStagedUpload(path, contentType, stagedUploadCap(rail.capabilities, contentType));
  } catch (err) {
    console.error("[whatsapp/upload-url] signing failed", err instanceof Error ? err.message : typeof err);
    signed = null;
  }
  if (!signed) {
    return NextResponse.json({ error: "File uploads aren't available right now." }, { status: 503 });
  }
  return NextResponse.json({
    stagedId,
    uploadUrl: signed.url,
    expiresAt: signed.expiresAt,
    contentLengthRange: signed.contentLengthRange,
  });
}
