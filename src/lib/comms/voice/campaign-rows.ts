import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import type {
  VoiceCampaignDoc,
  VoiceCampaignRecipientDoc,
  VoiceCampaignSkipReason,
} from "@/types";

/**
 * Recipient-row transitions shared by the campaign step, fanout and cancel
 * routes. Every settle is a transaction conditional on the row still being
 * "queued", so two writers racing on one row (a step and the cancel sweep,
 * or a step and its own redelivery) count it exactly once.
 */

/** QStash retries for a fanout page; the last delivery fails the campaign. */
export const FANOUT_RETRIES = 3;

type Settle =
  | { status: "skipped"; skippedReason: VoiceCampaignSkipReason }
  | { status: "failed"; error: string };

/** Settle a still-queued row. Returns false if it had already left "queued". */
export async function settleQueuedRecipient(
  recRef: FirebaseFirestore.DocumentReference,
  campaignRef: FirebaseFirestore.DocumentReference,
  settle: Settle,
): Promise<boolean> {
  return getAdminDb().runTransaction(async (tx) => {
    const rec = (await tx.get(recRef)).data() as VoiceCampaignRecipientDoc | undefined;
    if (rec?.status !== "queued") return false;
    tx.update(recRef, {
      ...settle,
      settledAt: FieldValue.serverTimestamp(),
      attempts: FieldValue.increment(1),
    });
    tx.update(campaignRef, {
      [settle.status === "skipped" ? "totals.skipped" : "totals.failed"]: FieldValue.increment(1),
      "totals.queued": FieldValue.increment(-1),
    });
    return true;
  });
}

export type DialClaim = "dial" | "cancelled" | "settled";

/** A cancelled or failed campaign places no new calls; the row's skip reason. */
export function stopReason(
  campaign: Pick<VoiceCampaignDoc, "status">,
): "cancelled" | "campaign_failed" | null {
  if (campaign.status === "cancelled") return "cancelled";
  if (campaign.status === "failed") return "campaign_failed";
  return null;
}

/**
 * The last gate before dialling, in one transaction: a cancelled (or
 * failed) campaign skips the row; otherwise the row is committed to "called" (callId filled
 * in after the dial) and the campaign flips queued → calling. A cancel
 * therefore either lands first — no call — or finds the row already out of
 * "queued" and leaves it alone; and the flip can never overwrite a cancel.
 */
export async function claimDial(
  recRef: FirebaseFirestore.DocumentReference,
  campaignRef: FirebaseFirestore.DocumentReference,
): Promise<DialClaim> {
  return getAdminDb().runTransaction(async (tx): Promise<DialClaim> => {
    const [cSnap, rSnap] = await tx.getAll(campaignRef, recRef);
    const campaign = cSnap?.data() as VoiceCampaignDoc | undefined;
    const rec = rSnap?.data() as VoiceCampaignRecipientDoc | undefined;
    if (!campaign || rec?.status !== "queued") return "settled";
    const stop = stopReason(campaign);
    if (stop) {
      tx.update(recRef, {
        status: "skipped",
        skippedReason: stop,
        settledAt: FieldValue.serverTimestamp(),
        attempts: FieldValue.increment(1),
      });
      tx.update(campaignRef, {
        "totals.skipped": FieldValue.increment(1),
        "totals.queued": FieldValue.increment(-1),
      });
      return "cancelled";
    }
    tx.update(recRef, {
      status: "called",
      settledAt: FieldValue.serverTimestamp(),
      attempts: FieldValue.increment(1),
    });
    tx.update(campaignRef, {
      "totals.called": FieldValue.increment(1),
      "totals.queued": FieldValue.increment(-1),
      ...(campaign.status === "queued"
        ? { status: "calling", startedAt: FieldValue.serverTimestamp() }
        : {}),
    });
    return "dial";
  });
}

/**
 * After Vapi accepted the call: store its ids and re-read the campaign in
 * one transaction. Returns true when a cancel landed while the call was
 * being dialled (claimDial had already moved the row out of "queued", so
 * the cancel sweep skipped it and "stop all" had no control URL to end) —
 * the caller must hang the call up. The row records it as ended by cancel.
 */
export async function recordDialled(
  recRef: FirebaseFirestore.DocumentReference,
  campaignRef: FirebaseFirestore.DocumentReference,
  callId: string,
  callControlUrl: string | null,
): Promise<boolean> {
  return getAdminDb().runTransaction(async (tx) => {
    const campaign = (await tx.get(campaignRef)).data() as VoiceCampaignDoc | undefined;
    const cancelled = campaign?.status === "cancelled";
    tx.update(recRef, {
      callId,
      callControlUrl,
      ...(cancelled ? { endedByCancel: true } : {}),
    });
    return cancelled;
  });
}

/** Flip the campaign to "completed" once the fan-out is done and no rows
 *  remain queued. Transaction so two final rows settling at once can't
 *  double-fire the flip. */
export async function maybeCompleteCampaign(
  campaignRef: FirebaseFirestore.DocumentReference,
): Promise<void> {
  await getAdminDb().runTransaction(async (tx) => {
    const snap = await tx.get(campaignRef);
    if (!snap.exists) return;
    const data = snap.data() as VoiceCampaignDoc;
    if (
      data.status === "completed" ||
      data.status === "failed" ||
      data.status === "cancelled"
    )
      return;
    // Absent = a campaign fanned out whole at creation (pre-paging).
    if (data.fanoutDone === false) return;
    if ((data.totals?.queued ?? 0) <= 0) {
      tx.update(campaignRef, {
        status: "completed",
        completedAt: FieldValue.serverTimestamp(),
      });
    }
  });
}
