import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import type { PaymentLink } from "@/types/payment-links";
import type { QuotePaidVia } from "@/types/quotes";

/**
 * A Paystack payment link already paid for this invoice whose invoice step
 * has not finished (a transient failure; Paystack will redeliver). The
 * operator's click is then acknowledging THAT payment, so it is recorded as
 * the payer. Otherwise the redelivery finds the invoice paid by someone else
 * and flags a refund on a single payment.
 */
export async function unsettledPaystackLinkPayment(
  subAccountId: string,
  invoiceId: string,
): Promise<QuotePaidVia | undefined> {
  const snap = await getAdminDb()
    .collection("paymentLinks")
    .where("subAccountId", "==", subAccountId)
    .where("invoiceId", "==", invoiceId)
    .where("status", "==", "paid")
    .get();
  for (const d of snap.docs) {
    const link = d.data() as PaymentLink;
    if (!link.invoiceSettledAt && link.paystackReference) {
      return { rail: "paystack_link", linkId: d.id, reference: link.paystackReference };
    }
  }
  return undefined;
}
