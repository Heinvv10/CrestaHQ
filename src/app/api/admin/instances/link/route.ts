import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireAgencyOwner } from "@/lib/auth/require-agency-owner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Manual instance → purchase pin for the Instances fleet view. The fuzzy
 * matcher in lib/affiliate/instances-data.ts covers the common alias cases,
 * but some buyers purchase and deploy under completely unrelated identities —
 * this lets the owner pin the match once and have it stick across heartbeats
 * (`linkedPurchaseId` on the instance doc; heartbeat merges never touch it).
 *
 * Body: { instanceId: string, purchase: string | null }
 *   - `purchase` accepts either a purchase doc id (= Stripe session id) OR a
 *     buyer email — resolved server-side so the operator can paste whichever
 *     they have at hand.
 *   - null / "" clears an existing pin.
 *
 * Owner-only. Display-only effect: pins never drive the dispute auto-flag or
 * any revocation — that stays exact-email in lib/stripe/dispute.ts.
 */

interface LinkBody {
  instanceId?: string;
  purchase?: string | null;
}

export async function POST(request: Request) {
  const auth = await requireAgencyOwner(request);
  if (auth instanceof NextResponse) return auth;

  let body: LinkBody;
  try {
    body = (await request.json()) as LinkBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const instanceId =
    typeof body.instanceId === "string" ? body.instanceId.trim() : "";
  if (!instanceId || instanceId.includes("/")) {
    return NextResponse.json({ error: "Missing instanceId" }, { status: 400 });
  }

  const db = getAdminDb();
  const instanceRef = db.collection("leadstackInstances").doc(instanceId);
  const instanceSnap = await instanceRef.get();
  if (!instanceSnap.exists) {
    return NextResponse.json({ error: "Instance not found" }, { status: 404 });
  }

  const rawPurchase =
    typeof body.purchase === "string" ? body.purchase.trim() : "";

  // Clear an existing pin.
  if (!rawPurchase) {
    await instanceRef.update({
      linkedPurchaseId: FieldValue.delete(),
      linkedAt: FieldValue.delete(),
      linkedBy: FieldValue.delete(),
    });
    return NextResponse.json({ ok: true, linkedPurchaseId: null });
  }

  // Resolve the purchase: doc id first (Stripe session id), then buyer email.
  let purchaseId: string | null = null;
  let buyerEmail: string | null = null;

  if (!rawPurchase.includes("@")) {
    const byId = await db.collection("purchases").doc(rawPurchase).get();
    if (byId.exists) {
      purchaseId = byId.id;
      buyerEmail = (byId.data()?.email as string | undefined) ?? null;
    }
  }
  if (!purchaseId) {
    // Equality-only query (no orderBy) so this needs no composite index;
    // a buyer has at most a handful of purchases — pick the newest in memory.
    const byEmail = await db
      .collection("purchases")
      .where("email", "==", rawPurchase.toLowerCase())
      .get();
    const newest = byEmail.docs
      .map((d) => ({
        id: d.id,
        email: (d.data().email as string | undefined) ?? null,
        createdAtMs: d.data().createdAt?.toMillis?.() ?? 0,
      }))
      .sort((a, b) => b.createdAtMs - a.createdAtMs)[0];
    if (newest) {
      purchaseId = newest.id;
      buyerEmail = newest.email;
    }
  }
  if (!purchaseId) {
    return NextResponse.json(
      { error: "No purchase found for that id or email." },
      { status: 404 },
    );
  }

  await instanceRef.update({
    linkedPurchaseId: purchaseId,
    linkedAt: FieldValue.serverTimestamp(),
    linkedBy: auth.email || auth.uid,
  });

  return NextResponse.json({ ok: true, linkedPurchaseId: purchaseId, buyerEmail });
}
