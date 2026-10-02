import { Timestamp } from "firebase/firestore";
import type { CalendarEvent, EventStatus } from "@/types/events";
import { eventStatus } from "@/types/events";

/**
 * Local overrides for changes the SERVER has just confirmed (mark-status,
 * mark-paid, operator reschedule, host reassign, Retry sync, the server-side
 * delete, a manual create). Firestore's Listen stream can sit silent for
 * ~30 s after a write, so the confirmed change is shown from the route's
 * 200 response instead of waiting for the snapshot delta.
 *
 * An override is a patch of specific fields, a deletion, or an insertion.
 *
 * Patched field: `from` is the value the LATEST snapshot held when we set the
 * override, and `ours` every value we confirmed for the field while the
 * override lived (`to` last). A later snapshot is classified, per field:
 *   - value === from  -> the stale pre-change snapshot: keep it.
 *   - value === to    -> the delta caught up: drop the override.
 *   - value in ours   -> one of OUR earlier confirmations still arriving
 *                        (A -> B -> C, the B delta landing after C was
 *                        confirmed): keep it.
 *   - anything else   -> someone else changed it after us: drop it, so
 *                        their change is not masked.
 * startAt and endAt are one field (`time`), so they are kept or dropped
 * together.
 * Deletion: the event gone from the snapshot -> drop; still there -> keep
 * hiding it. Insertion: the event in the snapshot -> drop; absent -> keep
 * showing it.
 * Two bounds keep an override from lying:
 *   - setEventPatch sets nothing for a field the latest snapshot already
 *     shows at the confirmed value (the delta beat the response), since no
 *     later snapshot would ever clear an override created after it. Likewise
 *     setEventDeleted for an event the latest snapshot no longer holds, and
 *     setEventInserted for one it already holds. The exception is an undo
 *     (A -> B -> A) while B is still unconfirmed by a snapshot: that override
 *     reads A as stale and so lives until the TTL, keeping B's delta hidden.
 *   - every override expires EVENT_OVERRIDE_TTL_MS after it was set, so even
 *     the blind spots (a third party reverting a field to `from`, or to one
 *     of `ours`, looks like a stale snapshot) can mask a real change for at
 *     most that long.
 */
export const EVENT_OVERRIDE_TTL_MS = 60_000;

/** What a server response confirmed about an event. Times are epoch ms. */
export interface EventPatch {
  status?: EventStatus;
  /** Confirmed together and judged as one unit. */
  time?: { startAt: number; endAt: number };
  assignedToUid?: string | null;
  assignedToName?: string | null;
  rescheduleCount?: number;
  /** Only ever cleared: a Retry sync the server reported as synced. */
  googleSyncError?: null;
}

/** A field as `read` gives it: comparable with `===`. */
type Value = string | number | null;

interface Confirmed {
  to: Value;
  from: Value;
  ours: Value[];
  at: number;
}

export interface EventOverride {
  status?: Confirmed;
  time?: Confirmed;
  assignedToUid?: Confirmed;
  assignedToName?: Confirmed;
  rescheduleCount?: Confirmed;
  googleSyncError?: Confirmed;
  deleted?: { at: number };
  inserted?: { event: CalendarEvent; at: number };
}

export type EventOverrides = Readonly<Record<string, EventOverride>>;

const FIELDS = [
  "status",
  "time",
  "assignedToUid",
  "assignedToName",
  "rescheduleCount",
  "googleSyncError",
] as const;
type Field = (typeof FIELDS)[number];

function ms(v: unknown): number | null {
  const d = (v as { toDate?: () => Date } | null)?.toDate?.();
  return d instanceof Date ? d.getTime() : null;
}

function timeKey(startAt: number | null, endAt: number | null): Value {
  return startAt === null || endAt === null ? null : `${startAt}/${endAt}`;
}

/** The snapshot's value for a patched field, comparable with `===`. */
function read(e: CalendarEvent, field: Field): Value {
  if (field === "status") return eventStatus(e);
  if (field === "time") return timeKey(ms(e.startAt), ms(e.endAt));
  if (field === "rescheduleCount") return e.rescheduleCount ?? 0;
  if (field === "googleSyncError") {
    const err = (e as { googleSyncError?: { message?: string; at?: unknown } | null }).googleSyncError;
    return err ? `${ms(err.at)}/${err.message}` : null;
  }
  return e[field] ?? null;
}

