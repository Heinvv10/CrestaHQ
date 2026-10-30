import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { GhlApiError, validateGhlAccess } from "@/lib/import/ghl/client";
import {
  subAccountSecretDoc,
  subAccountSecretPath,
} from "@/lib/server/sub-account-secrets";

/**
 * Connect / disconnect a GoHighLevel source for migration (Phase 4).
 *
 * POST   — store + validate a Private Integration Token + location id. The
 *          token is verified with a live GHL call before it's saved, and is
 *          stored server-only (never returned to the client).
 * DELETE — clear the connection.
 *
 * Sub-account admin only.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const token = typeof b.token === "string" ? b.token.trim() : "";
  const locationId = typeof b.locationId === "string" ? b.locationId.trim() : "";
  if (!token || !locationId) {
    return NextResponse.json(
      { error: "Both a Private Integration Token and a location id are required." },
      { status: 400 },
    );
  }

  // Validate against the live API before storing anything.
  let contactTotal: number | null = null;
  try {
    const res = await validateGhlAccess(token, locationId);
    contactTotal = res.contactTotal;
  } catch (err) {
    if (err instanceof GhlApiError && (err.status === 401 || err.status === 403)) {
      return NextResponse.json(
        { error: "GoHighLevel rejected the token. Check the token + location id." },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { error: "Couldn't reach GoHighLevel. Please try again." },
      { status: 502 },
    );
  }

  const db = getAdminDb();
  const ref = db.doc(`subAccounts/${subAccountId}`);
  if (!(await ref.get()).exists) {
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }
  // Token → server-only private doc; update() replaces the whole map, so a
  // pre-migration token on the member-readable doc goes too.
  const batch = db.batch();
  batch.set(db.doc(subAccountSecretPath(subAccountId, "ghl")), subAccountSecretDoc("ghl", token));
  batch.update(ref, {
    ghlImportConfig: {
      locationId,
      connectedByUid: access.uid,
      connectedAt: FieldValue.serverTimestamp(),
      lastValidatedAt: FieldValue.serverTimestamp(),
    },
    updatedAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();

  return NextResponse.json({ ok: true, contactTotal });
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const db = getAdminDb();
  const ref = db.doc(`subAccounts/${subAccountId}`);
  if (!(await ref.get()).exists) {
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }
  const batch = db.batch();
  batch.update(ref, {
    ghlImportConfig: FieldValue.delete(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.delete(db.doc(subAccountSecretPath(subAccountId, "ghl")));
  await batch.commit();
  return NextResponse.json({ ok: true });
}
