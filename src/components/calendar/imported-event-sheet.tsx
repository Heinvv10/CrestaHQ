"use client";

import { CalendarClock, MapPin } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { toDate } from "@/lib/format";
import type { CalendarEvent } from "@/types/events";

const DAY_MS = 86_400_000;

function whenLabel(event: CalendarEvent): string {
  const start = toDate(event.startAt);
  const end = toDate(event.endAt);
  if (!start) return "";
  if (event.allDay) {
    const day = (d: Date) =>
      d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
    // Whole days, rounded so a 23 or 25 hour day (daylight saving) is still one.
    const days = end ? Math.max(1, Math.round((end.getTime() - start.getTime()) / DAY_MS)) : 1;
    const last = new Date(start.getFullYear(), start.getMonth(), start.getDate() + days - 1);
    return `${days > 1 ? `${day(start)} - ${day(last)}` : day(start)} · All day`;
  }
  const stamp: Intl.DateTimeFormatOptions = {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  };
  const from = start.toLocaleString(undefined, stamp);
  if (!end) return from;
  // Past midnight, the end needs its own date or it reads as an end before the start.
  const sameDay = start.toDateString() === end.toDateString();
  return `${from} - ${sameDay ? end.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : end.toLocaleString(undefined, stamp)}`;
}

/**
 * Read-only view of an event imported from a member's Google Calendar
 * (`source: "google"`). No edit, cancel or delete: the server and the rules
 * refuse them too, and Google is the place to change it. A time-only import
 * (`importMode: "busy"`) shows only what was imported, which is a time.
 */
export function ImportedEventSheet({
  open,
  onOpenChange,
  event,
  ownerName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  event: CalendarEvent;
  /** From the members roster; null when it is unknown. */
  ownerName: string | null;
}) {
  const owner = ownerName ?? "a team member";
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg" data-testid="imported-event-sheet">
        <SheetHeader>
          <SheetTitle>{event.title}</SheetTitle>
          <SheetDescription>Imported from Google · {owner}&apos;s calendar</SheetDescription>
        </SheetHeader>
        <div className="space-y-3 p-4 pt-0 text-sm">
          <p className="flex items-center gap-2">
            <CalendarClock className="h-4 w-4 shrink-0 text-muted-foreground" />
            {whenLabel(event)}
          </p>
          {event.location && (
            <p className="flex items-center gap-2">
              <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" />
              {event.location}
            </p>
          )}
          <p className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
            {event.importMode === "details" ? "" : `${owner} shares this time as Busy only. `}
            Imported events are read-only here. Change or delete it in Google Calendar; the CRM updates within about 15
            minutes.
          </p>
          <div className="flex justify-end">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
