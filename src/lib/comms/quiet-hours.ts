import { computeWindowDeferralSeconds } from "@/lib/time/window";
import type { SubAccountDoc } from "@/types";
import type {
  WhatsAppProviderId,
  WhatsAppSendResult,
} from "@/lib/comms/whatsapp/provider";

/**
 * Quiet hours for AUTOMATED outbound SMS and WhatsApp.
 *
 * The workspace's `sendWindow` (Settings → Sending preferences) is the hours
 * automated messages may go out, in its own timezone; anything outside it is
 * quiet hours. Null means no restriction, which is every workspace until
 * someone sets one.
 *
 * Who is held: workflow steps, AI auto-replies, automatic review requests and
 * their reminders, missed-call text-backs. Who is not: a person sending
 * (composer, operator replies, the manual review-request button, a message a
 * person scheduled for a time they chose). The caller says which it is, and
 * the seams default to "automated" — the direction that fails safe, same as
 * the bridge's `humanReply` flag: a send wrongly marked manual reaches a
 * customer at 03:00.
 *
 * A held send is deferred to the end of the quiet window, never dropped, and
 * re-runs its opt-out checks when it is released.
 *
 * The one exemption mirrors the WhatsApp bridge's (rails.checkQuietHours →
 * humanReplyInOpenSession): quiet hours exist to stop the number looking like
 * a 03:00 bulk sender, and a reply to someone who is actively engaging right
 * now is the opposite signal. The bridge needs two conditions — a human reply
 * AND a contact inside an open session — because either alone is a blanket
 * pass. The equivalent here is also two: the send is a booking confirmation
 * the customer caused themselves (they booked on a public booking page), AND
 * that happened within the last SELF_TRIGGERED_EXEMPT_MS. A reminder a day
 * later, or a confirmation for a booking an operator entered, is held.
 */

export type SendOrigin = "manual" | "automated";

/** How recent a customer's own booking must be for its confirmation to go
 *  out during quiet hours. */
export const SELF_TRIGGERED_EXEMPT_MS = 10 * 60_000;

export interface QuietHoursHold {
  /** Seconds until the quiet window ends. Always > 0. */
  retryAfterSec: number;
  /** When the quiet window ends. */
  until: Date;
  /** The workspace's send-window timezone, for showing `until` to people. */
  timezone: string;
}

export function quietHoursHold(input: {
  subAccount: Pick<SubAccountDoc, "sendWindow"> | null | undefined;
  origin?: SendOrigin;
  /** When the customer made the booking this message confirms. Set only by
   *  callers sending a booking confirmation of a customer's own booking. */
  selfTriggeredBookingAt?: Date | null;
  now?: Date;
}): QuietHoursHold | null {
  if (input.origin === "manual") return null;
  const now = input.now ?? new Date();
  const window = input.subAccount?.sendWindow ?? null;
  const retryAfterSec = computeWindowDeferralSeconds(window, now);
  if (retryAfterSec <= 0) return null;
  const at = input.selfTriggeredBookingAt;
  if (at) {
    const age = now.getTime() - at.getTime();
    if (age >= 0 && age <= SELF_TRIGGERED_EXEMPT_MS) return null;
  }
  return {
    retryAfterSec,
    // The window's exact start: the deferral is counted from the wall-clock
    // SECOND, so sub-second jitter must not move `until` — it keys dedup ids.
    until: new Date(Math.floor(now.getTime() / 1000) * 1000 + retryAfterSec * 1000),
    timezone: window?.timezone ?? "UTC",
  };
}

/** `until` as the workspace reads it, e.g. "Fri 25 Sep, 08:00 (Africa/Johannesburg)". */
export function formatHoldUntil(hold: QuietHoursHold): string {
  try {
    const s = new Intl.DateTimeFormat("en-GB", {
      timeZone: hold.timezone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(hold.until);
    return `${s} (${hold.timezone})`;
  } catch {
    return hold.until.toISOString();
  }
}

/** Thrown by the throwing send helpers (SMS, free-form WhatsApp) when an
 *  automated send lands in quiet hours. Nothing was sent. */
export class QuietHoursDeferredError extends Error {
  readonly hold: QuietHoursHold;
  constructor(hold: QuietHoursHold) {
    super(`Held for quiet hours until ${hold.until.toISOString()}`);
    this.name = "QuietHoursDeferredError";
    this.hold = hold;
  }
}

export function isQuietHoursDeferred(err: unknown): err is QuietHoursDeferredError {
  return err instanceof QuietHoursDeferredError;
}

/** The refusal code the WhatsApp dispatchers return — the same code the
 *  bridge uses, so the existing operator wording applies. */
export const QUIET_HOURS_REFUSAL = "quiet_hours";

/** The WhatsApp dispatchers' answer for an automated send held by quiet
 *  hours: refused before any rail was touched. */
export function quietHoursRefusal(
  provider: WhatsAppProviderId,
  hold: QuietHoursHold,
): WhatsAppSendResult & { provider: WhatsAppProviderId } {
  return {
    provider,
    ok: false,
    error: `Held for quiet hours until ${hold.until.toISOString()}`,
    refusedBy: QUIET_HOURS_REFUSAL,
    quietHours: hold,
    providerOutcome: "DEFINITELY_REJECTED",
    attempted: false,
  };
}
