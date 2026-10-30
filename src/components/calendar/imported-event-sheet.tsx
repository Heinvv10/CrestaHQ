"use client";

import { CalendarClock, MapPin } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { useSubAccount } from "@/context/sub-account-context";
import { useSubAccountMembers } from "@/hooks/use-sub-account-members";
import { importedOwnerName } from "@/lib/calendar/imported-event";
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
    // Google's all-day end is the day after the last day.
    const last = end ? new Date(end.getTime() - 1) : start;
    return `${last.getTime() - start.getTime() >= DAY_MS ? `${day(start)} - ${day(last)}` : day(start)} · All day`;
  }
  const from = start.toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
  return end ? `${from} - ${end.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}` : from;
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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  event: CalendarEvent;
}) {
  const { subAccountId } = useSubAccount();
  const { members } = useSubAccountMembers(subAccountId);
  const owner = importedOwnerName(members, event.importOwnerUid) ?? "a team member";
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
