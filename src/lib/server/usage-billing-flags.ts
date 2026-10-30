import "server-only";

import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { usageChargeId } from "@/lib/billing/usage";

/**
 * A usage month that needs a person: a withhold, an expiry, or a refusal the
 * first time it appears. Written as a `billingEvents` row of type
 * `usage.flagged`, which Agency -> Client billing -> Attention already lists
 * (with "Mark resolved") alongside flagged payments. No email: the existing
 * flag email is worded for payments that arrived, and this adds no new
 * outbound mail.
 *
 * Deduped by a deterministic id over (sub-account, month, reason) and a
 * `create()`: the same problem flags once, not on every daily run. A new
 * reason for the same month flags again. Best-effort: a flag that fails to
 * write is logged and never masks the work that raised it.
 */
export async function flagUsageIssue(input: {
  agencyId: string;
  subAccountId: string;
  month: string;
  reason: string;
}): Promise<void> {
  const { agencyId, subAccountId, month, reason } = input;
  if (!agencyId) {
    console.error(`[usage-close] not flagged, no agency sa=${subAccountId} month=${month}: ${reason}`);
    return;
  }
  const digest = createHash("sha1").update(reason).digest("hex").slice(0, 10);
  try {
    await getAdminDb()
      .collection("billingEvents")
      .doc(`usage-flag-${subAccountId}-${month || "none"}-${digest}`)
      .create({
        agencyId,
        subAccountId,
        event: "usage.flagged",
        detail: {
          reason,
          reference: month ? usageChargeId(subAccountId, month) : null,
          month: month || null,
          amountCents: null,
          currency: null,
        },
        createdAt: FieldValue.serverTimestamp(),
      });
  } catch (err) {
    if ((err as { code?: number }).code === 6) return; // already flagged
    console.error(`[usage-close] flag not written sa=${subAccountId} month=${month}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
