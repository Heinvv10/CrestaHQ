import { Timestamp } from "firebase/firestore";
import type { CalendarEvent, EventStatus } from "@/types/events";
import { eventStatus } from "@/types/events";

/**
 * Local overrides for changes the SERVER has just confirmed (mark-status,
 * operator reschedule, the server-side delete). Firestore's Listen stream can
 * sit silent for ~30 s after a write, so the confirmed change is shown from
 * the route's 200 response instead of waiting for the snapshot delta.
 *
 * An override is either a patch of specific fields or a deletion.
 *
 * Patched field: `from` is the value the LATEST snapshot held when we set the
 * override. It is what lets a later snapshot be classified, per field:
 *   - value === to    -> the delta caught up: drop the override.
 *   - value === from  -> the stale pre-change snapshot: keep it.
 *   - anything else   -> someone else changed it after us: drop it, so
 *                        their change is not masked.
 * Deletion: the event gone from the snapshot -> drop; still there -> keep
 * hiding it.
 * Two bounds keep an override from lying:
 *   - setEventPatch sets nothing for a field the latest snapshot already
 *     shows at the confirmed value (the delta beat the response), since no
 *     later snapshot would ever clear an override created after it. Likewise
 *     setEventDeleted for an event the latest snapshot no longer holds.
 *   - every override expires EVENT_OVERRIDE_TTL_MS after it was set, so even
 *     the blind spot (a third party reverting a field to `from` looks like a
 *     stale snapshot) can mask a real change for at most that long.
 */
export const EVENT_OVERRIDE_TTL_MS = 60_000;

/** What a server response confirmed about an event. Times are epoch ms. */
export interface EventPatch {
  status?: EventStatus;
  startAt?: number;
  endAt?: number;
}

interface Confirmed<V> {
  to: V;
  from: V | null;
  at: number;
}

export interface EventOverride {
  status?: Confirmed<EventStatus>;
  startAt?: Confirmed<number>;
  endAt?: Confirmed<number>;
  deleted?: { at: number };
}

export type EventOverrides = Readonly<Record<string, EventOverride>>;

const FIELDS = ["status", "startAt", "endAt"] as const;

/** The snapshot's value for a patched field, comparable with `===`. */
function read(e: CalendarEvent, field: (typeof FIELDS)[number]): EventStatus | number | null {
  if (field === "status") return eventStatus(e);
  const d = (e[field] as { toDate?: () => Date } | null)?.toDate?.();
  return d instanceof Date ? d.getTime() : null;
}

function withEntry(overrides: EventOverrides, id: string, entry: EventOverride): EventOverrides {
  const { [id]: _replaced, ...rest } = overrides;
  return Object.keys(entry).length === 0 ? rest : { ...rest, [id]: entry };
}

export function setEventPatch(
  overrides: EventOverrides,
  id: string,
  patch: EventPatch,
  latestSnapshot: readonly CalendarEvent[],
  nowMs: number,
): EventOverrides {
  const row = latestSnapshot.find((e) => e.id === id);
  const entry: Record<string, unknown> = { ...overrides[id] };
  for (const field of FIELDS) {
    const to = patch[field];
    if (to === undefined) continue;
    const from = row ? read(row, field) : to;
    // The snapshot already shows it: nothing to bridge.
    if (row && from === to) delete entry[field];
    else entry[field] = { to, from, at: nowMs };
  }
  return withEntry(overrides, id, entry as EventOverride);
}

export function setEventDeleted(
  overrides: EventOverrides,
  id: string,
  latestSnapshot: readonly CalendarEvent[],
  nowMs: number,
): EventOverrides {
  // The snapshot already dropped it: nothing to bridge.
  if (!latestSnapshot.some((e) => e.id === id)) return withEntry(overrides, id, {});
  return withEntry(overrides, id, { deleted: { at: nowMs } });
}

export function reconcileEventOverrides(
  overrides: EventOverrides,
  snapshotEvents: readonly CalendarEvent[],
): EventOverrides {
  const ids = Object.keys(overrides);
  if (ids.length === 0) return overrides;
  const byId = new Map(snapshotEvents.map((e) => [e.id, e]));
  let next = overrides;
  for (const id of ids) {
    const e = byId.get(id);
    const entry: Record<string, unknown> = { ...overrides[id] };
    if (!e) {
      // Not in this window: keep a patch; a deletion has caught up.
      if (!overrides[id].deleted) continue;
      delete entry.deleted;
    } else {
      for (const field of FIELDS) {
        const o = overrides[id][field];
        if (!o || read(e, field) === o.from) continue; // stale snapshot: keep
        delete entry[field]; // caught up, or changed by someone else
      }
    }
    if (Object.keys(entry).length === Object.keys(overrides[id]).length) continue;
    next = withEntry(next, id, entry as EventOverride);
  }
  return next;
}

/** Drop overrides older than the TTL. Returns the same object if none expired. */
export function expireEventOverrides(
  overrides: EventOverrides,
  nowMs: number,
): EventOverrides {
  let next = overrides;
  for (const [id, entry] of Object.entries(overrides)) {
    const live = Object.entries(entry).filter(
      ([, o]) => nowMs - (o as { at: number }).at < EVENT_OVERRIDE_TTL_MS,
    );
    if (live.length === Object.keys(entry).length) continue;
    next = withEntry(next, id, Object.fromEntries(live) as EventOverride);
  }
  return next;
}

/**
 * Extra wait so the timer never fires a hair before the TTL has elapsed
 * (timers can run early by a ms; `expireEventOverrides` would then drop
 * nothing).
 */
export const EVENT_OVERRIDE_TIMER_PAD_MS = 50;

/**
 * What the expiry timer applies. Always returns a NEW object, so React
 * re-renders and the timer effect re-arms even when nothing had expired yet.
 */
export function expireEventOverridesAndRearm(
  overrides: EventOverrides,
  nowMs: number,
): EventOverrides {
  const next = expireEventOverrides(overrides, nowMs);
  return next === overrides ? { ...overrides } : next;
}

/** ms until the earliest override expires, or null when there are none. */
export function nextEventOverrideExpiryMs(
  overrides: EventOverrides,
  nowMs: number,
): number | null {
  const ats = Object.values(overrides).flatMap((entry) =>
    Object.values(entry).map((o) => (o as { at: number }).at),
  );
  if (ats.length === 0) return null;
  return Math.max(0, Math.min(...ats) + EVENT_OVERRIDE_TTL_MS - nowMs) + EVENT_OVERRIDE_TIMER_PAD_MS;
}

export function applyEventOverrides(
  events: CalendarEvent[],
  overrides: EventOverrides,
): CalendarEvent[] {
  if (Object.keys(overrides).length === 0) return events;
  return events.flatMap((e) => {
    const o = overrides[e.id];
    if (!o) return [e];
    if (o.deleted) return [];
    return [
      {
        ...e,
        ...(o.status && { status: o.status.to }),
        ...(o.startAt && { startAt: Timestamp.fromMillis(o.startAt.to) }),
        ...(o.endAt && { endAt: Timestamp.fromMillis(o.endAt.to) }),
      },
    ];
  });
}
