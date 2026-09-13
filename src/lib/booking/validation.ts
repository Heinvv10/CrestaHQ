import "server-only";

import {
  DEFAULT_MIN_NOTICE_HOURS,
  DEFAULT_PAYMENT_HOLD_HOURS,
  DEFAULT_REMINDER_OFFSETS_MINUTES,
  DEFAULT_VISIBLE_DAYS,
  type BookingHost,
  type BookingPageFormData,
  type BookingPayment,
  type BookingService,
  type CalendarType,
  type DateOverride,
  type IntakeField,
  type WorkingHour,
} from "@/types/booking";

/**
 * Server-side validation + normalisation for the booking-page CRUD
 * routes. Each `validate*` function returns `{ ok: true, value }` with
 * the cleaned shape, or `{ ok: false, error }` with a single
 * operator-facing message. Routes surface the error message via 400.
 *
 * Doing all coercion + bounds-checks here keeps the route handlers
 * tight and ensures the persisted shape matches the TypeScript type
 * exactly — Firestore is schemaless, so this file IS the schema check.
 */

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

// ── Allowed slot durations (matches GHL's common set + a couple extras) ──
const ALLOWED_DURATIONS = new Set([15, 30, 45, 60, 75, 90, 120]);
const ALLOWED_BUFFERS = new Set([0, 5, 10, 15, 30, 45, 60]);

// ── Currency: aligned with the existing edit-deal-dialog picker ──
export const BOOKING_CURRENCIES = ["USD", "AUD", "EUR", "GBP", "CAD"] as const;
const CURRENCY_SET = new Set<string>(BOOKING_CURRENCIES);

// ── Slug rules: lowercase kebab-case, must start + end with alphanumeric ──
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

// Reserved slugs that would shadow internal routes or look broken.
const RESERVED_SLUGS = new Set(["new", "edit", "settings", "api", ""]);

export function validateSlug(input: unknown): Validated<string> {
  if (typeof input !== "string") {
    return { ok: false, error: "Slug is required." };
  }
  const slug = input.trim().toLowerCase();
  if (!SLUG_RE.test(slug)) {
    return {
      ok: false,
      error:
        "Slug must be 1–48 characters: lowercase letters, numbers, and hyphens. Can't start or end with a hyphen.",
    };
  }
  if (RESERVED_SLUGS.has(slug)) {
    return { ok: false, error: `"${slug}" is a reserved slug. Pick another.` };
  }
  return { ok: true, value: slug };
}

export function validateName(input: unknown): Validated<string> {
  if (typeof input !== "string") {
    return { ok: false, error: "Name is required." };
  }
  const name = input.trim();
  if (name.length < 1 || name.length > 80) {
    return { ok: false, error: "Name must be 1–80 characters." };
  }
  return { ok: true, value: name };
}

export function validateDescription(input: unknown): Validated<string> {
  // Markdown body shown on the public page. Optional; cap to keep
  // Firestore docs reasonable + render predictable.
  if (input == null) return { ok: true, value: "" };
  if (typeof input !== "string") {
    return { ok: false, error: "Description must be text." };
  }
  if (input.length > 2000) {
    return { ok: false, error: "Description is too long (max 2000 chars)." };
  }
  return { ok: true, value: input };
}

export function validateStatus(
  input: unknown,
): Validated<"draft" | "published"> {
  if (input === "draft" || input === "published") {
    return { ok: true, value: input };
  }
  return { ok: false, error: "Status must be draft or published." };
}

export function validateDuration(input: unknown): Validated<number> {
  const n = typeof input === "number" ? input : Number(input);
  if (!Number.isFinite(n) || !ALLOWED_DURATIONS.has(n)) {
    return {
      ok: false,
      error: `Duration must be one of: ${[...ALLOWED_DURATIONS].join(", ")} minutes.`,
    };
  }
  return { ok: true, value: n };
}

export function validateBuffer(input: unknown): Validated<number> {
  const n = typeof input === "number" ? input : Number(input);
  if (!Number.isFinite(n) || !ALLOWED_BUFFERS.has(n)) {
    return {
      ok: false,
      error: `Buffer must be one of: ${[...ALLOWED_BUFFERS].join(", ")} minutes.`,
    };
  }
  return { ok: true, value: n };
}

