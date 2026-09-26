import "server-only";

import { isDocId } from "@/lib/server/doc-id";
import { getAdminDb } from "@/lib/firebase/admin";
import { emailIsConfigured, tenantFrom } from "@/lib/comms/resend";
import { predictInvoicePayRail, type PayRailKind } from "@/lib/server/invoice-pay-rail";
import { sendQuoteServerSide } from "@/lib/server/quote-send-service";
import { emailAsReviewed, quoteFingerprint, type QuoteSendExpect } from "@/lib/quotes/send-preview";
import type { SubAccountDoc } from "@/types";
import { CapabilityOutcomeUnknown, CapabilityUserError, type AiSuiteCapability } from "./types";
import { str } from "./helpers";
import { messageBody, oneLine, plainSpaces } from "./text-safety";
import { masked } from "./conversation-send-support";
import { recordProvenanceRows } from "./record-provenance";
import { docLabel, quoteIdParam, quoteRows, tenantQuote, type TenantQuote } from "./quote-support";

/**
 * send_quote for API agents (AGENT_API_V1_PLAN.md, PR11): email a quote or
 * invoice to its contact, as the Send button does, once a person approves
 * (outbound). The preview shows the recipient, the channel (email), how an
 * invoice is paid, the document's lines and total, and the exact subject and
 * text, with placeholders for the links made at send (send-preview.ts). All
 * of it is pinned, and the send itself refuses anything that differs
 * (`sendQuoteServerSide`'s `expect`).
 */

const RAIL_SHOWN: Record<PayRailKind, string> = {
  paystack_card: "a Paystack card-on-file link: paying it also saves the card for this invoice's recurring schedule",
  paystack: "a Paystack payment link",
  paypal: "a PayPal link on the quote's page",
  stripe: "Stripe card payment on the quote's page",
};

async function plan(subAccountId: string, q: TenantQuote): Promise<{ expect: QuoteSendExpect; name: string; from: string }> {
  if (q.status === "paid") throw new CapabilityUserError(`That ${docLabel(q).toLowerCase()} is already paid.`);
  const db = getAdminDb();
  const [contactSnap, subSnap] = await Promise.all([
    isDocId(q.contactId) ? db.doc(`contacts/${q.contactId}`).get() : null,
    db.doc(`subAccounts/${subAccountId}`).get(),
  ]);
  const contact = contactSnap?.data();
  if (!contact || contact.subAccountId !== subAccountId) throw new CapabilityUserError("Its contact isn't in this workspace any more.");
  const to = typeof contact.email === "string" ? contact.email.trim() : "";
  if (!to) throw new CapabilityUserError("Its contact has no email address.");
  const sub = (subSnap.data() as SubAccountDoc | undefined) ?? null;
  if (!emailIsConfigured(sub)) throw new CapabilityUserError("Email isn't configured for this workspace.");
  let rail: PayRailKind | null = null;
  if (q.kind === "invoice") {
    const predicted = await predictInvoicePayRail(q, sub);
    if (!predicted.ok) throw new CapabilityUserError(predicted.error);
    rail = predicted.rail;
  }
  const name = typeof contact.name === "string" ? contact.name.trim() : "";
  const email = emailAsReviewed({
    quote: q,
    businessName: sub?.name || "Your business",
    businessLogoUrl: sub?.logoUrl ?? null,
    recipientName: name,
    payLink: rail === "paystack" || rail === "paystack_card",
  });
  // Shown as sent, but for the kind of space (currency amounts use a
  // no-break space): text a message body would otherwise tidy can't be.
  if (messageBody(email.text) !== plainSpaces(email.text) || oneLine(email.subject) !== plainSpaces(email.subject)) {
    throw new CapabilityUserError("The email's text has characters or spacing that can't be shown exactly as sent.");
  }
  return { expect: { to, subject: email.subject, text: email.text, html: email.html, rail, fingerprint: quoteFingerprint(q) }, name, from: tenantFrom(sub) ?? "the shared sending address" };
}

export const QUOTE_SEND_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "send_quote",
    level: "sub-account",
    requiredRole: "subAccountMember",
    surfaces: ["agent"],
    approval: "outbound",
    menuLabel: "Email a quote or invoice to its contact (a person approves)",
    description:
      "Email a quote or invoice to its contact with a link to view (and for an invoice, pay) it, as the Send button does. Re-sending makes a fresh link. Queued for a person to approve.",
    parameters: { type: "object", properties: { quoteId: quoteIdParam }, required: ["quoteId"], additionalProperties: false },
    validate: (raw) => {
      const quoteId = str(raw, "quoteId");
      return isDocId(quoteId) ? { ok: true, args: { quoteId } } : { ok: false, error: "a quoteId is required" };
    },
    summarize: () => "Send a quote or invoice.",
    approvalTarget: async (ctx, args) => {
      const q = await tenantQuote(ctx.subAccountId!, args.quoteId);
      return { contactId: isDocId(q.contactId) ? q.contactId : null, territoryId: q.territoryId ?? null, scoped: true };
    },
    preview: async (ctx, args) => {
      const q = await tenantQuote(ctx.subAccountId!, args.quoteId);
      const { expect, name, from } = await plan(ctx.subAccountId!, q);
      return {
        rows: [
          { label: "Send", value: `${docLabel(q)} ${oneLine(q.quoteNumber)}${q.status === "draft" ? "" : " again (a fresh link replaces the old one)"}` },
          ...recordProvenanceRows(q.id, q),
          { label: "To", value: `${oneLine(name) || "(unnamed)"} (${masked("email", expect.to)})` },
          { label: "Channel", value: "Email" },
          { label: "From", value: oneLine(from) },
          { label: "Replies go to", value: "the approver's email address" },
          ...(expect.rail ? [{ label: "Payment", value: RAIL_SHOWN[expect.rail] }] : []),
          ...quoteRows(q),
          { label: "Subject", value: oneLine(expect.subject) },
          { label: "Message", value: messageBody(expect.text)!, multiline: true as const },
          { label: "Then", value: "It is marked sent, and workflows that start when a quote is sent run." },
        ],
        pinned: { quoteId: q.id, ...expect },
      };
    },
    execute: async (ctx, args) => {
      const q = await tenantQuote(ctx.subAccountId!, args.quoteId);
      // What the approver reviewed: the send refuses anything that now differs.
      const { quoteId: _id, ...expect } = (ctx.approved?.pinned ?? {}) as Partial<QuoteSendExpect> & { quoteId?: string };
      const sent = await sendQuoteServerSide({
        subAccountId: ctx.subAccountId!,
        quoteId: q.id,
        replyTo: ctx.email || null,
        // The decide route checked the approver may act on this contact.
        actor: { kind: "system", reason: "an approved agent proposal; the approver's territory was checked on approve" },
        expect: expect as QuoteSendExpect,
      });
      if (!sent.ok) {
        const msg = `${sent.failure.error}${sent.cardLinkFallback ? ` (${sent.cardLinkFallback})` : ""}`;
        // A provider error can't say whether the email left.
        if (sent.failure.code === "send_failed") throw new CapabilityOutcomeUnknown(msg);
        throw new CapabilityUserError(msg);
      }
      return { resultText: `Sent ${docLabel(q).toLowerCase()} ${q.quoteNumber} to ${masked("email", sent.sentTo)}.`, ref: { kind: "quote", id: q.id } };
    },
  },
];
