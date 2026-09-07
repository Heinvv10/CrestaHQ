import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { normalizeDestinationUrl } from "@/lib/tracked-links/destination";
import { DEFAULT_TRACKED_LINK } from "@/types/tracked-links";

export const dynamic = "force-dynamic";

/**
 * GET  /api/sub-accounts/[id]/tracked-links — list, newest first.
 * POST /api/sub-accounts/[id]/tracked-links — create.
 *
 * Any active member may manage links (same bar as products/quotes — a
 * collaborator building a campaign needs to add one). Dashboard-created
 * links are always `mode: "live"`; the test namespace only exists for
 * API keys.
 */

interface CreateLinkPayload {
  name?: unknown;
  destinationUrl?: unknown;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: subAccountId } = await params;

  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const snap = await getAdminDb()
    .collection("trackedLinks")
    .where("subAccountId", "==", subAccountId)
    .orderBy("createdAt", "desc")
    .get();

  const links = snap.docs.map((d) => {
    const data = d.data();
    const lastClickedAt = data.lastClickedAt as
      | { toDate?: () => Date }
      | undefined;
    return {
      id: d.id,
      name: (data.name as string) ?? "",
      destinationUrl: (data.destinationUrl as string) ?? "",
      clickCount: (data.clickCount as number) ?? 0,
      lastClickedAt: lastClickedAt?.toDate
        ? lastClickedAt.toDate().toISOString()
        : null,
    };
  });

  return NextResponse.json({ links });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: subAccountId } = await params;

  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: CreateLinkPayload;
  try {
    body = (await request.json()) as CreateLinkPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  const destinationUrl = normalizeDestinationUrl(body.destinationUrl);
  if (!destinationUrl) {
    return NextResponse.json(
      { error: "destinationUrl must be an http(s) URL" },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  const agencyId =
    access.agencyId ?? (subSnap.data()?.agencyId as string | undefined);
  if (!agencyId) {
    return NextResponse.json(
      { error: "Sub-account is missing an agencyId" },
      { status: 500 },
    );
  }

  const docRef = db.collection("trackedLinks").doc();
  await docRef.set({
    ...DEFAULT_TRACKED_LINK,
    agencyId,
    subAccountId,
    createdByUid: access.uid,
    mode: "live",
    name,
    destinationUrl,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  return NextResponse.json({ id: docRef.id }, { status: 201 });
}