function confirmedValue(patch: EventPatch, field: Field): Value | undefined {
  if (field === "time") return patch.time && timeKey(patch.time.startAt, patch.time.endAt);
  return patch[field];
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
    const to = confirmedValue(patch, field);
    if (to === undefined) continue;
    const ours = [...(overrides[id]?.[field]?.ours ?? []), to];
    const from = row ? read(row, field) : to;
    // The snapshot already shows it and no other value of ours for the field
    // is still arriving: nothing to bridge.
    if (row && from === to && ours.every((v) => v === to)) delete entry[field];
    else entry[field] = { to, from, ours, at: nowMs };
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

/** `event` must be built only from a create route's 2xx response. */
export function setEventInserted(
  overrides: EventOverrides,
  event: CalendarEvent,
  latestSnapshot: readonly CalendarEvent[],
  nowMs: number,
): EventOverrides {
  // The snapshot already holds it: nothing to bridge.
  if (latestSnapshot.some((e) => e.id === event.id)) return overrides;
  return withEntry(overrides, event.id, { inserted: { event, at: nowMs } });
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
      // Not in this window: keep a patch or an insertion; a deletion has caught up.
      if (!overrides[id].deleted) continue;
      delete entry.deleted;
    } else {
      delete entry.inserted; // the snapshot holds it now
      for (const field of FIELDS) {
        const o = overrides[id][field];
        if (!o) continue;
        const v = read(e, field);
        // Stale, or one of our own earlier confirmations: keep.
        if (v === o.from || (v !== o.to && o.ours.includes(v))) continue;
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
  const held = new Set(events.map((e) => e.id));
  const inserted = Object.entries(overrides).flatMap(([id, o]) =>
    o.inserted && !held.has(id) ? [o.inserted.event] : [],
  );
  return [...events, ...inserted].flatMap((e) => {
    const o = overrides[e.id];
    if (!o) return [e];
    if (o.deleted) return [];
    const [startAt, endAt] = o.time ? String(o.time.to).split("/").map(Number) : [];
    return [
      {
        ...e,
        ...(o.status && { status: o.status.to as EventStatus }),
        ...(o.time && { startAt: Timestamp.fromMillis(startAt), endAt: Timestamp.fromMillis(endAt) }),
        ...(o.assignedToUid && { assignedToUid: o.assignedToUid.to as string | null }),
        ...(o.assignedToName && { assignedToName: o.assignedToName.to as string | null }),
        ...(o.rescheduleCount && { rescheduleCount: o.rescheduleCount.to as number }),
        ...(o.googleSyncError && { googleSyncError: null }),
      },
    ];
  });
}

/**
 * The event a create route's 2xx body says it stored (`{ id, stored }`, dates
 * as ISO strings), or null when the body does not carry one.
 */
export function createdEventFromResponse(body: unknown): CalendarEvent | null {
  const { id, stored } = (body ?? {}) as { id?: unknown; stored?: Record<string, unknown> | null };
  if (typeof id !== "string" || !id || !stored || typeof stored !== "object") return null;
  const ts = (v: unknown) => {
    const d = typeof v === "string" ? new Date(v) : null;
    return d && !Number.isNaN(d.getTime()) ? Timestamp.fromDate(d) : null;
  };
  const startAt = ts(stored.startAt);
  const endAt = ts(stored.endAt);
  if (!startAt || !endAt || typeof stored.title !== "string") return null;
  return {
    ...stored,
    id,
    startAt,
    endAt,
    createdAt: ts(stored.createdAt),
    updatedAt: ts(stored.updatedAt),
  } as CalendarEvent;
}

/**
 * The open dialog's event as the page now shows it (snapshot plus
 * overrides), so the dialog judges against confirmed values. Falls back to
 * the event as picked once it has left the page's list.
 */
export function shownEvent(
  events: readonly CalendarEvent[],
  picked: CalendarEvent | null,
): CalendarEvent | null {
  return picked && (events.find((e) => e.id === picked.id) ?? picked);
}
