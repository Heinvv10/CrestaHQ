"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Loader2, MoreHorizontal, Search } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useSubAccount } from "@/context/sub-account-context";
import { useEffectiveTerritoryFilter } from "@/hooks/use-effective-territory-filter";
import { useSubAccountMembers } from "@/hooks/use-sub-account-members";
import { subscribeToContacts } from "@/lib/firestore/contacts";
import { subscribeToEvents } from "@/lib/firestore/events";
import { subscribeToBookingPages } from "@/lib/firestore/booking-pages";
import { toDate } from "@/lib/format";
import {
  appointmentCalendarLabel,
  appointmentOwnerLabel,
  hasActiveFilters,
  matchesFilters,
  matchesSearch,
  matchesTab,
  EMPTY_APPOINTMENT_FILTERS,
  type AppointmentFilters,
  type AppointmentTab,
} from "@/lib/calendar/appointment-filters";
import { CalendarViewSwitch } from "@/components/calendar/calendar-view-switch";
import { EventDialog } from "@/components/calendar/event-dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  eventStatus,
  eventStatusLabel,
  isValidStatusTransition,
  type CalendarEvent,
  type EventStatus,
} from "@/types/events";
import type { Contact } from "@/types/contacts";
import type { BookingPage } from "@/types/booking";

const SELECT_CLASS =
  "border-input bg-background h-9 w-full rounded-md border px-2 text-sm";

/** Row-menu status offers, in a sensible reading order. */
const STATUS_ACTIONS: { status: EventStatus; label: string }[] = [
  { status: "completed", label: "Mark completed" },
  { status: "no_show", label: "Mark no-show" },
  { status: "cancelled", label: "Cancel" },
];

const PAGE_SIZE = 25;

