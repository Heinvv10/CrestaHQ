import { formatCurrency } from "@/lib/format";
import { computeQuoteTotals } from "@/lib/quotes/calc";
import { computeNextRunAt, type Cadence } from "@/lib/recurring/cadence";
import type { QuoteDiscount, QuoteLineItem } from "@/types/quotes";

/**
 * Pro-rating a billing-day (anchor) change on a schedule that has already
 * billed. Pure: the route persists the plan, the cycle applies the credit.
 *
 * Invoices bill IN ADVANCE: the invoice due 15 Jun pays for 15 Jun – 15 Jul,
 * so the customer is "covered until" 15 Jul. Moving the anchor to the 20th
 * makes the next bill 20 Jul:
 *   GAP     (next bill after coveredUntil) — 15–20 Jul was never billed, so ONE
 *           one-off invoice is raised for it, at the time of the edit;
 *   OVERLAP (next bill before coveredUntil) — those days are paid twice, so the
 *           next invoice carries a credit for them.
 * Amount = template total × days ÷ days in the cycle the pro-rated days start
 * (old anchor for a gap, new anchor for an overlap), rounded to cents.
 *
 * Only anchor changes WITHIN one cadence pro-rate. A cadence change (monthly ↔
 * quarterly/weekly) redefines what a cycle is worth, so it never pro-rates.
 * Nor does a schedule that has never billed, or one that is not active.
 */

const DAY = 86_400_000;

/** What `recurringInvoices.proration` records (Dates here, Timestamps stored). */
export interface ProrationRecord {
  /** `lastDueAt` of the billed cycle this record belongs to; stale after the next cycle bills. */
  forLastDueAt: Date | null;
  /** The customer has paid through this instant (exclusive). */
  coveredUntil: Date;
  /** A credit owed on the invoice for the cycle due `appliesToDueAt`, or null. */
  credit: ProratedPeriod & { appliesToDueAt: Date } | null;
  /** The last gap invoiced by this record; `invoiceId` is filled once raised. */
  gap: ProratedPeriod & { invoiceId: string | null } | null;
}

export interface ProratedPeriod {
  from: Date;
  to: Date;
  days: number;
  cycleDays: number;
  /** Pre-tax amount, in currency units, rounded to cents. */
  taxable: number;
  label: string;
}

interface Template {
  lineItems: QuoteLineItem[];
  globalDiscount: QuoteDiscount;
  globalTaxPercent: number | null;
}

export function planProration(input: {
  timezone: string;
  before: {
    status: string;
    cadence: Cadence;
    anchorDay: number | null;
    nextRunAt: Date | null;
    lastDueAt: Date | null;
    cyclesGenerated: number;
    proration: ProrationRecord | null;
  };
  after: {
    status: string;
    cadence: Cadence;
    anchorDay: number | null;
    /** The recomputed next run; null when the edit did not move it. */
    nextRunAt: Date | null;
    template: Template;
  };
}): ProrationRecord | null {
  const { before, after, timezone } = input;
  if (before.cyclesGenerated < 1) return null;
  if (before.status !== "active" || after.status !== "active") return null;
  if (!sameCadence(before.cadence, after.cadence)) return null;
  if (before.anchorDay === null || after.anchorDay === null) return null;
  if (before.anchorDay === after.anchorDay || !after.nextRunAt) return null;

  const prior = before.proration;
  const priorValid = !!prior && sameInstant(prior.forLastDueAt, before.lastDueAt);
  const coveredUntil = priorValid
    ? prior.coveredUntil
    : before.lastDueAt
      ? computeNextRunAt({ previous: before.lastDueAt, cadence: before.cadence, anchorDay: before.anchorDay, timezone })
      : before.nextRunAt; // billed before `lastDueAt` existed: the claim set nextRunAt one cycle on
  if (!coveredUntil) return null;

  const next = after.nextRunAt;
  const base = { forLastDueAt: before.lastDueAt, coveredUntil, credit: null, gap: null };
  if (next.getTime() === coveredUntil.getTime()) return base;

  const isGap = next.getTime() > coveredUntil.getTime();
  const [from, to] = isGap ? [coveredUntil, next] : [next, coveredUntil];
  const cycleEnd = computeNextRunAt({
    previous: from,
    cadence: after.cadence,
    anchorDay: isGap ? before.anchorDay : after.anchorDay,
    timezone,
  });
  const days = wholeDays(from, to);
  const cycleDays = wholeDays(from, cycleEnd);
  // A full cycle or more is missed billing, not a billing-day change.
  if (days <= 0 || days >= cycleDays) return null;

  const taxable = round2((computeQuoteTotals(after.template).taxableAmount * days) / cycleDays);
  const range = `${dayMonth(from, timezone)} – ${dayMonth(to, timezone)}`;
  if (isGap) {
    const label = `Pro-rated: ${range} (billing day changed)`;
    return { ...base, coveredUntil: next, gap: { from, to, days, cycleDays, taxable, label, invoiceId: null } };
  }
  const label = `Pro-rated credit: ${range} (billing day changed)`;
  return { ...base, credit: { from, to, days, cycleDays, taxable, label, appliesToDueAt: next } };
}

