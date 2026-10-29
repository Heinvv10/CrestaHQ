import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { isDocId } from "@/lib/server/doc-id";
import { readJsonCapped } from "@/lib/server/read-json-capped";
import {
  LOGO_MAX_BODY_BYTES,
  logoDocRef,
  logoPublicUrl,
  storeLogo,
  validateLogo,
} from "@/lib/brand/logo-server";
import { isUploadedLogoUrl } from "@/lib/brand/logo-shared";

/**
 * Sub-account logo upload/remove (admin or agency owner). Same flow as the
 * agency logo: store server-side, point `subAccount.logoUrl` at the public
 * serving route.
 */

const notFound = () => NextResponse.json({ error: "Sub-account not found" }, { status: 404 });

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  if (!isDocId(subAccountId)) return notFound();
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const read = await readJsonCapped(request, LOGO_MAX_BODY_BYTES);
  if (!read.ok) {
    return read.reason === "too_large"
      ? NextResponse.json({ error: "Logo is too large. Try a simpler image." }, { status: 413 })
      : NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const body = (read.value ?? {}) as { data?: unknown; mime?: unknown };

  const result = validateLogo(body.data, body.mime);
  if (typeof result === "string") {
    return NextResponse.json({ error: result }, { status: 400 });
  }

  // Checked before storing: a logo saved behind a URL we can't build is orphaned.
  if (!logoPublicUrl("sa", subAccountId, 0)) {
    return NextResponse.json(
      { error: "NEXT_PUBLIC_APP_URL isn't configured, so the logo can't be given a public URL." },
      { status: 503 },
    );
  }

  const version = await storeLogo(
    "sa",
    subAccountId,
    result,
    body.mime as "image/png" | "image/webp",
  );
  const logoUrl = logoPublicUrl("sa", subAccountId, version) as string;
  await getAdminDb().doc(`subAccounts/${subAccountId}`).set(
    { logoUrl, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );

  return NextResponse.json({ ok: true, logoUrl });
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  if (!isDocId(subAccountId)) return notFound();
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const subRef = getAdminDb().doc(`subAccounts/${subAccountId}`);
  const snap = await subRef.get();
  await logoDocRef("sa", subAccountId).delete();
  // Leave a pasted URL alone; only clear the field when it points at our upload.
  if (isUploadedLogoUrl(snap.data()?.logoUrl as string | undefined)) {
    await subRef.update({
      logoUrl: null,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  return NextResponse.json({ ok: true });
}
