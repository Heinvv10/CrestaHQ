"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  applyStatusChange,
  createSingleFlightGuard,
} from "@/components/calendar/appointment-status-action";
import {
  appointmentCalendarLabel,
  appointmentOwnerLabel,
  canOfferStatusActions,
  canRescheduleAppointment,
  dateInputToFromMs,
  dateInputToToMs,
  formatAppointmentTime,
  hasActiveFilters,
  matchesFilters,
  matchesSearch,
  matchesTab,
  resolveAppointmentsTimezone,
  sortAppointments,
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
  const { subAccountId, agencyId, saPath, subAccount } = useSubAccount();
  const { ready: filterReady, filter: territoryFilter } =
    useEffectiveTerritoryFilter();
  const { members } = useSubAccountMembers(subAccountId);
  const tz = resolveAppointmentsTimezone(subAccount);

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
  const [busyEventId, setBusyEventId] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<CalendarEvent | null>(null);
  // Stable across renders — guards against a second click landing before
  // React has repainted the row's disabled button.
  const statusGuard = useRef(createSingleFlightGuard()).current;

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

  const memberNameByUid = useMemo(() => {
    const m = new Map<string, string>();
    for (const member of members) m.set(member.uid, member.displayName);
    return m;
  }, [members]);

  const now = Date.now();
  const tabbedEvents = useMemo(
    () => events.filter((e) => matchesTab(e, tab, now)),
    [events, tab, now],
  );

  const visibleEvents = useMemo(() => {
    const filtered = tabbedEvents.filter((e) => {
      if (!matchesFilters(e, filters)) return false;
      const contactName = e.contactId ? (contactsById.get(e.contactId)?.name ?? "") : "";
      return matchesSearch(e, contactName, search);
    });
    return sortAppointments(filtered, tab);
  }, [tabbedEvents, filters, contactsById, search, tab]);

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
    setBusyEventId(event.id);
    const outcome = await statusGuard.run(event.id, () => applyStatusChange(event.id, next));
    setBusyEventId(null);
    if (outcome.skipped) return; // already in flight for this row
    toast[outcome.result.toast.kind](outcome.result.toast.message);
  }

  async function confirmCancel() {
    if (!cancelTarget) return;
    const target = cancelTarget;
    setCancelTarget(null);
    await changeStatus(target, "cancelled");
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
        tz={tz}
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
                  ownerLabel={appointmentOwnerLabel(event, memberNameByUid)}
                  tz={tz}
                  saPath={saPath}
                  busy={busyEventId === event.id}
                  onChangeStatus={(next) => {
                    if (next === "cancelled") setCancelTarget(event);
                    else void changeStatus(event, next);
                  }}
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

      <AlertDialog
        open={!!cancelTarget}
        onOpenChange={(o) => {
          if (!o) setCancelTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this booking?</AlertDialogTitle>
            <AlertDialogDescription>
              The visitor is notified by email.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmCancel()}>
              Cancel booking
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function FilterPanel({
  filters,
  onChange,
  bookingPages,
  members,
  tz,
}: {
  filters: AppointmentFilters;
  onChange: (next: AppointmentFilters) => void;
  bookingPages: BookingPage[];
  members: { uid: string; displayName: string }[];
  tz: string;
}) {
  const STATUSES: EventStatus[] = [
    "scheduled",
    "awaiting_payment",
    "completed",
    "cancelled",
    "no_show",
  ];

  /** Render an epoch ms back to a `<input type="date">` value, in `tz` — the
   *  same zone dateInputToFromMs/dateInputToToMs parsed it in, so re-opening
   *  the picker shows the date the filter is actually applying. */
  function msToDateInput(ms: number | null): string {
    if (ms === null) return "";
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(ms));
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
        onChange={(e) => onChange({ ...filters, fromMs: dateInputToFromMs(e.target.value, tz) })}
      />
      <Input
        type="date"
        aria-label="To date"
        value={msToDateInput(filters.toMs)}
        onChange={(e) => onChange({ ...filters, toMs: dateInputToToMs(e.target.value, tz) })}
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
  ownerLabel,
  tz,
  saPath,
  busy,
  onChangeStatus,
  onEdit,
}: {
  event: CalendarEvent;
  contact: Contact | null;
  calendarLabel: string;
  ownerLabel: string;
  tz: string;
  saPath: (path: string) => string;
  busy: boolean;
  onChangeStatus: (next: EventStatus) => void;
  onEdit: () => void;
}) {
  const status = eventStatus(event);
  const start = toDate(event.startAt);
  const whenLabel = start ? formatAppointmentTime(start, tz) : "—";
  const offerStatusActions = canOfferStatusActions(event);
  const canReschedule = canRescheduleAppointment(event);

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
      <td className="p-3">{ownerLabel}</td>
      <td className="p-3 text-right">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button type="button" variant="ghost" size="icon" disabled={busy}>
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <MoreHorizontal className="h-4 w-4" />
                )}
              </Button>
            }
          />
          <DropdownMenuContent align="end">
            {/* Status actions match the operator dialog's BookingActionsPanel:
                only a booking-page event has a lifecycle to flip — flipping a
                manual event's status here would still email a "visitor" and
                fire booking.* workflow triggers with nothing behind them. */}
            {offerStatusActions &&
              STATUS_ACTIONS.filter(
                (a) => a.status !== status && isValidStatusTransition(status, a.status),
              ).map((a) => (
                <DropdownMenuItem key={a.status} onClick={() => onChangeStatus(a.status)}>
                  {a.label}
                </DropdownMenuItem>
              ))}
            <DropdownMenuItem onClick={onEdit}>
              {canReschedule ? "Reschedule" : "Edit"}
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