/**
 * Validate the weekly schedule. Each range is within 0–1440, start <
 * end, and ranges on the same day are non-overlapping. Sorted on output
 * so the availability calculator can walk left-to-right without
 * re-sorting.
 */
export function validateWorkingHours(
  input: unknown,
): Validated<WorkingHour[]> {
  if (!Array.isArray(input)) {
    return { ok: false, error: "Working hours must be a list." };
  }
  const cleaned: WorkingHour[] = [];
  for (const raw of input) {
    if (typeof raw !== "object" || raw === null) {
      return { ok: false, error: "Each working-hour entry must be an object." };
    }
    const r = raw as Record<string, unknown>;
    const day = Number(r.dayOfWeek);
    const start = Number(r.startMinute);
    const end = Number(r.endMinute);
    if (
      !Number.isInteger(day) ||
      day < 0 ||
      day > 6 ||
      !Number.isInteger(start) ||
      start < 0 ||
      start > 1440 ||
      !Number.isInteger(end) ||
      end < 0 ||
      end > 1440
    ) {
      return {
        ok: false,
        error:
          "Working-hour values must be integers: dayOfWeek 0–6, startMinute and endMinute 0–1440.",
      };
    }
    if (start >= end) {
      return {
        ok: false,
        error: "Each working-hour range must have startMinute < endMinute.",
      };
    }
    cleaned.push({
      dayOfWeek: day as WorkingHour["dayOfWeek"],
      startMinute: start,
      endMinute: end,
    });
  }

  // Overlap check per day. Sort by start, then ensure adjacent pairs
  // don't intersect. Sorting also produces the canonical persisted order.
  cleaned.sort((a, b) =>
    a.dayOfWeek === b.dayOfWeek
      ? a.startMinute - b.startMinute
      : a.dayOfWeek - b.dayOfWeek,
  );
  for (let i = 1; i < cleaned.length; i++) {
    const prev = cleaned[i - 1];
    const curr = cleaned[i];
    if (prev.dayOfWeek === curr.dayOfWeek && prev.endMinute > curr.startMinute) {
      return {
        ok: false,
        error: "Working-hour ranges on the same day can't overlap.",
      };
    }
  }
  return { ok: true, value: cleaned };
}

export const MAX_DATE_OVERRIDES = 366;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Date-specific hours: unique real calendar dates, each with sane
 * non-overlapping ranges (validated like one weekday of working hours).
 * Empty ranges = closed that date. Past dates are kept; the list is capped.
 */
