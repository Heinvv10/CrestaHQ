import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { BillingError } from "@/lib/billing/errors";
import { getAdminDb } from "@/lib/firebase/admin";
import { verifyPaystackTransaction } from "@/lib/paystack/billing-api";
import { parsePaymentLinkReference } from "@/lib/server/payment-links-service";
import { markQuotePaidServerSide } from "@/lib/server/quotes-service";
import type { PaymentLink } from "@/types/payment-links";

/**
 * Paystack `charge.success` → payment link paid. The ONLY writer of
 * `paymentLinks.status = "paid"`.
 *
 * The caller (`/api/webhooks/paystack/sa/[subAccountId]`) has verified the
 * signature with this sub-account's key. That proves the event came from the
 * tenant's Paystack account, not that the money matches the link — the
 * operator controls that account and anything else they run on it can send
 * `charge.success`. So the body is used only for its reference; the facts come
 * from Paystack's verify endpoint, called with the same tenant key, and must
 * match the doc on status, reference, amount and currency.
 *
 * Never throws. `retry: true` means Paystack could not be asked (network or a
 * 5xx), and the route answers non-200 so Paystack redelivers. Every other
 * refusal is final: answering non-200 to a forged or foreign event would only
 * make Paystack retry it.
 */

export interface PaymentLinkReconcileResult {
  handled: boolean;
  retry?: boolean;
  detail: string;
}

export async function reconcilePaystackCharge(input: {
  subAccountId: string;
  secretKey: string;
  reference: string;
}): Promise<PaymentLinkReconcileResult> {
  const { subAccountId, secretKey, reference } = input;
  const tag = `[paystack/payment-links] sa=${subAccountId} ref=${reference}`;

  const linkId = parsePaymentLinkReference(reference);
  // Another integration on the same Paystack account. Not ours to judge.
  if (!linkId) return { handled: false, detail: "not a payment-link reference" };

  try {
    const db = getAdminDb();
    const ref = db.doc(`paymentLinks/${linkId}`);
    const link = (await ref.get()).data() as PaymentLink | undefined;
    if (!link) {
      console.warn(`${tag} no payment link ${linkId}`);
      return { handled: false, detail: "no matching link" };
    }
    if (link.subAccountId !== subAccountId) {
      console.error(`${tag} link ${linkId} belongs to sa=${link.subAccountId}`);
      return { handled: false, detail: "tenancy mismatch" };
    }

    let tx;
    try {
      tx = await verifyPaystackTransaction(reference, secretKey);
    } catch (err) {
      // BillingError 400 = Paystack answered and refused (unknown reference on
      // this account). Anything else = we could not ask; let Paystack retry.
      const refused = err instanceof BillingError && err.status === 400;
      console.error(`${tag} verify failed`, err);
      return refused
        ? { handled: false, detail: "verify refused" }
        : { handled: false, retry: true, detail: "verify unavailable" };
    }

    const mismatch =
      tx.status !== "success"
        ? `status=${tx.status}`
        : tx.reference !== reference
          ? `reference=${tx.reference}`
          : tx.amount !== link.amountCents
            ? `amount=${tx.amount} expected=${link.amountCents}`
            : (tx.currency ?? "").toUpperCase() !== link.currency
              ? `currency=${tx.currency} expected=${link.currency}`
              : null;
    if (mismatch) {
      console.error(`${tag} not marking paid: ${mismatch}`);
      return { handled: false, detail: `mismatch ${mismatch}` };
    }

    const outcome = await db.runTransaction(async (t) => {
      const fresh = (await t.get(ref)).data() as PaymentLink | undefined;
      if (fresh?.status === "paid") {
        return fresh.paystackReference === reference ? "replay" : "duplicate";
      }
      t.update(ref, {
        status: "paid",
        paystackReference: reference,
        payerEmail: tx.customer?.email ?? null,
        paidAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return "paid";
    });

    if (outcome === "duplicate") {
      // A second successful payment for a link already paid — the customer
      // paid twice. Money is in the tenant's account; the operator refunds it.
      console.error(`${tag} link ${linkId} already paid by ${link.paystackReference}; second payment needs a refund`);
      return { handled: true, detail: "duplicate payment" };
    }

    // Also on a replay: if the invoice step failed after the link was marked
    // paid, the redelivery finishes it. The service is idempotent itself.
    if (link.invoiceId) {
      const res = await markQuotePaidServerSide({
        quoteId: link.invoiceId,
        expectSubAccountId: subAccountId,
      });
      if (!res.ok && res.code !== "already_paid") {
        console.warn(`${tag} invoice ${link.invoiceId} not marked paid: ${res.code} — ${res.message}`);
      }
    }

    return { handled: true, detail: outcome === "paid" ? `link ${linkId} paid` : "already paid (idempotent no-op)" };
  } catch (err) {
    console.error(`${tag} reconcile failed`, err);
    return { handled: false, retry: true, detail: "error" };
  }
}
