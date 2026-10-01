import type { CalendarEvent, EventStatus } from "@/types/events";
import { eventStatus } from "@/types/events";

/**
 * Row status overrides for the appointments list. Firestore's Listen stream
 * can sit silent for ~30 s after a write, so a status the server has just
 * confirmed is shown from the mark-status response instead of waiting for
 * the snapshot delta.
 *
 * `from` is the status the row had when we changed it. It is what lets a
 * snapshot be classified:
 *   - status === override  -> the delta caught up: drop the override.
 *   - status === from      -> the stale pre-change snapshot: keep it.
 *   - anything else        -> someone else changed it after us: drop it, so
 *                             their change is not masked.
 * Known blind spot: a third party reverting the row to `from` is
 * indistinguishable from a stale snapshot, so the override holds until the
 * next differing snapshot.
 */
export type StatusOverrides = Readonly<
  Record<string, { status: EventStatus; from: EventStatus }>
>;

export function setStatusOverride(
  overrides: StatusOverrides,
  id: string,
  status: EventStatus,
  from: EventStatus,
): StatusOverrides {
  return { ...overrides, [id]: { status, from } };
}

export function reconcileStatusOverrides(
  overrides: StatusOverrides,
  snapshotEvents: readonly CalendarEvent[],
): StatusOverrides {
  const ids = Object.keys(overrides);
  if (ids.length === 0) return overrides;
  const byId = new Map(snapshotEvents.map((e) => [e.id, e]));
  let next: Record<string, StatusOverrides[string]> | null = null;
  for (const id of ids) {
    const e = byId.get(id);
    if (!e) continue; // not in this window: keep
    const s = eventStatus(e);
    if (s === overrides[id].from) continue; // stale snapshot: keep
    next ??= { ...overrides };
    delete next[id]; // caught up, or changed by someone else
  }
  return next ?? overrides;
}

export function applyStatusOverrides(
  events: CalendarEvent[],
  overrides: StatusOverrides,
): CalendarEvent[] {
  if (Object.keys(overrides).length === 0) return events;
  return events.map((e) => {
    const o = overrides[e.id];
    return o ? { ...e, status: o.status } : e;
  });
}