export function validateDateOverrides(input: unknown): Validated<DateOverride[]> {
  if (input === undefined || input === null) return { ok: true, value: [] };
  if (!Array.isArray(input)) {
    return { ok: false, error: "Date-specific hours must be a list." };
  }
  if (input.length > MAX_DATE_OVERRIDES) {
    return { ok: false, error: `At most ${MAX_DATE_OVERRIDES} date-specific entries.` };
  }
  const out: DateOverride[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const date = typeof r.date === "string" ? r.date : "";
    const m = DATE_RE.exec(date);
    const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
    if (!d || d.toISOString().slice(0, 10) !== date) {
      return { ok: false, error: "Each date-specific entry needs a real date (YYYY-MM-DD)." };
    }
    if (seen.has(date)) {
      return { ok: false, error: `${date} is listed twice in date-specific hours.` };
    }
    seen.add(date);
    if (!Array.isArray(r.ranges)) {
      return { ok: false, error: `${date}: ranges must be a list (empty = closed).` };
    }
    const hours = validateWorkingHours(
      r.ranges.map((x) => ({ ...(x as object), dayOfWeek: 0 })),
    );
    if (!hours.ok) return { ok: false, error: `${date}: ${hours.error}` };
    out.push({
      date,
      ranges: hours.value.map(({ startMinute, endMinute }) => ({ startMinute, endMinute })),
    });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return { ok: true, value: out };
}

/** Null/absent ⇒ legacy step (duration + buffer). */
export function validateSlotInterval(input: unknown): Validated<number | null> {
  if (input === undefined || input === null || input === "") return { ok: true, value: null };
  const n = typeof input === "number" ? input : Number(input);
  if (!Number.isInteger(n) || n < 5 || n > 240 || n % 5 !== 0) {
    return { ok: false, error: "Slot interval must be 5–240 minutes, in steps of 5." };
  }
  return { ok: true, value: n };
}

/**
 * Validate the IANA timezone. We rely on the runtime's tz database via
 * `Intl.DateTimeFormat` — any string the runtime accepts is good
 * enough; this matches how slot computation will format times.
 */
export function validateTimezone(input: unknown): Validated<string> {
  if (typeof input !== "string" || input.length === 0) {
    return { ok: false, error: "Timezone is required." };
  }
  try {
    // Throws RangeError for unknown zones.
    new Intl.DateTimeFormat("en-US", { timeZone: input });
    return { ok: true, value: input };
  } catch {
    return { ok: false, error: `"${input}" isn't a recognised timezone.` };
  }
}

export function validateVisibleDays(input: unknown): Validated<number> {
  const n =
    input === undefined || input === null
      ? DEFAULT_VISIBLE_DAYS
      : typeof input === "number"
        ? input
        : Number(input);
  if (!Number.isInteger(n) || n < 1 || n > 90) {
    return {
      ok: false,
      error: "Visible days must be a whole number between 1 and 90.",
    };
  }
  return { ok: true, value: n };
}

export function validateMinNoticeHours(input: unknown): Validated<number> {
  const n =
    input === undefined || input === null
      ? DEFAULT_MIN_NOTICE_HOURS
      : typeof input === "number"
        ? input
        : Number(input);
  if (!Number.isInteger(n) || n < 0 || n > 168) {
    return {
      ok: false,
      error: "Minimum notice must be a whole number of hours (0–168).",
    };
  }
  return { ok: true, value: n };
}

export function validateMaxPerDay(input: unknown): Validated<number | null> {
  if (input == null || input === "") return { ok: true, value: null };
  const n = typeof input === "number" ? input : Number(input);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    return {
      ok: false,
      error: "Max per day must be a whole number 1–100, or leave blank.",
    };
  }
  return { ok: true, value: n };
}

const INTAKE_FIELD_TYPES = new Set(["text", "textarea", "select"] as const);

// WARNING: this rebuilds every field from an explicit property list — nothing
// is spread from the raw input. Any new property added to IntakeField is
// silently dropped on save unless it is also extracted and pushed here.
export function validateIntakeFields(
  input: unknown,
): Validated<IntakeField[]> {
  if (input === undefined || input === null) return { ok: true, value: [] };
  if (!Array.isArray(input)) {
    return { ok: false, error: "Intake fields must be a list." };
  }
  if (input.length > 10) {
    return {
      ok: false,
      error: "At most 10 intake fields. Keep the form short to lift completions.",
    };
  }
  const cleaned: IntakeField[] = [];
  const idsSeen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== "object" || raw === null) {
      return { ok: false, error: "Each intake field must be an object." };
    }
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id.trim() : "";
    const label = typeof r.label === "string" ? r.label.trim() : "";
    const type = typeof r.type === "string" ? r.type : "";
    const required = r.required === true;
    if (!id || !/^[a-z0-9_]{1,40}$/i.test(id)) {
      return {
        ok: false,
        error:
          "Each intake field needs an id (letters, numbers, underscores, ≤40 chars).",
      };
    }
    if (idsSeen.has(id)) {
      return { ok: false, error: `Duplicate intake field id "${id}".` };
    }
    idsSeen.add(id);
    if (!label || label.length > 120) {
      return {
        ok: false,
        error: `Field "${id}" needs a label (1–120 chars).`,
      };
    }
    if (!INTAKE_FIELD_TYPES.has(type as IntakeField["type"])) {
      return {
        ok: false,
        error: `Field "${id}" type must be text, textarea, or select.`,
      };
    }
    let options: string[] | null = null;
    if (type === "select") {
      if (!Array.isArray(r.options) || r.options.length === 0) {
        return {
          ok: false,
          error: `Select field "${id}" needs at least one option.`,
        };
      }
      const opts = r.options
        .map((o) => (typeof o === "string" ? o.trim() : ""))
        .filter((o) => o.length > 0);
      if (opts.length === 0) {
        return {
          ok: false,
          error: `Select field "${id}" needs at least one non-empty option.`,
        };
      }
      if (opts.length > 20) {
        return {
          ok: false,
          error: `Select field "${id}" can have at most 20 options.`,
        };
      }
      options = opts;
    }
    cleaned.push({
      id,
      label,
      type: type as IntakeField["type"],
      required,
      options,
    });
  }
  return { ok: true, value: cleaned };
}

