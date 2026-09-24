import { utcFromWallClock } from "@/lib/booking/availability";
import { computeQuoteTotals } from "@/lib/quotes/calc";
import { computeFirstRunAt, computeNextRunAt, startOfLocalDay, type Cadence } from "@/lib/recurring/cadence";
import type { ProratedPeriod, ProrationGap, ProrationRecord } from "@/lib/recurring/prorate-record";
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
 * Amount = template taxable × days ÷ days in the cycle those days start (for a
 * gap, on the billing day the paid-through date sits on as billed; for an
 * overlap, the new one), to the cent; tax as on any invoice.
 *
 * Only anchor changes WITHIN one cadence pro-rate. A cadence change (monthly ↔
 * quarterly/weekly) redefines what a cycle is worth, so it never pro-rates.
 * Nor does a schedule that has never billed, or one that is not active.
 */

const DAY = 86_400_000;
/** Raised gaps and taken credits kept on the schedule as history. */
const HISTORY_KEPT = 10;

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
  const thisPeriod = (x: { forLastDueAt: Date | null }) => sameInstant(x.forLastDueAt, before.lastDueAt);
  const priorGaps = prior?.gaps ?? [];
  // Paid through, and the billing day that date sits on as billed: the anchor
  // a gap starting there measures its cycle with (not the anchor of today).
  const baseAnchor = priorValid ? prior.coveredAnchorDay : before.anchorDay;
  const { at: covered, anchor: coveredAnchor } = priorGaps
    .filter((g) => thisPeriod(g) && g.state !== "pending")
    .reduce((best, g) => (g.to.getTime() > best.at.getTime() ? { at: g.to, anchor: g.toAnchorDay } : best), { at: base, anchor: baseAnchor });

  // The new billing day in the month coverage ends, never at or before today or the last run.
  const floor = Math.max(startOfLocalDay(now, timezone).getTime() - 1, before.lastRunAt?.getTime() ?? -Infinity);
  let next = computeFirstRunAt({ startAt: monthStart(covered, timezone), cadence: after.cadence, anchorDay: after.anchorDay, timezone });
  while (next.getTime() <= floor) {
    next = computeNextRunAt({ previous: next, cadence: after.cadence, anchorDay: after.anchorDay, timezone });
  }

  // A later edit recomputes this period's unraised gaps and untaken credits;
  // everything else (raised, taken, or owed from an earlier period) stands.
  const gaps = history(priorGaps.filter((g) => !(thisPeriod(g) && g.state === "pending")), (g) => g.state === "raised");
  const credits = history((prior?.credits ?? []).filter((c) => !(thisPeriod(c) && c.cycle === null)), (c) => c.cycle !== null);
  const record: ProrationRecord = { forLastDueAt: before.lastDueAt, coveredUntil: base, coveredAnchorDay: baseAnchor, credits, gaps };
  if (next.getTime() === covered.getTime()) return { record, next };

  const isGap = next.getTime() > covered.getTime();
  const [from, to] = isGap ? [covered, next] : [next, covered];
  const cycleEnd = computeNextRunAt({
    previous: from,
    cadence: after.cadence,
    anchorDay: isGap ? coveredAnchor : after.anchorDay,
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
      toAnchorDay: after.anchorDay,
      failureAlerted: false,
    };
    return { record: { ...record, gaps: [...gaps, gap] }, next };
  }
  const credit = { ...period, label: `Pro-rated credit: ${range} (billing day changed)`, appliesToDueAt: next, cycle: null, forLastDueAt: before.lastDueAt };
  return { record: { ...record, credits: [...credits, credit] }, next };
}

/** Keeps every item still in play, and the last few finished ones as history. */
function history<T>(items: T[], done: (item: T) => boolean): T[] {
  const kept = items.filter(done).slice(-HISTORY_KEPT);
  return items.filter((item) => !done(item) || kept.includes(item));
}

/** The one-off gap invoice's money: one line, the template's tax, no discount. */
export function gapInvoiceTemplate(gap: ProratedPeriod, template: Template): Template {
  return {
    lineItems: [{ id: "prorate", description: gap.label, quantity: 1, unitPrice: gap.taxable, productId: null }],
    globalDiscount: null,
    globalTaxPercent: template.globalTaxPercent,
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

