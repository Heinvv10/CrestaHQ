import type { BookingPage, DateOverride, WorkingHour } from "@/types/booking";

/**
 * Pure slot-availability calculator. Given a booking page, a "now"
 * instant, a window to scan, and the list of busy events overlapping
 * that window, produce the array of free slot intervals (UTC).
 *
 * Timezone math uses `Intl.DateTimeFormat` to read the page-tz offset
 * at an instant, so DST is handled without an external date library.
 * A wall time on a local date converts using the offsets in force just
 * before and just after that date (`localDay`): on an ordinary day they
 * are equal; on a DST day each candidate is checked against the wall
 * time it should show. A wall time inside a spring-forward gap does not
 * exist (skipped for slots); a repeated fall-back time uses its first
 * occurrence.
 *
 * Per-type rules (hosts, collective, class seats, services) sit on top of
 * this in `page-slots.ts`; callers go through `resolve-availability.ts`.
 */

export interface SlotCandidate {
  /** Absolute UTC instant when the slot starts. */
  startAt: Date;
  /** Absolute UTC instant when the slot ends (start + durationMinutes). */
  endAt: Date;
}

/** Cleaned busy-event shape consumed by the calculator. */
export interface BusyEvent {
  startAt: Date;
  endAt: Date;
}

export interface AvailabilityInput {
  page: BookingPage;
  /** "Now" — bookable horizon is computed relative to this. */
  now: Date;
  /** Earliest slot the caller cares about. Defaults to `now`. */
  fromInstant?: Date;
  /** Latest slot. Defaults to `now + page.visibleDays`. */
  toInstant?: Date;
  /**
   * Events that occupy a slot in the window. Caller must filter by
   * `eventOccupiesSlot()` (scheduled + awaiting_payment) so cancelled
   * meetings don't block new bookings.
   */
  busy: BusyEvent[];
  /**
   * Skip the min-notice (`page.minNoticeHours`) filter. Default false —
   * listing/rendering always enforces it. Set true ONLY for a book-time
   * re-verify of an ALREADY-OFFERED slot: min-notice is measured against
   * a moving "now", so re-applying it at confirm time can reject a slot
   * that was validly bookable when offered simply because conversation
   * time elapsed (the voice-booking false "slot just got taken"). The
   * busy-overlap and working-hours checks still run, so double-booking
   * protection is unaffected.
   */
  ignoreMinNotice?: boolean;
  /**
   * Per-host schedule override. When provided, slots are generated against
   * these ranges instead of `page.workingHours` — everything else
   * (duration / buffer / min-notice / per-day cap / DST handling) is
   * unchanged. Used by team-mode host-narrowing so a host with custom hours
   * only offers slots inside their own window. Absent ⇒ use the page hours.
   */
  workingHoursOverride?: WorkingHour[];
  /**
   * Date-specific hours ("YYYY-MM-DD" in the page tz). A listed date uses
   * these ranges instead of its weekday's hours; empty ranges = closed.
   * The caller resolves host-vs-page precedence and passes one list.
   */
  dateOverrides?: DateOverride[];
}

// One formatter per timezone: constructing Intl.DateTimeFormat is the
// expensive part, and slot generation calls wallClockInTz per candidate.
// Spellings of one zone ("europe/london", "Europe/London") share the
// formatter of its canonical name; both maps are capped (cleared when full)
// because the zone string can come from request input.
const formattersByName = new Map<string, Intl.DateTimeFormat>();
const formattersByZone = new Map<string, Intl.DateTimeFormat>();
const MAX_FORMATTERS = 500;

/** Exported for its cache test only. */
export function formatterFor(tz: string): Intl.DateTimeFormat {
  const hit = formattersByName.get(tz);
  if (hit) return hit;
  const created = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const zone = created.resolvedOptions().timeZone;
  const fmt = formattersByZone.get(zone) ?? created;
  if (formattersByName.size >= MAX_FORMATTERS) {
    formattersByName.clear();
    formattersByZone.clear();
  }
  formattersByZone.set(zone, fmt);
  formattersByName.set(tz, fmt);
  return fmt;
}

/** `instant`'s wall clock in `tz`, read as if it were UTC (ms). */
function wallAsUtc(instant: number, tz: string): number {
  const wc = wallClockInTz(new Date(instant), tz);
  return Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute, wc.second);
}

/**
 * One local date in `tz`: the UTC offsets in force 36 h either side of it
 * (DST changes are months apart, so these are the offsets before and after
 * any change on that date), and the instants showing a given wall minute.
 */
