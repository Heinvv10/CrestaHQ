/**
 * `isLong` on an event: it runs longer than any bookable slot (8 h), e.g. a
 * multi-day "Out of office". The busy read only looks back ~26 h by
 * `startAt`, so a long event that began earlier is found by a second query on
 * `(subAccountId, isLong, startAt)` instead. Every path that writes an
 * event's times writes this flag with them; booking-page and voice bookings
 * are slot-sized (≤ 8 h) and leave it absent, which reads as false.
 *
 * No server-only imports: the dashboard's client-side event writes use it.
 */

export const LONG_EVENT_MS = 8 * 60 * 60_000;

function millis(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  const t = v as { toMillis?: () => number; toDate?: () => Date } | null;
  if (typeof t?.toMillis === "function") return t.toMillis();
  const d = t?.toDate?.();
  return d instanceof Date ? d.getTime() : null;
}

export function isLongEvent(startAt: unknown, endAt: unknown): boolean {
  const s = millis(startAt);
  const e = millis(endAt);
  return s !== null && e !== null && e - s > LONG_EVENT_MS;
}