/** Upper bound on hosts per booking page — generous; real teams are small. */
export const MAX_BOOKING_HOSTS = 20;

/**
 * Shape-validate the team host list. Membership/active checks + name
 * re-snapshotting happen in the route (they need a DB read) — see
 * `resolveBookingHosts` in `lib/booking/hosts.ts`. Here we only ensure a
 * well-formed `{ uid, name }[]`, dedupe uids, and cap the count.
 */
export function validateHosts(input: unknown): Validated<BookingHost[]> {
  if (input === undefined || input === null) return { ok: true, value: [] };
  if (!Array.isArray(input)) {
    return { ok: false, error: "Hosts must be a list." };
  }
  if (input.length > MAX_BOOKING_HOSTS) {
    return {
      ok: false,
      error: `At most ${MAX_BOOKING_HOSTS} hosts per booking page.`,
    };
  }
  const cleaned: BookingHost[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== "object" || raw === null) {
      return { ok: false, error: "Each host must be an object." };
    }
    const r = raw as Record<string, unknown>;
    const uid = typeof r.uid === "string" ? r.uid.trim() : "";
    const name = typeof r.name === "string" ? r.name.trim() : "";
    if (!uid || uid.length > 128) {
      return { ok: false, error: "Each host needs a valid member id." };
    }
    if (seen.has(uid)) continue; // silently dedupe
    seen.add(uid);
    const host: BookingHost = { uid, name: name.slice(0, 120) };
    if (r.priority !== undefined && r.priority !== null) {
      if (r.priority !== 1 && r.priority !== 2 && r.priority !== 3) {
        return {
          ok: false,
          error: `Host "${name || uid}": priority must be high, medium or low.`,
        };
      }
      host.priority = r.priority;
    }
    // Optional per-host working-hours override. Absent/empty ⇒ the host
    // inherits the page-level schedule (field omitted from the doc).
    if (r.workingHours !== undefined && r.workingHours !== null) {
      const wh = validateWorkingHours(r.workingHours);
      if (!wh.ok) {
        return { ok: false, error: `Host "${name || uid}": ${wh.error}` };
      }
      if (wh.value.length > 0) host.workingHours = wh.value;
    }
    const overrides = validateDateOverrides(r.dateOverrides);
    if (!overrides.ok) {
      return { ok: false, error: `Host "${name || uid}": ${overrides.error}` };
    }
    if (overrides.value.length > 0) host.dateOverrides = overrides.value;
    cleaned.push(host);
  }
  return { ok: true, value: cleaned };
}

/**
 * Toggle exposing named-host selection on the public page + availability API.
 * Defaults to `false` (legacy docs + omitted field) so pooled auto-assign
 * stays the default and no page starts leaking host names.
 */
export function validateAllowHostSelection(
  input: unknown,
): Validated<boolean> {
  if (input === undefined || input === null) return { ok: true, value: false };
  if (typeof input === "boolean") return { ok: true, value: input };
  return { ok: false, error: "Host-selection toggle must be true or false." };
}

const CALENDAR_TYPES = new Set<CalendarType>([
  "personal",
  "round_robin",
  "collective",
  "class",
  "service",
]);
export const MAX_SEATS_PER_SLOT = 500;
export const MAX_BOOKING_SERVICES = 20;
const SERVICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Absent ⇒ undefined: the page keeps the derived legacy type. */
export function validateCalendarType(
  input: unknown,
): Validated<CalendarType | undefined> {
  if (input === undefined || input === null) return { ok: true, value: undefined };
  if (typeof input === "string" && CALENDAR_TYPES.has(input as CalendarType)) {
    return { ok: true, value: input as CalendarType };
  }
  return { ok: false, error: "Unknown calendar type." };
}

