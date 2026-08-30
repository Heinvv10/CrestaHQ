/**
 * SMS send-blocking semantics, split into two independent concepts:
 *
 *  - `smsOptedOut` — carrier-level STOP. Written ONLY by the Twilio inbound
 *    webhook (STOP/START keywords). Not liftable in-app — Twilio keeps its
 *    own suppression list, so only an inbound START clears it.
 *  - `smsConsent.consented === false` — asked and declined (a form's consent
 *    checkbox left unticked). Our own block, liftable if the customer later
 *    consents.
 *  - No consent record at all (imports, manual entry, forms without a
 *    consent box) — sendable, as before.
 *
 * The form submit route historically wrote `smsOptedOut: true` for a
 * declined checkbox, which faked an irreversible carrier STOP that no START
 * was ever coming to lift. This helper is the single gate senders check so
 * the two concepts can't re-conflate.
 */

export interface SmsBlockCheckInput {
  smsOptedOut?: boolean;
  smsConsent?: { consented?: boolean } | null;
}

export type SmsBlockReason = "carrier_stop" | "consent_declined";

/** Returns why an SMS to this contact must not be sent, or null if sendable. */
export function smsSendBlock(
  contact: SmsBlockCheckInput,
): SmsBlockReason | null {
  if (contact.smsOptedOut === true) return "carrier_stop";
  if (contact.smsConsent?.consented === false) return "consent_declined";
  return null;
}
