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
 * Deduped by a deterministic id over (sub-account, month, reason, ISO week)
 * and a `create()`: the same problem flags once per week, not on every daily
 * run, and one that recurs after being resolved flags again the next week. A
 * new reason for the same month flags at once. Best-effort by default: a flag
 * that fails to write is logged and never masks the work that raised it; with
 * `strict` the error is thrown, so a caller that can be retried is retried.
 */

/** "2026-W44": the ISO week (Monday start) of `d`, in UTC. */
export function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day); // the Thursday of this week
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export async function flagUsageIssue(input: {
  agencyId: string;
  subAccountId: string;
  month: string;
  reason: string;
  strict?: boolean;
  /** A one-off event (a withhold): no week bucket, so a retry in a later week cannot flag it twice. */
  once?: boolean;
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
      .doc(`usage-flag-${subAccountId}-${month || "none"}-${digest}${input.once ? "" : `-${isoWeekKey(new Date())}`}`)
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
    if ((err as { code?: number }).code === 6) return; // already flagged this week
    if (input.strict) throw err;
    console.error(`[usage-close] flag not written sa=${subAccountId} month=${month}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
