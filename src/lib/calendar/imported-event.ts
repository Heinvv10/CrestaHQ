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

/** A long trip must not flood the grid. */
const MAX_SPAN_DAYS = 31;

/**
 * Local days an imported event covers, first to last: a 3-day Busy block must
 * mark all three days, or the later ones read as free. The end is exclusive
 * (Google's all-day end is the next midnight), and a timed event ending
 * after midnight covers the day it ends on.
 */
export function importedEventDays(start: Date, end: Date | null): Date[] {
  const first = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const lastInstant = end && end.getTime() > start.getTime() ? new Date(end.getTime() - 1) : start;
  const days = [first];
  for (let i = 1; days.length < MAX_SPAN_DAYS; i++) {
    const d = new Date(first.getFullYear(), first.getMonth(), first.getDate() + i);
    if (d.getTime() > lastInstant.getTime()) break;
    days.push(d);
  }
  return days;
}
