import {
  computeFirstRunAt,
  normalizeAnchorDay,
  resolveAnchorDay,
  type Cadence,
} from "@/lib/recurring/cadence";
import {
  fail,
  parseCadence,
  parseEnding,
  parseLocalDate,
  parseName,
  parseStatusChange,
  parseThreshold,
  parseTimezone,
  type ParseResult,
} from "@/lib/recurring/schedule-fields";
import {
  sanitizeQuoteTemplate,
  type QuoteTemplateInput,
} from "@/lib/quotes/sanitize";
import type {
  RecurringInvoiceEndMode,
  RecurringInvoiceStatus,
} from "@/types/recurring-invoices";

/**
 * Turning an operator's form submission into schedule fields.
 *
 * Pure on purpose — no Firestore, no `server-only` — because the rules worth
 * testing here are arithmetic and refusal, and both are cheaper to pin
 * without a database. The routes own tenancy, persistence and timestamps;
 * this owns what a valid schedule looks like.
 *
 * Dates arrive as `yyyy-mm-dd` and are read as local midnight in the
 * schedule's own timezone, because that is what the cadence module then bills
 * against: a schedule starting "1 March" starts on the 1st where the business
 * is, not wherever the server happens to run.
 */

/** Everything a create writes beyond tenancy and run state. */
export interface ScheduleCreateFields {
  name: string;
  cadence: Cadence;
  anchorDay: number | null;
  timezone: string;
  startAt: Date;
  nextRunAt: Date;
  endMode: RecurringInvoiceEndMode;
  endAt: Date | null;
  maxCycles: number | null;
  reviewFirst: boolean;
  unpaidEscalationThreshold: number;
  currency: string;
  lineItems: ReturnType<typeof sanitizeQuoteTemplate>["lineItems"];
  globalDiscount: NonNullable<
    ReturnType<typeof sanitizeQuoteTemplate>["globalDiscount"]
  > | null;
  globalTaxPercent: number | null;
  termsAndNotes: string;
  billedToOrganization: string | null;
  billingAddress: string | null;
  paymentDueDays: number | null;
}

export interface ScheduleInputBody extends QuoteTemplateInput {
  name?: unknown;
  cadence?: unknown;
  anchorDay?: unknown;
  timezone?: unknown;
  startDateString?: unknown;
  endMode?: unknown;
  endDateString?: unknown;
  maxCycles?: unknown;
  reviewFirst?: unknown;
  unpaidEscalationThreshold?: unknown;
  status?: unknown;
  [key: string]: unknown;
}

/**
 * Validate a create payload.
 *
 * `fallbackTimezone` is the sub-account's own zone, used when the operator
 * did not pick one — the route reads it, so this stays pure.
 */
export function parseScheduleCreate(
  body: ScheduleInputBody,
  fallbackTimezone: string,
): ParseResult<ScheduleCreateFields> {
  const name = parseName(body.name);
  if (!name) return fail("A schedule name is required.");

  const cadence = parseCadence(body.cadence);
  if (!cadence) return fail("Pick a cadence of week, month, quarter or year.");

  const timezone = parseTimezone(body.timezone) ?? parseTimezone(fallbackTimezone) ?? "UTC";

  const startAt = parseLocalDate(body.startDateString, timezone);
  if (!startAt) return fail("Start date must be a yyyy-mm-dd date.");

  const anchorDay =
    cadence.unit === "week"
      ? null
      : typeof body.anchorDay === "number" && Number.isFinite(body.anchorDay)
        ? normalizeAnchorDay(body.anchorDay)
        : resolveAnchorDay(cadence, startAt, timezone);

  const ending = parseEnding(body, timezone);
  if (!ending.ok) return ending;

  const template = sanitizeQuoteTemplate(body);
  if (!template.lineItems || template.lineItems.length === 0) {
    return fail("Add at least one line item before saving the schedule.");
  }

  const nextRunAt = computeFirstRunAt({ startAt, cadence, anchorDay, timezone });

  // An end date the first cycle already sits past is a schedule that would be
  // born completed. Refuse it here rather than write one that never bills.
  if (ending.value.endAt && nextRunAt.getTime() > ending.value.endAt.getTime()) {
    return fail("The end date falls before the first billing date.");
  }

  return {
    ok: true,
    value: {
      name,
      cadence,
      anchorDay,
      timezone,
      startAt,
      nextRunAt,
      endMode: ending.value.endMode,
      endAt: ending.value.endAt,
      maxCycles: ending.value.maxCycles,
      reviewFirst: body.reviewFirst === true,
      unpaidEscalationThreshold: parseThreshold(body.unpaidEscalationThreshold),
      currency: template.currency ?? "USD",
      lineItems: template.lineItems,
      globalDiscount: template.globalDiscount ?? null,
      globalTaxPercent: template.globalTaxPercent ?? null,
      termsAndNotes: template.termsAndNotes ?? "",
      billedToOrganization: template.billedToOrganization ?? null,
      billingAddress: template.billingAddress ?? null,
      paymentDueDays: template.paymentDueDays ?? null,
    },
  };
}