export function validateServices(input: unknown): Validated<BookingService[]> {
  if (!Array.isArray(input) || input.length === 0) {
    return { ok: false, error: "A service page needs at least one service." };
  }
  if (input.length > MAX_BOOKING_SERVICES) {
    return {
      ok: false,
      error: `At most ${MAX_BOOKING_SERVICES} services per booking page.`,
    };
  }
  const out: BookingService[] = [];
  const ids = new Set<string>();
  for (const raw of input) {
    const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<
      string,
      unknown
    >;
    const id = typeof r.id === "string" ? r.id : "";
    const name = typeof r.name === "string" ? r.name.trim() : "";
    if (!SERVICE_ID_RE.test(id) || ids.has(id)) {
      return { ok: false, error: "Each service needs a unique id." };
    }
    ids.add(id);
    if (!name || name.length > 80) {
      return { ok: false, error: "Each service needs a name (max 80 chars)." };
    }
    const duration = validateDuration(r.durationMinutes);
    if (!duration.ok) return { ok: false, error: `Service "${name}": ${duration.error}` };
    const description =
      typeof r.description === "string" && r.description.trim()
        ? r.description.trim()
        : null;
    if (description && description.length > 500) {
      return { ok: false, error: `Service "${name}": description max 500 chars.` };
    }
    out.push({ id, name, durationMinutes: duration.value, description });
  }
  return { ok: true, value: out };
}

/**
 * Host count per type. Re-run by the routes AFTER `resolveBookingHosts`,
 * since dropping an inactive member can take a collective page below two.
 */
export function validateCalendarTypeHosts(
  type: CalendarType | undefined,
  hostCount: number,
): Validated<true> {
  if ((type === "personal" || type === "class") && hostCount > 1) {
    return { ok: false, error: "A personal or class page has at most one host." };
  }
  if (type === "collective" && hostCount < 2) {
    return { ok: false, error: "A collective page needs at least two hosts." };
  }
  if (type === "round_robin" && hostCount < 1) {
    return { ok: false, error: "A round-robin page needs at least one host." };
  }
  return { ok: true, value: true };
}

/**
 * The type-specific fields. Each is null on a type it doesn't belong to, so
 * a full-replace PATCH that changes the type clears the old type's fields.
 * Undefined values are skipped on write (`ignoreUndefinedProperties`).
 */
function validateCalendarTypeFields(
  type: CalendarType | undefined,
  b: Record<string, unknown>,
  hostCount: number,
): Validated<
  Pick<BookingPageFormData, "distribution" | "seatsPerSlot" | "services">
> {
  // No type sent (legacy caller): leave every type field as stored.
  if (type === undefined) {
    return {
      ok: true,
      value: { distribution: undefined, seatsPerSlot: undefined, services: undefined },
    };
  }
  const hostsOk = validateCalendarTypeHosts(type, hostCount);
  if (!hostsOk.ok) return hostsOk;

  let distribution: BookingPageFormData["distribution"] = null;
  if ((type === "round_robin" || type === "service") && b.distribution != null) {
    if (b.distribution !== "availability" && b.distribution !== "equal") {
      return { ok: false, error: "Distribution must be availability or equal." };
    }
    distribution = b.distribution;
  }

  let seatsPerSlot: number | null = null;
  if (type === "class") {
    const n = b.seatsPerSlot;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 2 || n > MAX_SEATS_PER_SLOT) {
      return {
        ok: false,
        error: `Seats per slot must be a whole number from 2 to ${MAX_SEATS_PER_SLOT}.`,
      };
    }
    seatsPerSlot = n;
  }

  let services: BookingService[] | null = null;
  if (type === "service") {
    const v = validateServices(b.services);
    if (!v.ok) return v;
    services = v.value;
  }
  return { ok: true, value: { distribution, seatsPerSlot, services } };
}

