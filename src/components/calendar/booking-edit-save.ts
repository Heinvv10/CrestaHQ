import type { CalendarEvent, EventFormData, EventNotifySkipReason } from "@/types/events";

/** The time the server holds for the booking, as far as the dialog knows. */
export interface TimeBaseline {
  startAt: Date | null;
  endAt: Date | null;
}

export interface RescheduleResponse {
  ok: boolean;
  body: {
    error?: string;
    code?: string;
    newStartAt?: string;
    newEndAt?: string;
    rescheduleCount?: number;
    notifyEmailSent?: boolean;
    notifyEmailSkipReason?: EventNotifySkipReason;
  };
}

/** The time a successful reschedule's response says the server now holds. */
export interface ConfirmedTime {
  startAt: Date;
  endAt: Date;
  /** The count the server stored, when the response carries it. */
  rescheduleCount?: number;
}

export type BookingEditResult =
  | { kind: "reschedule_refused"; error: string }
  | { kind: "saved"; baseline: TimeBaseline; warning: string | null }
  | {
      kind: "fields_failed";
      baseline: TimeBaseline;
      /** True when THIS save moved the booking before the field write failed. */
      rescheduled: boolean;
      warning: string | null;
      error: unknown;
    };

/** Operator-facing reason the visitor wasn't emailed, for the dialog's toasts. */
export function notifySkipDetail(reason: EventNotifySkipReason | undefined): string {
  return reason === "email_not_configured"
    ? "Resend isn't configured on this deployment"
    : reason === "no_contact_email"
      ? "the visitor's contact record has no email address"
      : reason === "contact_opted_out"
        ? "the visitor opted out of email"
        : reason === "send_failed"
          ? "the email send failed (check Vercel logs)"
          : reason === "test_mode"
            ? "this is a test-mode event"
            : "couldn't reach the visitor by email";
}

/**
 * Save an edit to a booking-page event. A changed time carries reschedule
 * bookkeeping (stamps, trigger, reminders, visitor email) a bare client
 * write can't do, so it goes through the operator reschedule route — FIRST,
 * so a refused reschedule saves nothing. The other fields then save as a
 * plain client write.
 *
 * The returned `baseline` is the time the server now holds. The dialog
 * keeps it, so retrying after a failed field write doesn't re-POST a
 * reschedule the server already applied. `no_change` from the server
 * means the same thing (the time is already there) and falls through to
 * the field write rather than blocking it.
 *
 * `onRescheduled` is called only when THIS save's reschedule returned 200
 * with the new times in its body — what a list may show before its snapshot
 * catches up, never the time the dialog asked for. It is called BEFORE the
 * field write: that write reads the contact first, which waits on the same
 * silent Listen stream the caller is bridging.
 */
export async function saveBookingPageEdit(args: {
  eventId: string;
  baseline: TimeBaseline;
  startAt: Date;
  endAt: Date;
  timeLocked: boolean;
  fields: Partial<Omit<EventFormData, "startAt" | "endAt">>;
  reschedule: (eventId: string, startAt: Date, endAt: Date) => Promise<RescheduleResponse>;
  updateFields: (
    eventId: string,
    fields: Partial<Omit<EventFormData, "startAt" | "endAt">>,
  ) => Promise<void>;
  onRescheduled?: (time: ConfirmedTime) => void;
}): Promise<BookingEditResult> {
  const { eventId, baseline, startAt, endAt } = args;
  const timeChanged =
    !args.timeLocked &&
    (!baseline.startAt ||
      !baseline.endAt ||
      baseline.startAt.getTime() !== startAt.getTime() ||
      baseline.endAt.getTime() !== endAt.getTime());

  let nextBaseline = baseline;
  let rescheduled = false;
  let warning: string | null = null;
  if (timeChanged) {
    const res = await args.reschedule(eventId, startAt, endAt);
    if (!res.ok && res.body.code !== "no_change") {
      return {
        kind: "reschedule_refused",
        error: res.body.error ?? "Couldn't reschedule. Nothing was saved.",
      };
    }
    nextBaseline = { startAt, endAt };
    if (res.ok) {
      rescheduled = true;
      const confirmedStart = new Date(res.body.newStartAt ?? NaN);
      const confirmedEnd = new Date(res.body.newEndAt ?? NaN);
      if (!Number.isNaN(confirmedStart.getTime()) && !Number.isNaN(confirmedEnd.getTime())) {
        const { rescheduleCount } = res.body;
        args.onRescheduled?.({
          startAt: confirmedStart,
          endAt: confirmedEnd,
          ...(typeof rescheduleCount === "number" && { rescheduleCount }),
        });
      }
      // The reschedule rotated the visitor's manage link — if they weren't
      // emailed the new one, the operator has to know.
      if (!res.body.notifyEmailSent) {
        warning = `Rescheduled — the visitor wasn't emailed (${notifySkipDetail(
          res.body.notifyEmailSkipReason,
        )}); their old manage link no longer works.`;
      }
    }
  }

  try {
    await args.updateFields(eventId, args.fields);
  } catch (error) {
    return { kind: "fields_failed", baseline: nextBaseline, rescheduled, warning, error };
  }
  return { kind: "saved", baseline: nextBaseline, warning };
}

/**
 * The dialog's fields minus `contactId` when the contact is unchanged and the
 * event already carries a territory. A `contactId` makes `updateEvent`
 * re-derive the territory with a contact read (a `getDoc`), and that read
 * waits on the same Listen stream that can sit silent for ~30 s, leaving
 * Save on "Saving…". With the contact unchanged the event keeps the
 * territory it has. A changed contact, or an event with no territory yet,
 * still gets the read.
 */
export function withoutUnchangedContact<T extends { contactId?: string | null }>(
  fields: T,
  event: Pick<CalendarEvent, "contactId" | "territoryId">,
): T | Omit<T, "contactId"> {
  if ((fields.contactId ?? null) !== (event.contactId ?? null) || !event.territoryId) return fields;
  const { contactId: _unchanged, ...rest } = fields;
  return rest;
}
