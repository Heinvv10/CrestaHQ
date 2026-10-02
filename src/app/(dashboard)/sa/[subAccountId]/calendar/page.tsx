"use client";

import { useEffect, useState } from "react";
import { CalendarDays } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useSubAccount } from "@/context/sub-account-context";
import { useSubAccountContacts } from "@/context/contacts-context";
import { subscribeToEvents } from "@/lib/firestore/events";
import { useEffectiveTerritoryFilter } from "@/hooks/use-effective-territory-filter";
import { useEventOverrides } from "@/hooks/use-event-overrides";
import type { CalendarEvent } from "@/types/events";
import { CalendarView } from "@/components/calendar/calendar-view";
import { CalendarViewSwitch } from "@/components/calendar/calendar-view-switch";

export default function CalendarPage() {
  const { user, loading: authLoading } = useAuth();
  const { subAccountId, agencyId } = useSubAccount();
  const { ready: filterReady, filter: territoryFilter } =
    useEffectiveTerritoryFilter();
  const [snapshotEvents, setSnapshotEvents] = useState<CalendarEvent[]>([]);
  // The grid waits on the same Listen stream as the appointments list, so it
  // shows the dialog's server-confirmed changes the same way.
  const { events, noteConfirmedStatus, noteConfirmedReschedule, noteConfirmedDelete } =
    useEventOverrides(snapshotEvents);
  const { contacts, loading: contactsLoading } = useSubAccountContacts();
  const [eventsLoading, setEventsLoading] = useState(true);
  const loading = eventsLoading || contactsLoading;

  useEffect(() => {
    if (authLoading || !user || !agencyId) return;
    if (!filterReady) return;
    setEventsLoading(true);
    const scope = { agencyId, subAccountId };
    const unsubE = subscribeToEvents(scope, { territoryFilter }, (l) => {
      setSnapshotEvents(l);
      setEventsLoading(false);
    });
    return () => {
      unsubE();
    };
  }, [user, agencyId, subAccountId, authLoading, filterReady, territoryFilter]);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Calendar</h1>
          <p className="text-sm text-muted-foreground">
            Manual events — meetings, calls, reminders. Click any day to add
            something.
          </p>
        </div>
        <CalendarViewSwitch active="calendar" />
      </div>

      {loading ? (
        <CalendarSkeleton />
      ) : (
        <CalendarView
          events={events}
          contacts={contacts}
          onStatusChange={noteConfirmedStatus}
          onRescheduled={noteConfirmedReschedule}
          onDeleted={noteConfirmedDelete}
        />
      )}
    </div>
  );
}

function CalendarSkeleton() {
  return (
    <div className="rounded-2xl border bg-card">
      <div className="flex items-center justify-between border-b p-4">
        <div className="h-6 w-40 animate-pulse rounded bg-muted" />
        <div className="h-7 w-24 animate-pulse rounded bg-muted" />
      </div>
      <div className="grid grid-cols-7 grid-rows-6">
        {Array.from({ length: 42 }).map((_, i) => (
          <div
            key={i}
            className="min-h-[100px] border-b border-r bg-muted/10 last:border-r-0"
          >
            {i % 5 === 0 && (
              <div className="m-1.5 h-3 w-4 animate-pulse rounded bg-muted" />
            )}
          </div>
        ))}
      </div>
      <div className="sr-only">
        <CalendarDays />
      </div>
    </div>
  );
}