/** What a PATCH may change. Absent keys stay absent so nothing is blanked. */
export interface ScheduleUpdateFields {
  name?: string;
  status?: RecurringInvoiceStatus;
  cadence?: Cadence;
  anchorDay?: number | null;
  endMode?: RecurringInvoiceEndMode;
  endAt?: Date | null;
  maxCycles?: number | null;
  reviewFirst?: boolean;
  unpaidEscalationThreshold?: number;
  currency?: string;
  lineItems?: ScheduleCreateFields["lineItems"];
  globalDiscount?: ScheduleCreateFields["globalDiscount"];
  globalTaxPercent?: number | null;
  termsAndNotes?: string;
  billedToOrganization?: string | null;
  billingAddress?: string | null;
  paymentDueDays?: number | null;
  /**
   * Set only when the cadence or the anchor moved: the stored `nextRunAt` was
   * computed from the OLD cadence, so leaving it would bill the next cycle on
   * a day the operator has just changed away from. Recomputed from today, so
   * an edit can never pull a cycle earlier than the day it was made.
   */
  recomputeNextRunFrom?: Date;
}

export function parseScheduleUpdate(
  body: ScheduleInputBody,
  current: {
    cadence: Cadence;
    anchorDay: number | null;
    timezone: string;
    status: RecurringInvoiceStatus;
  },
  now: Date,
): ParseResult<ScheduleUpdateFields> {
  const out: ScheduleUpdateFields = {};

  if (body.name !== undefined) {
    const name = parseName(body.name);
    if (!name) return fail("A schedule name is required.");
    out.name = name;
  }

  if (body.status !== undefined) {
    const status = parseStatusChange(body.status, current.status);
    if (!status.ok) return status;
    out.status = status.value;
  }

  let cadence = current.cadence;
  let cadenceMoved = false;
  if (body.cadence !== undefined) {
    const parsed = parseCadence(body.cadence);
    if (!parsed) return fail("Pick a cadence of week, month, quarter or year.");
    if (parsed.unit !== cadence.unit || parsed.interval !== cadence.interval) {
      cadenceMoved = true;
    }
    cadence = parsed;
    out.cadence = parsed;
  }

  if (body.anchorDay !== undefined || cadenceMoved) {
    const anchorDay =
      cadence.unit === "week"
        ? null
        : typeof body.anchorDay === "number" && Number.isFinite(body.anchorDay)
          ? normalizeAnchorDay(body.anchorDay)
          : (current.anchorDay ??
            resolveAnchorDay(cadence, now, current.timezone));
    if (anchorDay !== current.anchorDay) cadenceMoved = true;
    out.anchorDay = anchorDay;
  }

  if (
    body.endMode !== undefined ||
    body.endDateString !== undefined ||
    body.maxCycles !== undefined
  ) {
    const ending = parseEnding(body, current.timezone);
    if (!ending.ok) return ending;
    out.endMode = ending.value.endMode;
    out.endAt = ending.value.endAt;
    out.maxCycles = ending.value.maxCycles;
  }

  if (body.reviewFirst !== undefined) out.reviewFirst = body.reviewFirst === true;
  if (body.unpaidEscalationThreshold !== undefined) {
    out.unpaidEscalationThreshold = parseThreshold(
      body.unpaidEscalationThreshold,
    );
  }

  const template = sanitizeQuoteTemplate(body);
  if (template.lineItems && template.lineItems.length === 0) {
    return fail("A schedule must keep at least one line item.");
  }
  Object.assign(out, template);

  if (cadenceMoved) {
    out.recomputeNextRunFrom = computeFirstRunAt({
      startAt: now,
      cadence,
      anchorDay: out.anchorDay ?? current.anchorDay,
      timezone: current.timezone,
    });
  }

  return { ok: true, value: out };
}