function localDay(year: number, month: number, day: number, tz: string) {
  const midnight = Date.UTC(year, month - 1, day);
  const noon = midnight + 12 * 3600_000;
  const offsets = [...new Set([noon - 36 * 3600_000, noon + 36 * 3600_000].map((t) => wallAsUtc(t, tz) - t))];
  return {
    midnight,
    /** Instants whose wall clock in `tz` is `minuteOfDay` on this date, earliest first. */
    instants(minuteOfDay: number): number[] {
      const wall = midnight + minuteOfDay * 60_000;
      if (offsets.length === 1) return [wall - offsets[0]];
      return offsets
        .map((o) => wall - o)
        .filter((t) => wallAsUtc(t, tz) === wall)
        .sort((a, b) => a - b);
    },
    /** A wall minute that doesn't exist (spring-forward gap) → the pre-change offset, i.e. shifted forward. */
    fallback(minuteOfDay: number): number {
      return midnight + minuteOfDay * 60_000 - offsets[0];
    },
    /** Minutes from this date's local midnight to `instant`'s wall clock. */
    wallMinute(instant: number): number {
      return (wallAsUtc(instant, tz) - midnight) / 60_000;
    },
  };
}

/**
 * Returns the wall-clock fields a UTC instant displays in the given
 * IANA timezone. Useful for "what day of the week is `instant` in tz?".
 */
function wallClockInTz(
  instant: Date,
  tz: string,
): {
  year: number;
  month: number; // 1-12 (not JS 0-11) — convenient for the inverse
  day: number;
  hour: number;
  minute: number;
  second: number;
  dayOfWeek: WorkingHour["dayOfWeek"];
} {
  // Intl.DateTimeFormat returns parts in the target tz.
  const parts = formatterFor(tz).formatToParts(instant);
  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "0";
  const year = Number(get("year"));
  const month = Number(get("month"));
  const day = Number(get("day"));
  // `hour: "2-digit", hour12: false` returns "24" at midnight on some
  // engines — normalise to 0.
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0;
  const minute = Number(get("minute"));
  const second = Number(get("second"));
  const weekdayMap: Record<string, WorkingHour["dayOfWeek"]> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const dayOfWeek = weekdayMap[get("weekday")] ?? 0;
  return { year, month, day, hour, minute, second, dayOfWeek };
}

/**
 * Convert a wall-clock target in a tz back to its absolute UTC instant
 * (see the file header). A repeated fall-back time gives its first
 * occurrence; a time inside a spring-forward gap is shifted forward by
 * the gap (02:30 on a 02:00→03:00 day gives 03:30).
 *
 * Exported for reuse (e.g. the AI Suite's create_event capability
 * interprets "2026-07-08 14:00" in the sub-account's timezone) — the
 * logic is generic, it just happens to live with its heaviest consumer.
 */
export function utcFromWallClock(
  year: number,
  month: number, // 1-12
  day: number,
  minuteOfDay: number,
  tz: string,
): Date {
  const local = localDay(year, month, day, tz);
  return new Date(local.instants(minuteOfDay)[0] ?? local.fallback(minuteOfDay));
}

/**
 * Iterate the candidate slot starts within a single working-hour range
 * on one local date. Steps by the page's slot interval (legacy: duration
 * + buffer) in wall time. A slot lasts its duration in real time and must
 * end inside the range in wall time; wall times that don't exist that day
 * (spring-forward gap) are skipped, repeated ones use the first occurrence.
 */
function* slotsForRange(
  page: BookingPage,
  local: ReturnType<typeof localDay>,
  range: { startMinute: number; endMinute: number },
): Generator<SlotCandidate> {
  const step =
    page.slotIntervalMinutes ?? page.durationMinutes + page.bufferMinutes;
  // Last legal start: range.endMinute − durationMinutes.
  const lastStartMinute = range.endMinute - page.durationMinutes;
  for (let m = range.startMinute; m <= lastStartMinute; m += step) {
    const start = local.instants(m)[0];
    if (start === undefined) continue;
    const end = start + page.durationMinutes * 60_000;
    if (local.wallMinute(end) > range.endMinute) continue;
    yield { startAt: new Date(start), endAt: new Date(end) };
  }
}

/**
 * Compute the set of free slots for a booking page in a window.
 * Returns a sorted-ascending array (oldest first). Uses an O(slots ×
 * busy) overlap check — fine at the v1 scale (each sub-account's
 * window query is at most a few hundred slots × a few hundred busy
 * events).
 */
