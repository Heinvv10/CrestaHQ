import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import { captureSnapshot } from "@/lib/snapshots/capture";
import { SNAPSHOT_VERSION } from "@/types/snapshots";

interface CaptureBody {
  sourceSubAccountId?: string;
  name?: string;
  description?: string;
}

interface CallerClaims {
  status?: string;
  agencyRole?: string;
  agencyId?: string | null;
}

/**
 * Agency-owner gate that also returns the caller's agencyId (needed for the
 * snapshot doc path). Mirrors the local helper in
 * /api/agency/sub-accounts/route.ts.
 */
async function requireAgencyOwnerWithId(
  request: Request,
): Promise<{ uid: string; agencyId: string } | NextResponse> {
  const uid = request.headers.get("x-user-uid");
  if (!uid) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const record = await getAdminAuth().getUser(uid).catch(() => null);
  if (!record) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const claims = (record.customClaims ?? {}) as CallerClaims;
  if (claims.status !== "active") {
    return NextResponse.json({ error: "Account inactive" }, { status: 403 });
  }
  if (claims.agencyRole !== "owner" || !claims.agencyId) {
    return NextResponse.json({ error: "Agency owner only" }, { status: 403 });
  }
  return { uid, agencyId: claims.agencyId };
}

/** GET — list this agency's snapshots (summaries only, no payload). */
export async function GET(request: Request) {
  const access = await requireAgencyOwnerWithId(request);
  if (access instanceof NextResponse) return access;

  const db = getAdminDb();
  const snap = await db
    .collection(`agencies/${access.agencyId}/snapshots`)
    .orderBy("createdAt", "desc")
    .get();

  const snapshots = snap.docs.map((d) => {
    const data = d.data();
    const payload = data.payload ?? {};
    return {
      id: d.id,
      name: data.name ?? "",
      description: data.description ?? "",
      sourceSubAccountId: data.sourceSubAccountId ?? null,
      version: data.version ?? SNAPSHOT_VERSION,
      createdAt: data.createdAt?.toMillis?.() ?? null,
      counts: {
        forms: payload.forms?.length ?? 0,
        messageTemplates: payload.messageTemplates?.length ?? 0,
        products: payload.products?.length ?? 0,
        workflows: payload.workflows?.length ?? 0,
      },
    };
  });

  return NextResponse.json({ snapshots });
}

/** POST — capture a new snapshot from a source sub-account. */
export async function POST(request: Request) {
  const access = await requireAgencyOwnerWithId(request);
  if (access instanceof NextResponse) return access;
  const { agencyId, uid } = access;

  let body: CaptureBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const sourceSubAccountId = body.sourceSubAccountId?.trim();
  const name = body.name?.trim();
  const description = body.description?.trim() ?? "";
  if (!sourceSubAccountId) {
    return NextResponse.json(
      { error: "sourceSubAccountId is required." },
      { status: 400 },
    );
  }
  if (!name) {
    return NextResponse.json({ error: "Name is required." }, { status: 400 });
  }

  const db = getAdminDb();

  // The source sub-account must belong to the caller's agency — never let an
  // owner capture config out of another agency's tenant.
  const subSnap = await db.doc(`subAccounts/${sourceSubAccountId}`).get();
  if (!subSnap.exists || subSnap.data()?.agencyId !== agencyId) {
    return NextResponse.json(
      { error: "Sub-account not found in this agency." },
      { status: 404 },
    );
  }

  const payload = await captureSnapshot(db, sourceSubAccountId);

  const ref = db.collection(`agencies/${agencyId}/snapshots`).doc();
  await ref.set({
    id: ref.id,
    agencyId,
    name,
    description,
    version: SNAPSHOT_VERSION,
    sourceSubAccountId,
    createdByUid: uid,
    createdAt: FieldValue.serverTimestamp(),
    payload,
  });

  return NextResponse.json({
    snapshotId: ref.id,
    counts: {
      forms: payload.forms.length,
      messageTemplates: payload.messageTemplates.length,
      products: payload.products.length,
      workflows: payload.workflows.length,
    },
  });
}
