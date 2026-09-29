import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatAppointmentTime } from "@/lib/calendar/appointment-filters";
import { APPOINTMENTS_UPCOMING_LIMIT } from "@/lib/firestore/events";

/**
 * Says out loud which appointments the list did not load, so an older
 * event is never missing without explanation (see subscribeToAppointments).
 */
export function AppointmentsWindowNotice({
  upcomingCapped,
  olderHidden,
  oldestLoaded,
  tz,
  loadingOlder,
  onLoadOlder,
}: {
  upcomingCapped: boolean;
  olderHidden: boolean;
  oldestLoaded: Date | null;
  tz: string;
  loadingOlder: boolean;
  onLoadOlder: () => void;
}) {
  if (!upcomingCapped && !olderHidden) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-dashed px-3 py-2 text-xs text-muted-foreground">
      <div className="space-y-0.5">
        {upcomingCapped && (
          <p>Showing the next {APPOINTMENTS_UPCOMING_LIMIT} upcoming appointments only.</p>
        )}
        {olderHidden && (
          <p>
            Older appointments are not loaded
            {oldestLoaded ? ` — showing back to ${formatAppointmentTime(oldestLoaded, tz)}` : ""}.
          </p>
        )}
      </div>
      {olderHidden && (
        <Button type="button" variant="outline" size="sm" onClick={onLoadOlder} disabled={loadingOlder}>
          {loadingOlder && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Load older
        </Button>
      )}
    </div>
  );
}
