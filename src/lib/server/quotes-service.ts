import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { computeQuoteTotals } from "@/lib/quotes/calc";
import {
  emitQuoteWebhook,
  fireQuoteTrigger,
  recordQuoteActivity,
} from "@/lib/quotes/lifecycle";
import { maybeSendReviewRequest } from "@/lib/reviews/request";
import type { Quote, QuotePaidVia } from "@/types/quotes";

/**
 * Quotes service — the single server-side path that flips a quote/invoice to
 * `paid` and runs its side-effects.
 *
 * Extracted so the Stripe order reconciler, the Paystack payment-link
 * reconciler and the operator's manual "Mark as paid" button drive the SAME
 * transition — a compare-and-set, so when they race only the winner fires
 * the side effects (at most once; see below). Payments v1's rule was that
 * a card payment must not invent a second paid-path — otherwise the activity
 * row, the `quote.paid` workflow trigger, the outbound webhook, and the
 * auto Google-review request all drift between the two.
 *
 * Auth and territory gating stay in the callers: the route checks membership,
 * the reconciler's authority is the verified Stripe signature.
 */

export type MarkQuotePaidOutcome =
  | { ok: true; quote: Quote & { id: string } }
  | {
      ok: false;
      code: "not_found" | "wrong_tenant" | "already_paid" | "bad_status" | "amount_changed";
      message: string;
      /** On `already_paid`: who paid it, so a retrying caller can tell its
       *  own earlier success from someone else's. */
      paidVia?: QuotePaidVia | null;
    };

export async function markQuotePaidServerSide(input: {
  quoteId: string;
  /** Refuse if the quote belongs to another sub-account. */
  expectSubAccountId: string;
  /** Recorded on the quote with the paid write. Omitted = none (manual). */
  paidVia?: QuotePaidVia;
  /**
   * What the caller was paid for, in cents and ISO currency. Checked inside
   * the transaction, so an invoice edited after the caller's own read is
   * refused (`amount_changed`) rather than marked paid on a short payment.
   * Omitted = not checked (the manual button, Stripe).
   */
  expectTotalCents?: number;
  expectCurrency?: string;
}): Promise<MarkQuotePaidOutcome> {
  const db = getAdminDb();
  const ref = db.collection("quotes").doc(input.quoteId);

  // Check and write in ONE transaction (compare-and-set). Four callers can
  // race — the button, the Stripe reconciler, Paystack links (two links for
  // one invoice, or a redelivered webhook) — and only the caller whose write
  // commits may fire the side effects below. A check outside the transaction
  // let two callers both see "sent" and both fire the trigger.
  const outcome = await db.runTransaction(async (tx): Promise<MarkQuotePaidOutcome | Quote> => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      return { ok: false, code: "not_found", message: "Quote not found" };
    }
    const quote = snap.data() as Quote;
    if (quote.subAccountId !== input.expectSubAccountId) {
      return {
        ok: false,
        code: "wrong_tenant",
        message: "Quote belongs to a different sub-account",
      };
    }
    // Idempotent: a replayed payment event, or a double-click on Mark as
    // paid, must not re-fire the workflow trigger or send a second review
    // request.
    if (quote.status === "paid") {
      return {
        ok: false,
        code: "already_paid",
        message: "Already marked paid",
        paidVia: quote.paidVia ?? null,
      };
    }

    const allowed =
      quote.kind === "invoice"
        ? quote.status === "sent" || quote.status === "viewed"
        : quote.status === "accepted";
    if (!allowed) {
      return {
        ok: false,
        code: "bad_status",
        message:
          quote.kind === "invoice"
            ? `Only sent invoices can be marked paid. Current status: ${quote.status}`
            : `Only accepted quotes can be marked paid. Current status: ${quote.status}`,
      };
    }

    if (
      (input.expectTotalCents !== undefined &&
        Math.round(computeQuoteTotals(quote).total * 100) !== input.expectTotalCents) ||
      (input.expectCurrency !== undefined &&
        (quote.currency || "").toUpperCase() !== input.expectCurrency.toUpperCase())
    ) {
      return {
        ok: false,
        code: "amount_changed",
        message: "The invoice total or currency changed since it was paid for",
      };
    }

    tx.update(ref, {
      status: "paid",
      paidVia: input.paidVia ?? null,
      paidAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return quote;
  });
  if ("ok" in outcome) return outcome;
  const quote = outcome;

  const withId = { ...quote, id: input.quoteId, status: "paid" as const };

  // The paid write has committed. Side effects fire AT MOST once, and only
  // for the compare-and-set winner: a loser gets already_paid above. A crash
  // between the commit and these lines skips them, and nothing re-fires them
  // (pre-existing; out of scope here). Each is caught on its own so a failing
  // one neither skips the next nor turns a committed payment into a throw.
  await recordQuoteActivity(withId, "quote_marked_paid").catch((err: unknown) =>
    console.error(`[quotes-service] activity failed quote=${input.quoteId}`, err),
  );
  await fireQuoteTrigger(withId, "quote_marked_paid").catch((err: unknown) =>
    console.error(`[quotes-service] trigger failed quote=${input.quoteId}`, err),
  );
  void emitQuoteWebhook(withId, "quote_marked_paid");
  void maybeSendReviewRequest({
    subAccountId: quote.subAccountId,
    agencyId: quote.agencyId,
    contactId: quote.contactId,
    trigger: "quote_paid",
  });

  return { ok: true, quote: withId };
}
