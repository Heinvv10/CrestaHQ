import type { AssignableMember } from "@/types";

/**
 * Whose Google Calendar an imported event came from. The doc stores only the
 * owner's uid (no name is denormalised onto it), so the roster supplies the
 * name; `null` when the member has since left, or has no display name (the
 * roster then falls back to an email, which is not shown to teammates).
 */
export function importedOwnerName(
  members: Pick<AssignableMember, "uid" | "displayName">[],
  ownerUid: string | null | undefined,
): string | null {
  if (!ownerUid) return null;
  const name = members.find((m) => m.uid === ownerUid)?.displayName.trim();
  return name && !name.includes("@") ? name : null;
}

const DAY_MS = 86_400_000;

/**
 * Local days an imported event covers within `range` (first and last day
 * shown, inclusive), so a 40-day block viewed in its last week paints that
 * week. A 3-day Busy block must mark all three days, or the later ones read
 * as free.
 * - All-day: the stored span is midnight to midnight in the OWNER's zone, so
 *   it is counted in whole days (rounded for a 23/25h day) from the start day
 *   rather than read off the end in the viewer's zone, which would spill one
 *   event onto a second day. An owner far from the viewer's zone can still
 *   see the start day shifted by one (documented).
 * - Timed: from the start day to the day of the last instant before the end,
 *   so one ending after midnight covers the next day, and one ending at
 *   midnight does not.
 */
export function importedEventDays(
  start: Date,
  end: Date | null,
  allDay: boolean,
  range: { from: Date; to: Date },
): Date[] {
  const at = (base: Date, offset: number) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset);
  const first = at(start, 0);
  const hasEnd = !!end && end.getTime() > start.getTime();
  const last = !hasEnd
    ? first
    : allDay
      ? at(start, Math.max(1, Math.round((end.getTime() - start.getTime()) / DAY_MS)) - 1)
      : at(new Date(end.getTime() - 1), 0);
  const lo = Math.max(first.getTime(), at(range.from, 0).getTime());
  const hi = Math.min(last.getTime(), at(range.to, 0).getTime());
  const days: Date[] = [];
  for (let d = new Date(lo); d.getTime() <= hi; d = at(d, 1)) days.push(d);
  return days;
}
