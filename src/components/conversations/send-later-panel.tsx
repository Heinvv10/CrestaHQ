"use client";

import { useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  checkSendLaterValue,
  defaultSendLaterValue,
  zoneLabel,
} from "@/lib/conversations/schedule-time";
import { utcMsToWallClock } from "@/lib/deal-config";
import { SCHEDULE_MAX_DAYS, SCHEDULE_MIN_LEAD_MS } from "@/types/scheduled-messages";

/**
 * The date/time picker behind "Send later…". A time outside the API's bounds
 * is refused HERE, with the reason on screen — never snapped to another time
 * and never submitted. One booking per click: a ref guards the request in
 * flight (state alone lets a fast double click through before re-render).
 *
 * A bottom sheet under `sm` (so it never sits on top of the textarea and the
 * channel tabs at phone width), a popover above the Send button from `sm` up.
 */
export function SendLaterPanel({
  zone,
  disabled,
  onSchedule,
  onClose,
}: {
  zone: string;
  disabled: boolean;
  /** Books the message; resolves true when it was booked. */
  onSchedule: (sendAtIso: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(() => defaultSendLaterValue(Date.now(), zone));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);

  async function schedule() {
    if (inFlight.current || disabled) return;
    const checked = checkSendLaterValue(value, zone, Date.now());
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    inFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      if (await onSchedule(checked.iso)) onClose();
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  const now = Date.now();
  return (
    <>
    {/* Phone width: a scrim behind the bottom sheet, so it reads as a sheet
        over the composer rather than a box lying on top of it. */}
    <div aria-hidden className="fixed inset-0 z-40 bg-black/30 sm:hidden" onClick={onClose} />
    <div
      data-testid="send-later-panel"
      className="bg-popover fixed inset-x-4 bottom-4 z-50 space-y-2 rounded-lg border p-3 text-sm shadow-lg sm:absolute sm:inset-x-auto sm:right-0 sm:bottom-full sm:mb-2 sm:w-72"
    >
      <label className="block text-xs font-medium" htmlFor="send-later-at">
        Send at
      </label>
      <Input
        id="send-later-at"
        type="datetime-local"
        value={value}
        min={utcMsToWallClock(now + SCHEDULE_MIN_LEAD_MS, zone)}
        max={utcMsToWallClock(now + SCHEDULE_MAX_DAYS * 86_400_000, zone)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? "send-later-error" : undefined}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        // Enter inside the composer's form would submit it — i.e. send NOW.
        // In this field it can only mean "schedule".
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void schedule();
          }
        }}
      />
      {error && (
        <p id="send-later-error" role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
      <p className="text-muted-foreground text-[11px]">
        Times are in {zoneLabel(zone, now)}. Up to {SCHEDULE_MAX_DAYS} days ahead.
      </p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
        <Button type="button" size="sm" disabled={disabled || saving} onClick={schedule}>
          {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
          Schedule
        </Button>
      </div>
    </div>
    </>
  );
}
