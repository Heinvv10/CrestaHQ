import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireAgencyOwnerAny } from "@/lib/auth/require-tenancy";
import { readJsonCapped } from "@/lib/server/read-json-capped";
import { dropCachedLogo } from "@/lib/brand/logo-cache";
import {
  LOGO_MAX_BODY_BYTES,
  logoDocRef,
  logoPublicUrl,
  storeLogo,
  validateLogo,
} from "@/lib/brand/logo-server";
import { LOGO_ID_RE, pointsAtUploadedLogo } from "@/lib/brand/logo-shared";

/**
 * Owner-only agency logo upload/remove. The browser resizes the file
 * (lib/brand/render-logo-client.ts); we re-validate, store it, and point the
 * agency's existing `logoUrl` at the public serving route. The agency is the
 * caller's own, from their claims (same as PATCH /api/agency).
 */

export async function POST(request: Request) {
  const owner = await requireAgencyOwnerAny(request);
  if (owner instanceof NextResponse) return owner;
  const agencyId = owner.agencyId as string;
  if (!LOGO_ID_RE.test(agencyId)) {
    return NextResponse.json(
      { error: "This id can't be given a public logo URL." },
      { status: 400 },
    );
  }

  const read = await readJsonCapped(request, LOGO_MAX_BODY_BYTES);
  if (!read.ok) {
    return read.reason === "too_large"
      ? NextResponse.json({ error: "Logo is too large. Try a simpler image." }, { status: 413 })
      : NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const body = (read.value ?? {}) as { data?: unknown; mime?: unknown };

  const result = await validateLogo(body.data, body.mime);
  if (typeof result === "string") {
    return NextResponse.json({ error: result }, { status: 400 });
  }

  // Checked before storing: a logo saved behind a URL we can't build is orphaned.
  if (!logoPublicUrl("agency", agencyId, 0)) {
    return NextResponse.json(
      { error: "NEXT_PUBLIC_APP_URL isn't configured, so the logo can't be given a public URL." },
      { status: 503 },
    );
  }

  const version = await storeLogo(
    "agency",
    agencyId,
    result,
    body.mime as "image/png" | "image/webp",
  );
  const logoUrl = logoPublicUrl("agency", agencyId, version) as string;
  await getAdminDb().doc(`agencies/${agencyId}`).update({
    logoUrl,
    updatedAt: FieldValue.serverTimestamp(),
  });

  dropCachedLogo("agency", agencyId);

  return NextResponse.json({ ok: true, logoUrl });
}

export async function DELETE(request: Request) {
  const owner = await requireAgencyOwnerAny(request);
  if (owner instanceof NextResponse) return owner;
  const agencyId = owner.agencyId as string;

  const db = getAdminDb();
  const agencyRef = db.doc(`agencies/${agencyId}`);
  const snap = await agencyRef.get();
  // Leave a pasted URL alone; clear the field when its path is this tenant's
  // upload, whatever origin it was minted under.
  if (pointsAtUploadedLogo(snap.data()?.logoUrl as string | undefined, "agency", agencyId)) {
    await agencyRef.update({
      logoUrl: null,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
  // Blob last: a failure between the two leaves a stored logo nothing points
  // at, never a logoUrl that 404s in every email and page.
  await logoDocRef("agency", agencyId).delete();
  dropCachedLogo("agency", agencyId);

  return NextResponse.json({ ok: true });
}
