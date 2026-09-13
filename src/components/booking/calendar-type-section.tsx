"use client";

import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CALENDAR_TYPES, pageCalendarType } from "@/lib/booking/calendar-types";
import type {
  BookingPageFormData,
  BookingService,
  CalendarType,
} from "@/types/booking";

/**
 * The editor's "Calendar type" section: the type itself plus the settings
 * only that type has — distribution (round robin / service), seats (class),
 * the services list (service). Host count rules are shown here and enforced
 * by the server.
 */

const DURATIONS = [15, 30, 45, 60, 75, 90, 120] as const;
const MAX_SERVICES = 20;
const SELECT_CLASS =
  "flex h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 text-foreground dark:bg-input/30 [&_option]:bg-background [&_option]:text-foreground";

type Setter = <K extends keyof BookingPageFormData>(
  key: K,
  value: BookingPageFormData[K],
) => void;

/**
 * A fresh service id. Random, never `service-N`: a booking keeps the id of the
 * service it was made for, so a deleted service's id must not come back on a
 * new one.
 */
export function newServiceId(): string {
  return `svc_${crypto.randomUUID().slice(0, 8)}`;
}

/** Defaults a freshly picked type needs to pass validation. */
export function typeDefaults(
  type: CalendarType,
  durationMinutes: number,
): Pick<BookingPageFormData, "calendarType" | "seatsPerSlot" | "services"> {
  return {
    calendarType: type,
    seatsPerSlot: type === "class" ? 10 : null,
    services:
      type === "service"
        ? [{ id: newServiceId(), name: "Consultation", durationMinutes, description: null }]
        : null,
  };
}

/**
 * The type fields after switching to `next`: the new type's own (kept when
 * already set, else defaulted), and null for every field it doesn't use — so
 * stale seats, services or distribution never ride along.
 */
export function fieldsForType(
  form: BookingPageFormData,
  next: CalendarType,
): Pick<BookingPageFormData, "calendarType" | "seatsPerSlot" | "services" | "distribution"> {
  const d = typeDefaults(next, form.durationMinutes);
  const services = form.services ?? [];
  return {
    calendarType: next,
    seatsPerSlot: next === "class" ? (form.seatsPerSlot ?? d.seatsPerSlot) : null,
    services: next === "service" ? (services.length > 0 ? services : d.services) : null,
    distribution:
      next === "round_robin" || next === "service" ? (form.distribution ?? null) : null,
  };
}

export function hostRuleHint(type: CalendarType, hostCount: number): string | null {
  if ((type === "personal" || type === "class") && hostCount > 1) {
    return "This type books one person — keep at most one host.";
  }
  if (type === "collective" && hostCount < 2) {
    return "Collective needs at least two hosts — every one of them joins each booking.";
  }
  if (type === "round_robin" && hostCount < 1) {
    return "Round robin needs at least one host.";
  }
  return null;
}

export function CalendarTypeSection({
  form,
  set,
  disabled,
}: {
  form: BookingPageFormData;
  set: Setter;
  disabled?: boolean;
}) {
  const type = pageCalendarType(form);
  const services = form.services ?? [];

  function changeType(next: CalendarType) {
    const f = fieldsForType(form, next);
    set("calendarType", f.calendarType);
    set("seatsPerSlot", f.seatsPerSlot);
    set("services", f.services);
    set("distribution", f.distribution);
  }

  function setService(i: number, patch: Partial<BookingService>) {
    set("services", services.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  }

  function addService() {
    set("services", [
      ...services,
      { id: newServiceId(), name: "", durationMinutes: form.durationMinutes, description: null },
    ]);
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="calendarType">Calendar type</Label>
        <select
          id="calendarType"
          value={type}
          onChange={(e) => changeType(e.target.value as CalendarType)}
          disabled={disabled}
          className={SELECT_CLASS}
        >
          {CALENDAR_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <p className="text-[11px] text-muted-foreground">
          {CALENDAR_TYPES.find((t) => t.value === type)?.description}
          {type === "personal" && (form.hosts ?? []).length === 0
            ? " With no host picked, every event in this sub-account blocks it."
            : ""}
        </p>
      </div>

      {(type === "round_robin" || type === "service") && (
        <fieldset className="space-y-2" disabled={disabled}>
          <legend className="text-sm font-medium">Meeting distribution</legend>
          {(
            [
              ["equal", "Optimize for equal distribution", "The least-busy free host gets the booking; priority breaks ties."],
              ["availability", "Optimize for availability", "The highest-priority free host gets the booking; load breaks ties."],
            ] as const
          ).map(([value, label, hint]) => (
            <label key={value} className="flex cursor-pointer items-start gap-3 rounded-lg border bg-background p-3">
              <input
                type="radio"
                name="distribution"
                value={value}
                checked={(form.distribution ?? "equal") === value}
                onChange={() => set("distribution", value)}
                className="mt-0.5 h-4 w-4 cursor-pointer"
              />
              <span>
                <span className="block text-sm font-medium">{label}</span>
                <span className="block text-xs text-muted-foreground">{hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}

      {type === "class" && (
        <div className="space-y-1.5">
          <Label htmlFor="seatsPerSlot">Seats per slot</Label>
          <Input
            id="seatsPerSlot"
            type="number"
            min={2}
            max={500}
            value={form.seatsPerSlot ?? ""}
            onChange={(e) =>
              set("seatsPerSlot", e.target.value === "" ? null : Number(e.target.value))
            }
            disabled={disabled}
            className="w-32"
          />
          <p className="text-[11px] text-muted-foreground">
            A time stays open until this many people have booked it. Each
            attendee gets their own confirmation and reminders.
          </p>
        </div>
      )}

      {type === "service" && (
        <div className="space-y-2">
          <p className="text-sm font-medium">Services</p>
          {services.map((s, i) => (
            <div key={s.id} className="grid gap-2 rounded-lg border bg-background p-3 sm:grid-cols-[1fr_8rem_auto]">
              <Input
                aria-label={`Service ${i + 1} name`}
                value={s.name}
                onChange={(e) => setService(i, { name: e.target.value })}
                placeholder="Haircut"
                maxLength={80}
                disabled={disabled}
              />
              <select
                aria-label={`Service ${i + 1} duration`}
                value={s.durationMinutes}
                onChange={(e) => setService(i, { durationMinutes: Number(e.target.value) })}
                disabled={disabled}
                className={SELECT_CLASS}
              >
                {DURATIONS.map((d) => (
                  <option key={d} value={d}>
                    {d} min
                  </option>
                ))}
              </select>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => set("services", services.filter((_, j) => j !== i))}
                disabled={disabled || services.length <= 1}
                aria-label={`Remove service ${i + 1}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
              <Input
                aria-label={`Service ${i + 1} description`}
                value={s.description ?? ""}
                onChange={(e) => setService(i, { description: e.target.value || null })}
                placeholder="Description (optional)"
                maxLength={500}
                disabled={disabled}
                className="sm:col-span-3"
              />
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addService}
            disabled={disabled || services.length >= MAX_SERVICES}
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            Add service
          </Button>
        </div>
      )}
    </div>
  );
}
