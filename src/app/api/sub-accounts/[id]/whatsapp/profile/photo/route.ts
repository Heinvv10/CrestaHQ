import "server-only";

import { NextResponse } from "next/server";
import { withWhatsappSettings } from "@/lib/comms/whatsapp/settings/route-support";
import { MAX_PHOTO_BYTES, sniffPhotoMime } from "@/lib/comms/whatsapp/settings/photo";

/**
 * POST /api/sub-accounts/[id]/whatsapp/profile/photo — multipart `file`.
 * Admin only. JPEG or PNG, ≤ 5 MB, decided by the bytes' own magic numbers
 * rather than the client's content-type (which is whatever the browser or a
 * script chose to say). Uploaded to Meta's resumable endpoint and set as the
 * profile picture; answers with the URL Meta then serves.
 */

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
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
  if (file.size > MAX_PHOTO_BYTES) {
    return NextResponse.json({ error: "Photo must be 5 MB or smaller." }, { status: 400 });
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = sniffPhotoMime(bytes);
  if (!mime) {
    return NextResponse.json({ error: "Photo must be a JPEG or PNG." }, { status: 400 });
  }

  return withWhatsappSettings(request, id, "admin", async ({ provider }) => {
    await provider.uploadProfilePhoto(bytes, mime);
    const profile = await provider.getProfile();
    return NextResponse.json({ ok: true, profilePictureUrl: profile.profilePictureUrl });
  });
}
