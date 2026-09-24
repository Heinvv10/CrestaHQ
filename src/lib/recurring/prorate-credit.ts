import { formatCurrency } from "@/lib/format";
import { computeQuoteTotals } from "@/lib/quotes/calc";
import type { ProrationCredit, ProrationRecord } from "@/lib/recurring/prorate-record";
import type { QuoteDiscount, QuoteLineItem } from "@/types/quotes";

/**
 * Pro-rated credits (a billing day moved earlier) onto the cycles that owe them.
 *
 * A credit is owed from the cycle it was computed for and taken by the first
 * cycle generated on or after it — so a cycle skipped as too stale, or one
 * that fails before its invoice exists, passes it on. An invoice cannot go
 * below zero, so a credit larger than what is left of the invoice is split:
 * the rest is owed by the next cycle. What a FINAL cycle cannot absorb is
 * orphaned, for a human to credit by hand.
 */

interface Template {
  lineItems: QuoteLineItem[];
  globalDiscount: QuoteDiscount;
  globalTaxPercent: number | null;
}

export function takeCredits(
  record: ProrationRecord | null,
  cycle: { dueAt: Date; number: number; final: boolean; template: Template },
): { applied: ProrationCredit[]; credits: ProrationCredit[]; orphaned: ProrationCredit[] } | null {
  const owed = (c: ProrationCredit) => c.cycle === null && c.appliesToDueAt.getTime() <= cycle.dueAt.getTime();
  if (!record?.credits.some(owed)) return null;
  let room = computeQuoteTotals(cycle.template).taxableAmount;
  const applied: ProrationCredit[] = [];
  const credits = record.credits.flatMap((c): ProrationCredit[] => {
    if (!owed(c) || room <= 0) return [c];
    const take = round2(Math.min(c.taxable, room));
    room = round2(room - take);
    const taken = { ...c, taxable: take, cycle: cycle.number };
    applied.push(taken);
    const rest = round2(c.taxable - take);
    // Due just after this cycle, so the next one takes it.
    const remainder = { ...c, taxable: rest, label: `${c.label} (remainder)`, appliesToDueAt: new Date(cycle.dueAt.getTime() + 1) };
    return rest > 0 ? [taken, remainder] : [taken];
  });
  const orphaned = cycle.final ? credits.filter((c) => c.cycle === null) : [];
  return { applied, credits, orphaned };
}

/**
 * The template with `credits` applied.
 *
 * Quote lines are clamped to ≥ 0 everywhere (calc, sanitiser, builder), so a
 * negative line would be zeroed the moment an operator saved a review-first
 * draft. Credits are therefore folded into a flat discount — which every
 * surface keeps and shows — and a zero-priced line names each for the customer.
 */
export function withProratedCredits(template: Template, credits: ProrationCredit[], currency: string): Template {
  const { lineItems, globalDiscount, globalTaxPercent } = template;
  if (credits.length === 0) return { lineItems, globalDiscount, globalTaxPercent };
  const totals = computeQuoteTotals(template);
  return {
    lineItems: [
      ...lineItems,
      ...credits.map((c, i) => ({
        id: `prorate-credit-${i + 1}`,
        description: `${c.label}: −${formatCurrency(c.taxable, currency)} excl. tax, included in the discount`,
        quantity: 1,
        unitPrice: 0,
        productId: null,
      })),
    ],
    globalDiscount: { type: "flat", value: round2(totals.discountAmount + credits.reduce((sum, c) => sum + c.taxable, 0)) },
    globalTaxPercent,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
