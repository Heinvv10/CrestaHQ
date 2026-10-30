import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  requireSubAccountAdmin,
  requireSubAccountMember,
} from "@/lib/auth/require-tenancy";
import { prepareBookingPage } from "@/lib/server/booking-page-write";
import { GLOBAL_TERRITORY_ID } from "@/types";
import type { BookingPage } from "@/types/booking";

/**
 * Booking-page CRUD per sub-account.
 *
 * GET  — list every booking page in the sub-account. Visible to any
 *        active member so collaborators can see/share public links.
 *        Reads also flow over the client SDK + Firestore rules — this
 *        route exists for server-side renderers and integration tests.
 * POST — create a new booking page. Sub-account admin only. Slug must
 *        be globally unique within the sub-account; the slug doubles as
 *        the Firestore doc id so collisions are detected by doc.create.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const snap = await getAdminDb()
    .collection(`subAccounts/${subAccountId}/bookingPages`)
    .get();
  const pages = snap.docs
    .map((d) => ({ id: d.id, ...(d.data() as Omit<BookingPage, "id">) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return NextResponse.json({ ok: true, pages });
}

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

  const prepared = await prepareBookingPage(subAccountId, body);
  if (!prepared.ok) {
    return NextResponse.json({ error: prepared.error }, { status: prepared.status });
  }
  const { data, agencyId } = prepared;
  const db = getAdminDb();

  // Defensively land the territoryId — Global by default so the
  // no-unassigned invariant holds even when scoping is off.
  const territoryId =
    data.defaultTerritoryId &&
    data.defaultTerritoryId !== GLOBAL_TERRITORY_ID
      ? data.defaultTerritoryId
      : GLOBAL_TERRITORY_ID;

  // Doc id == slug → atomic uniqueness check via create().
  const ref = db.doc(
    `subAccounts/${subAccountId}/bookingPages/${data.slug}`,
  );
  const now = FieldValue.serverTimestamp();
  const docPayload = {
    ...data,
    id: data.slug,
    agencyId,
    subAccountId,
    createdByUid: access.uid,
    territoryId,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await ref.create(docPayload);
  } catch (err) {
    // Firestore raises ALREADY_EXISTS (code 6) on create when the doc
    // exists. Surface as 409 so the editor can prompt for a different slug.
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? (err as { code?: number | string }).code
        : null;
    if (code === 6 || code === "already-exists") {
      return NextResponse.json(
        {
          error: `A booking page with the slug "${data.slug}" already exists. Pick another.`,
        },
        { status: 409 },
      );
    }
    throw err;
  }

  return NextResponse.json({ ok: true, slug: data.slug });
}