export default function AppointmentsListPage() {
  const { user, loading: authLoading } = useAuth();
  const { subAccountId, agencyId, saPath } = useSubAccount();
  const { ready: filterReady, filter: territoryFilter } =
    useEffectiveTerritoryFilter();
  const { members } = useSubAccountMembers(subAccountId);

  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [bookingPages, setBookingPages] = useState<BookingPage[]>([]);
  const [loading, setLoading] = useState(true);

  const [tab, setTab] = useState<AppointmentTab>("upcoming");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<AppointmentFilters>(
    EMPTY_APPOINTMENT_FILTERS,
  );
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);

  useEffect(() => {
    if (authLoading || !user || !agencyId) return;
    if (!filterReady) return;
    setLoading(true);
    const scope = { agencyId, subAccountId };
    let eventsReady = false;
    let contactsReady = false;
    const settle = () => {
      if (eventsReady && contactsReady) setLoading(false);
    };
    const unsubE = subscribeToEvents(scope, { territoryFilter }, (l) => {
      setEvents(l);
      eventsReady = true;
      settle();
    });
    const unsubC = subscribeToContacts(scope, { territoryFilter }, (l) => {
      setContacts(l);
      contactsReady = true;
      settle();
    });
    const unsubP = subscribeToBookingPages(subAccountId, setBookingPages);
    return () => {
      unsubE();
      unsubC();
      unsubP();
    };
  }, [user, agencyId, subAccountId, authLoading, filterReady, territoryFilter]);

  const contactsById = useMemo(() => {
    const m = new Map<string, Contact>();
    for (const c of contacts) m.set(c.id, c);
    return m;
  }, [contacts]);

  const bookingPageNameBySlug = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of bookingPages) m.set(p.slug, p.name);
    return m;
  }, [bookingPages]);

  const now = Date.now();
  const tabbedEvents = useMemo(
    () => events.filter((e) => matchesTab(e, tab, now)),
    [events, tab, now],
  );

  const visibleEvents = useMemo(() => {
    return tabbedEvents.filter((e) => {
      if (!matchesFilters(e, filters)) return false;
      const contactName = e.contactId ? (contactsById.get(e.contactId)?.name ?? "") : "";
      return matchesSearch(e, contactName, search);
    });
  }, [tabbedEvents, filters, contactsById, search]);

  const counts = useMemo(
    () => ({
      upcoming: events.filter((e) => matchesTab(e, "upcoming", now)).length,
      cancelled: events.filter((e) => matchesTab(e, "cancelled", now)).length,
      all: events.length,
    }),
    [events, now],
  );

  // Reset pagination whenever the visible set could shrink/reorder underneath it.
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [tab, filters, search]);

  async function changeStatus(event: CalendarEvent, next: EventStatus) {
    try {
      const res = await fetch(`/api/events/by-id/${event.id}/mark-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Couldn't update.");
      toast.success(`Marked ${eventStatusLabel(next).toLowerCase()}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update.");
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Appointments</h1>
          <p className="text-sm text-muted-foreground">
            Every calendar event across the sub-account, in one list.
          </p>
        </div>
        <CalendarViewSwitch active="appointments" />
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as AppointmentTab)}>
        <TabsList>
          <TabsTrigger value="upcoming">Upcoming ({counts.upcoming})</TabsTrigger>
          <TabsTrigger value="cancelled">Cancelled ({counts.cancelled})</TabsTrigger>
          <TabsTrigger value="all">All ({counts.all})</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by title or contact…"
          className="pl-8"
        />
      </div>

      <FilterPanel
        filters={filters}
        onChange={setFilters}
        bookingPages={bookingPages}
        members={members}
      />

      {loading ? (
        <div className="flex items-center justify-center gap-2 rounded-2xl border border-dashed py-10 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : visibleEvents.length === 0 ? (
        <div className="rounded-2xl border border-dashed bg-card p-10 text-center text-sm text-muted-foreground">
          No appointments in this view.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/30 text-left text-xs font-medium text-muted-foreground">
              <tr>
                <th className="p-3">Title</th>
                <th className="p-3">Contact</th>
                <th className="p-3">Status</th>
                <th className="p-3">Appointment time</th>
                <th className="p-3">Calendar</th>
                <th className="p-3">Owner</th>
                <th className="p-3" />
              </tr>
            </thead>
            <tbody>
              {visibleEvents.slice(0, visibleCount).map((event) => (
                <AppointmentRow
                  key={event.id}
                  event={event}
                  contact={event.contactId ? (contactsById.get(event.contactId) ?? null) : null}
                  calendarLabel={appointmentCalendarLabel(event, bookingPageNameBySlug)}
                  saPath={saPath}
                  onChangeStatus={(next) => changeStatus(event, next)}
                  onEdit={() => setSelectedEvent(event)}
                />
              ))}
            </tbody>
          </table>
          {visibleCount < visibleEvents.length && (
            <div className="flex justify-center border-t p-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
              >
                Load more ({visibleEvents.length - visibleCount} more)
              </Button>
            </div>
          )}
        </div>
      )}

      <EventDialog
        open={!!selectedEvent}
        onOpenChange={(o) => {
          if (!o) setSelectedEvent(null);
        }}
        contacts={contacts}
        event={selectedEvent}
      />
    </div>
  );
}

