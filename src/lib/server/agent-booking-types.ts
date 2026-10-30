import type { BookingPage } from "@/types/booking";

/** `messaging` = SMS, WhatsApp, Messenger or Instagram (contact already known). */
export type AgentBookingChannel = "phone" | "web-text" | "web-voice" | "messaging";

export const CHANNEL_COPY: Record<
  AgentBookingChannel,
  { createdByUid: string; notes: string; fallbackName: string }
> = {
  phone: {
    createdByUid: "voice-agent",
    notes: "Booked by phone via the AI voice agent.",
    fallbackName: "Phone booking",
  },
  "web-text": {
    createdByUid: "web-chat-agent",
    notes: "Booked in the website chat by the AI assistant.",
    fallbackName: "Web chat booking",
  },
  "web-voice": {
    createdByUid: "web-chat-agent",
    notes: "Booked by voice on the website by the AI assistant.",
    fallbackName: "Web voice booking",
  },
  messaging: {
    createdByUid: "messaging-agent",
    notes: "Booked in a message conversation by the AI assistant.",
    fallbackName: "Message booking",
  },
};

export type AgentBookResult =
  | {
      ok: true;
      eventId: string;
      startAt: Date;
      endAt: Date;
      assignedToName: string | null;
    }
  | { ok: false; code: "slot_taken" | "invalid_slot" | "error" };

export interface AgentBookInput {
  subAccountId: string;
  agencyId: string;
  page: BookingPage;
  channel: AgentBookingChannel;
  startAtIso: string;
  name: string;
  /** Website bookings: where the confirmation goes. Phone: host notification only. */
  email?: string | null;
  phone?: string | null;
  /**
   * Phone: the caller-ID match, if any (null creates a phone-first contact).
   * Website: required; the caller reconciles the visitor first so the chat
   * session is linked to the same contact.
   */
  contactId: string | null;
  /** Already resolved from a name by the caller. Only honoured on
   *  `allowHostSelection` pages. Null = pooled least-loaded assignment. */
  hostUid?: string | null;
  /** Phone only: Vapi call id. A successful booking is stamped onto
   *  voiceCalls/{callId} so the end-of-call handler creates a follow-up Task. */
  callId?: string | null;
  /** Answers to the page's intake questions, saved on the event notes. */
  intakeAnswers?: { label: string; value: string }[];
  /** The booker's address, for "at your place" pages. */
  address?: string | null;
  /**
   * Number for a "we call you" page when it differs from `phone` (a caller
   * asking to be called on another number). Contact matching keeps `phone`.
   */
  locationPhone?: string | null;
}

