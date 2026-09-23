import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import type { BroadcastDoc } from "@/types";

/**
 * If the fan-out has finished and totals.queued is now 0, flip status →
 * "completed" and stamp completedAt. Re-reads the doc so the increment that
 * just happened is reflected; uses a transaction so the flip can't fire twice
 * if two final rows settle at exactly the same time. A cancelled broadcast
 * stays cancelled.
 */
export async function maybeMarkBroadcastCompleted(
  broadcastRef: FirebaseFirestore.DocumentReference,
): Promise<void> {
  await getAdminDb().runTransaction(async (tx) => {
    const snap = await tx.get(broadcastRef);
    if (!snap.exists) return;
    const data = snap.data() as BroadcastDoc;
    if (
      data.status === "completed" ||
      data.status === "failed" ||
      data.status === "cancelled"
    )
      return;
    // Absent = a broadcast fanned out whole at creation (pre-paging).
    if (data.fanoutDone === false) return;
    if ((data.totals?.queued ?? 0) <= 0) {
      tx.update(broadcastRef, {
        status: "completed",
        completedAt: FieldValue.serverTimestamp(),
      });
    }
  });
}
