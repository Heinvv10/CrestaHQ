import { Timestamp } from "firebase/firestore";
import type { CalendarEvent, EventStatus } from "@/types/events";
import type { EventOverrides } from "@/lib/calendar/event-overrides";

/**
 * What a page shows: its snapshot events with the confirmed-change overrides
 * laid over them (the rules that set and settle them are in
 * event-overrides.ts).
 */
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
