import { utcFromWallClock } from "@/lib/booking/availability";

/**
 * When a recurring invoice's next cycle falls due.
 *
 * All arithmetic happens in the schedule's own IANA timezone: "bill on the
 * 1st" has to mean the 1st where the business is, not wherever the server
 * runs. The result is an absolute instant, so the cron only ever compares
 * `nextRunAt <= now` and never has to know about timezones.
 *
 * A cycle falls due at local midnight of its day and is raised by whichever
 * daily sweep runs next — an invoice goes out on its day, not to the minute.
 *
 * The DST-correct wall-clock→UTC conversion is reused from the booking module
 * rather than reimplemented; there should be exactly one of those in the repo.
 */

export type CadenceUnit = "week" | "month" | "quarter" | "year";

export interface Cadence {
  unit: CadenceUnit;
  /** How many units between cycles. 1 = every month, 3 = every third month. */
  interval: number;
}

/** Months per cadence unit. `week` is handled separately, in days. */
const MONTHS_PER_UNIT: Record<Exclude<CadenceUnit, "week">, number> = {
  month: 1,
  quarter: 3,
  year: 12,
};

/**
 * The cycle after `previous`.
 *
 * For month-based cadences the day comes from `anchorDay` EVERY time, clamped
 * to the target month's length — never from the previous cycle's already
 * clamped day. That distinction is the whole point: a schedule anchored to the
 * 31st runs 31 Jan → 28 Feb → 31 Mar. Carrying the clamp forward instead gives
 * 31 Jan → 28 Feb → 28 Mar, and one February costs the schedule its month-end
 * anchor permanently.
 */
export function computeNextRunAt(input: {
  /** The cycle just run — or the schedule's start, for the first one. */
  previous: Date;
  cadence: Cadence;
  /** Day of month 1-31 for month-based cadences; ignored for `week`. */
  anchorDay: number | null;
  timezone: string;
}): Date {
  const { cadence, timezone } = input;
  const interval = Math.max(1, Math.trunc(cadence.interval));
  const local = localDateInTz(input.previous, timezone);

  if (cadence.unit === "week") {
    // Weeks need no anchor: adding whole weeks keeps the weekday by itself,
    // and there is no short month to clamp against.
    return localMidnight(addDays(local, interval * 7), timezone);
  }

  const step = MONTHS_PER_UNIT[cadence.unit] * interval;
  // Month arithmetic runs on the previous cycle's YEAR-MONTH, which clamping
  // never touched; only the day is re-derived from the anchor.
  const targetMonthIndex = local.month - 1 + step;
  const year = local.year + Math.floor(targetMonthIndex / 12);
  const month = (targetMonthIndex % 12) + 1;
  const anchor = normalizeAnchorDay(input.anchorDay ?? local.day);
  return localMidnight(
    { year, month, day: clampDay(year, month, anchor) },
    timezone,
  );
}

/**
 * The first cycle of a new schedule: the earliest anchored day at or after
 * `startAt`.
 *
 * A schedule created on the 10th and anchored to the 1st bills on the 1st of
 * next month, not immediately — the operator picked a billing day, and raising
 * an off-cycle invoice on day one would bill the customer twice that period.
 */
export function computeFirstRunAt(input: {
  startAt: Date;
  cadence: Cadence;
  anchorDay: number | null;
  timezone: string;
}): Date {
  const { cadence, timezone } = input;
  const local = localDateInTz(input.startAt, timezone);

  // Weeks start on the start date itself; there is no anchor to wait for.
  if (cadence.unit === "week") return localMidnight(local, timezone);

  const anchor = normalizeAnchorDay(input.anchorDay ?? local.day);
  const thisMonth = clampDay(local.year, local.month, anchor);
  if (thisMonth >= local.day) {
    return localMidnight(
      { year: local.year, month: local.month, day: thisMonth },
      timezone,
    );
  }
  // The anchor has already passed this month — step one whole CADENCE forward,
  // so a quarterly schedule does not silently become monthly.
  return computeNextRunAt({
    previous: input.startAt,
    cadence,
    anchorDay: anchor,
    timezone,
  });
}

/** Local midnight of the day `instant` falls on, in the schedule's zone. */
export function startOfLocalDay(instant: Date, timezone: string): Date {
  return localMidnight(localDateInTz(instant, timezone), timezone);
}

/** Day of month a schedule anchors to, or null for week cadences. */
export function resolveAnchorDay(
  cadence: Cadence,
  startAt: Date,
  timezone: string,
): number | null {
  if (cadence.unit === "week") return null;
  return localDateInTz(startAt, timezone).day;
}

/** 1-31, so a stored 0 or 99 cannot silently move a schedule's billing day. */
export function normalizeAnchorDay(day: number): number {
  if (!Number.isFinite(day)) return 1;
  return Math.min(31, Math.max(1, Math.trunc(day)));
}

/** Days in a month, with leap years handled by the Date constructor itself. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

interface LocalDate {
  year: number;
  month: number; // 1-12
  day: number;
}

function clampDay(year: number, month: number, anchorDay: number): number {
  return Math.min(anchorDay, daysInMonth(year, month));
}

function addDays(local: LocalDate, days: number): LocalDate {
  const d = new Date(Date.UTC(local.year, local.month - 1, local.day));
  d.setUTCDate(d.getUTCDate() + days);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

function localMidnight(local: LocalDate, timezone: string): Date {
  return utcFromWallClock(local.year, local.month, local.day, 0, timezone);
}

/** The calendar date an instant falls on, in the schedule's timezone. */
function localDateInTz(instant: Date, timezone: string): LocalDate {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  return { year: get("year"), month: get("month"), day: get("day") };
}