export function validatePayment(
  input: unknown,
): Validated<BookingPayment | null> {
  if (input === undefined || input === null) return { ok: true, value: null };
  if (typeof input !== "object") {
    return { ok: false, error: "Payment block must be an object." };
  }
  const r = input as Record<string, unknown>;
  const amount =
    typeof r.amount === "number" ? r.amount : Number(r.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100_000) {
    return {
      ok: false,
      error: "Payment amount must be greater than 0 (and below 100,000).",
    };
  }
  const currency =
    typeof r.currency === "string" ? r.currency.trim().toUpperCase() : "";
  if (!CURRENCY_SET.has(currency)) {
    return {
      ok: false,
      error: `Currency must be one of: ${[...CURRENCY_SET].join(", ")}.`,
    };
  }
  const description =
    typeof r.description === "string" && r.description.trim().length > 0
      ? r.description.trim().slice(0, 120)
      : null;
  const holdHours =
    r.holdHours === undefined || r.holdHours === null
      ? DEFAULT_PAYMENT_HOLD_HOURS
      : typeof r.holdHours === "number"
        ? r.holdHours
        : Number(r.holdHours);
  if (!Number.isInteger(holdHours) || holdHours < 1 || holdHours > 168) {
    return {
      ok: false,
      error: "Hold window must be a whole number of hours (1–168).",
    };
  }
  // Round to 2 decimals so floats from form inputs persist cleanly.
  const cleanedAmount = Math.round(amount * 100) / 100;
  return {
    ok: true,
    value: {
      amount: cleanedAmount,
      currency,
      description,
      holdHours,
    },
  };
}

export function validateRemindersEnabled(input: unknown): Validated<boolean> {
  if (typeof input === "boolean") return { ok: true, value: input };
  return { ok: false, error: "Reminders toggle must be true or false." };
}

export function validateReminderOffsets(
  input: unknown,
): Validated<number[]> {
  if (input === undefined || input === null) {
    return { ok: true, value: [...DEFAULT_REMINDER_OFFSETS_MINUTES] };
  }
  if (!Array.isArray(input)) {
    return { ok: false, error: "Reminder offsets must be a list of minutes." };
  }
  const cleaned: number[] = [];
  for (const raw of input) {
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isInteger(n) || n < 5 || n > 60 * 24 * 14) {
      return {
        ok: false,
        error: "Each reminder offset must be a whole number of minutes (5 to 20160 / 14 days).",
      };
    }
    cleaned.push(n);
  }
  if (cleaned.length > 4) {
    return {
      ok: false,
      error: "At most 4 reminders per booking page.",
    };
  }
  // Sort descending so the executor schedules in chronological order.
  cleaned.sort((a, b) => b - a);
  return { ok: true, value: cleaned };
}

export function validateTerritoryId(
  input: unknown,
): Validated<string | null> {
  if (input === undefined || input === null || input === "") {
    return { ok: true, value: null };
  }
  if (typeof input !== "string") {
    return { ok: false, error: "Territory id must be a string." };
  }
  return { ok: true, value: input };
}

/**
 * Hex color check for the accent override. Accepts #RGB / #RRGGBB
 * casing-insensitive; rejects everything else so the public page never
 * tries to render an invalid CSS color.
 */
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
export function validateAccentColor(input: unknown): Validated<string | null> {
  if (input == null || input === "") return { ok: true, value: null };
  if (typeof input !== "string" || !HEX_RE.test(input.trim())) {
    return { ok: false, error: "Accent color must be a hex like #5B5BD6." };
  }
  return { ok: true, value: input.trim().toUpperCase() };
}

export function validateLogoUrl(input: unknown): Validated<string | null> {
  if (input == null || input === "") return { ok: true, value: null };
  if (typeof input !== "string") {
    return { ok: false, error: "Logo URL must be a string." };
  }
  const url = input.trim();
  if (url.length > 1000) {
    return { ok: false, error: "Logo URL is too long." };
  }
  if (!/^https:\/\//.test(url)) {
    return { ok: false, error: "Logo URL must start with https://." };
  }
  return { ok: true, value: url };
}

