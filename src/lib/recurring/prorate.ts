import { utcFromWallClock } from "@/lib/booking/availability";
import { formatCurrency } from "@/lib/format";
import { computeQuoteTotals } from "@/lib/quotes/calc";
import { computeFirstRunAt, computeNextRunAt, startOfLocalDay, type Cadence } from "@/lib/recurring/cadence";
import type { QuoteDiscount, QuoteLineItem } from "@/types/quotes";

/**
 * Pro-rating a billing-day (anchor) change on a schedule that has already
 * billed. Pure: the route persists the plan, the sweep raises gap invoices,
 * the cycle claim takes the credit.
 *
 * Invoices bill IN ADVANCE: the invoice due 15 Jun pays for 15 Jun – 14 Jul,
 * so the customer is covered until 15 Jul. The billing day moves within that
 * month — 15th → 20th makes the next bill 20 Jul; 20th → 15th makes it 15 Jul
 * — and never earlier than today, so no extra cycle is consumed:
 *   GAP     (next bill after coverage) — ONE one-off invoice for the uncovered
 *           days, raised by the sweep (and best-effort at the edit);
 *   OVERLAP (next bill before coverage) — the next generated invoice carries a
 *           credit for the days paid twice.
 * Amount = template taxable × days ÷ days in the cycle those days start (old
 * anchor for a gap, new for an overlap), to the cent; tax as on any invoice.
 *
 * Only anchor changes WITHIN one cadence pro-rate. A cadence change (monthly ↔
 * quarterly/weekly) redefines what a cycle is worth, so it never pro-rates.
 * Nor does a schedule that has never billed, or one that is not active.
 */

const DAY = 86_400_000;
/** Raised gaps kept on the schedule as history. */
const RAISED_KEPT = 10;

export interface ProratedPeriod {
  from: Date;
  /** Exclusive; labels show the day before. */
  to: Date;
  days: number;
  cycleDays: number;
  /** Pre-tax amount, in currency units, rounded to cents. */
  taxable: number;
  label: string;
}

export interface ProrationGap extends ProratedPeriod {
  /** The quote doc id the invoice is raised under, fixed at the edit: a retaken claim cannot raise it twice. */
  docId: string;
  state: "pending" | "raising" | "raised";
  claimedAt: Date | null;
  invoiceId: string | null;
  /** The billed period it belongs to. Only that period's PENDING gaps can be cancelled by a later edit. */
  forLastDueAt: Date | null;
}

export interface ProrationCredit extends ProratedPeriod {
  /** Goes on the first invoice generated for a cycle due at or after this. */
  appliesToDueAt: Date;
  /** The cycle number that took it; null while owed. */
  cycle: number | null;
}

/** `recurringInvoices.proration` (Dates here, Timestamps stored). */
export interface ProrationRecord {
  /** `lastDueAt` of the billed cycle `coveredUntil` belongs to; stale after the next cycle bills. */
  forLastDueAt: Date | null;
  /** Paid through (exclusive) by billed cycles. Raised or raising gaps extend it; pending ones do not. */
  coveredUntil: Date;
  credit: ProrationCredit | null;
  gaps: ProrationGap[];
}

interface Template {
  lineItems: QuoteLineItem[];
  globalDiscount: QuoteDiscount;
  globalTaxPercent: number | null;
}

export function planProration(input: {
  timezone: string;
  now: Date;
  /** Quote doc id reserved for a gap invoice, should this edit make one. */
  newGapDocId: () => string;
  before: {
    status: string;
    cadence: Cadence;
    anchorDay: number | null;
    nextRunAt: Date | null;
    lastDueAt: Date | null;
    lastRunAt: Date | null;
    cyclesGenerated: number;
    proration: ProrationRecord | null;
  };
  after: { status: string; cadence: Cadence; anchorDay: number | null; template: Template };
}): { record: ProrationRecord; next: Date } | null {
  const { before, after, timezone, now } = input;
  if (before.cyclesGenerated < 1) return null;
  if (before.status !== "active" || after.status !== "active") return null;
  if (!sameCadence(before.cadence, after.cadence)) return null;
  if (before.anchorDay === null || after.anchorDay === null || before.anchorDay === after.anchorDay) return null;

  const prior = before.proration;
  const priorValid = !!prior && sameInstant(prior.forLastDueAt, before.lastDueAt);
  const base = priorValid
    ? prior.coveredUntil
    : before.lastDueAt
      ? computeNextRunAt({ previous: before.lastDueAt, cadence: before.cadence, anchorDay: before.anchorDay, timezone })
      : before.nextRunAt; // billed before `lastDueAt` existed: the claim set nextRunAt one cycle on
  if (!base) return null;
  const thisPeriod = (g: ProrationGap) => sameInstant(g.forLastDueAt, before.lastDueAt);
  const priorGaps = prior?.gaps ?? [];
  const covered = new Date(
    Math.max(base.getTime(), ...priorGaps.filter((g) => thisPeriod(g) && g.state !== "pending").map((g) => g.to.getTime())),
  );

  // The new billing day in the month coverage ends, never at or before today or the last run.
  const floor = Math.max(startOfLocalDay(now, timezone).getTime() - 1, before.lastRunAt?.getTime() ?? -Infinity);
  let next = computeFirstRunAt({ startAt: monthStart(covered, timezone), cadence: after.cadence, anchorDay: after.anchorDay, timezone });
  while (next.getTime() <= floor) {
    next = computeNextRunAt({ previous: next, cadence: after.cadence, anchorDay: after.anchorDay, timezone });
  }

  // A later edit replaces this period's gaps that were never raised; everything else stands.
  const kept = priorGaps.filter((g) => !(thisPeriod(g) && g.state === "pending"));
  const raised = kept.filter((g) => g.state === "raised").slice(-RAISED_KEPT);
  const gaps = kept.filter((g) => g.state !== "raised" || raised.includes(g));
  // A credit no cycle has taken yet is still owed (only reachable if a cycle was skipped).
  const owed = prior?.credit && prior.credit.cycle === null && !priorValid ? prior.credit : null;
  const record: ProrationRecord = { forLastDueAt: before.lastDueAt, coveredUntil: base, credit: owed, gaps };
  if (next.getTime() === covered.getTime()) return { record, next };

  const isGap = next.getTime() > covered.getTime();
  const [from, to] = isGap ? [covered, next] : [next, covered];
  const cycleEnd = computeNextRunAt({
    previous: from,
    cadence: after.cadence,
    anchorDay: isGap ? before.anchorDay : after.anchorDay,
    timezone,
  });
  const days = wholeDays(from, to);
  const cycleDays = wholeDays(from, cycleEnd);
  // A full cycle or more is missed billing (a schedule far behind), not a billing-day change.
  if (days <= 0 || days >= cycleDays) return null;

  const taxable = round2((computeQuoteTotals(after.template).taxableAmount * days) / cycleDays);
  const range = `${dayMonth(from, timezone)} – ${dayMonth(new Date(to.getTime() - DAY / 2), timezone)}`;
  const period = { from, to, days, cycleDays, taxable };
  if (isGap) {
    const gap: ProrationGap = {
      ...period,
      label: `Pro-rated: ${range} (billing day changed)`,
      docId: input.newGapDocId(),
      state: "pending",
      claimedAt: null,
      invoiceId: null,
      forLastDueAt: before.lastDueAt,
    };
    return { record: { ...record, gaps: [...gaps, gap] }, next };
  }
  const label = `Pro-rated credit: ${range} (billing day changed)`;
  return { record: { ...record, credit: { ...period, label, appliesToDueAt: next, cycle: null } }, next };
}

