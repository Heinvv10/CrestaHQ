"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  applyEventOverrides,
  expireEventOverridesAndRearm,
  nextEventOverrideExpiryMs,
  reconcileEventOverrides,
  setEventDeleted,
  setEventPatch,
  type EventOverrides,
} from "@/lib/calendar/event-overrides";
import type { CalendarEvent, EventStatus } from "@/types/events";

/**
 * A page's snapshot events with the server-confirmed changes it has not
 * caught up to yet laid over them (rules: lib/calendar/event-overrides.ts).
 * Call a `noteConfirmed*` only from a route's 200 response, with what that
 * response confirmed.
 */
export function useEventOverrides(snapshotEvents: CalendarEvent[]) {
  // The newest snapshot, readable from async callbacks without a stale closure.
  const latestSnapshot = useRef(snapshotEvents);
  const [overrides, setOverrides] = useState<EventOverrides>({});

  useEffect(() => {
    latestSnapshot.current = snapshotEvents;
    setOverrides((prev) => reconcileEventOverrides(prev, snapshotEvents));
  }, [snapshotEvents]);

  // Overrides never outlive EVENT_OVERRIDE_TTL_MS, so one can mask a real
  // change for at most that long.
  useEffect(() => {
    const wait = nextEventOverrideExpiryMs(overrides, Date.now());
    if (wait === null) return;
    const t = setTimeout(
      () => setOverrides((prev) => expireEventOverridesAndRearm(prev, Date.now())),
      wait,
    );
    return () => clearTimeout(t);
  }, [overrides]);

  const events = useMemo(
    () => applyEventOverrides(snapshotEvents, overrides),
    [snapshotEvents, overrides],
  );

  // Each reads the newest snapshot (a ref), not this render's: the delta may
  // have landed while the request was in flight.
  function noteConfirmedStatus(id: string, status: EventStatus) {
    setOverrides((prev) =>
      setEventPatch(prev, id, { status }, latestSnapshot.current, Date.now()),
    );
  }
  function noteConfirmedReschedule(id: string, startAt: Date, endAt: Date) {
    setOverrides((prev) =>
      setEventPatch(
        prev,
        id,
        { startAt: startAt.getTime(), endAt: endAt.getTime() },
        latestSnapshot.current,
        Date.now(),
      ),
    );
  }
  function noteConfirmedAssignee(id: string, assignedToUid: string | null, assignedToName: string | null) {
    setOverrides((prev) =>
      setEventPatch(prev, id, { assignedToUid, assignedToName }, latestSnapshot.current, Date.now()),
    );
  }
  function noteConfirmedDelete(id: string) {
    setOverrides((prev) => setEventDeleted(prev, id, latestSnapshot.current, Date.now()));
  }

  return {
    events,
    noteConfirmedStatus,
    noteConfirmedReschedule,
    noteConfirmedAssignee,
    noteConfirmedDelete,
  };
}
