import { notifySkipDetail } from "@/components/calendar/booking-edit-save";
import { eventStatusLabel } from "@/types/events";
import type { EventNotifySkipReason, EventStatus } from "@/types/events";

/**
 * POST a status change and compute the toast to show — the same honest
 * cancel-notification mapping as the operator dialog's BookingActionsPanel
 * (the server's `notifyEmailSent`/`notifyEmailSkipReason`, never an
 * optimistic "Visitor notified"). Pulled out of the row-menu component so
 * it's testable without rendering React.
 */
export interface StatusActionOutcome {
  ok: boolean;
  toast: { kind: "success" | "warning" | "error"; message: string };
}

export async function applyStatusChange(
  eventId: string,
  next: EventStatus,
  fetchImpl: typeof fetch = fetch,
): Promise<StatusActionOutcome> {
  try {
    const res = await fetchImpl(`/api/events/by-id/${eventId}/mark-status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      notifyEmailSent?: boolean;
      notifyEmailSkipReason?: EventNotifySkipReason;
    };
    if (!res.ok || !data.ok) {
      return {
        ok: false,
        toast: { kind: "error", message: data.error ?? "Couldn't update." },
      };
    }
    if (next === "cancelled") {
      if (data.notifyEmailSent) {
        return {
          ok: true,
          toast: { kind: "success", message: "Cancelled. Visitor notified by email." },
        };
      }
      return {
        ok: true,
        toast: {
          kind: "warning",
          message: `Cancelled, but ${notifySkipDetail(data.notifyEmailSkipReason)}. Reach out manually.`,
        },
      };
    }
    return {
      ok: true,
      toast: { kind: "success", message: `Marked ${eventStatusLabel(next).toLowerCase()}.` },
    };
  } catch (err) {
    return {
      ok: false,
      toast: { kind: "error", message: err instanceof Error ? err.message : "Couldn't update." },
    };
  }
}

/**
 * Serializes one caller's in-flight action per key so a second click (a
 * double-click, or a click landing before React re-renders the disabled
 * button) can't fire a second request while the first is still running.
 * `run()` returns `{ skipped: true }` instead of calling `fn` when
 * something is already in flight for `key`.
 */
export function createSingleFlightGuard() {
  const busyKeys = new Set<string>();
  return {
    /** The most recently checked key still in flight, or null. Test hook. */
    get busyKey(): string | null {
      return busyKeys.size > 0 ? [...busyKeys][0] : null;
    },
    isBusy(key: string): boolean {
      return busyKeys.has(key);
    },
    async run<T>(
      key: string,
      fn: () => Promise<T>,
    ): Promise<{ skipped: true } | { skipped: false; result: T }> {
      if (busyKeys.has(key)) return { skipped: true };
      busyKeys.add(key);
      try {
        const result = await fn();
        return { skipped: false, result };
      } finally {
        busyKeys.delete(key);
      }
    },
  };
}