export function computeAvailability(input: AvailabilityInput): SlotCandidate[] {
  const { page, now, busy } = input;
  // Per-host override wins when supplied; otherwise the page-level schedule.
  const workingHours = input.workingHoursOverride ?? page.workingHours;
  // `fromInstant` and `toInstant` defaults follow page settings — and
  // are clamped so the caller can't ask for a horizon beyond the page's
  // own visibleDays.
  const horizonEnd = new Date(
    now.getTime() + page.visibleDays * 24 * 60 * 60_000,
  );
  const minBookable = input.ignoreMinNotice
    ? now
    : new Date(now.getTime() + page.minNoticeHours * 60 * 60_000);
  const fromInstant = input.fromInstant
    ? new Date(Math.max(input.fromInstant.getTime(), minBookable.getTime()))
    : minBookable;
  const toInstant = input.toInstant
    ? new Date(Math.min(input.toInstant.getTime(), horizonEnd.getTime()))
    : horizonEnd;

  const overrides = new Map(
    (input.dateOverrides ?? []).map((o) => [o.date, o.ranges]),
  );
  const anyOpenOverride = [...overrides.values()].some((r) => r.length > 0);
  if (
    fromInstant >= toInstant ||
    (workingHours.length === 0 && !anyOpenOverride)
  ) {
    return [];
  }

  // Build a per-day-of-week lookup so each day-step does one map read.
  const rangesByDow = new Map<WorkingHour["dayOfWeek"], WorkingHour[]>();
  for (let d = 0; d <= 6; d++) {
    rangesByDow.set(d as WorkingHour["dayOfWeek"], []);
  }
  for (const r of workingHours) {
    rangesByDow.get(r.dayOfWeek)!.push(r);
  }

  // Walk the page's LOCAL calendar dates, from the date fromInstant falls
  // on to the date toInstant falls on. The pointer is a pure calendar date
  // (a UTC-midnight Date used only for y/m/d/weekday arithmetic), so the
  // walk is right for every offset (−12..+14); each slot's real instant
  // comes from `localDay`, which handles that date's DST change.
  const startWc = wallClockInTz(fromInstant, page.timezone);
  let cursor = new Date(
    Date.UTC(startWc.year, startWc.month - 1, startWc.day),
  );
  const endWc = wallClockInTz(toInstant, page.timezone);
  const endDate = new Date(Date.UTC(endWc.year, endWc.month - 1, endWc.day));

  const out: SlotCandidate[] = [];
  // Track per-tz-day count for maxPerDay. Key: "YYYY-MM-DD" in tz.
  const dayCounts = new Map<string, number>();

  // Precompute busy intervals as numeric ranges for fast overlap.
  const busyRanges = busy
    .map((b) => [b.startAt.getTime(), b.endAt.getTime()] as [number, number])
    .sort((a, b) => a[0] - b[0]);

  function overlapsAny(slot: SlotCandidate): boolean {
    const s = slot.startAt.getTime();
    const e = slot.endAt.getTime();
    for (const [bs, be] of busyRanges) {
      if (bs >= e) break; // sorted: no further busy ranges can overlap
      if (be > s) return true;
    }
    return false;
  }

  // Hard cap iterations as a defensive bound — visibleDays is already
  // bounded to 90 by the validator, but belt-and-suspenders.
  let safety = 100;
  while (cursor <= endDate && safety-- > 0) {
    const wc = {
      year: cursor.getUTCFullYear(),
      month: cursor.getUTCMonth() + 1,
      day: cursor.getUTCDate(),
      dayOfWeek: cursor.getUTCDay() as WorkingHour["dayOfWeek"],
    };
    const dayKey = cursor.toISOString().slice(0, 10);
    const local = localDay(wc.year, wc.month, wc.day, page.timezone);
    const dayMax = page.maxPerDay ?? Infinity;
    // A date override replaces that weekday's hours for this date only.
    const dayRanges =
      overrides.get(dayKey) ?? rangesByDow.get(wc.dayOfWeek) ?? [];
    for (const range of dayRanges) {
      for (const slot of slotsForRange(page, local, range)) {
        // Window + min-notice filter.
        if (slot.startAt < fromInstant) continue;
        if (slot.endAt > toInstant) continue;
        // Day cap.
        const count = dayCounts.get(dayKey) ?? 0;
        if (count >= dayMax) break;
        // Conflict filter.
        if (overlapsAny(slot)) continue;
        out.push(slot);
        dayCounts.set(dayKey, count + 1);
      }
    }
    // Next calendar date (UTC-midnight arithmetic has no DST).
    cursor = new Date(cursor.getTime() + 24 * 60 * 60_000);
  }

  out.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
  return out;
}

/**
 * Helper: group a slot list into per-day buckets keyed by the date
 * label in the page's tz (e.g. "2026-05-30"). Used by the public page
 * to render slots organised by day without round-tripping to the
 * formatter for every row.
 */
export function groupSlotsByLocalDate<T extends SlotCandidate>(
  slots: T[],
  tz: string,
): Array<{ dateKey: string; slots: T[] }> {
  const groups = new Map<string, T[]>();
  for (const s of slots) {
    const wc = wallClockInTz(s.startAt, tz);
    const key = `${wc.year}-${String(wc.month).padStart(2, "0")}-${String(wc.day).padStart(2, "0")}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(s);
    else groups.set(key, [s]);
  }
  return [...groups.entries()]
    .map(([dateKey, slots]) => ({ dateKey, slots }))
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey));
}

/**
 * Used by Slice 4's transactional re-check at submit time. Returns
 * true when `candidate` exactly matches one of the currently-free
 * slots — protects against a stale UI submitting a slot that's just
 * been taken (return 409 in that case).
 */
export function isSlotAvailable(
  candidate: SlotCandidate,
  freeSlots: SlotCandidate[],
): boolean {
  return freeSlots.some(
    (s) =>
      s.startAt.getTime() === candidate.startAt.getTime() &&
      s.endAt.getTime() === candidate.endAt.getTime(),
  );
}