/** The credit a cycle due `dueAt` takes, if one is owed and due by then. */
export function creditDueOn(proration: ProrationRecord | null, dueAt: Date): ProrationCredit | null {
  const credit = proration?.credit;
  return credit && credit.cycle === null && credit.appliesToDueAt.getTime() <= dueAt.getTime() ? credit : null;
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
 * The template with `credit` applied, or unchanged.
 *
 * Quote lines are clamped to ≥ 0 everywhere (calc, sanitiser, builder), so a
 * negative line would be zeroed the moment an operator saved a review-first
 * draft. The credit is therefore folded into a flat discount — which every
 * surface keeps and shows — and a zero-priced line names it for the customer.
 */
export function withProratedCredit(template: Template, credit: ProrationCredit | null, currency: string): Template {
  const { lineItems, globalDiscount, globalTaxPercent } = template;
  if (!credit) return { lineItems, globalDiscount, globalTaxPercent };
  const totals = computeQuoteTotals(template);
  const amount = formatCurrency(credit.taxable, currency);
  return {
    lineItems: [
      ...lineItems,
      {
        id: "prorate-credit",
        description: `${credit.label}: −${amount} excl. tax, included in the discount`,
        quantity: 1,
        unitPrice: 0,
        productId: null,
      },
    ],
    globalDiscount: { type: "flat", value: round2(totals.discountAmount + credit.taxable) },
    globalTaxPercent,
  };
}

function sameCadence(a: Cadence, b: Cadence): boolean {
  return a.unit === b.unit && a.interval === b.interval;
}

export function sameInstant(a: Date | null, b: Date | null): boolean {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}

/** Local midnight to local midnight; rounding absorbs a 23h or 25h DST day. */
function wholeDays(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / DAY);
}

function monthStart(at: Date, timezone: string): Date {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "numeric" }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return utcFromWallClock(get("year"), get("month"), 1, 0, timezone);
}

function dayMonth(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, day: "numeric", month: "short" }).format(at);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** A stored `proration` (Timestamps) back as a record (Dates); null if absent or malformed. */
export function readProration(raw: unknown): ProrationRecord | null {
  const r = asObject(raw);
  const coveredUntil = asDate(r?.coveredUntil);
  if (!r || !coveredUntil) return null;
  const c = period(r.credit);
  const credit = asObject(r.credit);
  const appliesToDueAt = asDate(credit?.appliesToDueAt);
  const gaps = (Array.isArray(r.gaps) ? r.gaps : []).flatMap((raw): ProrationGap[] => {
    const g = asObject(raw);
    const p = period(raw);
    if (!g || !p || typeof g.docId !== "string") return [];
    const state = g.state === "raising" || g.state === "raised" ? g.state : "pending";
    const invoiceId = typeof g.invoiceId === "string" ? g.invoiceId : null;
    return [{ ...p, docId: g.docId, state, claimedAt: asDate(g.claimedAt), invoiceId, forLastDueAt: asDate(g.forLastDueAt) }];
  });
  return {
    forLastDueAt: asDate(r.forLastDueAt),
    coveredUntil,
    credit: c && appliesToDueAt ? { ...c, appliesToDueAt, cycle: typeof credit?.cycle === "number" ? credit.cycle : null } : null,
    gaps,
  };
}

function period(raw: unknown): ProratedPeriod | null {
  const q = asObject(raw);
  const [from, to] = [asDate(q?.from), asDate(q?.to)];
  if (!q || !from || !to || typeof q.taxable !== "number") return null;
  return { from, to, days: Number(q.days), cycleDays: Number(q.cycleDays), taxable: q.taxable, label: String(q.label ?? "") };
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function asDate(v: unknown): Date | null {
  if (v instanceof Date) return v;
  const t = v as { toDate?: () => Date } | null | undefined;
  return typeof t?.toDate === "function" ? t.toDate() : null;
}
