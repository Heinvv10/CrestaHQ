import { utcFromWallClock } from "@/lib/booking/availability";
import { daysInMonth, type Cadence, type CadenceUnit } from "@/lib/recurring/cadence";
import type {
  RecurringChargeMode,
  RecurringInvoiceEndMode,
  RecurringInvoiceStatus,
} from "@/types/recurring-invoices";

/**
 * What a single schedule field is allowed to contain.
 *
 * Split from `schedule-input.ts`, which composes these into a whole valid
 * submission: this file answers "is that a cadence?", that one answers "is
 * that a schedule?".
 */

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const CADENCE_UNITS: CadenceUnit[] = ["week", "month", "quarter", "year"];
const END_MODES: RecurringInvoiceEndMode[] = ["never", "on_date", "after_count"];

/** Ceiling on `cadence.interval`. Beyond a year of weeks it is a typo. */
const MAX_INTERVAL = 52;
/** Ceiling on `unpaidEscalationThreshold`; 0 disables escalation entirely. */
const MAX_ESCALATION_THRESHOLD = 50;

export interface Ending {
  endMode: RecurringInvoiceEndMode;
  endAt: Date | null;
  maxCycles: number | null;
}

export function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

export function parseName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, 120);
  return trimmed || null;
}

export function parseCadence(value: unknown): Cadence | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { unit?: unknown; interval?: unknown };
  if (!CADENCE_UNITS.includes(raw.unit as CadenceUnit)) return null;
  const interval = Math.trunc(Number(raw.interval));
  if (!Number.isFinite(interval) || interval < 1 || interval > MAX_INTERVAL) {
    return null;
  }
  return { unit: raw.unit as CadenceUnit, interval };
}

/** An IANA zone the runtime actually knows, else null. */
export function parseTimezone(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return value;
  } catch {
    return null;
  }
}

/** `yyyy-mm-dd` read as local midnight in `timezone`. */
export function parseLocalDate(value: unknown, timezone: string): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const [year, month, day] = value.split("-").map(Number);
  // Reject 2026-02-31 rather than let the Date constructor roll it into March.
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return null;
  }
  const at = utcFromWallClock(year, month, day, 0, timezone);
  return Number.isNaN(at.getTime()) ? null : at;
}

export function parseThreshold(value: unknown): number {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < 0) return 2;
  return Math.min(MAX_ESCALATION_THRESHOLD, n);
}

/**
 * Only the transitions an operator may drive.
 *
 * `completed` is the engine's word, never the operator's: it means the end
 * condition was met, and letting a form assert it would let a schedule claim
 * a history it does not have. `cancelled` is terminal by design — restarting
 * billing after a cancellation is a new agreement, so it is a new schedule.
 */
export function parseStatusChange(
  value: unknown,
  current: RecurringInvoiceStatus,
): ParseResult<RecurringInvoiceStatus> {
  if (value !== "active" && value !== "paused" && value !== "cancelled") {
    return fail("Status must be active, paused or cancelled.");
  }
  if (current === "completed" || current === "cancelled") {
    return fail(`A ${current} schedule cannot be changed.`);
  }
  return { ok: true, value };
}

export function parseEnding(
  body: { endMode?: unknown; endDateString?: unknown; maxCycles?: unknown },
  timezone: string,
): ParseResult<Ending> {
  const endMode = END_MODES.includes(body.endMode as RecurringInvoiceEndMode)
    ? (body.endMode as RecurringInvoiceEndMode)
    : "never";

  if (endMode === "on_date") {
    const endAt = parseLocalDate(body.endDateString, timezone);
    if (!endAt) return fail("End date must be a yyyy-mm-dd date.");
    return { ok: true, value: { endMode, endAt, maxCycles: null } };
  }

  if (endMode === "after_count") {
    const maxCycles = Math.trunc(Number(body.maxCycles));
    if (!Number.isFinite(maxCycles) || maxCycles < 1) {
      return fail("Number of invoices must be 1 or more.");
    }
    return {
      ok: true,
      value: { endMode, endAt: null, maxCycles: Math.min(1_000, maxCycles) },
    };
  }

  return { ok: true, value: { endMode: "never", endAt: null, maxCycles: null } };
}

/**
 * Whether the template would actually invoice for something.
 *
 * A count of line items is not enough: the sanitiser turns `{}` into a valid
 * empty item, so an all-blank template passes a length check and then mails
 * the customer a nil invoice every cycle for as long as the schedule lives. A
 * hand-made invoice at least gets looked at once before it goes out.
 */
export function hasBillableLineItem<
  T extends { description: string; quantity: number; unitPrice: number },
>(items: T[] | undefined): items is T[] {
  return (
    !!items &&
    items.some(
      (item) => item.description.trim() !== "" || item.quantity * item.unitPrice > 0,
    )
  );
}

/**
 * How each cycle asks for the money, judged against the schedule's other
 * settings as they will be after the save. Absent keeps `current`. A card
 * cycle charges unattended, so it cannot wait for a review; saved cards are
 * charged in ZAR only.
 */
export function parseChargeMode(
  value: unknown,
  current: RecurringChargeMode,
  settings: { reviewFirst: boolean; currency: string },
): ParseResult<RecurringChargeMode> {
  if (value !== undefined && value !== "invoice" && value !== "card") {
    return fail("Charge mode must be invoice or card.");
  }
  const mode = value ?? current;
  if (mode === "card" && settings.reviewFirst) {
    return fail("A schedule that charges the saved card cannot wait for review. Turn off review, or bill by invoice.");
  }
  if (mode === "card" && settings.currency.toUpperCase() !== "ZAR") {
    return fail("Only ZAR schedules can charge a saved card.");
  }
  return { ok: true, value: mode };
}

/**
 * Where a moved cadence or anchor restarts from. A card schedule charges
 * unattended, so its new billing day never lands before the run already
 * scheduled: moving the anchor from the 1st to the 5th the day after a charge
 * would otherwise charge the card twice in one month.
 */
export function cadenceRestart(now: Date, scheduled: Date | null, chargeMode: unknown): Date {
  return chargeMode === "card" && scheduled && scheduled.getTime() > now.getTime() ? scheduled : now;
}
