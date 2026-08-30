import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import {
  emitQuoteWebhook,
  fireQuoteTrigger,
  recordQuoteActivity,
} from "@/lib/quotes/lifecycle";
import { maybeSendReviewRequest } from "@/lib/reviews/request";
import type { Quote } from "@/types/quotes";

/**
 * Quotes service — the single server-side path that flips a quote/invoice to
 * `paid` and runs its side-effects.
 *
 * Extracted so the Stripe order reconciler and the operator's manual
 * "Mark as paid" button drive the SAME transition. Payments v1's rule was that
 * a card payment must not invent a second paid-path — otherwise the activity
 * row, the `quote.paid` workflow trigger, the outbound webhook, and the
 * auto Google-review request all drift between the two.
 *
 * Auth and territory gating stay in the callers: the route checks membership,
 * the reconciler's authority is the verified Stripe signature.
 */

export type MarkQuotePaidOutcome =
  | { ok: true; quote: Quote & { id: string } }
  | { ok: false; code: "not_found" | "wrong_tenant" | "already_paid" | "bad_status"; message: string };

export async function markQuotePaidServerSide(input: {
  quoteId: string;
  /** Refuse if the quote belongs to another sub-account. */
  expectSubAccountId: string;
}): Promise<MarkQuotePaidOutcome> {
  const db = getAdminDb();
  const ref = db.collection("quotes").doc(input.quoteId);
  const snap = await ref.get();
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
  // Idempotent: a replayed Stripe event, or a double-click on Mark as paid,
  // must not re-fire the workflow trigger or send a second review request.
  if (quote.status === "paid") {
    return { ok: false, code: "already_paid", message: "Already marked paid" };
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

  await ref.update({
    status: "paid",
    paidAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  const withId = { ...quote, id: input.quoteId, status: "paid" as const };

  // Side-effects swallow their own errors — a stale activity write must not
  // fail a payment that already succeeded.
  await recordQuoteActivity(withId, "quote_marked_paid");
  await fireQuoteTrigger(withId, "quote_marked_paid");
  void emitQuoteWebhook(withId, "quote_marked_paid");
  void maybeSendReviewRequest({
    subAccountId: quote.subAccountId,
    agencyId: quote.agencyId,
    contactId: quote.contactId,
    trigger: "quote_paid",
  });

  return { ok: true, quote: withId };
}
