import "server-only";

import { randomUUID } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import type { BroadcastDoc, BroadcastSendDoc } from "@/types";

/**
 * A claim older than this belongs to a step that died mid-send (a live step
 * settles in seconds). Its outcome is unknown, so the row is failed rather
 * than re-sent: a missed email is recoverable, a duplicate is not.
 */
const CLAIM_STALE_MS = 10 * 60 * 1000;

export type SendClaim =
  | { outcome: "claimed"; broadcast: BroadcastDoc; send: BroadcastSendDoc; claimId: string }
  /** Row settled by this call (cancelled / interrupted) — re-check completion. */
  | { outcome: "settled_now"; reason: "cancelled" | "interrupted" }
  | { outcome: "missing" | "already_settled" | "in_flight" };

/**
 * Take the per-recipient send claim in one transaction, so a QStash
 * redelivery (or two concurrent deliveries) can never send the same row
 * twice. Also where cancellation is honoured — reading the broadcast inside
 * the transaction means a cancel either lands first (row skipped) or waits
 * until this row is claimed — and where the broadcast flips queued → sending,
 * so that write can never overwrite a cancel.
 */
export async function claimSend(
  broadcastRef: FirebaseFirestore.DocumentReference,
  sendRef: FirebaseFirestore.DocumentReference,
): Promise<SendClaim> {
  return getAdminDb().runTransaction(async (tx): Promise<SendClaim> => {
    const [bSnap, sSnap] = await tx.getAll(broadcastRef, sendRef);
    if (!bSnap?.exists || !sSnap?.exists) return { outcome: "missing" };
    const broadcast = bSnap.data() as BroadcastDoc;
    const send = sSnap.data() as BroadcastSendDoc;
    if (send.status !== "queued") return { outcome: "already_settled" };

    const settleTotals = (field: "totals.skipped" | "totals.failed") =>
      tx.update(broadcastRef, {
        [field]: FieldValue.increment(1),
        "totals.queued": FieldValue.increment(-1),
      });

    if (send.claimedAt) {
      const age = Date.now() - (send.claimedAt as Timestamp).toMillis();
      if (age < CLAIM_STALE_MS) return { outcome: "in_flight" };
      tx.update(sendRef, {
        status: "failed",
        error: "Delivery unknown (interrupted) — not retried to avoid a duplicate email.",
        sentAt: FieldValue.serverTimestamp(),
      });
      settleTotals("totals.failed");
      return { outcome: "settled_now", reason: "interrupted" };
    }

    if (broadcast.status === "cancelled") {
      tx.update(sendRef, {
        status: "skipped",
        skippedReason: "cancelled",
        sentAt: FieldValue.serverTimestamp(),
      });
      settleTotals("totals.skipped");
      return { outcome: "settled_now", reason: "cancelled" };
    }

    const claimId = randomUUID();
    tx.update(sendRef, { claimedAt: Timestamp.now(), claimId });
    if (broadcast.status === "queued") {
      tx.update(broadcastRef, {
        status: "sending",
        startedAt: FieldValue.serverTimestamp(),
      });
    }
    return { outcome: "claimed", broadcast, send, claimId };
  });
}
