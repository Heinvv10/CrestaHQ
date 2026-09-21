import type { WhatsAppProviderId } from "@/lib/comms/whatsapp/provider";

/**
 * One WhatsApp number a sub-account can send FROM.
 *
 * A sub-account used to have exactly one rail (`whatsappProvider`) and no way
 * to choose a number, while GoHighLevel's own WhatsApp action carries a
 * "SELECT FROM PHONE NUMBER" dropdown — so the single field was already worse
 * than the thing we claim parity with, and more bridge numbers are being
 * built. Senders are therefore a list.
 *
 * Stored on the member-readable `subAccounts/{id}` doc, so it holds display
 * metadata ONLY. Credentials stay where each rail already keeps them, under
 * `subAccounts/{id}/private/*`.
 */
export interface WhatsAppSender {
  /** Stable id, referenced by `whatsapp_template` nodes. Never reused. */
  id: string;
  /** Operator-facing name, e.g. "Sales — +27 78 435 6159". */
  label: string;
  /** Which rail this number sends over. */
  provider: WhatsAppProviderId;
  /** Display number, E.164. Never a credential. */
  phoneNumber: string;
  /** The sender used when a step names none. Exactly one, enforced on write. */
  isDefault?: boolean;
  /**
   * Reserved for per-sender credentials, which do not exist yet: today every
   * rail reads one credential doc per sub-account. Nothing writes this field,
   * and `resolveWhatsappSender` REFUSES a sender that carries one rather than
   * silently sending on another sender's credentials.
   */
  credentialsId?: string;
}

/** Sanity cap on the registry — a picker, not a phone book. */
export const MAX_WHATSAPP_SENDERS = 10;

/**
 * Id of the sender synthesized for a sub-account that has no registry yet.
 * Persisted nowhere: it exists so a resolved sender always has an id.
 */
export const LEGACY_WHATSAPP_SENDER_ID = "default";
