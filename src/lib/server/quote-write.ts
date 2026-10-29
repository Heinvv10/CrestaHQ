import "server-only";

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { agentEditStamp } from "@/lib/server/agent-edit-stamp";
import { issueQuoteNumber } from "@/lib/quotes/number";
import { sanitizeQuoteTemplate } from "@/lib/quotes/sanitize";
import type { AgentActor } from "@/lib/workflows/agent-hold";
import { GLOBAL_TERRITORY_ID } from "@/types";
import { DEFAULT_QUOTE } from "@/types/quotes";
import type { Quote, QuoteDiscount, QuoteKind, QuoteLineItem } from "@/types/quotes";

/**
 * Creating a quote / invoice, shared by `POST /api/sub-accounts/[id]/quotes`
 * and the agent's create_quote. The caller has already checked the contact
 * is in the sub-account (and the member's territory); this validates a deal
 * link, requires a line item, issues the number and writes the draft.
 */

export interface CreateQuotePayload {
  contactId?: string;
  kind?: QuoteKind;
  lineItems?: QuoteLineItem[];
  currency?: string;
  globalDiscount?: QuoteDiscount;
  globalTaxPercent?: number | null;
  termsAndNotes?: string;
  billedToOrganization?: string | null;
  billingAddress?: string | null;
  validUntilDateString?: string | null;
  paymentDueDays?: number | null;
  autoCreateDealOnAccept?: boolean;
  dealId?: string | null;
  requireSignature?: boolean;
}

export type QuoteWriteFailure = { ok: false; status: number; error: string };

export async function createQuote(opts: {
  subAccountId: string;
  agencyId: string;
  createdByUid: string;
  contactId: string;
  contact: FirebaseFirestore.DocumentData;
  body: CreateQuotePayload;
  actor?: AgentActor;
}): Promise<{ ok: true; id: string; quoteNumber: string } | QuoteWriteFailure> {
  const { subAccountId, contactId, contact, body } = opts;
  const db = getAdminDb();
  const sanitized = sanitizePayload(body);
  const kind: QuoteKind = body.kind === "invoice" ? "invoice" : "quote";

  // Optional link to an existing pipeline deal (quote-only). Validated
  // hard: the deal must exist, live in this sub-account, and belong to
  // the quote's contact — a linked accept moves that deal to Won, so a
  // bad link would progress someone else's deal. Absent/null = the
  // pre-linkage behavior (auto-create on accept), unchanged.
  let dealId: string | null = null;
  if (typeof body.dealId === "string" && body.dealId.trim() && kind === "quote") {
    const linked = await checkDealLink(subAccountId, body.dealId.trim(), contactId);
    if (!linked.ok) return linked;
    dealId = body.dealId.trim();
  }

  // A quote / invoice with zero line items isn't a useful document and
  // can't have a meaningful total — reject up-front. UI also gates this
  // (catalog-only line items, save disabled when empty) but the server
  // is the source of truth.
  if (!sanitized.lineItems || sanitized.lineItems.length === 0) {
    return { ok: false, status: 400, error: "Add at least one product from the catalog before saving." };
  }

  let quoteNumber: string;
  try {
    quoteNumber = await issueQuoteNumber(subAccountId, kind);
  } catch (err) {
    console.error("[quotes/create] issueQuoteNumber failed", err);
    return { ok: false, status: 500, error: "Failed to allocate quote number" };
  }

  const docRef = db.collection("quotes").doc();
  // Build the document. Use FieldValue.serverTimestamp() for createdAt /
  // updatedAt so they sort consistently with everything else in the
  // tenancy. publicTokenHash is empty until the first send.
  const doc: Omit<Quote, "id"> = {
    ...DEFAULT_QUOTE,
    kind,
    agencyId: opts.agencyId,
    subAccountId,
    createdByUid: opts.createdByUid,
    contactId,
    quoteNumber,
    publicTokenHash: "",
    // Inherit territory from the contact this quote is for — quotes
    // follow their account's territory (Global fallback).
    territoryId: (contact.territoryId as string | null | undefined) ?? GLOBAL_TERRITORY_ID,
    ...sanitized,
    dealId,
    requireSignature: kind === "quote" ? body.requireSignature !== false : false,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };

  try {
    await docRef.set({ ...doc, ...agentEditStamp(opts.actor) });
  } catch (err) {
    console.error("[quotes/create] write failed", err);
    return { ok: false, status: 500, error: "Failed to create quote" };
  }
  return { ok: true, id: docRef.id, quoteNumber };
}

/** A deal a quote may link to: in this sub-account and the quote's contact's. */
export async function checkDealLink(subAccountId: string, dealId: string, contactId: string): Promise<{ ok: true } | QuoteWriteFailure> {
  const dealSnap = await getAdminDb().doc(`deals/${dealId}`).get();
  const deal = dealSnap.data();
  if (!dealSnap.exists || deal?.subAccountId !== subAccountId) return { ok: false, status: 404, error: "Linked deal not found" };
  if (deal?.contactId !== contactId) return { ok: false, status: 400, error: "Linked deal belongs to a different contact" };
  return { ok: true };
}

/**
 * Clean + clamp the operator-supplied payload before writing. The money and
 * document fields are shared with the recurring-invoice template and are
 * cleaned by `sanitizeQuoteTemplate`; only the quote-only fields are handled
 * here.
 */
export function sanitizePayload(body: CreateQuotePayload): Partial<Quote> {
  const out: Partial<Quote> = sanitizeQuoteTemplate(body);

  if (typeof body.autoCreateDealOnAccept === "boolean") {
    out.autoCreateDealOnAccept = body.autoCreateDealOnAccept;
  }

  if (body.validUntilDateString === null) {
    out.validUntil = null;
  } else if (
    typeof body.validUntilDateString === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(body.validUntilDateString)
  ) {
    // Treat the picked date as end-of-day local time. Convert to an
    // admin Timestamp so the cast to the Quote type (which uses client
    // SDK's Timestamp) is structurally honest — admin + client
    // Timestamps share the same shape at runtime, TS just treats them
    // as different nominal types.
    const d = new Date(`${body.validUntilDateString}T23:59:59`);
    if (!Number.isNaN(d.getTime())) {
      out.validUntil = Timestamp.fromDate(d) as unknown as Quote["validUntil"];
    }
  }

  return out;
}
