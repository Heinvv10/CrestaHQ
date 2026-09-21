import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { BillingError } from "@/lib/billing/errors";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  verifyPaystackTransaction,
  type PaystackVerifiedTransaction,
} from "@/lib/paystack/billing-api";
import {
  invoiceTotalCents,
  parsePaymentLinkReference,
} from "@/lib/server/payment-links-service";
import { markQuotePaidServerSide } from "@/lib/server/quotes-service";
import type { PaymentLink } from "@/types/payment-links";
import type { Quote } from "@/types/quotes";

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
 * NOT gated on `paymentsEnabledByAgency`: once money is taken it is recorded,
 * whatever the agency has switched off since. The pay page is gated instead.
 *
 * Never throws. `retry: true` means Paystack could not give an answer (network,
 * 5xx, 429, a rotated key), and the route answers non-200 so Paystack
 * redelivers — a real payment must not be dropped over a transient refusal.
 * Only a genuine "not found", or a mismatch, is final.
 */

export interface PaymentLinkReconcileResult {
  handled: boolean;
  retry?: boolean;
  detail: string;
}

/**
 * The amount the link asked for. With customer-borne fees Paystack's `amount`
 * is the request PLUS fees, so `requested_amount` is the figure that must
 * equal the link. Source: PaystackOSS/openapi `dist/paystack.yaml`,
 * `VerifyResponse.data.requested_amount` (integer, required). Falls back to
 * `amount` only if a response ever omits it.
 */
function requestedAmount(tx: PaystackVerifiedTransaction): number {
  return typeof tx.requested_amount === "number" ? tx.requested_amount : tx.amount;
}

/** Paystack answered that the reference does not exist on this account. */
function isNotFound(err: unknown): boolean {
  if (!(err instanceof BillingError)) return false;
  return (
    err.providerStatus === 404 ||
    (err.providerStatus === 400 && /not found/i.test(err.message))
  );
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

    let tx: PaystackVerifiedTransaction;
    try {
      tx = await verifyPaystackTransaction(reference, secretKey);
    } catch (err) {
      console.error(`${tag} verify failed`, err);
      return isNotFound(err)
        ? { handled: false, detail: "verify: not found" }
        : { handled: false, retry: true, detail: "verify unavailable" };
    }

    const amount = requestedAmount(tx);
    const mismatch =
      tx.status !== "success"
        ? `status=${tx.status}`
        : tx.reference !== reference
          ? `reference=${tx.reference}`
          : amount !== link.amountCents
            ? `amount=${amount} expected=${link.amountCents}`
            : (tx.currency ?? "").toUpperCase() !== link.currency
              ? `currency=${tx.currency} expected=${link.currency}`
              : null;
    if (mismatch) {
      console.error(`${tag} not marking paid: ${mismatch}`);
      return { handled: false, detail: `mismatch ${mismatch}` };
    }

    const outcome = await db.runTransaction(async (t) => {
      const fresh = (await t.get(ref)).data() as PaymentLink | undefined;
      if (fresh?.status !== "paid") {
        t.update(ref, {
          status: "paid",
          paystackReference: reference,
          payerEmail: tx.customer?.email ?? null,
          paidAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        return "paid";
      }
      if (fresh.paystackReference === reference) return "replay";
      // The customer paid twice (two tabs). Recorded so the operator sees a
      // refund is owed; a redelivery of the same second payment adds nothing.
      if ((fresh.extraPayments ?? []).some((p) => p.reference === reference)) return "replay";
      t.update(ref, {
        extraPayments: FieldValue.arrayUnion({ reference, amountCents: amount, paidAt: new Date() }),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return "duplicate";
    });

    if (outcome === "duplicate") {
      console.error(`${tag} link ${linkId} already paid by ${link.paystackReference}; second payment needs a refund`);
      return { handled: true, detail: "duplicate payment recorded" };
    }
    if (outcome === "replay") return { handled: true, detail: "already recorded (idempotent no-op)" };

    // First paid transition only. A replay never reaches here, so overlapping
    // deliveries cannot fire the invoice's workflow / review triggers twice.
    if (link.invoiceId) {
      const attention = await settleInvoice(link, subAccountId);
      if (attention) {
        console.warn(`${tag} invoice ${link.invoiceId}: ${attention}`);
        await ref.update({ attention, updatedAt: FieldValue.serverTimestamp() });
      }
    }
    return { handled: true, detail: `link ${linkId} paid` };
  } catch (err) {
    console.error(`${tag} reconcile failed`, err);
    return { handled: false, retry: true, detail: "error" };
  }
}

/**
 * Mark the link's invoice paid through the shared paid path, if it still is
 * the invoice the customer paid. Returns why not, for the operator — the money
 * is already in their account either way.
 */
async function settleInvoice(link: PaymentLink, subAccountId: string): Promise<string | null> {
  try {
    const quote = (await getAdminDb().doc(`quotes/${link.invoiceId}`).get()).data() as Quote | undefined;
    if (!quote || quote.subAccountId !== subAccountId) {
      return "Paid, but the invoice no longer exists. Record this payment by hand.";
    }
    if (quote.status === "paid") {
      return "Paid, but the invoice was already paid another way — a refund may be owed.";
    }
    if (
      (quote.currency || "").toUpperCase() !== link.currency ||
      invoiceTotalCents(quote) !== link.amountCents
    ) {
      return "Paid, but the invoice changed after this link was made, so it was not marked paid. Check the amount and mark it by hand.";
    }
    const res = await markQuotePaidServerSide({
      quoteId: link.invoiceId!,
      expectSubAccountId: subAccountId,
    });
    return res.ok ? null : `Paid, but the invoice could not be marked paid: ${res.message}.`;
  } catch (err) {
    console.error(`[paystack/payment-links] invoice ${link.invoiceId} settle failed`, err);
    return "Paid, but updating the invoice failed part-way. Check the invoice and mark it paid if it isn't.";
  }
}
