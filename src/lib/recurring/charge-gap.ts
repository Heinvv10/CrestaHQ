import type { Cadence } from "@/lib/recurring/cadence";

const DAY = 86_400_000;
const MONTHS: Record<Exclude<Cadence["unit"], "week">, number> = { month: 1, quarter: 3, year: 12 };

/**
 * The least time that may pass between two card charges on one schedule: its
 * cadence period, less a tolerance for month-end clamps (31 Jan → 28 Feb) and
 * a sweep that runs a little late one day and on time the next. Month-based:
 * months × 28 days − 2 days. Weekly: interval × 7 days − 12 hours.
 *
 * Checked when the card is charged, not when the schedule is edited, so no
 * edit — anchor, cadence, or a flip through invoice mode — can charge a
 * customer twice in one period, and no edit has to skip a period to avoid it.
 */
export function minCardChargeGapMs(cadence: Cadence): number {
  const interval = Math.max(1, Math.trunc(cadence.interval));
  if (cadence.unit === "week") return interval * 7 * DAY - DAY / 2;
  return interval * MONTHS[cadence.unit] * 28 * DAY - 2 * DAY;
}
