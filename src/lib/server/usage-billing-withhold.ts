import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { recordBillingEvent } from "@/lib/server/billing-lifecycle";
import { flagUsageIssue } from "@/lib/server/usage-billing-flags";
import { DAY_MS, toMillis, type PendingChargeDoc } from "@/lib/server/usage-billing-shared";
import { formatUsageMonth } from "@/lib/billing/usage";
import type { SubAccountDoc } from "@/types";

/** A charge or queue entry older than this gives up: cancelled/withheld, not retried forever. */
export const INVOICE_EMAIL_RETRY_DAYS = 7;
/** A claim this old with no send recorded belongs to a run that died; take it over. */
export const CLAIM_TIMEOUT_MS = 15 * 60 * 1000;

type Charge = FirebaseFirestore.DocumentData;
export const claimFresh = (c: Charge, now: Date) => {
  const claimedMs = toMillis(c.invoiceEmailClaimedAt);
  return claimedMs !== null && now.getTime() - claimedMs < CLAIM_TIMEOUT_MS;
};

/** The queue entry has waited longer than the retry window. */
export const queuedPastWindow = (p: PendingChargeDoc, now: Date): boolean =>
  now.getTime() - (toMillis(p.createdAt) ?? now.getTime()) > INVOICE_EMAIL_RETRY_DAYS * DAY_MS;

export type WithheldWhy =
  | "rebilling_switched_off_before_invoice"
  | "invoice could not be sent"
  | "over ceiling"
  | "no billing email";

/**
 * The ledger fields for a withheld month. The amount carried INTO the month
 * stays owed: it goes back on the ledger as `carryOutCents`, so the next billed
 * month (within the 2-month rule) picks it up; only the month's own usage is
 * dropped. Written in the SAME transaction as a charge cancel, so a crash can
 * never leave one without the other.
 */
export function withheldPatch(why: string, carryBackCents: number): Record<string, unknown> {
  return {
    "closed.withheldAt": FieldValue.serverTimestamp(),
    "closed.withheldReason": why,
    "closed.carryOutCents": carryBackCents,
  };
}

/** After the commit: audit rows and the attention flag. */
export async function announceWithheld(input: {
  sub: SubAccountDoc;
  month: string;
  chargeId: string;
  charge: "none" | "canceled";
  why: string;
  carryBackCents: number;
}): Promise<void> {
  const { sub, month, chargeId, charge, why, carryBackCents } = input;
  console.warn(`[usage-close] month withheld sa=${sub.id} month=${month} charge=${charge}: ${why}`);
  if (charge === "canceled") {
    recordBillingEvent({
      agencyId: sub.agencyId,
      subAccountId: sub.id,
      event: "charge.canceled",
      detail: { chargeId, kind: "usage", usageMonth: month, reason: why },
    });
  }
  recordBillingEvent({
    agencyId: sub.agencyId,
    subAccountId: sub.id,
    event: "usage.withheld",
    detail: { month, chargeId, chargeCanceled: charge === "canceled", reason: why, carryBackCents },
  });
  await flagUsageIssue({
    agencyId: sub.agencyId,
    subAccountId: sub.id,
    month,
    reason: `Usage for ${formatUsageMonth(month)} was not billed (${why})${charge === "canceled" ? "; its charge was cancelled" : ""}.`,
  });
}

/**
 * The month is no longer eligible by the time the charge comes to be minted.
 * Before the invoice email there is no debt, so nothing is billed; after it, the
 * debt stands. A send that was ATTEMPTED (`emailAttemptedAt`) may have gone out,
 * so it counts as sent. Returns "withheld" (queue entry can go), "stands" (carry
 * on as normal) or "busy" (an email is being sent right now; leave it).
 */
export async function withholdUnsent(input: {
  sub: SubAccountDoc;
  month: string;
  chargeId: string;
  now: Date;
  ledgerRef: FirebaseFirestore.DocumentReference;
  carryBackCents: number;
}): Promise<"withheld" | "stands" | "busy"> {
  const { sub, month, chargeId, now, ledgerRef, carryBackCents } = input;
  const why: WithheldWhy = "rebilling_switched_off_before_invoice";
  const chargeRef = getAdminDb().doc(`billingCharges/${chargeId}`);
  const verdict = await getAdminDb().runTransaction(async (tx) => {
    const c = (await tx.get(chargeRef)).data();
    if (!c) return "none" as const;
    if (c.status !== "pending" || c.emailedTo || c.emailAttemptedAt) return "stands" as const;
    if (claimFresh(c, now)) return "busy" as const;
    tx.update(chargeRef, { status: "canceled", tokenHash: null, updatedAt: FieldValue.serverTimestamp() });
    tx.update(ledgerRef, withheldPatch(why, carryBackCents));
    return "canceled" as const;
  });
  if (verdict === "stands" || verdict === "busy") return verdict;
  // No charge exists: the ledger stamp is the only write, so it needs no transaction.
  if (verdict === "none") await ledgerRef.update(withheldPatch(why, carryBackCents));
  await announceWithheld({ sub, month, chargeId, charge: verdict === "none" ? "none" : "canceled", why, carryBackCents });
  return "withheld";
}