/**
 * Optional meeting URL — Zoom / Google Meet / Whereby / any video tool.
 * Must be http(s); rejected otherwise so emails + .ics never carry a
 * broken link. Cap at 1000 chars to keep Firestore docs reasonable.
 */
export function validateMeetingUrl(input: unknown): Validated<string | null> {
  if (input == null || input === "") return { ok: true, value: null };
  if (typeof input !== "string") {
    return { ok: false, error: "Meeting URL must be a string." };
  }
  const url = input.trim();
  if (url.length > 1000) {
    return { ok: false, error: "Meeting URL is too long." };
  }
  if (!/^https?:\/\//i.test(url)) {
    return {
      ok: false,
      error: "Meeting URL must start with https:// (or http:// for testing).",
    };
  }
  try {
    new URL(url);
  } catch {
    return { ok: false, error: "Meeting URL isn't a valid URL." };
  }
  return { ok: true, value: url };
}

/**
 * Optional post-booking redirect URL. Stricter than the meeting URL:
 * this navigates a real visitor's browser, so we require https:// (no
 * http://) and reject any non-http(s) scheme (javascript:, data:, etc.)
 * so a malicious config can't turn the confirmation panel into an XSS /
 * open-redirect vector. Cap at 1000 chars to keep Firestore docs lean.
 */
export function validateRedirectUrl(input: unknown): Validated<string | null> {
  if (input == null || input === "") return { ok: true, value: null };
  if (typeof input !== "string") {
    return { ok: false, error: "Redirect URL must be a string." };
  }
  const url = input.trim();
  if (url.length > 1000) {
    return { ok: false, error: "Redirect URL is too long." };
  }
  if (!/^https:\/\//i.test(url)) {
    return { ok: false, error: "Redirect URL must start with https://." };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "Redirect URL isn't a valid URL." };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, error: "Redirect URL must use https://." };
  }
  return { ok: true, value: url };
}

/**
 * Toggle for appending `booking_id` + `email` to the redirect URL.
 * Defaults to `true` (legacy docs + omitted field) so existing behaviour
 * is preserved; the operator opts out to keep PII out of the redirect.
 */
export function validateRedirectAppendParams(
  input: unknown,
): Validated<boolean> {
  if (input === undefined || input === null) return { ok: true, value: true };
  if (typeof input === "boolean") return { ok: true, value: input };
  return {
    ok: false,
    error: "Append-params toggle must be true or false.",
  };
}

export function validateConfirmationMessage(
  input: unknown,
): Validated<string> {
  if (input == null) return { ok: true, value: "" };
  if (typeof input !== "string") {
    return { ok: false, error: "Confirmation message must be text." };
  }
  if (input.length > 1000) {
    return {
      ok: false,
      error: "Confirmation message is too long (max 1000 chars).",
    };
  }
  return { ok: true, value: input };
}

/**
 * Composite validator for the full editor payload. Returns the cleaned
 * `BookingPageFormData` shape (no tenancy/timestamps — those are
 * server-stamped). Short-circuits on the first failure so the operator
 * sees the most-actionable single error rather than a wall of them.
 */
