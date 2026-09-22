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
    const data = (await ref.get()).data() as Omit<PaymentLink, "id"> | undefined;
    const link: PaymentLink | undefined = data && { ...data, id: linkId };
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
    // The connection's CURRENT mode — the same key that verified this
    // transaction and that checkout charges with. Not stamped per link: a key
    // switched test → live after the link was made must still reconcile.
    const liveConnection = secretKey.startsWith("sk_live_");
    // Not a success, or not this reference: Paystack received nothing for
    // this link. Logged only.
    if (tx.status !== "success" || tx.reference !== reference) {
      console.error(`${tag} not marking paid: status=${tx.status} reference=${tx.reference}`);
      return { handled: false, detail: "not a success for this reference" };
    }
    // A verified success that doesn't match the link: money DID arrive on the
    // tenant's account, so the operator is told on the link. Still no paid
    // transition, still 200 — a redelivery would find the same mismatch.
    const mismatch =
      amount !== link.amountCents
        ? `amount=${amount} expected=${link.amountCents}`
        : tx.amount < amount
          ? `partial amount=${tx.amount} requested=${amount}`
          : (tx.currency ?? "").toUpperCase() !== link.currency
            ? `currency=${tx.currency} expected=${link.currency}`
            : (tx.domain === "live") !== liveConnection
              ? `mode domain=${tx.domain} connection=${liveConnection ? "live" : "test"}`
              : null;
    if (mismatch) {
      const attention = mismatch.startsWith("mode")
        ? `A ${tx.domain ?? "unknown"}-mode payment arrived while this workspace's Paystack is in ${liveConnection ? "live" : "test"} mode, and was not recorded. Check your Paystack dashboard.`
        : "Paystack received a payment that does not match this link — check your Paystack dashboard.";
      console.error(`${tag} not marking paid: ${mismatch}`);
      await ref.update({ attention, updatedAt: FieldValue.serverTimestamp() });
      return { handled: false, detail: `mismatch ${mismatch}` };
    }

    const { outcome, current } = await db.runTransaction(async (t) => {
      const fresh = (await t.get(ref)).data() as PaymentLink | undefined;
      if (fresh?.status !== "paid") {
        t.update(ref, {
          status: "paid",
          paystackReference: reference,
          paystackDomain: tx.domain ?? null,
          payerEmail: tx.customer?.email ?? null,
          paidAt: FieldValue.serverTimestamp(),
          // `attention` is deliberately NOT cleared: it records a real
          // mismatched payment the operator may still need to refund.
          updatedAt: FieldValue.serverTimestamp(),
        });
        return { outcome: "paid" as const, current: fresh ?? link };
      }
      if (fresh.paystackReference === reference) return { outcome: "replay" as const, current: fresh };
      // The customer paid twice (two tabs). Recorded so the operator sees a
      // refund is owed; a redelivery of the same second payment adds nothing.
      if ((fresh.extraPayments ?? []).some((p) => p.reference === reference)) {
        return { outcome: "duplicate-replay" as const, current: fresh };
      }
      t.update(ref, {
        extraPayments: FieldValue.arrayUnion({ reference, amountCents: amount, paidAt: new Date() }),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { outcome: "duplicate" as const, current: fresh };
    });

    if (outcome === "duplicate") {
      console.error(`${tag} link ${linkId} already paid by ${current.paystackReference}; second payment needs a refund`);
      return { handled: true, detail: "duplicate payment recorded" };
    }
    if (outcome === "duplicate-replay") return { handled: true, detail: "duplicate already recorded" };

    // The invoice step runs AT LEAST once: the process can die, or a write
    // fail, between the paid commit above and `invoiceSettledAt` below, and a
    // replay of this link's own reference then re-runs it. Repeating it is
    // safe because the quote records `paidVia` in its compare-and-set, so a
    // re-run recognises its own earlier success. Only the compare-and-set
    // winner fires the invoice's side effects.
    if (!link.invoiceId || (outcome === "replay" && current.invoiceSettledAt)) {
      return { handled: true, detail: outcome === "replay" ? "already recorded (idempotent no-op)" : `link ${linkId} paid` };
    }
    // Throws only on a transient failure: the route answers 503 and the
    // redelivery comes back through here.
    const invoiceAttention = await settleInvoice(link, subAccountId, reference);
    if (invoiceAttention) console.warn(`${tag} invoice ${link.invoiceId}: ${invoiceAttention}`);
    await ref.update({
      invoiceSettledAt: FieldValue.serverTimestamp(),
      invoiceAttention,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { handled: true, detail: `link ${linkId} paid` };
  } catch (err) {
    console.error(`${tag} reconcile failed`, err);
    return { handled: false, retry: true, detail: "error" };
  }
}

const INVOICE_CHANGED =
  "Paid, but the invoice changed after this link was made, so it was not marked paid. Check the amount and mark it by hand.";
const PAID_ANOTHER_WAY =
  "Paid, but the invoice was already paid another way — a refund may be owed.";

/**
 * Mark the link's invoice paid through the shared paid path, if it still is
 * the invoice the customer paid. Returns why not, for the operator — the money
 * is already in their account either way.
 *
 * Throws only on a transient (Firestore) failure, which the caller turns into
 * a redelivery. A problem with the invoice itself is a terminal answer, so a
 * malformed invoice does not become an endless retry.
 */
async function settleInvoice(
  link: PaymentLink,
  subAccountId: string,
  reference: string,
): Promise<string | null> {
  const quote = (await getAdminDb().doc(`quotes/${link.invoiceId}`).get()).data() as Quote | undefined;
  const ours = (via: Quote["paidVia"]) => via?.rail === "paystack_link" && via.reference === reference;

  let problem: string | null;
  try {
    problem = !quote || quote.subAccountId !== subAccountId
      ? "Paid, but the invoice no longer exists. Record this payment by hand."
      : quote.status === "paid"
        ? ours(quote.paidVia) ? "" : PAID_ANOTHER_WAY
        : (quote.currency || "").toUpperCase() !== link.currency ||
            invoiceTotalCents(quote) !== link.amountCents
          ? INVOICE_CHANGED
          : null;
  } catch (err) {
    console.error(`[paystack/payment-links] invoice ${link.invoiceId} unreadable`, err);
    return "Paid, but the invoice could not be read, so it was not marked paid. Check it and mark it by hand.";
  }
  // "" = our own earlier success (a retry after the invoice committed).
  if (problem !== null) return problem || null;

  const res = await markQuotePaidServerSide({
    quoteId: link.invoiceId!,
    expectSubAccountId: subAccountId,
    paidVia: { rail: "paystack_link", linkId: link.id, reference },
    // Re-checked inside the compare-and-set: the invoice can be edited
    // between the read above and the write.
    expectTotalCents: link.amountCents,
    expectCurrency: link.currency,
  });
  if (res.ok) return null;
  // already_paid: someone won the compare-and-set since the read above —
  // possibly an overlapping delivery of this same payment.
  if (res.code === "already_paid") return ours(res.paidVia) ? null : PAID_ANOTHER_WAY;
  if (res.code === "amount_changed") return INVOICE_CHANGED;
  return `Paid, but the invoice could not be marked paid: ${res.message}.`;
}
