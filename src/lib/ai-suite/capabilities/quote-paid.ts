import "server-only";

import { isDocId } from "@/lib/server/doc-id";
import { markQuotePaidServerSide } from "@/lib/server/quotes-service";
import { unsettledPaystackLinkPayment } from "@/lib/server/quote-paid-via";
import { canonical } from "@/lib/server/agent-proposals-encoding";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { fmtMoney, str } from "./helpers";
import { recordProvenanceRows } from "./record-provenance";
import { reviewPlan } from "./deal-review-plan";
import { docLabel, quoteIdParam, quoteRows, tenantQuote, totalCents, type TenantQuote } from "./quote-support";

/**
 * mark_quote_paid for API agents (AGENT_API_V1_PLAN.md, PR11). Marking a
 * quote or invoice paid runs its automations and can send the contact a
 * Google review request, so a person approves it (outbound). The preview
 * shows the amount and currency, how it is recorded, and the exact review
 * request (deal-review-plan.ts); all of it is pinned. Approve runs the
 * "Mark as paid" button's own path (markQuotePaidServerSide): the total and
 * currency are re-checked in its transaction, only the transaction's winner
 * asks for the review, and the ask itself refuses a number, channel or text
 * that changed (`reviewExpect`).
 */

/** Why the button would refuse this document, or null (quotes-service's rule). */
function notPayable(q: TenantQuote): string | null {
  if (q.status === "paid") return `That ${docLabel(q).toLowerCase()} is already paid.`;
  const cardDraft = q.status === "draft" && !!q.recurringInvoiceId && !!q.autoCharge;
  if (q.kind === "invoice") {
    return q.status === "sent" || q.status === "viewed" || cardDraft ? null : `Only a sent invoice can be marked paid (this one is ${q.status}).`;
  }
  return q.status === "accepted" ? null : `Only an accepted quote can be marked paid (this one is ${q.status}).`;
}

async function plan(subAccountId: string, q: TenantQuote) {
  const [review, paidVia] = await Promise.all([
    reviewPlan(subAccountId, q, Date.now(), "quote_paid"),
    unsettledPaystackLinkPayment(subAccountId, q.id),
  ]);
  const pinned = {
    quoteId: q.id,
    totalCents: totalCents(q),
    currency: (q.currency || "").toUpperCase(),
    paidVia: paidVia ?? null,
    contactId: review.contactId,
    phone: review.phone,
    channel: review.channel,
    body: review.body,
    fingerprint: review.fingerprint,
  };
  return { review, paidVia, pinned };
}

export const QUOTE_PAID_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "mark_quote_paid",
    level: "sub-account",
    requiredRole: "subAccountMember",
    surfaces: ["agent"],
    approval: "outbound",
    menuLabel: "Mark a quote or invoice paid (a person approves; may send a review request)",
    description:
      "Record that an accepted quote or a sent invoice was paid, as its Mark as paid button does. That runs the paid-quote automations and can send the contact a Google review request, so it is queued for a person to approve.",
    parameters: { type: "object", properties: { quoteId: quoteIdParam }, required: ["quoteId"], additionalProperties: false },
    validate: (raw) => {
      const quoteId = str(raw, "quoteId");
      return isDocId(quoteId) ? { ok: true, args: { quoteId } } : { ok: false, error: "a quoteId is required" };
    },
    summarize: () => "Mark a quote or invoice paid.",
    approvalTarget: async (ctx, args) => {
      const q = await tenantQuote(ctx.subAccountId!, args.quoteId);
      return { contactId: isDocId(q.contactId) ? q.contactId : null, territoryId: q.territoryId ?? null, scoped: true };
    },
    preview: async (ctx, args) => {
      const q = await tenantQuote(ctx.subAccountId!, args.quoteId);
      const why = notPayable(q);
      if (why) throw new CapabilityUserError(why);
      const { review, paidVia, pinned } = await plan(ctx.subAccountId!, q);
      return {
        rows: [
          { label: "Mark paid", value: `${docLabel(q)} ${q.quoteNumber}` },
          ...recordProvenanceRows(q.id, q),
          ...quoteRows(q),
          { label: "Amount", value: `${fmtMoney(pinned.totalCents / 100, pinned.currency)} in ${pinned.currency || "(no currency)"}` },
          {
            label: "Recorded as",
            value: paidVia ? `paid by the Paystack payment link already paid for it (${"reference" in paidVia ? paidVia.reference : paidVia.rail})` : "paid by hand (no card or link payment is recorded)",
          },
          { label: "Automations", value: "Workflows that start when a quote is paid run, as when a person marks it paid." },
          ...review.rows,
        ],
        pinned,
      };
    },
    execute: async (ctx, args) => {
      const q = await tenantQuote(ctx.subAccountId!, args.quoteId);
      const pinned = ctx.approved?.pinned ?? {};
      const now = await plan(ctx.subAccountId!, q);
      if (canonical(now.pinned) !== canonical(pinned)) {
        throw new CapabilityUserError("The amount, how it is recorded, the contact or the review request changed since this was reviewed; nothing was changed.");
      }
      const { review } = now;
      const result = await markQuotePaidServerSide({
        quoteId: q.id,
        expectSubAccountId: ctx.subAccountId!,
        ...(now.paidVia ? { paidVia: now.paidVia } : {}),
        expectTotalCents: now.pinned.totalCents,
        expectCurrency: now.pinned.currency,
        reviewExpect: review.channel
          ? { contactId: review.contactId!, phone: review.phone, channel: review.channel, body: review.body!, ...(review.fingerprint ? { fingerprint: review.fingerprint } : {}) }
          : null,
      });
      if (!result.ok) {
        const why: Record<string, string> = {
          already_paid: "It was marked paid meanwhile (by someone else); nothing more was done.",
          amount_changed: "The total or currency changed since this was reviewed; it was not marked paid.",
          contact_changed: "The quote's contact changed since this was reviewed; it was not marked paid.",
          bad_status: `${result.message}; it was not marked paid.`,
        };
        throw new CapabilityUserError(why[result.code] ?? "That quote or invoice isn't in this workspace.");
      }
      return { resultText: `Marked ${docLabel(q).toLowerCase()} ${q.quoteNumber} paid.`, ref: { kind: "quote", id: q.id } };
    },
  },
];