function FilterPanel({
  filters,
  onChange,
  bookingPages,
  members,
}: {
  filters: AppointmentFilters;
  onChange: (next: AppointmentFilters) => void;
  bookingPages: BookingPage[];
  members: { uid: string; displayName: string }[];
}) {
  const STATUSES: EventStatus[] = [
    "scheduled",
    "awaiting_payment",
    "completed",
    "cancelled",
    "no_show",
  ];

  function dateInputToMs(value: string, endOfDay: boolean): number | null {
    if (!value) return null;
    const d = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}`);
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  }
  function msToDateInput(ms: number | null): string {
    if (ms === null) return "";
    return new Date(ms).toISOString().slice(0, 10);
  }

  return (
    <div className="grid grid-cols-2 gap-2 rounded-xl border bg-muted/20 p-3 sm:grid-cols-3 md:grid-cols-6">
      <select
        aria-label="Calendar"
        value={filters.bookingPageSlug ?? ""}
        onChange={(e) =>
          onChange({ ...filters, bookingPageSlug: e.target.value || null })
        }
        className={SELECT_CLASS}
      >
        <option value="">Any calendar</option>
        {bookingPages.map((p) => (
          <option key={p.slug} value={p.slug}>
            {p.name}
          </option>
        ))}
      </select>

      <select
        aria-label="Appointment owner"
        value={filters.hostUid ?? ""}
        onChange={(e) => onChange({ ...filters, hostUid: e.target.value || null })}
        className={SELECT_CLASS}
      >
        <option value="">Any owner</option>
        {members.map((m) => (
          <option key={m.uid} value={m.uid}>
            {m.displayName}
          </option>
        ))}
      </select>

      <select
        aria-label="Status"
        value={filters.status ?? ""}
        onChange={(e) =>
          onChange({ ...filters, status: (e.target.value || null) as EventStatus | null })
        }
        className={SELECT_CLASS}
      >
        <option value="">Any status</option>
        {STATUSES.map((s) => (
          <option key={s} value={s}>
            {eventStatusLabel(s)}
          </option>
        ))}
      </select>

      <select
        aria-label="Source"
        value={filters.source ?? ""}
        onChange={(e) =>
          onChange({
            ...filters,
            source: (e.target.value || null) as AppointmentFilters["source"],
          })
        }
        className={SELECT_CLASS}
      >
        <option value="">Any source</option>
        <option value="booking_page">Booking page</option>
        <option value="manual">Manual</option>
      </select>

      <Input
        type="date"
        aria-label="From date"
        value={msToDateInput(filters.fromMs)}
        onChange={(e) =>
          onChange({ ...filters, fromMs: dateInputToMs(e.target.value, false) })
        }
      />
      <Input
        type="date"
        aria-label="To date"
        value={msToDateInput(filters.toMs)}
        onChange={(e) =>
          onChange({ ...filters, toMs: dateInputToMs(e.target.value, true) })
        }
      />

      {hasActiveFilters(filters) && (
        <button
          type="button"
          onClick={() => onChange(EMPTY_APPOINTMENT_FILTERS)}
          className="col-span-full text-left text-xs text-muted-foreground underline hover:text-foreground"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}

function AppointmentRow({
  event,
  contact,
  calendarLabel,
  saPath,
  onChangeStatus,
  onEdit,
}: {
  event: CalendarEvent;
  contact: Contact | null;
  calendarLabel: string;
  saPath: (path: string) => string;
  onChangeStatus: (next: EventStatus) => void;
  onEdit: () => void;
}) {
  const status = eventStatus(event);
  const start = toDate(event.startAt);
  const whenLabel = start
    ? new Intl.DateTimeFormat(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(start)
    : "—";
  const isBookingPage = event.source === "booking_page";

  return (
    <tr className="border-b last:border-b-0 hover:bg-muted/20">
      <td className="p-3 font-medium">{event.title}</td>
      <td className="p-3">
        {contact ? (
          <Link
            href={saPath(`/contacts/${contact.id}`)}
            className="text-primary hover:underline"
          >
            {contact.name || contact.email || contact.phone || "Contact"}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge status={status} />
          {!!event.rescheduleCount && (
            <span className="rounded-full bg-sky-500/10 px-2 py-0.5 text-[10px] font-medium text-sky-700 dark:text-sky-400">
              Rescheduled
            </span>
          )}
        </div>
      </td>
      <td className="p-3 whitespace-nowrap">{whenLabel}</td>
      <td className="p-3">{calendarLabel}</td>
      <td className="p-3">{appointmentOwnerLabel(event)}</td>
      <td className="p-3 text-right">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button type="button" variant="ghost" size="icon">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            }
          />
          <DropdownMenuContent align="end">
            {STATUS_ACTIONS.filter(
              (a) => a.status !== status && isValidStatusTransition(status, a.status),
            ).map((a) => (
              <DropdownMenuItem key={a.status} onClick={() => onChangeStatus(a.status)}>
                {a.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem onClick={onEdit}>
              {isBookingPage ? "Reschedule" : "Edit"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </td>
    </tr>
  );
}

function StatusBadge({ status }: { status: EventStatus }) {
  const styles: Record<EventStatus, string> = {
    scheduled: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    awaiting_payment: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
    completed: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    cancelled: "bg-rose-500/10 text-rose-700 dark:text-rose-400",
    no_show: "bg-zinc-500/10 text-zinc-700 dark:text-zinc-400",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${styles[status]}`}>
      {eventStatusLabel(status)}
    </span>
  );
}
