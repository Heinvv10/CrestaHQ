import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";

/**
 * The ledger row that marks one provider payment as having activated a plan.
 * Kept outside `billing` on purpose: re-assigning or comping a workspace
 * replaces the whole `billing` map, and the record of which payments have
 * already been spent must survive that.
 */
export function activationLedgerRef(provider: BillingPaymentProvider, reference: string) {
  return getAdminDb()
    .collection("billingActivations")
    .doc(`${provider}-${encodeURIComponent(reference)}`);
}

export type BillingPaymentProvider = "stripe" | "paystack";

/**
 * Money arrived that does not settle what it claims to. Recorded as a
 * `billingEvents` row (not yet shown in any UI) plus a console.error, keyed by
 * provider + reference so a redelivery does not add a second row. Awaited: a
 * flag that silently failed to write would leave a real payment unaccounted
 * for.
 */
export async function flagBillingPayment(input: {
  provider: BillingPaymentProvider;
  reference: string;
  agencyId: string;
  subAccountId: string;
  kind: "plan" | "charge";
  reason: string;
  amountCents: number | null;
  currency: string | null;
}): Promise<void> {
  console.error(
    `[billing] ${input.provider} ref=${input.reference} not settling ${input.kind}: ${input.reason}`,
  );
  await getAdminDb()
    .collection("billingEvents")
    .doc(`${input.provider}-flag-${encodeURIComponent(input.reference)}`)
    .set({
      agencyId: input.agencyId,
      subAccountId: input.subAccountId,
      event: "payment.flagged",
      detail: {
        provider: input.provider,
        reference: input.reference,
        kind: input.kind,
        reason: input.reason,
        amountCents: input.amountCents,
        currency: input.currency,
      },
      createdAt: FieldValue.serverTimestamp(),
    });
}
