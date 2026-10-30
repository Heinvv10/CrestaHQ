"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  BOOKING_LOCATION_OPTIONS,
  LOCATION_ADDRESS_MAX,
  locationNeedsValue,
} from "@/lib/booking/location";
import type { BookingLocationType, BookingPageFormData } from "@/types/booking";

/**
 * "Where does this meeting happen?" in the booking-page editor: the location
 * type, the address / number it needs, and the meeting URL (required for a
 * video link, the fallback for Google Meet).
 *
 * Google Meet is only offered while Calendar sync is on for the workspace and
 * the page has hosts — the room is made on a host's own Google Calendar. The
 * server re-checks both, plus every host's connection, on save
 * (lib/server/booking-page-write.ts).
 */
export function BookingLocationField({
  form,
  set,
  calendarSyncOn,
}: {
  form: BookingPageFormData;
  set: <K extends keyof BookingPageFormData>(key: K, value: BookingPageFormData[K]) => void;
  calendarSyncOn: boolean;
}) {
  const location = form.location ?? null;
  const hasHosts = (form.hosts ?? []).length > 0;
  const meetBlocked = !calendarSyncOn
    ? "Calendar sync isn't switched on for this workspace"
    : !hasHosts
      ? "add a host under Team first"
      : null;

  function choose(next: BookingLocationType | "") {
    if (!next) {
      set("location", null);
      set("googleMeet", false);
      set("meetingUrl", null);
      return;
    }
    // Keep a typed address / number when switching between types that use one.
    const keep =
      location && locationNeedsValue(location.type) === locationNeedsValue(next)
        ? location.value
        : null;
    set("location", { type: next, value: keep });
    set("googleMeet", next === "google_meet");
  }

  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor="locationType">Where does this meeting happen?</Label>
        <select
          id="locationType"
          value={location?.type ?? ""}
          onChange={(e) => choose(e.target.value as BookingLocationType | "")}
          className="flex h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 text-foreground dark:bg-input/30 [&_option]:bg-background [&_option]:text-foreground"
        >
          <option value="">Not set</option>
          {BOOKING_LOCATION_OPTIONS.map((o) => (
            <option
              key={o.type}
              value={o.type}
              disabled={o.type === "google_meet" && !!meetBlocked && location?.type !== "google_meet"}
            >
              {o.type === "google_meet" && meetBlocked ? `${o.label} — ${meetBlocked}` : o.label}
            </option>
          ))}
        </select>
        <p className="text-[11px] text-muted-foreground">
          {location
            ? BOOKING_LOCATION_OPTIONS.find((o) => o.type === location.type)?.hint
            : "Shown to bookers and in confirmations, reminders and the calendar invite."}
        </p>
        {location?.type === "google_meet" && meetBlocked && (
          <p className="text-[11px] text-amber-700 dark:text-amber-400">
            Google Meet can&apos;t be saved: {meetBlocked}.
          </p>
        )}
      </div>

      {location?.type === "in_person" && (
        <div className="space-y-1.5">
          <Label htmlFor="locationAddress">
            Address<span className="ml-1 text-destructive">*</span>
          </Label>
          <Input
            id="locationAddress"
            value={location.value ?? ""}
            onChange={(e) => set("location", { type: "in_person", value: e.target.value })}
            maxLength={LOCATION_ADDRESS_MAX}
            placeholder="12 Main Rd, Sandton"
            required
          />
        </div>
      )}

      {location?.type === "they_call" && (
        <div className="space-y-1.5">
          <Label htmlFor="locationPhone">
            Number to call<span className="ml-1 text-destructive">*</span>
          </Label>
          <Input
            id="locationPhone"
            type="tel"
            value={location.value ?? ""}
            onChange={(e) => set("location", { type: "they_call", value: e.target.value })}
            maxLength={40}
            placeholder="+27 11 000 0000"
            required
          />
        </div>
      )}

      {(location?.type === "video_link" || location?.type === "google_meet") && (
        <div className="space-y-1.5">
          <Label htmlFor="meetingUrl">
            {location.type === "google_meet" ? "Fallback meeting URL (optional)" : "Meeting URL"}
            {location.type === "video_link" && <span className="ml-1 text-destructive">*</span>}
          </Label>
          <Input
            id="meetingUrl"
            type="url"
            value={form.meetingUrl ?? ""}
            onChange={(e) =>
              set("meetingUrl", e.target.value.trim().length > 0 ? e.target.value.trim() : null)
            }
            maxLength={1000}
            placeholder="https://zoom.us/j/1234567890"
            autoComplete="off"
            spellCheck={false}
            required={location.type === "video_link"}
          />
          <p className="text-[11px] text-muted-foreground">
            {location.type === "google_meet"
              ? "Sent instead when a Google Meet link can't be made for a booking (the host's Google Calendar disconnected, or Google failed)."
              : "Zoom, Teams, Whereby or any video-call URL. Added to the confirmation email + the calendar invite so attendees can join with one click."}
          </p>
        </div>
      )}
    </>
  );
}
