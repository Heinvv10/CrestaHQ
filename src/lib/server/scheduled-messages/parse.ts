import { isValidEmailSendPayload } from "@/lib/server/conversation-send/email";
import {
  SCHEDULABLE_CHANNELS,
  SCHEDULE_MAX_DAYS,
  SCHEDULE_MIN_LEAD_MS,
  type ScheduledMessageChannel,
} from "@/types/scheduled-messages";

export interface ScheduleRequest {
  contactId: string;
  channel: ScheduledMessageChannel;
  body: string;
  subject: string | null;
  inReplyTo: string | null;
  references: string[] | null;
  sendAt: Date;
}

/** Same ceiling as the email route; for storage sanity on the other channels. */
const MAX_BODY = 200_000;

/**
 * Validate a "Send later" request. Pure — the tenancy and send-time checks run
 * in the route. An email request is held to exactly the live email route's
 * rules (isValidEmailSendPayload), so nothing can be booked that could not
 * have been sent.
 */
export function parseScheduleRequest(
  raw: unknown,
  nowMs: number
): { ok: true; value: ScheduleRequest } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Invalid request." };
  }
  const r = raw as Record<string, unknown>;
  const channel = SCHEDULABLE_CHANNELS.find((c) => c === r.channel);
  if (!channel) return { ok: false, error: "Pick a channel to send on." };

  const contactId = typeof r.contactId === "string" ? r.contactId.trim() : "";
  if (!contactId || contactId.includes("/")) {
    return { ok: false, error: "contactId is required." };
  }
  const body = typeof r.body === "string" ? r.body.trim() : "";
  if (!body) return { ok: false, error: "Write a message to schedule." };
  if (body.length > MAX_BODY) return { ok: false, error: "The message is too long." };

  let subject: string | null = null;
  let inReplyTo: string | null = null;
  let references: string[] | null = null;
  if (channel === "email") {
    const email = {
      contactId,
      subject: r.subject,
      body,
      inReplyTo: r.inReplyTo,
      references: r.references,
    };
    if (!isValidEmailSendPayload(email)) {
      return { ok: false, error: "Invalid email message or thread headers." };
    }
    subject = email.subject.trim();
    if (!subject) return { ok: false, error: "An email needs a subject." };
    inReplyTo = email.inReplyTo ?? null;
    references = email.references ?? null;
  }

  const sendAtMs =
    typeof r.sendAt === "string" ? Date.parse(r.sendAt) : Number.NaN;
  if (!Number.isFinite(sendAtMs)) {
    return { ok: false, error: "Pick a valid date and time." };
  }
  if (sendAtMs < nowMs + SCHEDULE_MIN_LEAD_MS) {
    return { ok: false, error: "Pick a time at least a minute from now." };
  }
  if (sendAtMs > nowMs + SCHEDULE_MAX_DAYS * 86_400_000) {
    return {
      ok: false,
      error: `Messages can be scheduled up to ${SCHEDULE_MAX_DAYS} days ahead.`,
    };
  }

  return {
    ok: true,
    value: {
      contactId,
      channel,
      body,
      subject,
      inReplyTo,
      references,
      sendAt: new Date(sendAtMs),
    },
  };
}
