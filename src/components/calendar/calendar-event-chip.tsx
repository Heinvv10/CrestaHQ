"use client";

import type { MouseEvent } from "react";
import { cn } from "@/lib/utils";
import { toDate } from "@/lib/format";
import { isImportedEvent, type CalendarEvent } from "@/types/events";

function formatTime(d: Date): string {
  return d
    .toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: d.getMinutes() === 0 ? undefined : "2-digit",
    })
    .toLowerCase()
    .replace(" ", "");
}

/**
 * One event on the month grid. An event imported from Google is a muted,
 * dashed chip (marked `data-imported`) that reads "All day" or its time, and
 * whose suffix is the owner's first name rather than a contact's.
 */
export function CalendarEventChip({
  event,
  who,
  onOpen,
}: {
  event: CalendarEvent;
  /** First name shown after the title: the contact, or the owner of an imported event. */
  who: string | undefined;
  onOpen: (e: MouseEvent) => void;
}) {
  const start = toDate(event.startAt);
  const imported = isImportedEvent(event);
  return (
    <button
      type="button"
      onClick={onOpen}
      title={imported ? "Imported from Google Calendar" : undefined}
      data-imported={imported ? "true" : undefined}
      className={cn(
        "group/event flex w-full items-center gap-1 truncate rounded-md border px-1.5 py-1 text-left text-[11px] font-medium leading-tight transition-colors hover:border-primary/30",
        imported
          ? "border-dashed border-border bg-muted/40 text-muted-foreground"
          : "border-transparent bg-gradient-to-r from-indigo-500/10 via-violet-500/10 to-pink-500/10",
      )}
    >
      <span
        className={cn(
          "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
          imported ? "bg-muted-foreground/50" : "bg-gradient-to-br from-indigo-500 via-violet-500 to-pink-500",
        )}
      />
      {start && (
        <span className="shrink-0 text-muted-foreground">{event.allDay ? "All day" : formatTime(start)}</span>
      )}
      <span className="truncate">
        {event.title}
        {who && (
          <span className="text-muted-foreground">
            {" · "}
            {who}
          </span>
        )}
      </span>
    </button>
  );
}
