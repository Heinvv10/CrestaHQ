import type { FieldValue, Timestamp } from "firebase/firestore";

import type { PaymentMode } from "@/types/payment-attempts";

/**
 * Card-on-file mandates — `paymentMandates/{id}`, id = the Paystack reference
 * of the payment that created it.
 *
 * A customer authorises a card by paying a recurring invoice's card-on-file
 * link (`paymentLinks.mandate`). The mandate is written ONLY by the
 * reconciler, from Paystack's verify answer for a payment that matched its
 * attempt, and only when Paystack marks the authorization reusable.
 *
 * Split in two, because rules are document-level:
 *   - this doc — display facts and consent evidence; member-read.
 *   - `paymentMandates/{id}/private/authorization` — what can charge the card
 *     (`PaymentMandateSecret`); no client may read or write it.
 *
 * `mode` + `keyFingerprint` are the key the card was authorised under. The
 * authorization only exists on that Paystack account, so once the connection
 * holds another key the mandate goes to `attention` and is never charged.
 * `revoked` is final: revoking deletes the authorization.
 */

export type PaymentMandateStatus = "active" | "attention" | "revoked";

/** What the customer agreed to, as shown above the pay button. */
export interface MandateTerms {
  amountCents: number;
  currency: string;
  /** "every month", "every 2 weeks", … */
  frequency: string;
  /** The exact sentence shown on the pay page. */
  text: string;
}

/** Consent evidence: the wording, when the customer clicked, from where. */
export interface MandateConsent {
  text: string;
  acceptedAt: Timestamp | Date;
  ip: string;
}

export interface PaymentMandate {
  id: string;

  agencyId: string;
  subAccountId: string;
  /** The operator who issued the card-on-file link. */
  createdByUid: string;

  contactId: string | null;
  recurringInvoiceId: string;
  paymentLinkId: string;
  /** The first payment's Paystack reference — also the doc id. */
  reference: string;

  terms: MandateTerms;
  consent: MandateConsent;

  cardBrand: string | null;
  last4: string | null;
  expMonth: string | null;
  expYear: string | null;

  mode: PaymentMode;
  keyFingerprint: string;

  status: PaymentMandateStatus;
  attention: string | null;
  /**
   * Recurring charges declined in a row, and the last gateway reason. At the
   * schedule's `unpaidEscalationThreshold` the mandate goes to `attention`;
   * a recorded successful charge resets the count.
   */
  consecutiveDeclines?: number;
  lastDeclineReason?: string | null;
  revokedAt: Timestamp | FieldValue | null;
  revokedByUid: string | null;

  createdAt: Timestamp | FieldValue;
  updatedAt: Timestamp | FieldValue;
}

/** Server-only. Never sent to a browser. */
export interface PaymentMandateSecret {
  authorizationCode: string;
  customerCode: string;
  /** Paystack charges an authorization only with its customer's email. */
  email: string;
  signature: string | null;
}

export const paymentMandateSecretPath = (mandateId: string) =>
  `paymentMandates/${mandateId}/private/authorization`;
