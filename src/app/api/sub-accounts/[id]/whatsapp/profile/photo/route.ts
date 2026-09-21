import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb, getAdminStorage } from "@/lib/firebase/admin";
import { withWhatsappSettings } from "@/lib/comms/whatsapp/settings/route-support";
import { MAX_PHOTO_BYTES, sniffPhotoMime } from "@/lib/comms/whatsapp/settings/photo";
import { isOwnedStoragePath } from "@/lib/media/service";
import type { MediaAssetDoc } from "@/types/media";

/**
 * POST /api/sub-accounts/[id]/whatsapp/profile/photo — either multipart
 * `file`, or JSON `{ mediaId }` naming a file in THIS sub-account's Media
 * Library. Admin only. Both paths meet at the same gate: JPEG or PNG, ≤ 5 MB,
 * decided by the bytes' own magic numbers rather than any declared type.
 * Uploaded to Meta's resumable endpoint and set as the profile picture;
 * answers with the URL Meta then serves.
 */

export const dynamic = "force-dynamic";

const tooLarge = () => NextResponse.json({ error: "Photo must be 5 MB or smaller." }, { status: 400 });

/** The bytes from the library doc, or the refusal to answer with. */
async function readLibraryPhoto(
  subAccountId: string,
  mediaId: unknown,
): Promise<Uint8Array | NextResponse> {
  if (typeof mediaId !== "string" || !mediaId) {
    return NextResponse.json({ error: "Expected `mediaId`." }, { status: 400 });
  }
  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}/media/${mediaId}`).get();
  const asset = snap.data() as MediaAssetDoc | undefined;
  // The doc lives under this sub-account's path AND its object path must be
  // this sub-account's — a doc pointing elsewhere is refused, not followed.
  if (!snap.exists || !asset || !isOwnedStoragePath(asset.storagePath, subAccountId, mediaId)) {
    return NextResponse.json({ error: "Media not found" }, { status: 404 });
  }
  if (asset.size > MAX_PHOTO_BYTES) return tooLarge();
  const [bytes] = await getAdminStorage().bucket().file(asset.storagePath).download();
  return new Uint8Array(bytes);
}

async function readMultipartPhoto(request: Request): Promise<Uint8Array | NextResponse> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected a multipart form with a `file` field." }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: "Expected a multipart form with a `file` field." }, { status: 400 });
  }
  if (file.size > MAX_PHOTO_BYTES) return tooLarge();
  return new Uint8Array(await file.arrayBuffer());
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  // The body is read only once the caller is an admin of a gated
  // workspace: an unauthenticated POST never makes the server buffer 5 MB.
  return withWhatsappSettings(request, id, "admin", async ({ provider }) => {
    const isJson = (request.headers.get("content-type") ?? "").includes("application/json");
    let bytes: Uint8Array | NextResponse;
    if (isJson) {
      const body = (await request.json().catch(() => null)) as { mediaId?: unknown } | null;
      bytes = await readLibraryPhoto(id, body?.mediaId);
    } else {
      bytes = await readMultipartPhoto(request);
    }
    if (bytes instanceof NextResponse) return bytes;
    if (bytes.byteLength > MAX_PHOTO_BYTES) return tooLarge();
    const mime = sniffPhotoMime(bytes);
    if (!mime) {
      return NextResponse.json({ error: "Photo must be a JPEG or PNG." }, { status: 400 });
    }
    await provider.uploadProfilePhoto(bytes, mime);
    const profile = await provider.getProfile();
    return NextResponse.json({ ok: true, profilePictureUrl: profile.profilePictureUrl });
  });
}
