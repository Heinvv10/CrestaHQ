"use client";

import { Boxes, GraduationCap, Repeat, User, Users } from "lucide-react";
import { CALENDAR_TYPES } from "@/lib/booking/calendar-types";
import type { CalendarType } from "@/types/booking";

/**
 * "Choose calendar type" step on New booking page — GHL's type dialog as
 * five cards. Picking one opens the editor preset to that type.
 */

const ICONS: Record<CalendarType, typeof User> = {
  personal: User,
  round_robin: Repeat,
  class: GraduationCap,
  collective: Users,
  service: Boxes,
};

export function CalendarTypePicker({
  onPick,
}: {
  onPick: (type: CalendarType) => void;
}) {
  return (
    <section className="space-y-3 rounded-2xl border bg-card p-5">
      <header>
        <h2 className="text-sm font-semibold">Choose calendar type</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Decides who can be booked and how a time fills up. You can change it
          later in the editor.
        </p>
      </header>
      <div className="grid gap-3 sm:grid-cols-2">
        {CALENDAR_TYPES.map((t) => {
          const Icon = ICONS[t.value];
          return (
            <button
              key={t.value}
              type="button"
              onClick={() => onPick(t.value)}
              data-calendar-type={t.value}
              className="flex items-start gap-3 rounded-xl border bg-background p-4 text-left transition hover:border-foreground/30 hover:bg-muted/40"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-500/10 text-teal-600 dark:text-teal-400">
                <Icon className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium">{t.label}</span>
                <span className="block text-xs text-muted-foreground">
                  {t.description}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
