import {
  detectTimeZone,
  isValidTimeZone,
  timeZoneAbbreviation,
  utcMsToWallClock,
  wallClockToUtcMs,
} from "@/lib/deal-config";
import { SCHEDULE_MAX_DAYS, SCHEDULE_MIN_LEAD_MS } from "@/types/scheduled-messages";

/**
 * "Send later" times are picked and shown in the SUB-ACCOUNT's timezone (the
 * business's clock, which is what "send at 9am" means to an operator), and
 * fall back to the browser's only when the sub-account has none. The picker
 * always names the zone it is using.
 */
export function scheduleTimeZone(subAccountTimeZone: string | null | undefined): string {
  return subAccountTimeZone && isValidTimeZone(subAccountTimeZone)
    ? subAccountTimeZone
    : detectTimeZone();
}

/** A `datetime-local` value read in `timeZone` → ISO instant, or null. */
export function wallClockToIso(value: string, timeZone: string): string | null {
  const ms = wallClockToUtcMs(value, timeZone);
  return ms === null ? null : new Date(ms).toISOString();
}

/** Default picker value: the first hour boundary (UTC) at least 30 minutes out. */
export function defaultSendLaterValue(nowMs: number, timeZone: string): string {
  const hour = 3_600_000;
  const at = Math.ceil((nowMs + 30 * 60_000) / hour) * hour;
  return utcMsToWallClock(at, timeZone);
}

/** "Sep 14, 9:00 AM SAST" — an instant as read in `timeZone`. */
export function formatInZone(iso: string, timeZone: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const text = new Date(ms).toLocaleString(undefined, {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `${text} ${timeZoneAbbreviation(timeZone, ms)}`;
}

/**
 * The picker's value → the instant to book, or the reason it cannot be booked
 * — the API's own bounds (parseScheduleRequest), checked BEFORE anything is
 * sent so an out-of-range time is refused on screen, never snapped or
 * submitted.
 */
export function checkSendLaterValue(
  value: string,
  timeZone: string,
  nowMs: number
): { ok: true; iso: string } | { ok: false; error: string } {
  const iso = value ? wallClockToIso(value, timeZone) : null;
  if (!iso) return { ok: false, error: "Pick a date and time." };
  const ms = Date.parse(iso);
  if (ms < nowMs + SCHEDULE_MIN_LEAD_MS) {
    return { ok: false, error: "Pick a time at least a minute from now." };
  }
  if (ms > nowMs + SCHEDULE_MAX_DAYS * 86_400_000) {
    return { ok: false, error: `Messages can be scheduled up to ${SCHEDULE_MAX_DAYS} days ahead.` };
  }
  return { ok: true, iso };
}

/** "Africa/Johannesburg (SAST)", or just "UTC" when the two would repeat. */
export function zoneLabel(timeZone: string, atMs: number): string {
  const abbr = timeZoneAbbreviation(timeZone, atMs);
  return abbr === timeZone ? timeZone : `${timeZone} (${abbr})`;
}
