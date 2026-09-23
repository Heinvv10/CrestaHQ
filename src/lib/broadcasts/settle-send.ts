import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import type { BroadcastSendDoc } from "@/types";

type TotalsField = "totals.sent" | "totals.skipped" | "totals.failed";

/** In-process attempts at the settle write before giving up to QStash. */
const SETTLE_ATTEMPTS = 3;

/**
 * Settle a claimed send row and move it out of totals.queued — one atomic
 * batch, so the row and the counters can never disagree. Retried in-process:
 * after a successful send the claim must not be dropped, so a blip here would
 * otherwise leave the row claimed until it goes stale and is failed as
 * "delivery unknown" although the email went out.
 */
export async function settleSend(
  sendRef: FirebaseFirestore.DocumentReference,
  broadcastRef: FirebaseFirestore.DocumentReference,
  rowPatch: Record<string, unknown>,
  total: TotalsField,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const batch = getAdminDb().batch();
    batch.update(sendRef, { ...rowPatch, attempts: FieldValue.increment(1) });
    batch.update(broadcastRef, {
      [total]: FieldValue.increment(1),
      "totals.queued": FieldValue.increment(-1),
    });
    try {
      await batch.commit();
      return;
    } catch (err) {
      if (attempt >= SETTLE_ATTEMPTS) throw err;
      console.warn("[broadcasts/step] settle write failed, retrying", attempt, err);
    }
  }
}

/**
 * Drop a claim taken by a step that failed BEFORE reaching the email
 * provider — nothing was sent, so QStash's retry may safely run the row
 * again instead of finding it "in flight".
 */
export async function releaseClaim(
  sendRef: FirebaseFirestore.DocumentReference,
): Promise<void> {
  await getAdminDb().runTransaction(async (tx) => {
    const row = (await tx.get(sendRef)).data() as BroadcastSendDoc | undefined;
    if (row?.status !== "queued" || !row.claimedAt) return;
    tx.update(sendRef, { claimedAt: FieldValue.delete() });
  });
}