/** The one-off gap invoice's money: one line, the template's tax, no discount. */
export function gapInvoiceTemplate(gap: ProratedPeriod, template: Template): Template {
  return {
    lineItems: [{ id: "prorate", description: gap.label, quantity: 1, unitPrice: gap.taxable, productId: null }],
    globalDiscount: null,
    globalTaxPercent: template.globalTaxPercent,
  };
}

/**
 * The template for the cycle due `dueAt`, with any credit owed on it.
 *
 * Quote lines are clamped to ≥ 0 everywhere (calc, sanitiser, builder), so a
 * negative line would be zeroed the moment an operator saved a review-first
 * draft. The credit is therefore folded into a flat discount — which every
 * surface keeps and shows — and a zero-priced line names it for the customer.
 */
export function withProratedCredit(
  template: Template,
  proration: ProrationRecord | null | undefined,
  dueAt: Date | null,
  currency: string,
): Template {
  const { lineItems, globalDiscount, globalTaxPercent } = template;
  const credit = proration?.credit;
  if (!credit || !dueAt || credit.appliesToDueAt.getTime() !== dueAt.getTime()) {
    return { lineItems, globalDiscount, globalTaxPercent };
  }
  const totals = computeQuoteTotals(template);
  const amount = formatCurrency(credit.taxable, currency);
  return {
    lineItems: [
      ...template.lineItems,
      {
        id: "prorate-credit",
        description: `${credit.label}: −${amount} excl. tax, included in the discount`,
        quantity: 1,
        unitPrice: 0,
        productId: null,
      },
    ],
    globalDiscount: { type: "flat", value: round2(totals.discountAmount + credit.taxable) },
    globalTaxPercent: template.globalTaxPercent,
  };
}

function sameCadence(a: Cadence, b: Cadence): boolean {
  return a.unit === b.unit && a.interval === b.interval;
}

function sameInstant(a: Date | null, b: Date | null): boolean {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}

/** Local midnight to local midnight; rounding absorbs a 23h or 25h DST day. */
function wholeDays(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / DAY);
}

function dayMonth(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, day: "numeric", month: "short" }).format(at);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** A stored `proration` (Timestamps) back as a record (Dates); null if absent or malformed. */
export function readProration(raw: unknown): ProrationRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const coveredUntil = asDate(r.coveredUntil);
  if (!coveredUntil) return null;
  const period = (p: unknown) => {
    if (!p || typeof p !== "object") return null;
    const q = p as Record<string, unknown>;
    const [from, to] = [asDate(q.from), asDate(q.to)];
    if (!from || !to || typeof q.taxable !== "number") return null;
    const { days, cycleDays, label } = q as { days: number; cycleDays: number; label: string };
    return { from, to, days, cycleDays, taxable: q.taxable, label };
  };
  const credit = period(r.credit);
  const appliesToDueAt = asDate((r.credit as Record<string, unknown> | null)?.appliesToDueAt);
  const gap = period(r.gap);
  return {
    forLastDueAt: asDate(r.forLastDueAt),
    coveredUntil,
    credit: credit && appliesToDueAt ? { ...credit, appliesToDueAt } : null,
    gap: gap ? { ...gap, invoiceId: ((r.gap as Record<string, unknown>).invoiceId as string | null) ?? null } : null,
  };
}

function asDate(v: unknown): Date | null {
  if (v instanceof Date) return v;
  const t = v as { toDate?: () => Date } | null | undefined;
  return typeof t?.toDate === "function" ? t.toDate() : null;
}
