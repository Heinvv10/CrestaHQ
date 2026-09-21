import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { normalizeDestinationUrl } from "@/lib/tracked-links/destination";

export const dynamic = "force-dynamic";

/**
 * PATCH / DELETE for a single tracked link. Both require the caller to be a
 * member of the link's owning sub-account.
 *
 * DELETE is a real delete, recursive — the `recipients` and `clicks`
 * subcollections would otherwise be orphaned and stay readable by id.
 */

async function loadLinkAndAuth(
  request: Request,
  subAccountId: string,
  linkId: string,
) {
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return { error: access };

  const db = getAdminDb();
  const snap = await db.doc(`trackedLinks/${linkId}`).get();
  if (!snap.exists) {
    return { error: NextResponse.json({ error: "Link not found" }, { status: 404 }) };
  }
  if (snap.data()?.subAccountId !== subAccountId) {
    return {
      error: NextResponse.json(
        { error: "Link belongs to a different sub-account" },
        { status: 403 },
      ),
    };
  }
  return { db, ref: snap.ref };
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; linkId: string }> },
) {
  const { id: subAccountId, linkId } = await params;
  const loaded = await loadLinkAndAuth(request, subAccountId, linkId);
  if ("error" in loaded) return loaded.error;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};
  if (typeof body.name === "string" && body.name.trim()) {
    updates.name = body.name.trim();
  }
  if (body.destinationUrl !== undefined) {
    const destinationUrl = normalizeDestinationUrl(body.destinationUrl);
    if (!destinationUrl) {
      return NextResponse.json(
        { error: "destinationUrl must be an http(s) URL" },
        { status: 400 },
      );
    }
    updates.destinationUrl = destinationUrl;
  }
  if (Object.keys(updates).length === 0) {
    return NextResponse.json(
      { error: "No valid fields to update" },
      { status: 400 },
    );
  }

  await loaded.ref.update({
    ...updates,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; linkId: string }> },
) {
  const { id: subAccountId, linkId } = await params;
  const loaded = await loadLinkAndAuth(request, subAccountId, linkId);
  if ("error" in loaded) return loaded.error;

  await loaded.db.recursiveDelete(loaded.ref);
  return NextResponse.json({ ok: true });
}
