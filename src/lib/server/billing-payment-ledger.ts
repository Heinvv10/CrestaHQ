import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { billingEventFlagId } from "@/lib/server/billing-attention";
import { notifyFlag } from "@/lib/server/billing-attention-notify";

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
 * `billingEvents` row (listed under Client billing → Attention, and emailed to
 * the agency owner once) plus a console.error, keyed by provider + reference
 * so a redelivery does not add a second row. Awaited: a flag that silently
 * failed to write would leave a real payment unaccounted for.
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
  const eventId = `${input.provider}-flag-${encodeURIComponent(input.reference)}`;
  await getAdminDb()
    .collection("billingEvents")
    .doc(eventId)
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
  await notifyFlag({
    flagId: billingEventFlagId(eventId),
    audience: "agencyOwner",
    agencyId: input.agencyId,
    subAccountId: input.subAccountId,
    reason: input.reason,
    amountCents: input.amountCents,
    currency: input.currency,
    reference: input.reference,
  });
}
