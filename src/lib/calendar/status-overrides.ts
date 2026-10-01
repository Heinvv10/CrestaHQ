import type { CalendarEvent, EventStatus } from "@/types/events";
import { eventStatus } from "@/types/events";

/**
 * Row status overrides for the appointments list. Firestore's Listen stream
 * can sit silent for ~30 s after a write, so a status the server has just
 * confirmed is shown from the mark-status response instead of waiting for
 * the snapshot delta.
 *
 * `from` is the status the LATEST snapshot held when we set the override. It
 * is what lets a later snapshot be classified:
 *   - status === override  -> the delta caught up: drop the override.
 *   - status === from      -> the stale pre-change snapshot: keep it.
 *   - anything else        -> someone else changed it after us: drop it, so
 *                             their change is not masked.
 * Two bounds keep an override from lying:
 *   - setStatusOverride sets nothing when the latest snapshot already shows
 *     the confirmed status (the delta beat the response), since no later
 *     snapshot would ever clear an override created after it.
 *   - every override expires STATUS_OVERRIDE_TTL_MS after it was set, so even
 *     the blind spot (a third party reverting the row to `from` looks like a
 *     stale snapshot) can mask a real change for at most that long.
 */
export const STATUS_OVERRIDE_TTL_MS = 60_000;

export type StatusOverrides = Readonly<
  Record<string, { status: EventStatus; from: EventStatus; at: number }>
>;

export function setStatusOverride(
  overrides: StatusOverrides,
  id: string,
  status: EventStatus,
  latestSnapshot: readonly CalendarEvent[],
  nowMs: number,
): StatusOverrides {
  const row = latestSnapshot.find((e) => e.id === id);
  const from = row ? eventStatus(row) : null;
  if (from === status) {
    // The snapshot already shows it: nothing to bridge.
    const { [id]: _caughtUp, ...rest } = overrides;
    return rest;
  }
  return {
    ...overrides,
    [id]: { status, from: from ?? status, at: nowMs },
  };
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
    if (eventStatus(e) === overrides[id].from) continue; // stale snapshot: keep
    next ??= { ...overrides };
    delete next[id]; // caught up, or changed by someone else
  }
  return next ?? overrides;
}

/** Drop overrides older than the TTL. Returns the same object if none expired. */
export function expireStatusOverrides(
  overrides: StatusOverrides,
  nowMs: number,
): StatusOverrides {
  const live = Object.entries(overrides).filter(
    ([, o]) => nowMs - o.at < STATUS_OVERRIDE_TTL_MS,
  );
  return live.length === Object.keys(overrides).length
    ? overrides
    : Object.fromEntries(live);
}

/** ms until the earliest override expires, or null when there are none. */
export function nextStatusOverrideExpiryMs(
  overrides: StatusOverrides,
  nowMs: number,
): number | null {
  const ats = Object.values(overrides).map((o) => o.at);
  if (ats.length === 0) return null;
  return Math.max(0, Math.min(...ats) + STATUS_OVERRIDE_TTL_MS - nowMs);
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