export function validateBookingPageFormData(
  body: unknown,
): Validated<BookingPageFormData> {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Invalid request body." };
  }
  const b = body as Record<string, unknown>;

  const slug = validateSlug(b.slug);
  if (!slug.ok) return slug;
  const name = validateName(b.name);
  if (!name.ok) return name;
  const description = validateDescription(b.description);
  if (!description.ok) return description;
  const status = validateStatus(b.status);
  if (!status.ok) return status;

  const durationMinutes = validateDuration(b.durationMinutes);
  if (!durationMinutes.ok) return durationMinutes;
  const bufferMinutes = validateBuffer(b.bufferMinutes);
  if (!bufferMinutes.ok) return bufferMinutes;
  const bufferBeforeMinutes = validateBuffer(b.bufferBeforeMinutes ?? 0);
  if (!bufferBeforeMinutes.ok) return bufferBeforeMinutes;
  const slotIntervalMinutes = validateSlotInterval(b.slotIntervalMinutes);
  if (!slotIntervalMinutes.ok) return slotIntervalMinutes;
  const workingHours = validateWorkingHours(b.workingHours);
  if (!workingHours.ok) return workingHours;
  if (workingHours.value.length === 0) {
    return {
      ok: false,
      error: "Set at least one working-hour range before publishing.",
    };
  }
  const dateOverrides = validateDateOverrides(b.dateOverrides);
  if (!dateOverrides.ok) return dateOverrides;
  const timezone = validateTimezone(b.timezone);
  if (!timezone.ok) return timezone;
  const visibleDays = validateVisibleDays(b.visibleDays);
  if (!visibleDays.ok) return visibleDays;
  const minNoticeHours = validateMinNoticeHours(b.minNoticeHours);
  if (!minNoticeHours.ok) return minNoticeHours;
  const maxPerDay = validateMaxPerDay(b.maxPerDay);
  if (!maxPerDay.ok) return maxPerDay;

  const intakeFields = validateIntakeFields(b.intakeFields);
  if (!intakeFields.ok) return intakeFields;

  const hosts = validateHosts(b.hosts);
  if (!hosts.ok) return hosts;
  const allowHostSelection = validateAllowHostSelection(b.allowHostSelection);
  if (!allowHostSelection.ok) return allowHostSelection;
  const calendarType = validateCalendarType(b.calendarType);
  if (!calendarType.ok) return calendarType;
  const typeFields = validateCalendarTypeFields(
    calendarType.value,
    b,
    hosts.value.length,
  );
  if (!typeFields.ok) return typeFields;

  const logoUrl = validateLogoUrl(b.logoUrl);
  if (!logoUrl.ok) return logoUrl;
  const accentColor = validateAccentColor(b.accentColor);
  if (!accentColor.ok) return accentColor;

  const meetingUrl = validateMeetingUrl(b.meetingUrl);
  if (!meetingUrl.ok) return meetingUrl;

  const confirmationMessage = validateConfirmationMessage(b.confirmationMessage);
  if (!confirmationMessage.ok) return confirmationMessage;
  const redirectUrl = validateRedirectUrl(b.redirectUrl);
  if (!redirectUrl.ok) return redirectUrl;
  const redirectAppendParams = validateRedirectAppendParams(
    b.redirectAppendParams,
  );
  if (!redirectAppendParams.ok) return redirectAppendParams;
  const remindersEnabled = validateRemindersEnabled(b.remindersEnabled);
  if (!remindersEnabled.ok) return remindersEnabled;
  const reminderOffsetsMinutes = validateReminderOffsets(
    b.reminderOffsetsMinutes,
  );
  if (!reminderOffsetsMinutes.ok) return reminderOffsetsMinutes;

  const payment = validatePayment(b.payment);
  if (!payment.ok) return payment;

  const defaultTerritoryId = validateTerritoryId(b.defaultTerritoryId);
  if (!defaultTerritoryId.ok) return defaultTerritoryId;

  return {
    ok: true,
    value: {
      slug: slug.value,
      name: name.value,
      description: description.value,
      status: status.value,
      durationMinutes: durationMinutes.value,
      bufferMinutes: bufferMinutes.value,
      bufferBeforeMinutes: bufferBeforeMinutes.value,
      slotIntervalMinutes: slotIntervalMinutes.value,
      workingHours: workingHours.value,
      dateOverrides: dateOverrides.value,
      timezone: timezone.value,
      visibleDays: visibleDays.value,
      minNoticeHours: minNoticeHours.value,
      maxPerDay: maxPerDay.value,
      intakeFields: intakeFields.value,
      hosts: hosts.value,
      allowHostSelection: allowHostSelection.value,
      calendarType: calendarType.value,
      ...typeFields.value,
      logoUrl: logoUrl.value,
      accentColor: accentColor.value,
      meetingUrl: meetingUrl.value,
      confirmationMessage: confirmationMessage.value,
      redirectUrl: redirectUrl.value,
      redirectAppendParams: redirectAppendParams.value,
      remindersEnabled: remindersEnabled.value,
      reminderOffsetsMinutes: reminderOffsetsMinutes.value,
      payment: payment.value,
      defaultTerritoryId: defaultTerritoryId.value,
    },
  };
}
