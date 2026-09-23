import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import type { BroadcastSendDoc } from "@/types";

type TotalsField = "totals.sent" | "totals.skipped" | "totals.failed";

/** A send row this step holds the claim on. */
export interface ClaimedRow {
  sendRef: FirebaseFirestore.DocumentReference;
  broadcastRef: FirebaseFirestore.DocumentReference;
  /** Written by claimSend; the settle only lands while it is still there. */
  claimId: string;
}

/** In-process attempts at the settle write before giving up to QStash. */
const SETTLE_ATTEMPTS = 3;

/**
 * Settle a claimed send row and move it out of totals.queued, in one
 * transaction that only writes while the row is still queued under THIS
 * claim — so a late original can never overwrite a row a retry already
 * failed as stale, nor count it twice. Retried in-process: after a
 * successful send the claim must not be dropped, so a blip here would
 * otherwise leave the row claimed until it goes stale and is failed as
 * "delivery unknown" although the email went out. Returns false when the
 * claim had been superseded.
 */
export async function settleSend(
  row: ClaimedRow,
  rowPatch: Record<string, unknown>,
  total: TotalsField,
): Promise<boolean> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await getAdminDb().runTransaction(async (tx) => {
        const current = (await tx.get(row.sendRef)).data() as BroadcastSendDoc | undefined;
        if (current?.status !== "queued" || current.claimId !== row.claimId) {
          console.warn("[broadcasts/step] claim superseded; settle skipped", row.sendRef.path);
          return false;
        }
        tx.update(row.sendRef, { ...rowPatch, attempts: FieldValue.increment(1) });
        tx.update(row.broadcastRef, {
          [total]: FieldValue.increment(1),
          "totals.queued": FieldValue.increment(-1),
        });
        return true;
      });
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
export async function releaseClaim(row: ClaimedRow): Promise<void> {
  await getAdminDb().runTransaction(async (tx) => {
    const current = (await tx.get(row.sendRef)).data() as BroadcastSendDoc | undefined;
    if (current?.status !== "queued" || current.claimId !== row.claimId) return;
    tx.update(row.sendRef, { claimedAt: FieldValue.delete(), claimId: FieldValue.delete() });
  });
}
