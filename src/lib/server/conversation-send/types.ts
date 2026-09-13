import type { Contact } from "@/types/contacts";

/**
 * Shared shapes for the conversation send service (SP2 d).
 *
 * The four manual send routes (/api/comms/{email,sms,whatsapp,meta}/send) and
 * the scheduled-message worker all send through this one service. The routes
 * keep auth + request parsing; everything from "does this contact have a phone
 * number" to the conversation-index write lives here, so a scheduled send runs
 * exactly the checks a live one does, at the moment it goes out.
 *
 * A refusal carries the HTTP status the route has always answered with, so
 * the thin routes stay byte-identical. The worker ignores `status` and records
 * `error` (and `code`) as the failure reason.
 */

/** Who is sending. `email` feeds the non-SMTP email Reply-To fallback. */
export interface SendActor {
  uid: string;
  email: string;
}

export interface SendRefusal {
  ok: false;
  status: number;
  error: string;
  code?: string;
  /**
   * The provider could not say whether the message was delivered (a WhatsApp
   * result marked AMBIGUOUS). Never serialised into a route response — the
   * scheduled-message worker reads it to avoid recording "not sent".
   */
  outcomeUnknown?: true;
}

export interface SendSuccess {
  ok: true;
  /** Provider message id (email Message-ID, Twilio SID, bridge/Meta id). */
  messageId: string;
  /** The route's success body, exactly as it has always been returned. */
  response: Record<string, unknown>;
}

export type SendOutcome = SendSuccess | SendRefusal;

/** Pre-send checks passed. Channel modules extend this with what they read. */
export type Prepared<T> = { ok: true } & T;

export function refuse(status: number, error: string, code?: string): SendRefusal {
  return code === undefined
    ? { ok: false, status, error }
    : { ok: false, status, error, code };
}

/** What every channel's send takes. */
export interface ChannelSendBase {
  /** The id the caller addressed (the route's trimmed payload value). */
  contactId: string;
  /** Resolved and access-checked by the caller. */
  contact: Contact;
  /** Final text — never rendered or trimmed further here. */
  body: string;
  actor: SendActor;
}
