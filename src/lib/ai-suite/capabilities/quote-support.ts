import "server-only";

import { isDocId } from "@/lib/server/doc-id";
import { getAdminDb } from "@/lib/firebase/admin";
import { computeQuoteTotals, lineItemSubtotal } from "@/lib/quotes/calc";
import type { Quote } from "@/types/quotes";
import { CapabilityUserError, type PreviewRow } from "./types";
import { fmtMoney } from "./helpers";
import { oneLine } from "./text-safety";

/** Shared by the quote capabilities (quotes.ts, quote-send.ts, quote-paid.ts). */

export const quoteIdParam = { type: "string", description: "The quote's or invoice's id (from list_quotes)." };

export type TenantQuote = Quote & { id: string };

export async function tenantQuote(subAccountId: string, quoteId: unknown): Promise<TenantQuote> {
  const snap = isDocId(quoteId) ? await getAdminDb().doc(`quotes/${quoteId}`).get() : null;
  const data = snap?.data();
  if (!data || data.subAccountId !== subAccountId) throw new CapabilityUserError("That quote or invoice isn't in this workspace.");
  return { ...(data as Omit<Quote, "id">), id: snap!.id };
}

export const docLabel = (q: Pick<Quote, "kind">) => (q.kind === "invoice" ? "Invoice" : "Quote");

/** Whole cents of the quote's total (what a payment is checked against). */
export const totalCents = (q: Pick<Quote, "lineItems" | "globalDiscount" | "globalTaxPercent">) =>
  Math.round(computeQuoteTotals(q).total * 100);

/** The document as the customer sees it: number, each line, and the totals. */
export function quoteRows(q: TenantQuote): PreviewRow[] {
  const cur = q.currency || "USD";
  const t = computeQuoteTotals(q);
  const lines = (q.lineItems ?? []).map(
    (li) => `${li.quantity} \u00d7 ${oneLine(li.description) || "(no description)"} @ ${fmtMoney(li.unitPrice, cur)} = ${fmtMoney(lineItemSubtotal(li), cur)}`
  );
  return [
    { label: docLabel(q), value: `${oneLine(q.quoteNumber)}, status ${q.status}` },
    { label: "Line items", value: lines.join("\n") || "(none)", multiline: true },
    {
      label: "Total",
      value: [
        `${fmtMoney(t.total, cur)}`,
        t.discountAmount ? `after a ${fmtMoney(t.discountAmount, cur)} discount` : null,
        t.taxAmount ? `including ${fmtMoney(t.taxAmount, cur)} tax` : null,
      ]
        .filter(Boolean)
        .join(", "),
    },
  ];
}
