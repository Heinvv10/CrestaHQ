/**
 * The ONE business-hours check for AI channels. Previously duplicated
 * verbatim in ai/respond.ts and web-chat/respond.ts — fine until the
 * policy changes, and then it's two places (the 23:00-hole fix had to be
 * applied twice, which is what earned this file).
 *
 * Semantics:
 *  - Hours are whole hours [0..24] evaluated in the given IANA timezone.
 *  - start === end → 24/7.
 *  - start < end → [start, end) — end=24 covers through 23:59 (midnight).
 *  - start > end → overnight window (e.g. 22 → 6).
 *  - An unresolvable timezone falls back to UTC rather than failing
 *    closed — a bad tz string must not silence every channel.
 */
export function isWithinBusinessHours(
  hoursStart: number,
  hoursEnd: number,
  timezone: string,
): boolean {
  const now = new Date();
  let hour: number;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: timezone || "UTC",
    }).formatToParts(now);
    const hourPart = parts.find((p) => p.type === "hour");
    hour = hourPart ? Number(hourPart.value) : now.getUTCHours();
    if (!Number.isFinite(hour)) hour = now.getUTCHours();
    if (hour === 24) hour = 0;
  } catch {
    hour = now.getUTCHours();
  }

  const start = Math.max(0, Math.min(23, Math.floor(hoursStart)));
  // End clamps to 24, not 23 — "until 24:00" must cover 23:00–23:59.
  const end = Math.max(0, Math.min(24, Math.floor(hoursEnd)));
  if (start === end) return true; // 24/7
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}
