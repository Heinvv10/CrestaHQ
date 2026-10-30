import { utcFromWallClock } from "@/lib/booking/availability";
import { computeFirstRunAt, type CadenceUnit } from "@/lib/recurring/cadence";
import type {
  RecurringChargeMode,
  RecurringInvoiceEndMode,
} from "@/types/recurring-invoices";

/**
 * The cadence form's own shape, and the pure functions around it: what a
 * blank schedule looks like, what date it would first bill on, and what the
 * create route expects to receive.
 *
 * Separate from the component so the arithmetic an operator is trusting —
 * "first invoice on the 28th" — is testable without rendering anything.
 */

export interface ScheduleFormValues {
  name: string;
  cadenceUnit: CadenceUnit;
  cadenceInterval: number;
  /** yyyy-mm-dd. Read as local midnight in `timezone`. */
  startDateString: string;
  timezone: string;
  endMode: RecurringInvoiceEndMode;
  endDateString: string;
  maxCycles: number;
  reviewFirst: boolean;
  chargeMode: RecurringChargeMode;
  unpaidEscalationThreshold: number;
}

export function defaultScheduleValues(timezone: string): ScheduleFormValues {
  return {
    name: "",
    cadenceUnit: "month",
    cadenceInterval: 1,
    startDateString: todayIn(timezone),
    timezone,
    endMode: "never",
    endDateString: "",
    maxCycles: 12,
    reviewFirst: false,
    chargeMode: "invoice",
    unpaidEscalationThreshold: 2,
  };
}

/** Today's date in `timezone`, as yyyy-mm-dd for a native date input. */
export function todayIn(timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/**
 * The date the first invoice will actually be raised, run through the same
 * function the server uses — so a start date whose anchor has already passed
 * shows next month here rather than surprising the operator later.
 */
export function previewFirstRun(values: ScheduleFormValues): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.startDateString)) return null;
  try {
    const [year, month, day] = values.startDateString.split("-").map(Number);
    const startAt = utcFromWallClock(year, month, day, 0, values.timezone);
    const at = computeFirstRunAt({
      startAt,
      cadence: {
        unit: values.cadenceUnit,
        interval: Math.max(1, values.cadenceInterval),
      },
      anchorDay: values.cadenceUnit === "week" ? null : day,
      timezone: values.timezone,
    });
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: values.timezone,
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(at);
  } catch {
    return null;
  }
}

/** The schedule half of the create payload, in the shape the route parses. */
export function schedulePayload(schedule: ScheduleFormValues) {
  return {
    name: schedule.name,
    cadence: {
      unit: schedule.cadenceUnit,
      interval: schedule.cadenceInterval,
    },
    startDateString: schedule.startDateString,
    timezone: schedule.timezone,
    endMode: schedule.endMode,
    endDateString: schedule.endDateString || null,
    maxCycles: schedule.maxCycles,
    reviewFirst: schedule.reviewFirst,
    chargeMode: schedule.chargeMode,
    unpaidEscalationThreshold: schedule.unpaidEscalationThreshold,
  };
}

/**
 * Seconds out of a Firestore timestamp that has crossed a JSON boundary.
 *
 * The admin SDK serialises to `_seconds`; the client SDK to `seconds`. One
 * place knows that, so a third shape appearing later is one fix rather than a
 * hunt through every surface that renders a date.
 */
export function timestampSeconds(value: unknown): number | null {
  const raw = value as { _seconds?: number; seconds?: number } | null;
  const seconds = raw?._seconds ?? raw?.seconds;
  return typeof seconds === "number" ? seconds : null;
}
