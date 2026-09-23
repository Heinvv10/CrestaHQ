import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import type { BroadcastDoc } from "@/types";

export const dynamic = "force-dynamic";

/**
 * Stop a bulk email broadcast. Flips the broadcast to "cancelled" and
 * returns — O(1) regardless of audience size. The fanout step stops paging,
 * and each still-queued row settles as skipped ("cancelled") when its
 * already-scheduled QStash message fires, because the step claims rows in a
 * transaction that reads this status. A row already claimed when the cancel
 * lands still sends: that email is in flight.
 */
export async function POST(request: Request) {
  let payload: { broadcastId?: string };
  try {
    payload = (await request.json()) as { broadcastId?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const broadcastId = payload.broadcastId?.trim();
  if (!broadcastId) {
    return NextResponse.json({ error: "broadcastId is required" }, { status: 400 });
  }

  const db = getAdminDb();
  const broadcastRef = db.collection("broadcasts").doc(broadcastId);
  const snap = await broadcastRef.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Broadcast not found" }, { status: 404 });
  }
  const access = await requireSubAccountMember(
    request,
    (snap.data() as BroadcastDoc).subAccountId,
  );
  if (access instanceof NextResponse) return access;

  const result = await db.runTransaction(async (tx) => {
    const current = (await tx.get(broadcastRef)).data() as BroadcastDoc;
    if (current.status !== "queued" && current.status !== "sending") {
      return current.status;
    }
    tx.update(broadcastRef, {
      status: "cancelled",
      completedAt: FieldValue.serverTimestamp(),
    });
    return null;
  });

  return NextResponse.json(
    result === null ? { ok: true } : { ok: true, alreadyStopped: result },
  );
}
