import {
  computeFirstRunAt,
  computeNextRunAt,
  startOfLocalDay,
  type Cadence,
} from "@/lib/recurring/cadence";

/**
 * Where a schedule points after an operator edit or a resume.
 *
 * What is guaranteed: the result never lands at or before `lastRunAt`, so an
 * edit cannot re-bill the cycle a sweep already billed that day. What is NOT:
 * an anchor change may shorten or lengthen the period straddling the edit
 * (billed on the 15th, moved to the 20th, bills again on the 20th) — that is a
 * product decision about period semantics, not something this enforces.
 *
 * A resume keeps every cycle due today or later that has not been billed, and
 * steps past only those whose local due date is before today. Those are
 * returned in `skipped` so the operator is told, not left to notice.
 */
export function recomputeNextRun(input: {
  cadenceMoved: boolean;
  resuming: boolean;
  cadence: Cadence;
  anchorDay: number | null;
  timezone: string;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  now: Date;
}): { next: Date; skipped: Date[]; resumeNote?: string } | null {
  const { cadence, anchorDay, timezone, lastRunAt, now } = input;
  const from = input.cadenceMoved
    ? computeFirstRunAt({ startAt: now, cadence, anchorDay, timezone })
    : input.nextRunAt;
  if (!from) return null;

  let floor = lastRunAt?.getTime() ?? -Infinity;
  if (input.resuming) {
    floor = Math.max(floor, startOfLocalDay(now, timezone).getTime() - 1);
  }
  const skipped: Date[] = [];
  let next = from;
  while (next.getTime() <= floor) {
    skipped.push(next);
    next = computeNextRunAt({ previous: next, cadence, anchorDay, timezone });
  }
  if (!input.cadenceMoved && next === from) return null;
  // A cadence change recomputes from today, so any skip there is a cycle
  // already billed today — nothing the operator needs to raise.
  const resumeNote =
    input.resuming && !input.cadenceMoved ? resumeSkipNote(skipped, timezone) : undefined;
  return { next, skipped, resumeNote };
}

/** The `lastError` a resume leaves when it stepped past unbilled cycles. */
function resumeSkipNote(
  skipped: Date[],
  timezone: string,
): string | undefined {
  if (skipped.length === 0) return undefined;
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: timezone });
  const shown = skipped.slice(0, 12).map((d) => fmt.format(d));
  const more = skipped.length > shown.length ? ` and ${skipped.length - shown.length} more` : "";
  return (
    `Resumed without billing the cycles due while paused: ${shown.join(", ")}${more}. ` +
    `Raise them by hand if they are still owed.`
  );
}
