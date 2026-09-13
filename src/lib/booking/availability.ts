import type { BookingPage, WorkingHour } from "@/types/booking";

/**
 * Pure slot-availability calculator. Given a booking page, a "now"
 * instant, a window to scan, and the list of busy events overlapping
 * that window, produce the array of free slot intervals (UTC).
 *
 * Timezone math uses `Intl.DateTimeFormat` to compute the page-tz
 * offset for any given UTC instant — so DST transitions are handled
 * naturally without an external date library. The trick:
 *
 *   1. Take a guess UTC instant that has the wall-clock fields we want.
 *   2. Format that guess in the target timezone to see what wall-clock
 *      the tz applies to it. The diff is the tz offset at that moment.
 *   3. Subtract the offset from the guess to land on the real UTC
 *      instant whose wall-clock in the target tz matches what we want.
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
  const fmt = new Intl.DateTimeFormat("en-US", {
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
  const parts = fmt.formatToParts(instant);
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
 * Convert a wall-clock target in a tz back to its absolute UTC instant.
 * Uses the offset-at-guess trick documented in the file header so DST
 * is handled without external libs.
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
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  // Guess: treat the wall-clock fields as if they were UTC.
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
  // What wall-clock does that guess actually display in the target tz?
  const wc = wallClockInTz(guess, tz);
  // Construct an "as-UTC" timestamp for what the tz showed.
  const seenAsUtc = Date.UTC(
    wc.year,
    wc.month - 1,
    wc.day,
    wc.hour,
    wc.minute,
    wc.second,
  );
  // The difference is the tz's offset at the guess. Subtract it to get
  // the real UTC instant whose tz-display equals the original target.
  const offset = seenAsUtc - guess.getTime();
  return new Date(guess.getTime() - offset);
}

const MAX_SLOTS_PER_RANGE = 24 * 60;

/**
 * Iterate the candidate slot starts within a single working-hour range
 * on a specific calendar day (year-month-day in the page's tz). Steps
 * by `step` minutes; the last slot must fully fit inside the range.
 */
function* slotsForRange(
  page: BookingPage,
  year: number,
  month: number,
  day: number,
  range: WorkingHour,
): Generator<SlotCandidate> {
  const step = page.durationMinutes + page.bufferMinutes;
  // Last legal start: range.endMinute − durationMinutes.
  const lastStartMinute = range.endMinute - page.durationMinutes;
  // Capped: a day has 1440 minutes, so a sane step never gets near it, and a
  // tiny one (malformed data) can't pin the event loop.
  for (
    let m = range.startMinute, i = 0;
    m <= lastStartMinute && i < MAX_SLOTS_PER_RANGE;
    m += step, i++
  ) {
    const start = utcFromWallClock(year, month, day, m, page.timezone);
    const end = new Date(start.getTime() + page.durationMinutes * 60_000);
    yield { startAt: start, endAt: end };
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

  if (fromInstant >= toInstant || workingHours.length === 0) {
    return [];
  }
  // A zero, negative or NaN length or step would never advance the slot loop.
  if (
    !(page.durationMinutes > 0) ||
    !(page.durationMinutes + page.bufferMinutes > 0)
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

  // Walk one calendar day at a time in the page's tz. We start by
  // finding the tz-day that fromInstant lives in, then step day-by-day
  // until we pass toInstant. The day pointer is a simple {y, m, d}
  // triple — increment via UTC math (always 24h), but re-derive the
  // tz-day fields on each step so DST doesn't drift us off.
  const startWc = wallClockInTz(fromInstant, page.timezone);
  // Anchor each step on an instant at noon UTC of the JS Date for the
  // year/month/day — far enough from midnight in either direction that
  // DST shifts can't land us on the wrong wall-clock day.
  let cursor = new Date(
    Date.UTC(startWc.year, startWc.month - 1, startWc.day, 12, 0, 0),
  );
  const endWc = wallClockInTz(toInstant, page.timezone);
  const endAnchor = new Date(
    Date.UTC(endWc.year, endWc.month - 1, endWc.day, 12, 0, 0),
  );

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
  while (cursor <= endAnchor && safety-- > 0) {
    const wc = wallClockInTz(cursor, page.timezone);
    const dayKey = `${wc.year}-${String(wc.month).padStart(2, "0")}-${String(wc.day).padStart(2, "0")}`;
    const dayMax = page.maxPerDay ?? Infinity;
    for (const range of rangesByDow.get(wc.dayOfWeek) ?? []) {
      for (const slot of slotsForRange(
        page,
        wc.year,
        wc.month,
        wc.day,
        range,
      )) {
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
    // Advance one calendar day. 24h step from noon UTC stays at noon UTC
    // across DST transitions (DST shifts the wall clock, not UTC).
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
